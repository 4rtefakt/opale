# TDV RMM - Installeur Intune unique avec bootstrap token
#
# Ce script s'exécute sur N PCs avec un bootstrap token UNIQUE embarqué.
# Au runtime, chaque PC :
#   1. Échange le bootstrap contre un token perso device-lié
#      (POST /api/agent/exchange-token avec son hostname)
#   2. Télécharge le binaire Go (auth Bearer du token perso)
#   3. Vérifie sha256, installe le service Windows
#   4. Cleanup résidus PS legacy
#
# Pattern setup-key Tailscale/Netbird : 1 script Intune assigné à un groupe
# (statique ou dynamique). Le bootstrap expire (typ. 7j) et peut être révoqué.
#
# Doit s'exécuter en SYSTEM. Conçu pour Intune Platform Scripts.
#
# Variables substituées par scripts/build-intune-bootstrap.sh :
#   ##URL##              — URL serveur RMM (ex. https://rmm.tourduvalat.app)
#   ##BOOTSTRAP_TOKEN##  — token bootstrap (validity bornée par expires_at en DB)

param()
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Url       = '##URL##'
$Bootstrap = '##BOOTSTRAP_TOKEN##'

$ServiceName = 'TDV-RMM-Agent'
$DataDir     = 'C:\ProgramData\TDV-RMM'
$ExePath     = "$DataDir\tdv-rmm-agent.exe"
$ConfigPath  = "$DataDir\config.json"
$LogPath     = "$DataDir\install-bootstrap.log"

function Log($msg) {
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "[$stamp] $msg"
    Write-Output $line
    try {
        if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
        Add-Content -Path $LogPath -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch {}
}

# --- 0. Idempotence : si le service Go tourne déjà, juste cleanup PS et exit ---
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing -and $existing.Status -eq 'Running') {
    Log "Service Go deja actif, cleanup PS et exit."
    schtasks /delete /tn 'TDV-RMM-Checkin' /f 2>&1 | Out-Null
    Remove-Item "$DataDir\checkin.ps1"   -Force -ErrorAction SilentlyContinue
    Remove-Item "$DataDir\install.log"   -Force -ErrorAction SilentlyContinue
    Remove-Item "$DataDir\ssh-setup.log" -Force -ErrorAction SilentlyContinue
    exit 0
}

$Hostname = $env:COMPUTERNAME
Log "Demarrage install bootstrap pour $Hostname"

# --- 1. ACL SYSTEM-only sur DataDir ---
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
Log "ACL SYSTEM-only OK sur $DataDir"

# --- 2. Récupérer le serial (pour audit + meilleur matching device) ---
$Serial = $null
try {
    $Serial = (Get-CimInstance Win32_BIOS -ErrorAction SilentlyContinue).SerialNumber
} catch {}
if (-not $Serial) { $Serial = '' }

# --- 3. Échange bootstrap → token perso ---
$BootstrapHeaders = @{
    'Authorization' = "Bearer $Bootstrap"
    'Content-Type'  = 'application/json'
}
$body = @{ hostname = $Hostname; serial = $Serial } | ConvertTo-Json -Compress

try {
    $exch = Invoke-RestMethod -Uri "$Url/api/agent/exchange-token" `
        -Method POST -Headers $BootstrapHeaders -Body $body -TimeoutSec 30
    $Token = $exch.token
    Log "Token perso obtenu (device_id=$($exch.device_id), prefix=$($Token.Substring(0, 8))...)"
} catch {
    Log "ECHEC: exchange-token: $_"
    exit 1
}

# --- 4. Télécharger metadata + binaire avec le token perso ---
$Headers = @{ 'Authorization' = "Bearer $Token" }
try {
    $meta = Invoke-RestMethod -Uri "$Url/api/agent/binary/meta?arch=amd64" -Headers $Headers -TimeoutSec 30
    Log "Meta OK: version=$($meta.version), sha256=$($meta.sha256.Substring(0, 12))..."
} catch {
    Log "ECHEC: meta endpoint: $_"
    exit 2
}

$tmpExe = Join-Path $env:TEMP "tdv-rmm-agent-bootstrap.exe"
try {
    Invoke-WebRequest -Uri "$Url/api/agent/binary?arch=amd64" -Headers $Headers `
        -OutFile $tmpExe -UseBasicParsing -TimeoutSec 180
    Log "Binaire telecharge: $((Get-Item $tmpExe).Length) octets"
} catch {
    Log "ECHEC: download binaire: $_"
    exit 3
}

# --- 5. Vérifier sha256 ---
$actualHash   = (Get-FileHash -Algorithm SHA256 -Path $tmpExe).Hash.ToLower()
$expectedHash = $meta.sha256.ToLower()
if ($actualHash -ne $expectedHash) {
    Log "ECHEC: sha256 mismatch (got=$actualHash, expected=$expectedHash)"
    Remove-Item $tmpExe -Force -ErrorAction SilentlyContinue
    exit 4
}
Log "sha256 verifie."

# --- 6. Installer binaire + config ---
Move-Item -Path $tmpExe -Destination $ExePath -Force
$config = @{ token = $Token; url = $Url } | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($ConfigPath, $config, [System.Text.UTF8Encoding]::new($false))
Log "Binaire et config ecrits."

# --- 7. Service Windows ---
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
    Log "ECHEC: service ne reste pas Running (status=$finalStatus). Rollback service."
    & sc.exe stop $ServiceName 2>&1 | Out-Null
    & sc.exe delete $ServiceName 2>&1 | Out-Null
    # Le token perso reste actif côté DB (pas grave : sera réutilisé au retry).
    exit 7
}
Log "Service $ServiceName stable apres 30s, OK."

# --- 9. Cleanup résidus PS ---
schtasks /delete /tn 'TDV-RMM-Checkin' /f 2>&1 | Out-Null
Remove-Item "$DataDir\checkin.ps1"   -Force -ErrorAction SilentlyContinue
Remove-Item "$DataDir\install.log"   -Force -ErrorAction SilentlyContinue
Remove-Item "$DataDir\ssh-setup.log" -Force -ErrorAction SilentlyContinue
Log "Cleanup PS effectue."

Log "Install bootstrap terminee avec succes pour $Hostname."
exit 0
