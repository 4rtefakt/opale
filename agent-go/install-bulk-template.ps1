# TDV RMM - Installeur bulk multi-PC pour déploiement Intune en groupe
#
# Ce script contient un mapping hostname → token embarqué (substitué au build).
# Au runtime, il :
#   1. Lit $env:COMPUTERNAME
#   2. Cherche son token dans le mapping ; exit 0 si pas dans la liste
#   3. Télécharge le binaire Go depuis l'API (auth Bearer avec son token)
#   4. Vérifie sha256 et installe le service Windows
#   5. Nettoie les résidus de l'agent PowerShell legacy (tâche planifiée + files)
#
# Doit s'exécuter en SYSTEM. Conçu pour Intune Platform Scripts.
#
# Variables substituées par scripts/bulk-build-intune-single-installer.sh :
#   ##URL##          — URL serveur RMM (ex. https://rmm.tourduvalat.app)
#   ##TOKENS_MAP##   — bloc PowerShell '<hostname>'='<token>'; ...

param()
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Url    = '##URL##'
$Tokens = @{
##TOKENS_MAP##
}

$ServiceName = 'TDV-RMM-Agent'
$DataDir     = 'C:\ProgramData\TDV-RMM'
$ExePath     = "$DataDir\tdv-rmm-agent.exe"
$ConfigPath  = "$DataDir\config.json"
$LogPath     = "$DataDir\install-bulk.log"

function Log($msg) {
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "[$stamp] $msg"
    Write-Output $line
    try {
        if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
        Add-Content -Path $LogPath -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch {}
}

# --- 1. Cherche le token de ce PC ---
$Hostname = $env:COMPUTERNAME
$Token    = $Tokens[$Hostname]
if (-not $Token) {
    Write-Output "Hostname '$Hostname' non present dans le mapping bulk. Skip."
    exit 0
}

Log "Demarrage install bulk pour $Hostname (token=$($Token.Substring(0, 8))..., url=$Url)"

# --- 2. Idempotence : si service Go deja installe et actif, cleanup PS uniquement ---
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing -and $existing.Status -eq 'Running') {
    Log "Service Go deja actif. Cleanup PS et exit."
    schtasks /delete /tn 'TDV-RMM-Checkin' /f 2>&1 | Out-Null
    Remove-Item "$DataDir\checkin.ps1"     -Force -ErrorAction SilentlyContinue
    Remove-Item "$DataDir\install.log"     -Force -ErrorAction SilentlyContinue
    Remove-Item "$DataDir\ssh-setup.log"   -Force -ErrorAction SilentlyContinue
    exit 0
}

# --- 3. ACL SYSTEM-only sur DataDir ---
if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
$systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$adminSid  = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
$acl = Get-Acl -Path $DataDir
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRule($rule) }
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    $systemSid, 'FullControl', @('ContainerInherit','ObjectInherit'), 'None', 'Allow')))
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    $adminSid, 'FullControl', @('ContainerInherit','ObjectInherit'), 'None', 'Allow')))
$acl.SetOwner($adminSid)
Set-Acl -Path $DataDir -AclObject $acl
Log "ACL SYSTEM-only appliquee sur $DataDir"

# --- 4. Telecharger metadata + binaire ---
$Headers = @{ 'Authorization' = "Bearer $Token" }
try {
    $meta = Invoke-RestMethod -Uri "$Url/api/agent/binary/meta?arch=amd64" -Headers $Headers -TimeoutSec 30
    Log "Meta OK: version=$($meta.version), sha256=$($meta.sha256.Substring(0, 12))..."
} catch {
    Log "ECHEC: meta endpoint: $_"
    exit 1
}

$tmpExe = Join-Path $env:TEMP "tdv-rmm-agent-bulk.exe"
try {
    Invoke-WebRequest -Uri "$Url/api/agent/binary?arch=amd64" -Headers $Headers -OutFile $tmpExe -UseBasicParsing -TimeoutSec 180
    Log "Binaire telecharge: $((Get-Item $tmpExe).Length) octets"
} catch {
    Log "ECHEC: download binaire: $_"
    exit 2
}

# --- 5. Verifier sha256 ---
$actualHash   = (Get-FileHash -Algorithm SHA256 -Path $tmpExe).Hash.ToLower()
$expectedHash = $meta.sha256.ToLower()
if ($actualHash -ne $expectedHash) {
    Log "ECHEC: sha256 mismatch (got=$actualHash, expected=$expectedHash)"
    Remove-Item $tmpExe -Force -ErrorAction SilentlyContinue
    exit 3
}
Log "sha256 verifie."

# --- 6. Installer binaire + config ---
Move-Item -Path $tmpExe -Destination $ExePath -Force
$config = @{ token = $Token; url = $Url } | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($ConfigPath, $config, [System.Text.UTF8Encoding]::new($false))
Log "Binaire et config ecrits."

# --- 7. Service Windows (create ou update) ---
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    if ($existing.Status -eq 'Running') {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
    & sc.exe config $ServiceName binPath= "`"$ExePath`"" start= auto 2>&1 | Out-Null
} else {
    & sc.exe create $ServiceName binPath= "`"$ExePath`"" start= auto DisplayName= 'TDV RMM Agent' 2>&1 | Out-Null
    & sc.exe description $ServiceName 'Agent de gestion de parc TDV - checkin et auto-update.' 2>&1 | Out-Null
}
& sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/5000/restart/30000 2>&1 | Out-Null
& sc.exe start $ServiceName 2>&1 | Out-Null

# --- 8. Smoke test 30s ---
$ok = $false
for ($i = 0; $i -lt 6; $i++) {
    Start-Sleep -Seconds 5
    $s = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($s -and $s.Status -eq 'Running') { $ok = $true } else { $ok = $false; break }
}
if (-not $ok) {
    $finalStatus = (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue).Status
    Log "ECHEC: service ne reste pas Running (status final=$finalStatus). Rollback."
    & sc.exe stop $ServiceName 2>&1 | Out-Null
    & sc.exe delete $ServiceName 2>&1 | Out-Null
    exit 7
}
Log "Service $ServiceName stable apres 30s, OK."

# --- 9. Cleanup residus PS ---
schtasks /delete /tn 'TDV-RMM-Checkin' /f 2>&1 | Out-Null
Remove-Item "$DataDir\checkin.ps1"     -Force -ErrorAction SilentlyContinue
Remove-Item "$DataDir\install.log"     -Force -ErrorAction SilentlyContinue
Remove-Item "$DataDir\ssh-setup.log"   -Force -ErrorAction SilentlyContinue
Log "Cleanup PS effectue."

Log "Install bulk terminee avec succes pour $Hostname."
exit 0
