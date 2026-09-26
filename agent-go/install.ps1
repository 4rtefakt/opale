# Installation de l'agent RMM (déployé via Intune ou manuel)
#
# Ce script :
#   1. Arrête le service existant (réinstallation / mise à jour)
#   2. Crée le dossier ProgramData (ACL SYSTEM-only) ; un dossier préexistant
#      dont le propriétaire n'est pas SYSTEM/Administrateurs est écarté
#   3. Embarque le binaire (Base64) et l'écrit sur disque
#   4. Écrit config.json avec le token et l'URL
#   5. Installe et démarre le Windows Service
#
# Le binaire et la config sont SYSTEM-only — aucun utilisateur standard
# ne peut les lire ou les modifier. Le service tourne en SYSTEM.
#
# Markers remplacés au build par agent-go/build.js :
#   ##AGENT_BIN_B64##         binaire Base64
#   ##TOKEN##                 token agent
#   ##URL##                   URL serveur RMM
#   ##SERVICE_NAME##          nom du Windows Service (branding.ServiceName)
#   ##SERVICE_DISPLAY_NAME##  nom affiché services.msc
#   ##SERVICE_DESCRIPTION##   description du service
#   ##DATA_DIR_NAME##         nom du dossier sous %ProgramData%
#   ##BIN_NAME##              nom du binaire (sans extension)
#   ##LEGACY_SERVICE_NAME##   optionnel — ancien service à désinstaller (vide = skip)

param()
$ErrorActionPreference = 'Stop'

$ServiceName        = '##SERVICE_NAME##'
$ServiceDisplayName = '##SERVICE_DISPLAY_NAME##'
$ServiceDescription = '##SERVICE_DESCRIPTION##'
$DataDirName        = '##DATA_DIR_NAME##'
$BinName            = '##BIN_NAME##'

$DataDir     = Join-Path $env:ProgramData $DataDirName
$ExePath     = Join-Path $DataDir "$BinName.exe"
$ConfigPath  = Join-Path $DataDir 'config.json'

$AgentBinB64 = '##AGENT_BIN_B64##'
$Token       = '##TOKEN##'
$Url         = '##URL##'

if (-not $Token -or $Token -eq '##TOKEN##') {
    Write-Error 'Token non substitué — ce script doit être généré via agent-go/build.js'
    exit 1
}

# --- Legacy service cleanup (optionnel) : désinstalle un ancien service
# Windows nommé différemment, pour les instances qui migrent une flotte
# existante. Vide par défaut → branche désactivée. Le DataDir legacy est
# préservé (compat shim côté agent Go via branding.LegacyDataDirName).
$LegacyServiceName = '##LEGACY_SERVICE_NAME##'
if ($LegacyServiceName -and $LegacyServiceName -ne '##LEGACY_SERVICE_NAME##' -and $ServiceName -ne $LegacyServiceName) {
    $legacy = Get-Service -Name $LegacyServiceName -ErrorAction SilentlyContinue
    if ($legacy) {
        Write-Output "Legacy service $LegacyServiceName detected — uninstalling"
        if ($legacy.Status -eq 'Running') {
            Stop-Service -Name $LegacyServiceName -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
        }
        & sc.exe delete $LegacyServiceName | Out-Null
    }
}

# ACL : SYSTEM (FullControl) + Administrators (FullControl), rien pour les Users.
# On référence les comptes par SID (locale-independent : sur Windows FR
# "BUILTIN\Administrators" est "BUILTIN\Administrateurs" et ne résout pas).
$systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')        # NT AUTHORITY\SYSTEM
$adminSid  = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')    # BUILTIN\Administrators

# Héritage parent coupé, règles existantes vidées, propriétaire Administrateurs.
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
# plus, même par elles). Les chemins de succès repassent le
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
        Write-Output "Service $ServiceName arrêté et désactivé (dossier de données non fiable) : réactivé en fin d'installation réussie"
    }
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
            Write-Output "ATTENTION : $DataDir n'est pas de confiance (propriétaire, ACL ou liens) : déplacé vers $aside"
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
}

# Relance de l'agent existant après un échec : uniquement si le dossier de
# données est de confiance ET que le service pointe exactement sur l'exe de
# ce dossier. Sinon le service reste arrêté (et désactivé s'il l'a été par
# Disable-AgentService) : on ne lance jamais un exe d'un dossier qu'un autre
# compte a pu recréer.
function Restore-AgentService {
    if (-not $wasRunning) { return }
    $image = ''
    try {
        $image = [string](Get-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName" -Name ImagePath -ErrorAction Stop).ImagePath
    } catch {
        $image = ''
    }
    $image = $image.Trim().Trim('"')
    if ((Test-DataDirTrusted) -and ($image -ieq $ExePath) -and (Test-TrustedItem $ExePath)) {
        & sc.exe config $ServiceName start= auto | Out-Null
        Start-Service -Name $ServiceName -ErrorAction SilentlyContinue
        Write-Output "Agent existant relancé."
    } else {
        Write-Output "ATTENTION : service $ServiceName laissé arrêté/désactivé (dossier de données non fiable ou chemin inattendu : '$image')."
    }
}

# --- 1. Arrêt du service existant (libère l'exe et les fichiers du dossier) ---
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
$wasRunning = $false
if ($existing -and $existing.Status -eq 'Running') {
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    # Attendre la libération du fichier exe
    Start-Sleep -Seconds 2
    $wasRunning = $true
}

# --- 2. Dossier de confiance + ACL SYSTEM-only ---
try {
    Initialize-DataDir
} catch {
    Write-Output "ERREUR dossier de données : $_"
    # Ne pas laisser l'agent existant arrêté… si c'est sûr.
    Restore-AgentService
    exit 8
}

try {
    # --- 3. Binaire : écrit sous un nom aléatoire dans le dossier verrouillé,
    # ACL réinitialisée, puis déplacé sur le nom définitif ---
    $tmpExe = Join-Path $DataDir ("$BinName-" + [guid]::NewGuid().ToString('N') + '.download')
    [System.IO.File]::WriteAllBytes($tmpExe, [Convert]::FromBase64String($AgentBinB64))
    Set-SystemOnlyAcl $tmpExe $false
    Move-Item -LiteralPath $tmpExe -Destination $ExePath -Force
    Write-Output "Binaire écrit : $ExePath ($((Get-Item -LiteralPath $ExePath).Length) octets)"

    # --- 4. Configuration ---
    $config = @{ token = $Token; url = $Url } | ConvertTo-Json -Compress
    $tmpCfg = Join-Path $DataDir ('config-' + [guid]::NewGuid().ToString('N') + '.tmp')
    [System.IO.File]::WriteAllText($tmpCfg, $config, [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $tmpCfg -Destination $ConfigPath -Force
    Write-Output "Config écrite : $ConfigPath"
} catch {
    Write-Output "ERREUR installation : $_"
    if ($tmpExe) { Remove-Item -LiteralPath $tmpExe -Force -ErrorAction SilentlyContinue }
    # Ne pas laisser l'agent existant arrêté… si c'est sûr.
    Restore-AgentService
    exit 3
}

# --- 5. Service Windows ---
if ($existing) {
    # Mise à jour du chemin si déjà installé (sc config binPath=)
    & sc.exe config $ServiceName binPath= "`"$ExePath`"" start= auto | Out-Null
} else {
    & sc.exe create $ServiceName binPath= "`"$ExePath`"" start= auto DisplayName= "$ServiceDisplayName" | Out-Null
    & sc.exe description $ServiceName "$ServiceDescription" | Out-Null
}

# Recovery actions : restart auto en cas de crash (utile pour l'auto-update)
& sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/5000/restart/30000 | Out-Null

Start-Service -Name $ServiceName
Write-Output "Service $ServiceName démarré"

# Attendre 5s puis vérifier que le service tourne toujours (smoke test)
Start-Sleep -Seconds 5
$svc = Get-Service -Name $ServiceName
if ($svc.Status -ne 'Running') {
    Write-Error "Service en état inattendu : $($svc.Status)"
    exit 2
}
Write-Output "OK : agent installé et fonctionnel"
