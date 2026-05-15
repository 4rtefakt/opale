-- Bibliothèque de scripts intégrés
ALTER TABLE scripts ADD COLUMN IF NOT EXISTS is_builtin  BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE scripts ADD COLUMN IF NOT EXISTS builtin_key TEXT;

-- Index unique sur builtin_key (NULL ignorés → pas de conflit entre scripts custom)
CREATE UNIQUE INDEX IF NOT EXISTS scripts_builtin_key_idx ON scripts (builtin_key);

-- ── Réseau ───────────────────────────────────────────────────────────────────

INSERT INTO scripts (name, description, category, shell_type, is_builtin, builtin_key, code)
VALUES (
  'Configuration réseau complète',
  'Affiche ipconfig /all : adaptateurs, IPs, DHCP, DNS.',
  'Réseau', 'powershell', TRUE, 'net_ipconfig_all',
  $script$ipconfig /all$script$
)
ON CONFLICT (builtin_key) DO NOTHING;

INSERT INTO scripts (name, description, category, shell_type, is_builtin, builtin_key, code)
VALUES (
  'Table de routage',
  'Affiche les routes IP actives (route print).',
  'Réseau', 'powershell', TRUE, 'net_route_print',
  $script$route print$script$
)
ON CONFLICT (builtin_key) DO NOTHING;

INSERT INTO scripts (name, description, category, shell_type, is_builtin, builtin_key, code)
VALUES (
  'Ping passerelle par défaut',
  'Détecte la passerelle et lance 4 pings de diagnostic.',
  'Réseau', 'powershell', TRUE, 'net_ping_gateway',
  $script$$gw = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' |
            Sort-Object RouteMetric | Select-Object -First 1).NextHop
if ($gw) {
    Write-Host "Passerelle : $gw"
    Test-Connection -ComputerName $gw -Count 4
} else {
    Write-Host "Aucune passerelle par défaut trouvée"
}$script$
)
ON CONFLICT (builtin_key) DO NOTHING;

INSERT INTO scripts (name, description, category, shell_type, is_builtin, builtin_key, code)
VALUES (
  'Résolution DNS',
  'Teste la résolution DNS de google.com via Resolve-DnsName.',
  'Réseau', 'powershell', TRUE, 'net_dns_test',
  $script$Resolve-DnsName google.com | Select-Object Name, Type, IPAddress | Format-Table -AutoSize$script$
)
ON CONFLICT (builtin_key) DO NOTHING;

-- ── Système ──────────────────────────────────────────────────────────────────

INSERT INTO scripts (name, description, category, shell_type, is_builtin, builtin_key, code)
VALUES (
  'Espace disque libre',
  'Affiche utilisé / libre / total pour chaque volume FileSystem.',
  'Système', 'powershell', TRUE, 'sys_disk_free',
  $script$Get-PSDrive -PSProvider FileSystem | Select-Object Name,
    @{N='Utilisé (Go)'; E={[math]::Round($_.Used  / 1GB, 2)}},
    @{N='Libre (Go)';   E={[math]::Round($_.Free  / 1GB, 2)}},
    @{N='Total (Go)';   E={[math]::Round(($_.Used + $_.Free) / 1GB, 2)}} |
    Format-Table -AutoSize$script$
)
ON CONFLICT (builtin_key) DO NOTHING;

INSERT INTO scripts (name, description, category, shell_type, is_builtin, builtin_key, code)
VALUES (
  'Services automatiques arrêtés',
  'Liste les services de démarrage Automatique qui ne sont pas en cours d''exécution.',
  'Système', 'powershell', TRUE, 'sys_services_stopped',
  $script$Get-Service |
    Where-Object { $_.StartType -eq 'Automatic' -and $_.Status -ne 'Running' } |
    Select-Object Name, DisplayName, Status |
    Format-Table -AutoSize$script$
)
ON CONFLICT (builtin_key) DO NOTHING;

INSERT INTO scripts (name, description, category, shell_type, is_builtin, builtin_key, code)
VALUES (
  'Événements critiques (24 h)',
  'Retourne les événements Critical et Error du journal Système des dernières 24 heures.',
  'Système', 'powershell', TRUE, 'sys_event_errors',
  $script$$since = (Get-Date).AddHours(-24)
Get-WinEvent -FilterHashtable @{
    LogName   = 'System'
    Level     = 1, 2
    StartTime = $since
} -MaxEvents 30 -ErrorAction SilentlyContinue |
    Select-Object TimeCreated, LevelDisplayName, ProviderName,
        @{N='Message'; E={ $_.Message -replace "`n",' ' | Select-Object -First 1 }} |
    Format-List$script$
)
ON CONFLICT (builtin_key) DO NOTHING;

-- ── Mises à jour ─────────────────────────────────────────────────────────────

INSERT INTO scripts (name, description, category, shell_type, is_builtin, builtin_key, code)
VALUES (
  'Mises à jour Windows en attente',
  'Interroge Windows Update via COM pour lister les mises à jour non installées.',
  'Mises à jour', 'powershell', TRUE, 'upd_pending',
  $script$try {
    $session  = New-Object -ComObject Microsoft.Update.Session
    $searcher = $session.CreateUpdateSearcher()
    $result   = $searcher.Search('IsInstalled=0 and IsHidden=0')
    if ($result.Updates.Count -eq 0) {
        'Aucune mise à jour en attente'
    } else {
        Write-Host "$($result.Updates.Count) mise(s) à jour en attente :"
        $result.Updates | ForEach-Object { "  - $($_.Title)" }
    }
} catch {
    "Erreur lors de la vérification : $_"
}$script$
)
ON CONFLICT (builtin_key) DO NOTHING;

INSERT INTO scripts (name, description, category, shell_type, is_builtin, builtin_key, code)
VALUES (
  'Redémarrage Windows en attente',
  'Vérifie les clés de registre CBS, WindowsUpdate et PendingFileRename.',
  'Mises à jour', 'powershell', TRUE, 'upd_reboot_pending',
  $script$$reboot = $false
if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') {
    $reboot = $true; 'WindowsUpdate : redémarrage requis'
}
if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') {
    $reboot = $true; 'CBS : redémarrage requis'
}
$pfr = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' `
       -Name PendingFileRenameOperations -ErrorAction SilentlyContinue
if ($pfr.PendingFileRenameOperations) { $reboot = $true; 'PendingFileRename : redémarrage requis' }
if (-not $reboot) { 'Aucun redémarrage en attente' }$script$
)
ON CONFLICT (builtin_key) DO NOTHING;

-- ── Sécurité ─────────────────────────────────────────────────────────────────

INSERT INTO scripts (name, description, category, shell_type, is_builtin, builtin_key, code)
VALUES (
  'Statut Windows Defender',
  'Affiche l''état de la protection temps réel, antivirus, et l''âge des signatures.',
  'Sécurité', 'powershell', TRUE, 'sec_defender_status',
  $script$try {
    $s = Get-MpComputerStatus
    [PSCustomObject]@{
        'Protection temps réel' = $s.RealTimeProtectionEnabled
        'Antivirus activé'      = $s.AntivirusEnabled
        'Signatures (jours)'    = $s.AntivirusSignatureAge
        'Dernière analyse (j)'  = $s.QuickScanAge
        'Menaces actives'       = $s.ThreatIDs.Count
    } | Format-List
} catch {
    "Windows Defender non disponible : $_"
}$script$
)
ON CONFLICT (builtin_key) DO NOTHING;

INSERT INTO scripts (name, description, category, shell_type, is_builtin, builtin_key, code)
VALUES (
  'État BitLocker',
  'Affiche le statut de chiffrement et les protecteurs de clé (dont la recovery key) pour chaque volume.',
  'Sécurité', 'powershell', TRUE, 'sec_bitlocker_status',
  $script$try {
    $vols = Get-BitLockerVolume -ErrorAction Stop
    foreach ($v in $vols) {
        Write-Host "Volume $($v.MountPoint) : $($v.ProtectionStatus) — $($v.VolumeStatus)"
        foreach ($kp in $v.KeyProtector) {
            $line = "  Protecteur : $($kp.KeyProtectorType)"
            if ($kp.KeyProtectorType -eq 'RecoveryPassword') {
                $line += " | Recovery ID : $($kp.KeyProtectorId)"
                $line += " | Clé : $($kp.RecoveryPassword)"
            }
            Write-Host $line
        }
    }
} catch {
    "BitLocker non disponible ou droits insuffisants : $_"
}$script$
)
ON CONFLICT (builtin_key) DO NOTHING;
