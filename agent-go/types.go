package main

// Payload du POST /api/agent/checkin — strictement compatible avec le
// schéma attendu par api/routes/agent.js (voir branche checkin).
type CheckinPayload struct {
	Hostname          string             `json:"hostname"`
	Serial            string             `json:"serial,omitempty"`
	Model             string             `json:"model,omitempty"`
	Manufacturer      string             `json:"manufacturer,omitempty"`
	CPU               string             `json:"cpu,omitempty"`
	RAMGB             int                `json:"ram_gb,omitempty"`
	OS                string             `json:"os,omitempty"`
	OSBuild           string             `json:"os_build,omitempty"`
	BIOSVersion       string             `json:"bios_version,omitempty"`
	IPNetbird         string             `json:"ip_netbird,omitempty"`
	Disks             []Disk             `json:"disks"`
	Network           []NetIface         `json:"network"`
	Bandwidth         []BandwidthSample  `json:"bandwidth"`
	// Ping est un tableau pour matcher la branche `Array.isArray(_ping)`
	// de api/routes/agent.js (le payload PS envoyait déjà un array).
	Ping              []PingStats        `json:"ping"`
	AgentVersion      string             `json:"agent_version"`
	DeploymentResults []DeploymentResult `json:"deployment_results"`
	DetectionResults  []DetectionResult  `json:"detection_results"`
	Health            *HealthSignals     `json:"health,omitempty"`
	Tamper            *TamperReport      `json:"tamper,omitempty"`
	SystemInfo        *SystemInfo        `json:"system_info,omitempty"`
	SystemPerf        *SystemPerf        `json:"system_perf,omitempty"`
}

// TamperReport — remonté à chaque checkin si le hash du binaire courant
// ne match pas le baseline en state. Le serveur logge en audit_logs.
type TamperReport struct {
	Expected   string `json:"expected"`
	Actual     string `json:"actual"`
	DetectedAt string `json:"detected_at"` // RFC3339
}

type Disk struct {
	Letter  string  `json:"letter"`
	Label   string  `json:"label,omitempty"`
	SizeGB  float64 `json:"size_gb"`
	UsedPct float64 `json:"used_pct"`
}

type NetIface struct {
	MAC     string `json:"mac"`
	IP      string `json:"ip,omitempty"`
	Adapter string `json:"adapter,omitempty"`
	Type    string `json:"type"` // "eth" | "wifi" | "netbird"
}

type BandwidthSample struct {
	Adapter   string `json:"adapter"`
	BytesSent uint64 `json:"bytes_sent"`
	BytesRecv uint64 `json:"bytes_recv"`
}

type PingStats struct {
	Host          string   `json:"host"`
	LatencyMs     *float64 `json:"latency_ms"`
	PacketLossPct int      `json:"packet_loss_pct"`
}

type DeploymentResult struct {
	DeploymentID string `json:"deployment_id"`
	ExitCode     int    `json:"exit_code"`
	Output       string `json:"output"`
}

type DetectionResult struct {
	PackageID string `json:"package_id"`
	Detected  bool   `json:"detected"`
}

// HealthSignals — état de santé OS, sécurité, maintenance. Stocké en
// JSONB côté API ; toute clé absente = donnée non collectée (vs valeur
// false explicite). Pointeurs partout pour distinguer "off" de "inconnu".
type HealthSignals struct {
	BitLocker     *BitLockerState `json:"bitlocker,omitempty"`
	Defender      *DefenderState  `json:"defender,omitempty"`
	Firewall      *FirewallState  `json:"firewall,omitempty"`
	TPMPresent    *bool           `json:"tpm_present,omitempty"`
	PendingReboot *bool           `json:"pending_reboot,omitempty"`
	LastWinUpdate *string         `json:"last_windows_update,omitempty"` // YYYY-MM-DD
}

type BitLockerState struct {
	Volume           string `json:"volume"`
	Enabled          bool   `json:"enabled"`
	ProtectionStatus string `json:"protection_status"` // "on" / "off"
	EncryptionMethod string `json:"encryption_method,omitempty"`
}

type DefenderState struct {
	AntivirusEnabled       bool    `json:"antivirus_enabled"`
	RealTimeProtection     bool    `json:"realtime_protection"`
	AntispywareEnabled     bool    `json:"antispyware_enabled"`
	SignatureLastUpdate    *string `json:"signature_last_update,omitempty"` // YYYY-MM-DD
	SignatureAgeDays       *int    `json:"signature_age_days,omitempty"`
	// Threats history — pour spotter un poste qui chope régulièrement des
	// malware (cible privilégiée ou utilisateur à risque).
	ThreatsLast30d         *int    `json:"threats_last_30d,omitempty"`
	LastThreatAt           *string `json:"last_threat_at,omitempty"`        // YYYY-MM-DD
}

type FirewallState struct {
	DomainEnabled  bool `json:"domain_enabled"`
	PrivateEnabled bool `json:"private_enabled"`
	PublicEnabled  bool `json:"public_enabled"`
}

// SystemInfo — informations matérielles + système qui changent rarement.
// Stocké en JSONB sur devices, rafraîchi à chaque checkin (COALESCE).
type SystemInfo struct {
	Cores         int            `json:"cores,omitempty"`           // cœurs physiques
	Threads       int            `json:"threads,omitempty"`         // logical processors
	CPUMHz        int            `json:"cpu_mhz,omitempty"`         // base clock
	Mainboard     *Mainboard     `json:"mainboard,omitempty"`
	GPUs          []GPU          `json:"gpus,omitempty"`
	MonitorsCount int            `json:"monitors_count,omitempty"`
	CurrentUser   string         `json:"current_user,omitempty"`    // null = personne loggué localement
	BatteryHealth *BatteryHealth `json:"battery_health,omitempty"`
}

// BatteryHealth — capacité actuelle vs design + cycles, via IOCTL_BATTERY.
// Métrique slow-changing (semaines/mois), donc dans system_info.
type BatteryHealth struct {
	HealthPct      float64 `json:"health_pct"`                 // FullCharged / Designed * 100
	DesignedMWh    uint32  `json:"designed_mwh,omitempty"`     // capacité de design (mWh ou mAh selon firmware)
	FullChargeMWh  uint32  `json:"full_charge_mwh,omitempty"`  // capacité actuelle
	CycleCount     uint32  `json:"cycle_count,omitempty"`      // 0 si firmware ne le remonte pas
	Chemistry      string  `json:"chemistry,omitempty"`        // "LION", "NiMH"…
}

type Mainboard struct {
	Manufacturer string `json:"manufacturer,omitempty"`
	Product      string `json:"product,omitempty"`
	SerialNumber string `json:"serial,omitempty"`
}

type GPU struct {
	Name          string `json:"name"`
	DriverVersion string `json:"driver_version,omitempty"`
	DriverDate    string `json:"driver_date,omitempty"`
}

// SystemPerf — métriques de perf instantanées + uptime, stockées en
// time-series. Cleanup à 7j comme bandwidth/ping.
type SystemPerf struct {
	RAMUsedGB       float64 `json:"ram_used_gb"`
	RAMTotalGB      float64 `json:"ram_total_gb"`
	RAMUsedPct      float64 `json:"ram_used_pct"`
	CPUAvgPct       float64 `json:"cpu_avg_pct"`            // moyenne sur tous les cores et la fenêtre de sample
	CPUMaxPct       float64 `json:"cpu_max_pct"`            // max single-core sur la fenêtre — utile pour spotter un thread saturé
	UptimeSeconds   int64   `json:"uptime_seconds"`
	BatteryPct      *int    `json:"battery_pct,omitempty"`  // nil = pas de batterie (desktop)
	BatteryStatus   string  `json:"battery_status,omitempty"` // "ac" | "charging" | "discharging" | "full" | "low" | "critical"
}

// Réponse au checkin.
type CheckinResponse struct {
	OK                bool               `json:"ok"`
	DeviceID          string             `json:"device_id"`
	New               bool               `json:"new"`
	Commands          []Command          `json:"commands"`
	Deployments       []Deployment       `json:"deployments"`
	Detect            []Detect           `json:"detect"`
	AgentUpdate       *AgentUpdate       `json:"agent_update"`
	MaintenanceWindow *MaintenanceWindow `json:"maintenance_window,omitempty"`
}

type Command struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Script string `json:"script"`
}

type Deployment struct {
	DeploymentID      string `json:"deployment_id"`
	Name              string `json:"name"`
	Type              string `json:"type"`
	WingetID          string `json:"winget_id"`
	InstallScript     string `json:"install_script"`
	PostInstallScript string `json:"post_install_script"`
	DetectionScript   string `json:"detection_script"`
}

type Detect struct {
	PackageID       string `json:"package_id"`
	DetectionScript string `json:"detection_script"`
}

// AgentUpdate — instruction de mise à jour. Si SHA256 ou Signature manquent,
// l'agent doit refuser l'update (sécurité).
type AgentUpdate struct {
	LatestVersion string `json:"latest_version"`
	DownloadURL   string `json:"download_url"`
	SHA256        string `json:"sha256"`
	Signature     string `json:"signature_ed25519"` // base64 standard
}
