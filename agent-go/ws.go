package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"net/url"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Canal de contrôle long-lived agent ↔ serveur. Pendant que la boucle
// runCheckin continue son polling 15min, runWSClient maintient en parallèle
// une connexion WS qui sert :
//   - en PR 1 : heartbeat + advertise capabilities (rien d'utilisateur-visible)
//   - en PR 2 : à porter la console interactive
//
// La sécurité est la même que l'HTTP : TLS strict, pinning SPKI hérité,
// Bearer token dans le header HTTP Upgrade (pas en query string).
//
// Reconnect avec backoff exponentiel + jitter, plafonné à 60s. Compteur
// remis à zéro après 5min de session stable pour éviter qu'un flap réseau
// long laisse l'agent en backoff max.

const (
	wsBackoffMin   = 1 * time.Second
	wsBackoffMax   = 60 * time.Second
	wsStableReset  = 5 * time.Minute
	wsDialTimeout  = 30 * time.Second
	wsReadLimit    = 64 * 1024  // miroir de WS_FRAME_MAX_BYTES côté serveur
	wsWriteTimeout = 10 * time.Second
)

// wsFrame — format JSON sur le fil { type, id, data }. `id` n'est utilisé
// qu'à partir de PR 2 pour multiplexer les sessions console.
type wsFrame struct {
	Type string          `json:"type"`
	ID   *string         `json:"id,omitempty"`
	Data json.RawMessage `json:"data,omitempty"`
}

// wsCapabilities — ce que l'agent annonce dans `hello`. Délègue à une fonction
// platform-specific (cf. console_windows.go / console_other.go) : "console"
// n'est annoncée que sur Windows où ConPTY est disponible.
func wsCapabilities() []string {
	return wsCapabilitiesPlatform()
}

// wsWriter sérialise les c.Write entre la read-loop (qui répond au ping) et
// les goroutines PTY (qui streament console.data). coder/websocket interdit
// les Write concurrents — on prend un mutex unique.
type wsWriter struct {
	c  *websocket.Conn
	mu sync.Mutex
}

func (w *wsWriter) write(ctx context.Context, t, id string, data json.RawMessage) error {
	payload := map[string]any{"type": t}
	if id != "" {
		payload["id"] = id
	}
	if len(data) > 0 {
		payload["data"] = data
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	wctx, cancel := context.WithTimeout(ctx, wsWriteTimeout)
	defer cancel()
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.c.Write(wctx, websocket.MessageText, raw)
}

// RunWSClient — boucle de reconnect infinie, jusqu'à annulation du ctx.
// À lancer en goroutine au démarrage de l'agent (mode service ET --debug).
func RunWSClient(ctx context.Context, cfg *Config) {
	backoff := wsBackoffMin
	for {
		if err := ctx.Err(); err != nil {
			return
		}

		connectedAt := time.Now()
		err := runWSSession(ctx, cfg)
		uptime := time.Since(connectedAt)

		if err := ctx.Err(); err != nil {
			return
		}

		// Connexion stable suffisamment longtemps ⇒ on reset le backoff
		// pour qu'un flap après plusieurs heures ne reparte pas à 60s.
		if uptime > wsStableReset {
			backoff = wsBackoffMin
		}

		logWarn("ws-session-end", "", LogFields{
			"error":     errString(err),
			"uptime_ms": uptime.Milliseconds(),
			"backoff_s": int(backoff.Seconds()),
		})

		// Jitter ±20% pour éviter qu'un fan-out de N agents reconnecte
		// en phase après un restart serveur.
		jitter := time.Duration(rand.Int64N(int64(backoff/5) + 1))
		sleep := backoff - backoff/10 + jitter
		select {
		case <-time.After(sleep):
		case <-ctx.Done():
			return
		}
		if backoff < wsBackoffMax {
			backoff *= 2
			if backoff > wsBackoffMax {
				backoff = wsBackoffMax
			}
		}
	}
}

// runWSSession — une seule connexion, vit jusqu'à erreur ou cancel. Retourne
// l'erreur pour que le caller décide du backoff.
func runWSSession(ctx context.Context, cfg *Config) error {
	wsURL, err := buildWSURL(cfg.URL)
	if err != nil {
		return fmt.Errorf("build url : %w", err)
	}

	// TLS identique au httpClient : MinVersion 1.2, pinning SPKI via
	// VerifyPeerCertificate, jamais d'InsecureSkipVerify. On instancie un
	// http.Client dédié plutôt que de réutiliser httpClient car coder/websocket
	// désactive le Timeout pour les connexions long-lived (sinon le Dial
	// hérite du timeout 30s qui couperait la session).
	httpC := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				MinVersion:            tls.VersionTLS12,
				VerifyPeerCertificate: verifyPeerSPKI,
			},
		},
	}

	hdr := http.Header{}
	hdr.Set("Authorization", "Bearer "+cfg.Token)
	hdr.Set("User-Agent", userAgent())

	dialCtx, cancel := context.WithTimeout(ctx, wsDialTimeout)
	defer cancel()

	c, _, err := websocket.Dial(dialCtx, wsURL, &websocket.DialOptions{
		HTTPClient: httpC,
		HTTPHeader: hdr,
	})
	if err != nil {
		return fmt.Errorf("dial : %w", err)
	}
	// coder/websocket gère le body de la réponse Upgrade ; ne pas y toucher.
	// CloseNow est idempotent — sûr même si on Close proprement avant.
	defer c.CloseNow()

	c.SetReadLimit(wsReadLimit)

	writer := &wsWriter{c: c}
	mgr := newConsoleManager(writer)
	// Kill toutes les sessions console si le tube tombe : un ConPTY orphelin
	// laisserait un shell SYSTEM en cours d'exécution sans interlocuteur.
	defer mgr.closeAll("ws-disconnect")

	logInfo("ws-connected", "", LogFields{"url": wsURL})

	// Envoi du hello dès l'ouverture. C'est ce qui fait passer la conn de
	// "anonyme" à "qualifiée" côté serveur (capabilities, version).
	helloData, _ := json.Marshal(map[string]any{
		"agent_version": AgentVersion,
		"os":            runtime.GOOS,
		"arch":          runtime.GOARCH,
		"capabilities":  wsCapabilities(),
	})
	if err := writer.write(ctx, "hello", "", helloData); err != nil {
		return fmt.Errorf("send hello : %w", err)
	}

	for {
		if err := ctx.Err(); err != nil {
			// Tentative de close propre — best-effort, on a CloseNow en defer.
			_ = c.Close(websocket.StatusNormalClosure, "shutdown")
			return err
		}
		_, raw, err := c.Read(ctx)
		if err != nil {
			return fmt.Errorf("read : %w", err)
		}
		var fr wsFrame
		if err := json.Unmarshal(raw, &fr); err != nil {
			logWarn("ws-bad-frame", "", LogFields{"error": err.Error()})
			continue
		}
		switch fr.Type {
		case "welcome":
			logInfo("ws-welcome", "", nil)
		case "ping":
			pongData, _ := json.Marshal(map[string]any{"ts": time.Now().UnixMilli()})
			if err := writer.write(ctx, "pong", "", pongData); err != nil {
				return fmt.Errorf("send pong : %w", err)
			}
		case "pong":
		case "bye":
			logInfo("ws-server-bye", "", nil)
			_ = c.Close(websocket.StatusNormalClosure, "client-bye")
			return errors.New("server sent bye")
		case "console.open", "console.input", "console.resize", "console.close":
			mgr.dispatch(ctx, fr)
		default:
			// Type inconnu : ignore (forward-compat pour quand le serveur
			// commence à émettre des frames d'une version plus récente).
		}
	}
}

// buildWSURL — `https://host/api` → `wss://host/api/agent/ws`. Le LoadConfig
// trim déjà le trailing `/api`, mais on tolère sa présence ici pour rester
// robuste à un éventuel skip du Load (tests).
func buildWSURL(httpURL string) (string, error) {
	u, err := url.Parse(httpURL)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		// Autorisé uniquement pour les tests (httptest.Server). LoadConfig
		// refuse http:// en production.
		u.Scheme = "ws"
	default:
		return "", fmt.Errorf("scheme inattendu : %q", u.Scheme)
	}
	u.Path = strings.TrimSuffix(strings.TrimRight(u.Path, "/"), "/api") + "/api/agent/ws"
	return u.String(), nil
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
