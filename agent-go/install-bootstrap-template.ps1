# Opale — Intune installer with bootstrap token (single artefact, N PCs)
#
# Executes on each Windows endpoint with a UNIQUE bootstrap token embedded.
# At runtime, every PC:
#   1. Exchanges the bootstrap for a per-device token
#      (POST /api/agent/exchange-token with hostname + serial)
#   2. Downloads the Go agent binary (Bearer auth with the per-device token)
#   3. Verifies sha256, installs the Windows Service
#   4. Cleans up legacy PowerShell residues if any
#
# Tailscale/Netbird setup-key pattern: 1 Intune Platform Script assigned to a
# group (static or dynamic). Bootstrap expires (default 7d) and is revocable.
#
# Must run as SYSTEM. Designed for Intune Platform Scripts.
#
# Markers substituted at build time by scripts/build-intune-bootstrap.sh :
#   ##URL##                  — RMM server URL (e.g. https://rmm.example.com)
#   ##BOOTSTRAP_TOKEN##      — bootstrap token (DB-tracked expiry)
#   ##SERVICE_NAME##         — Windows Service name (e.g. Opale-Agent)
#   ##DATA_DIR_NAME##        — ProgramData subfolder name (e.g. Opale)
#   ##BIN_NAME##             — agent binary base name (e.g. opale-agent)
#   ##LEGACY_SCHTASKS_NAME## — optional legacy scheduled task to remove (empty = skip)

param()
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Url       = '##URL##'
$Bootstrap = '##BOOTSTRAP_TOKEN##'

$ServiceName       = '##SERVICE_NAME##'
$DataDirName       = '##DATA_DIR_NAME##'
$BinName           = '##BIN_NAME##'
$LegacySchtasks    = '##LEGACY_SCHTASKS_NAME##'

$DataDir     = Join-Path $env:ProgramData $DataDirName
$ExePath     = Join-Path $DataDir "$BinName.exe"
$ConfigPath  = Join-Path $DataDir 'config.json'
$LogPath     = Join-Path $DataDir 'install-bootstrap.log'

# Les lignes de log ne sont écrites dans $DataDir qu'une fois le dossier
# vérifié (Initialize-DataDir) : avant, elles sont gardées en mémoire. Écrire
# dans un dossier préparé par un utilisateur permettrait de suivre un lien
# planté à la place du fichier de log.
$script:DataDirTrusted = $false
$script:PendingLog = New-Object System.Collections.Generic.List[string]

function Log($msg) {
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "[$stamp] $msg"
    Write-Output $line
    if (-not $script:DataDirTrusted) {
        $script:PendingLog.Add($line)
        return
    }
    try {
        foreach ($l in $script:PendingLog) { Add-Content -LiteralPath $LogPath -Value $l -Encoding UTF8 -ErrorAction SilentlyContinue }
        $script:PendingLog.Clear()
        Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch {}
}

$systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')        # NT AUTHORITY\SYSTEM
$adminSid  = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')    # BUILTIN\Administrators

# ACL SYSTEM + Administrateurs (FullControl), héritage parent coupé,
# propriétaire Administrateurs. Comptes référencés par SID (indépendant de
# la langue).
function Set-SystemOnlyAcl([string]$Path, [bool]$IsContainer) {
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRule($rule) }
    if ($IsContainer) { $inherit = @('ContainerInherit','ObjectInherit') } else { $inherit = 'None' }
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
        $systemSid, 'FullControl', $inherit, 'None', 'Allow')))
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
        $adminSid, 'FullControl', $inherit, 'None', 'Allow')))
    $acl.SetOwner($adminSid)
    Set-Acl -LiteralPath $Path -AclObject $acl
}

# Attributs de l'entrée elle-même (GetAttributes ne suit pas les points
# d'analyse) ; $null si le chemin n'existe pas.
function Get-EntryAttributes([string]$Path) {
    try { return [System.IO.File]::GetAttributes($Path) } catch { return $null }
}

# Élément de confiance : ni jonction / lien, propriétaire SYSTEM ou
# Administrateurs.
function Test-TrustedItem([string]$Path) {
    $attrs = Get-EntryAttributes $Path
    if ($null -eq $attrs) { return $false }
    if ($attrs -band [System.IO.FileAttributes]::ReparsePoint) { return $false }
    $owner = (Get-Acl -LiteralPath $Path).GetOwner([System.Security.Principal.SecurityIdentifier])
    return ($owner -eq $systemSid -or $owner -eq $adminSid)
}

# Un utilisateur standard peut créer un sous-dossier de %ProgramData% (il
# en devient propriétaire, donc peut toujours en réécrire l'ACL) ou y
# déposer fichiers et jonctions avant l'installation. Si le dossier, ou
# l'un de ses éléments directs, n'est pas de confiance, il est écarté par
# un simple renommage (jamais Remove-Item -Recurse, qui suit les jonctions
# sous Windows PowerShell 5.1) puis recréé vide.
function Initialize-DataDir {
    $attrs = Get-EntryAttributes $DataDir
    if ($null -ne $attrs) {
        $trusted = $false
        try {
            if (($attrs -band [System.IO.FileAttributes]::Directory) -and (Test-TrustedItem $DataDir)) {
                $trusted = $true
                foreach ($child in @(Get-ChildItem -LiteralPath $DataDir -Force)) {
                    if (-not (Test-TrustedItem $child.FullName)) { $trusted = $false; break }
                }
            }
        } catch { $trusted = $false }
        if (-not $trusted) {
            $aside = "$DataDir.untrusted-" + (Get-Date -Format 'yyyyMMddHHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
            [System.IO.Directory]::Move($DataDir, $aside)
            Log "WARN: $DataDir not owned by SYSTEM/Administrators (or contains links): moved aside to $aside"
        }
    }
    if ($null -eq (Get-EntryAttributes $DataDir)) {
        New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
    }
    Set-SystemOnlyAcl $DataDir $true
    $script:DataDirTrusted = $true
}

function Remove-LegacyScheduledTask {
    if ($LegacySchtasks -and $LegacySchtasks -ne '##LEGACY_SCHTASKS_NAME##') {
        schtasks /delete /tn $LegacySchtasks /f 2>&1 | Out-Null
    }
}

# --- 0. Idempotence : if Go service already running, just cleanup PS and exit ---
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing -and $existing.Status -eq 'Running') {
    Log "Go service already running, cleanup PS and exit."
    Remove-LegacyScheduledTask
    Remove-Item "$DataDir\checkin.ps1"   -Force -ErrorAction SilentlyContinue
    Remove-Item "$DataDir\install.log"   -Force -ErrorAction SilentlyContinue
    Remove-Item "$DataDir\ssh-setup.log" -Force -ErrorAction SilentlyContinue
    exit 0
}

$Hostname = $env:COMPUTERNAME
Log "Starting bootstrap install for $Hostname"

# --- 1. DataDir de confiance + ACL SYSTEM-only ---
try {
    Initialize-DataDir
} catch {
    Log "FAIL: data dir $DataDir : $_"
    exit 8
}
Log "ACL SYSTEM-only OK on $DataDir"

# --- 2. Read serial (for audit + better device matching) ---
$Serial = $null
try {
    $Serial = (Get-CimInstance Win32_BIOS -ErrorAction SilentlyContinue).SerialNumber
} catch {}
if (-not $Serial) { $Serial = '' }

# --- 3. Bootstrap exchange → per-device token ---
$BootstrapHeaders = @{
    'Authorization' = "Bearer $Bootstrap"
    'Content-Type'  = 'application/json'
}
$body = @{ hostname = $Hostname; serial = $Serial } | ConvertTo-Json -Compress

try {
    $exch = Invoke-RestMethod -Uri "$Url/api/agent/exchange-token" `
        -Method POST -Headers $BootstrapHeaders -Body $body -TimeoutSec 30
    $Token = $exch.token
    Log "Per-device token obtained (device_id=$($exch.device_id), prefix=$($Token.Substring(0, 8))...)"
} catch {
    Log "FAIL: exchange-token: $_"
    exit 1
}

# --- 4. Download metadata + binary with the per-device token ---
$Headers = @{ 'Authorization' = "Bearer $Token" }
try {
    $meta = Invoke-RestMethod -Uri "$Url/api/agent/binary/meta?arch=amd64" -Headers $Headers -TimeoutSec 30
    Log "Meta OK: version=$($meta.version), sha256=$($meta.sha256.Substring(0, 12))..."
} catch {
    Log "FAIL: meta endpoint: $_"
    exit 2
}

# Téléchargement sous un nom aléatoire DANS le DataDir verrouillé (et non
# dans $env:TEMP = C:\Windows\Temp en SYSTEM, où un nom prévisible peut être
# pré-créé ou remplacé entre la vérification et le déplacement).
$tmpExe = Join-Path $DataDir ("$BinName-" + [guid]::NewGuid().ToString('N') + '.download')
try {
    Invoke-WebRequest -Uri "$Url/api/agent/binary?arch=amd64" -Headers $Headers `
        -OutFile $tmpExe -UseBasicParsing -TimeoutSec 180
    Set-SystemOnlyAcl $tmpExe $false
    Log "Binary downloaded: $((Get-Item -LiteralPath $tmpExe).Length) bytes"
} catch {
    Log "FAIL: download binary: $_"
    Remove-Item -LiteralPath $tmpExe -Force -ErrorAction SilentlyContinue
    exit 3
}

# --- 5. Verify sha256 ---
$actualHash   = (Get-FileHash -Algorithm SHA256 -LiteralPath $tmpExe).Hash.ToLower()
$expectedHash = $meta.sha256.ToLower()
if ($actualHash -ne $expectedHash) {
    Log "FAIL: sha256 mismatch (got=$actualHash, expected=$expectedHash)"
    Remove-Item -LiteralPath $tmpExe -Force -ErrorAction SilentlyContinue
    exit 4
}
Log "sha256 verified."

# --- 6. Install binary + config ---
Move-Item -LiteralPath $tmpExe -Destination $ExePath -Force
$config = @{ token = $Token; url = $Url } | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($ConfigPath, $config, [System.Text.UTF8Encoding]::new($false))
Log "Binary and config written."

# --- 7. Windows Service ---
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    if ($existing.Status -eq 'Running') {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
    & sc.exe config $ServiceName binPath= "`"$ExePath`"" start= auto 2>&1 | Out-Null
} else {
    & sc.exe create $ServiceName binPath= "`"$ExePath`"" start= auto DisplayName= "$ServiceName" 2>&1 | Out-Null
    & sc.exe description $ServiceName "Agent — checkin and auto-update." 2>&1 | Out-Null
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
    Log "FAIL: service does not stay Running (status=$finalStatus). Rollback service."
    & sc.exe stop $ServiceName 2>&1 | Out-Null
    & sc.exe delete $ServiceName 2>&1 | Out-Null
    # Per-device token stays active in DB (fine: will be reused on retry).
    exit 7
}
Log "Service $ServiceName stable after 30s, OK."

# --- 9. Cleanup PS residues ---
Remove-LegacyScheduledTask
Remove-Item "$DataDir\checkin.ps1"   -Force -ErrorAction SilentlyContinue
Remove-Item "$DataDir\install.log"   -Force -ErrorAction SilentlyContinue
Remove-Item "$DataDir\ssh-setup.log" -Force -ErrorAction SilentlyContinue
Log "PS cleanup done."

Log "Bootstrap install completed successfully for $Hostname."
exit 0
