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
# Administrateurs, et aucune autorisation accordée à un autre compte. Un
# dossier où un utilisateur a pu écrire peut contenir des liens durs vers
# des fichiers système (même propriétaire, invisibles autrement) ; un lien
# dur partage l'ACL de sa cible, qui accorde presque toujours la lecture à
# d'autres comptes, et est donc écarté par ce contrôle.
function Test-TrustedItem([string]$Path) {
    $attrs = Get-EntryAttributes $Path
    if ($null -eq $attrs) { return $false }
    if ($attrs -band [System.IO.FileAttributes]::ReparsePoint) { return $false }
    $acl = Get-Acl -LiteralPath $Path
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
    if (-not ($owner -eq $systemSid -or $owner -eq $adminSid)) { return $false }
    foreach ($rule in @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))) {
        if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
        if (-not ($rule.IdentityReference -eq $systemSid -or $rule.IdentityReference -eq $adminSid)) { return $false }
    }
    return $true
}

# Dossier de données de confiance : dossier réel, lui et chacun de ses
# éléments directs de confiance (cf. Test-TrustedItem).
function Test-DataDirTrusted {
    try {
        $attrs = Get-EntryAttributes $DataDir
        if ($null -eq $attrs) { return $false }
        if (-not ($attrs -band [System.IO.FileAttributes]::Directory)) { return $false }
        if (-not (Test-TrustedItem $DataDir)) { return $false }
        foreach ($child in @(Get-ChildItem -LiteralPath $DataDir -Force)) {
            if (-not (Test-TrustedItem $child.FullName)) { return $false }
        }
        return $true
    } catch {
        return $false
    }
}

# Création avec l'ACL SYSTEM-only dès l'origine (pas de fenêtre où le
# dossier hérite de l'ACL de %ProgramData%). $Path doit être un nom
# imprévisible : CreateDirectory (comme New-Item -Force) renvoie SANS
# ERREUR un dossier déjà existant, sans lui appliquer l'ACL. Repli
# New-Item SANS -Force (échoue si le nom existe) si l'API .NET Framework
# manque (PowerShell 7).
function New-SystemOnlyDirectory([string]$Path) {
    $sec = $null
    try {
        $sec = New-Object System.Security.AccessControl.DirectorySecurity
        $sec.SetAccessRuleProtection($true, $false)
        $sec.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
            $systemSid, 'FullControl', @('ContainerInherit','ObjectInherit'), 'None', 'Allow')))
        $sec.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
            $adminSid, 'FullControl', @('ContainerInherit','ObjectInherit'), 'None', 'Allow')))
    } catch {
        $sec = $null
    }
    if ($null -ne $sec) {
        try {
            [void][System.IO.Directory]::CreateDirectory($Path, $sec)
            return
        } catch [System.Management.Automation.MethodException] {
            # Surcharge absente (.NET Core) ou échec : repli New-Item
            # sans -Force ci-dessous (vérifié ensuite par Initialize-DataDir).
        }
    }
    New-Item -ItemType Directory -Path $Path | Out-Null
}

# Avant d'écarter ou de (re)créer le dossier de données, le service
# existant ne doit plus pouvoir démarrer : son exe est dans ce dossier, et
# un utilisateur qui recréerait le dossier (course perdue par le renommage,
# code 8) avec son propre exe le ferait lancer en SYSTEM — démarrage manuel,
# boot ou actions de récupération du SCM (un service désactivé ne démarre
# plus, même par elles). Même chose pour la tâche planifiée
# héritée, qui exécute un script du dossier. Les chemins de succès repassent le
# service en start= auto.
function Disable-AgentService {
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc) {
        & sc.exe config $ServiceName start= disabled | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "sc.exe config $ServiceName start= disabled : code $LASTEXITCODE" }
        if ($svc.Status -ne 'Stopped') {
            Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
            $svc.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped, (New-TimeSpan -Seconds 30))
        }
        Log "Service $ServiceName stopped and disabled (untrusted data dir): re-enabled only by a successful install"
    }
    # Tâche planifiée héritée : elle exécute un script de ce dossier.
    Remove-LegacyScheduledTask
}

# Un utilisateur standard peut créer un sous-dossier de %ProgramData% (il
# en devient propriétaire, donc peut toujours en réécrire l'ACL, y compris
# via un handle WRITE_DAC ouvert avant qu'on ne change le propriétaire) ou
# y déposer fichiers, liens et jonctions. Règle : ne jamais adopter un
# chemin qu'un autre compte a pu créer.
#   - dossier existant de confiance (réinstallation, mise à jour) : gardé ;
#   - sinon il est écarté par un simple renommage (jamais Remove-Item
#     -Recurse, qui suit les jonctions sous Windows PowerShell 5.1) ;
#   - le nouveau dossier est créé sous un nom aléatoire voisin, avec l'ACL
#     SYSTEM-only, vérifié vide et de confiance, puis renommé en $DataDir :
#     le renommage échoue si le nom a été recréé entre-temps (installation
#     interrompue, code 8).
function Initialize-DataDir {
    if (-not (Test-DataDirTrusted)) {
        Disable-AgentService
        if ($null -ne (Get-EntryAttributes $DataDir)) {
            $aside = "$DataDir.untrusted-" + (Get-Date -Format 'yyyyMMddHHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
            [System.IO.Directory]::Move($DataDir, $aside)
            Log "WARN: $DataDir not trusted (owner, ACL or links): moved aside to $aside"
        }
        $fresh = "$DataDir.new-" + [guid]::NewGuid().ToString('N')
        New-SystemOnlyDirectory $fresh
        try {
            Set-SystemOnlyAcl $fresh $true
            if (-not (Test-TrustedItem $fresh)) { throw "$fresh : ACL ou propriétaire inattendu" }
            if (@(Get-ChildItem -LiteralPath $fresh -Force).Count -ne 0) { throw "$fresh : dossier neuf non vide" }
            [System.IO.Directory]::Move($fresh, $DataDir)
        } catch {
            # Suppression non récursive (ne suit aucune jonction, pas d'invite).
            try { [System.IO.Directory]::Delete($fresh) } catch { }
            throw "création de $DataDir impossible (nom recréé entre-temps ?) : $_"
        }
    }
    Set-SystemOnlyAcl $DataDir $true
    if (-not (Test-DataDirTrusted)) {
        throw "$DataDir modifié pendant sa création : installation interrompue"
    }
    $script:DataDirTrusted = $true
}

# Dossier déjà installé et verrouillé : le journal fichier peut être écrit
# dès maintenant (dont le chemin « service déjà lancé » qui sort tôt).
if (Test-DataDirTrusted) { $script:DataDirTrusted = $true }

function Remove-LegacyScheduledTask {
    # Pas le marker littéral ici : le sed global des scripts de build le
    # remplacerait aussi, et la condition deviendrait toujours fausse.
    if ($LegacySchtasks -and $LegacySchtasks -notlike '##*##') {
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
$tmpCfg = Join-Path $DataDir ('config-' + [guid]::NewGuid().ToString('N') + '.tmp')
[System.IO.File]::WriteAllText($tmpCfg, $config, [System.Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $tmpCfg -Destination $ConfigPath -Force
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
