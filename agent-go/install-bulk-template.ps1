# Opale — bulk Intune installer (single artefact, many PCs, hostname → token map)
#
# This script embeds a hostname → token mapping (substituted at build time).
# At runtime it:
#   1. Reads $env:COMPUTERNAME
#   2. Looks up its token in the mapping; exit 0 if absent from the list
#   3. Downloads the Go binary from the API (Bearer auth with its token)
#   4. Verifies sha256 and installs the Windows Service
#   5. Cleans up legacy PowerShell residues if any
#
# Must run as SYSTEM. Designed for Intune Platform Scripts.
#
# Markers substituted by scripts/bulk-build-intune-single-installer.sh :
#   ##URL##                  — RMM server URL (e.g. https://rmm.example.com)
#   ##TOKENS_MAP##           — PowerShell block "<hostname>='<token>'; ..."
#   ##SERVICE_NAME##         — Windows Service name (e.g. Opale-Agent)
#   ##DATA_DIR_NAME##        — ProgramData subfolder name (e.g. Opale)
#   ##BIN_NAME##             — agent binary base name (e.g. opale-agent)
#   ##LEGACY_SCHTASKS_NAME## — optional legacy scheduled task to remove (empty = skip)

param()
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Url    = '##URL##'
$Tokens = @{
##TOKENS_MAP##
}

$ServiceName    = '##SERVICE_NAME##'
$DataDirName    = '##DATA_DIR_NAME##'
$BinName        = '##BIN_NAME##'
$LegacySchtasks = '##LEGACY_SCHTASKS_NAME##'

$DataDir     = Join-Path $env:ProgramData $DataDirName
$ExePath     = Join-Path $DataDir "$BinName.exe"
$ConfigPath  = Join-Path $DataDir 'config.json'
$LogPath     = Join-Path $DataDir 'install-bulk.log'

function Log($msg) {
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "[$stamp] $msg"
    Write-Output $line
    try {
        if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
        Add-Content -Path $LogPath -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch {}
}

function Remove-LegacyScheduledTask {
    if ($LegacySchtasks -and $LegacySchtasks -ne '##LEGACY_SCHTASKS_NAME##') {
        schtasks /delete /tn $LegacySchtasks /f 2>&1 | Out-Null
    }
}

# --- 1. Look up this PC's token ---
$Hostname = $env:COMPUTERNAME
$Token    = $Tokens[$Hostname]
if (-not $Token) {
    Write-Output "Hostname '$Hostname' not in bulk mapping. Skip."
    exit 0
}

Log "Starting bulk install for $Hostname (token=$($Token.Substring(0, 8))..., url=$Url)"

# --- 2. Idempotence: if Go service already installed and running, only cleanup PS ---
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing -and $existing.Status -eq 'Running') {
    Log "Go service already running. Cleanup PS and exit."
    Remove-LegacyScheduledTask
    Remove-Item "$DataDir\checkin.ps1"     -Force -ErrorAction SilentlyContinue
    Remove-Item "$DataDir\install.log"     -Force -ErrorAction SilentlyContinue
    Remove-Item "$DataDir\ssh-setup.log"   -Force -ErrorAction SilentlyContinue
    exit 0
}

# --- 3. ACL SYSTEM-only on DataDir ---
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
Log "ACL SYSTEM-only applied on $DataDir"

# --- 4. Download metadata + binary ---
$Headers = @{ 'Authorization' = "Bearer $Token" }
try {
    $meta = Invoke-RestMethod -Uri "$Url/api/agent/binary/meta?arch=amd64" -Headers $Headers -TimeoutSec 30
    Log "Meta OK: version=$($meta.version), sha256=$($meta.sha256.Substring(0, 12))..."
} catch {
    Log "FAIL: meta endpoint: $_"
    exit 1
}

$tmpExe = Join-Path $env:TEMP "$BinName-bulk.exe"
try {
    Invoke-WebRequest -Uri "$Url/api/agent/binary?arch=amd64" -Headers $Headers -OutFile $tmpExe -UseBasicParsing -TimeoutSec 180
    Log "Binary downloaded: $((Get-Item $tmpExe).Length) bytes"
} catch {
    Log "FAIL: download binary: $_"
    exit 2
}

# --- 5. Verify sha256 ---
$actualHash   = (Get-FileHash -Algorithm SHA256 -Path $tmpExe).Hash.ToLower()
$expectedHash = $meta.sha256.ToLower()
if ($actualHash -ne $expectedHash) {
    Log "FAIL: sha256 mismatch (got=$actualHash, expected=$expectedHash)"
    Remove-Item $tmpExe -Force -ErrorAction SilentlyContinue
    exit 3
}
Log "sha256 verified."

# --- 6. Install binary + config ---
Move-Item -Path $tmpExe -Destination $ExePath -Force
$config = @{ token = $Token; url = $Url } | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($ConfigPath, $config, [System.Text.UTF8Encoding]::new($false))
Log "Binary and config written."

# --- 7. Windows Service (create or update) ---
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
    Log "FAIL: service does not stay Running (final status=$finalStatus). Rollback."
    & sc.exe stop $ServiceName 2>&1 | Out-Null
    & sc.exe delete $ServiceName 2>&1 | Out-Null
    exit 7
}
Log "Service $ServiceName stable after 30s, OK."

# --- 9. Cleanup PS residues ---
Remove-LegacyScheduledTask
Remove-Item "$DataDir\checkin.ps1"     -Force -ErrorAction SilentlyContinue
Remove-Item "$DataDir\install.log"     -Force -ErrorAction SilentlyContinue
Remove-Item "$DataDir\ssh-setup.log"   -Force -ErrorAction SilentlyContinue
Log "PS cleanup done."

Log "Bulk install completed successfully for $Hostname."
exit 0
