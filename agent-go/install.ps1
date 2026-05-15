# Installation de l'agent RMM (déployé via Intune ou manuel)
#
# Ce script :
#   1. Crée le dossier ProgramData (ACL SYSTEM-only)
#   2. Embarque le binaire (Base64) et l'écrit sur disque
#   3. Écrit config.json avec le token et l'URL
#   4. Installe et démarre le Windows Service
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

# --- 1. Création du dossier + ACL SYSTEM-only ---
if (-not (Test-Path $DataDir)) {
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
}

# ACL : SYSTEM (FullControl) + Administrators (FullControl), rien pour les Users.
# On référence les comptes par SID (locale-independent : sur Windows FR
# "BUILTIN\Administrators" est "BUILTIN\Administrateurs" et ne résout pas).
$systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')        # NT AUTHORITY\SYSTEM
$adminSid  = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')    # BUILTIN\Administrators

$acl = Get-Acl -Path $DataDir
$acl.SetAccessRuleProtection($true, $false)  # désactive l'héritage
# Vide les règles existantes
foreach ($rule in @($acl.Access)) {
    [void]$acl.RemoveAccessRule($rule)
}
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    $systemSid, 'FullControl',
    @('ContainerInherit','ObjectInherit'), 'None', 'Allow'
)))
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    $adminSid, 'FullControl',
    @('ContainerInherit','ObjectInherit'), 'None', 'Allow'
)))
$acl.SetOwner($adminSid)
Set-Acl -Path $DataDir -AclObject $acl

# --- 2. Décodage et écriture du binaire ---
[System.IO.File]::WriteAllBytes($ExePath, [Convert]::FromBase64String($AgentBinB64))
Write-Output "Binaire écrit : $ExePath ($((Get-Item $ExePath).Length) octets)"

# --- 3. Configuration ---
$config = @{ token = $Token; url = $Url } | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($ConfigPath, $config, [System.Text.UTF8Encoding]::new($false))
Write-Output "Config écrite : $ConfigPath"

# --- 4. Service Windows ---
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    if ($existing.Status -eq 'Running') {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        # Attendre la libération du fichier exe
        Start-Sleep -Seconds 2
    }
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
