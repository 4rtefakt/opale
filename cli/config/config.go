package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

type Config struct {
	Server    string     `json:"server"`
	Token     string     `json:"token"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"` // optionnel — set au login si l'API le renvoie
}

func Path() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "opale", "credentials")
}

// Load lit le fichier credentials. Retourne :
//   - (&Config{}, nil)        si le fichier n'existe pas (= non authentifié)
//   - (nil,        err)        si le fichier est illisible OU corrompu
//   - (&Config{…}, nil)        si le fichier est valide
//
// Le précédent comportement renvoyait (&Config{partial}, unmarshal-err) :
// les callers qui ignoraient l'erreur (`if err == nil { use cfg }`)
// continuaient leur chemin avec une config potentiellement partielle.
func Load() (*Config, error) {
	data, err := os.ReadFile(Path())
	if err != nil {
		if os.IsNotExist(err) {
			return &Config{}, nil
		}
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

func Save(c *Config) error {
	p := Path()
	if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
		return err
	}
	data, err := json.Marshal(c)
	if err != nil {
		return err
	}
	// 0600 = rw user only. Sur Windows ce mode est largement ignoré (NTFS
	// gère via ACLs) — documenté dans le README CLI. Pour un binaire admin
	// sur sa propre machine, acceptable.
	return os.WriteFile(p, data, 0600)
}

func Delete() error {
	err := os.Remove(Path())
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
