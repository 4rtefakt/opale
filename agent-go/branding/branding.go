// Package branding regroupe les valeurs build-time qui définissent
// l'identité physique de l'agent sur la machine cible : nom du Windows
// Service, nom du dossier ProgramData, nom du binaire, slug User-Agent.
//
// Ces variables sont injectées au link via -ldflags "-X ..." par le builder
// (cf. agent-go/build.js), ce qui permet de produire un binaire brandé sans
// recompiler le code source. Les défauts ci-dessous sont neutres "Opale" —
// chaque déploiement peut fournir ses propres valeurs via un profil de
// branding (cf. instance-local/agent-profile.json).
package branding

var (
	// ServiceName — nom du Windows Service installé. Utilisé par sc.exe
	// (create/config/start/stop) et par svc.Run côté agent.
	ServiceName = "Opale-Agent"

	// ServiceDisplayName — nom affiché dans services.msc.
	ServiceDisplayName = "Opale Agent"

	// ServiceDescription — description du Windows Service.
	ServiceDescription = "Agent Opale — checkin et auto-update."

	// DataDirName — nom du dossier sous %ProgramData% (Windows) ou
	// ~/.config/ (autre OS) qui contient config.json, state.json, le
	// binaire courant et ses backups.
	DataDirName = "Opale"

	// BinName — nom de base du binaire agent (sans extension).
	// L'extension .exe est ajoutée à la volée sur Windows.
	BinName = "opale-agent"

	// UserAgentSlug — préfixe du header User-Agent envoyé au serveur.
	// Le serveur l'utilise pour distinguer l'agent Go d'autres clients.
	UserAgentSlug = "opale-agent-go"

	// LAPSAccountDescription — description du compte local créé par
	// la rotation LAPS (visible dans lusrmgr.msc).
	LAPSAccountDescription = "Opale recovery account (LAPS-rotated)"

	// TempScriptPrefix — préfixe des fichiers temporaires PowerShell créés
	// pour exécuter les scripts à distance (os.CreateTemp pattern).
	TempScriptPrefix = "opale-"

	// LAPSDefaultUser — nom du compte local recovery par défaut, utilisé
	// au bootstrap avant que l'agent ne reçoive la valeur runtime du
	// serveur.
	LAPSDefaultUser = "opale-recovery"

	// LegacyDataDirName — si non-vide, l'agent cherche aussi un dossier
	// %ProgramData%\<LegacyDataDirName>\ et l'utilise s'il existe (compat
	// shim pour migrations d'instances historiques). Vide par défaut.
	// À injecter au build via -X branding.LegacyDataDirName=<nom>.
	LegacyDataDirName = ""
)
