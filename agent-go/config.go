package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/4rtefakt/opale/agent-go/branding"
)

// Config — contenu du config.json (chemin retourné par configPath()).
// Ce fichier est lu au démarrage et après chaque rotation de token.
type Config struct {
	Token string `json:"token"`
	URL   string `json:"url"`

	// LAPSEnabled : si false (défaut), la rotation du mot de passe local
	// admin est désactivée. À activer explicitement pour ne pas
	// surprendre l'admin après upgrade.
	LAPSEnabled bool `json:"laps_enabled,omitempty"`
	// LAPSUser : compte local DÉDIÉ rotaté. Ne PAS pointer sur
	// "Administrator" ou un compte existant pour éviter tout lockout.
	// Créé automatiquement par l'agent à la première rotation.
	LAPSUser string `json:"laps_user,omitempty"`
}

// lapsUser — wrapper qui délègue à ResolveLAPSUser : valeur runtime servie
// par /api/agent/runtime-config en priorité, puis cfg.LAPSUser, puis
// branding.LAPSDefaultUser. Voir runtime_config.go pour la cascade complète.
func (c *Config) lapsUser() string {
	return ResolveLAPSUser(c)
}

// dataDir retourne le répertoire qui contient config.json, state.json et
// le binaire agent. Cascade Windows :
//
//  1. Override explicite via $RMM_DATA_DIR (utile pour les tests / migration).
//  2. %ProgramData%\<branding.DataDirName>\ — chemin canonique par instance.
//  3. Fallback %ProgramData%\<branding.LegacyDataDirName>\ si défini et
//     présent (compat shim opt-in pour migrations d'instances historiques).
//     Vide par défaut → branche désactivée.
//  4. À défaut, le chemin canonique (peut être créé par l'installer).
func dataDir() string {
	if runtime.GOOS == "windows" {
		if override := os.Getenv("RMM_DATA_DIR"); override != "" {
			return override
		}
		pd := os.Getenv("ProgramData")
		if pd == "" {
			pd = `C:\ProgramData`
		}
		canonical := filepath.Join(pd, branding.DataDirName)
		if dirExists(canonical) {
			return canonical
		}
		if branding.LegacyDataDirName != "" && branding.LegacyDataDirName != branding.DataDirName {
			legacy := filepath.Join(pd, branding.LegacyDataDirName)
			if dirExists(legacy) {
				logWarn("legacy-datadir", "ancien dossier "+branding.LegacyDataDirName+" détecté — réinstaller l'agent pour migrer", LogFields{
					"legacy":    legacy,
					"canonical": canonical,
				})
				return legacy
			}
		}
		return canonical
	}
	if override := os.Getenv("RMM_DATA_DIR"); override != "" {
		return override
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", strings.ToLower(branding.DataDirName))
}

func dirExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

func configPath() string { return filepath.Join(dataDir(), "config.json") }
func statePath() string  { return filepath.Join(dataDir(), "state.json") }
func binaryPath() string { return filepath.Join(dataDir(), agentExeName()) }
func backupPath() string { return filepath.Join(dataDir(), agentBackupName()) }
func newBinPath() string { return filepath.Join(dataDir(), agentNewName()) }

func agentExeName() string {
	if runtime.GOOS == "windows" {
		return branding.BinName + ".exe"
	}
	return branding.BinName
}

func agentBackupName() string {
	if runtime.GOOS == "windows" {
		return branding.BinName + ".bak.exe"
	}
	return branding.BinName + ".bak"
}

func agentNewName() string {
	if runtime.GOOS == "windows" {
		return branding.BinName + ".new.exe"
	}
	return branding.BinName + ".new"
}

// Save écrit la config sur disque atomiquement (fichier .new + rename).
// Permissions strictes 0600 — Windows ignore le mode mais l'ACL du dossier
// data dir reste SYSTEM-only via install.ps1.
func (c *Config) Save() error {
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal : %w", err)
	}
	tmp := configPath() + ".new"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("write %s : %w", tmp, err)
	}
	if err := os.Rename(tmp, configPath()); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename : %w", err)
	}
	return nil
}

// LoadConfig lit et valide le fichier de config. Retourne une erreur claire
// si le fichier est manquant ou si l'URL/token sont invalides — l'agent
// refuse de démarrer dans tous les cas (pas de fallback silencieux).
func LoadConfig() (*Config, error) {
	p := configPath()
	raw, err := os.ReadFile(p)
	if err != nil {
		return nil, fmt.Errorf("lecture %s : %w", p, err)
	}
	var c Config
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("config JSON invalide (%s) : %w", p, err)
	}
	if c.Token == "" {
		return nil, errors.New("config.json : token manquant")
	}
	if c.URL == "" {
		return nil, errors.New("config.json : url manquante")
	}
	if !strings.HasPrefix(c.URL, "https://") {
		return nil, fmt.Errorf("config.json : url doit être en https:// (reçu %q)", c.URL)
	}
	c.URL = strings.TrimRight(c.URL, "/")
	c.URL = strings.TrimSuffix(c.URL, "/api")
	return &c, nil
}
