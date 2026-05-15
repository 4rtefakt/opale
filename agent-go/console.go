package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"sync"
)

// Multiplexage des sessions console-via-agent sur le tube WS persistant.
// La spawn d'un ConPTY est OS-dependent (cf. console_windows.go) ; la
// gestion des sessions et le bridge WS ↔ PTY sont cross-platform.

const (
	consoleReadBufBytes = 16 * 1024
	consoleMaxCols      = 1000
	consoleMaxRows      = 1000
)

// consolePTY abstrait un pseudo-terminal selon l'OS. Sur Windows c'est un
// ConPTY ; sur les autres OS c'est un stub qui retourne immédiatement une
// erreur à l'open (la capability "console" n'est annoncée que sur Windows,
// donc le serveur n'enverra jamais console.open à un agent non-Windows en
// pratique, mais la défense en profondeur ne coûte rien).
type consolePTY interface {
	io.ReadWriteCloser
	Resize(cols, rows uint16) error
	PID() int
}

// consoleSession — l'état serveur côté agent pour une session active.
type consoleSession struct {
	id     string
	pty    consolePTY
	cancel context.CancelFunc  // annule la goroutine read PTY
}

// consoleManager — registre des sessions actives. Une seule instance par
// connexion WS (recréée à chaque reconnect ; quand le tube tombe, toutes
// les sessions sont killed).
type consoleManager struct {
	mu       sync.Mutex
	sessions map[string]*consoleSession
	writer   *wsWriter
}

func newConsoleManager(w *wsWriter) *consoleManager {
	return &consoleManager{
		sessions: map[string]*consoleSession{},
		writer:   w,
	}
}

// dispatch — appelé par la read loop de runWSSession quand la frame est
// console.*. Le ctx est celui de la session WS.
func (m *consoleManager) dispatch(ctx context.Context, fr wsFrame) {
	if fr.ID == nil || *fr.ID == "" {
		logWarn("console-frame-no-id", "", LogFields{"type": fr.Type})
		return
	}
	id := *fr.ID
	switch fr.Type {
	case "console.open":
		m.openSession(ctx, id, fr.Data)
	case "console.input":
		m.handleInput(id, fr.Data)
	case "console.resize":
		m.handleResize(id, fr.Data)
	case "console.close":
		m.closeSession(id, "server-close")
	}
}

type openParams struct {
	Shell string `json:"shell"`
	Cols  uint16 `json:"cols"`
	Rows  uint16 `json:"rows"`
}

func (m *consoleManager) openSession(ctx context.Context, id string, data json.RawMessage) {
	var p openParams
	_ = json.Unmarshal(data, &p)
	if p.Cols == 0 || p.Cols > consoleMaxCols {
		p.Cols = 80
	}
	if p.Rows == 0 || p.Rows > consoleMaxRows {
		p.Rows = 24
	}
	if p.Shell == "" {
		p.Shell = "powershell.exe"
	}

	m.mu.Lock()
	if _, exists := m.sessions[id]; exists {
		m.mu.Unlock()
		m.sendError(id, "session déjà ouverte avec cet id")
		return
	}
	m.mu.Unlock()

	pty, err := spawnConsole(p.Shell, p.Cols, p.Rows)
	if err != nil {
		logWarn("console-open-fail", "", LogFields{"session_id": id, "error": err.Error()})
		m.sendError(id, err.Error())
		return
	}

	sessCtx, cancel := context.WithCancel(ctx)
	s := &consoleSession{id: id, pty: pty, cancel: cancel}

	m.mu.Lock()
	m.sessions[id] = s
	m.mu.Unlock()

	logInfo("console-opened", "", LogFields{
		"session_id": id, "shell": p.Shell, "pid": pty.PID(),
		"cols": p.Cols, "rows": p.Rows,
	})

	// Notifie le serveur que la session est prête (porte le PID pour audit).
	openedData, _ := json.Marshal(map[string]any{"pid": pty.PID()})
	_ = m.writer.write(sessCtx, "console.opened", id, openedData)

	// Toast utilisateur — RGPD : on alerte la session interactive qu'un
	// admin a ouvert une console. Non bloquant (msg.exe peut être absent
	// sur Home, ou aucune session user connectée).
	go notifyConsoleOpened(id)

	// Read loop : stream stdout du PTY vers le serveur.
	go m.pumpPTY(sessCtx, s)
}

func (m *consoleManager) pumpPTY(ctx context.Context, s *consoleSession) {
	buf := make([]byte, consoleReadBufBytes)
	for {
		n, err := s.pty.Read(buf)
		if n > 0 {
			payload, _ := json.Marshal(map[string]any{
				"b64": base64.StdEncoding.EncodeToString(buf[:n]),
			})
			if werr := m.writer.write(ctx, "console.data", s.id, payload); werr != nil {
				// WS down ou ctx annulé. Inutile de continuer ; la session
				// sera close par closeAll au retour de runWSSession.
				return
			}
		}
		if err != nil {
			// EOF = process terminé, autre erreur = PTY crash.
			reason := "exit"
			if !errors.Is(err, io.EOF) {
				reason = err.Error()
			}
			exitData, _ := json.Marshal(map[string]any{"reason": reason})
			_ = m.writer.write(ctx, "console.exit", s.id, exitData)
			m.removeSession(s.id, "pty-eof")
			return
		}
	}
}

func (m *consoleManager) handleInput(id string, data json.RawMessage) {
	m.mu.Lock()
	s, ok := m.sessions[id]
	m.mu.Unlock()
	if !ok {
		return
	}
	var p struct {
		B64 string `json:"b64"`
	}
	if err := json.Unmarshal(data, &p); err != nil || p.B64 == "" {
		return
	}
	raw, err := base64.StdEncoding.DecodeString(p.B64)
	if err != nil {
		return
	}
	if _, err := s.pty.Write(raw); err != nil {
		logWarn("console-input-write-fail", "", LogFields{"session_id": id, "error": err.Error()})
	}
}

func (m *consoleManager) handleResize(id string, data json.RawMessage) {
	m.mu.Lock()
	s, ok := m.sessions[id]
	m.mu.Unlock()
	if !ok {
		return
	}
	var p struct {
		Cols uint16 `json:"cols"`
		Rows uint16 `json:"rows"`
	}
	if err := json.Unmarshal(data, &p); err != nil {
		return
	}
	if p.Cols == 0 || p.Cols > consoleMaxCols || p.Rows == 0 || p.Rows > consoleMaxRows {
		return
	}
	if err := s.pty.Resize(p.Cols, p.Rows); err != nil {
		logWarn("console-resize-fail", "", LogFields{"session_id": id, "error": err.Error()})
	}
}

// closeSession — initié par le serveur (console.close) ou interne.
func (m *consoleManager) closeSession(id, reason string) {
	m.removeSession(id, reason)
}

func (m *consoleManager) removeSession(id, reason string) {
	m.mu.Lock()
	s, ok := m.sessions[id]
	if ok {
		delete(m.sessions, id)
	}
	m.mu.Unlock()
	if !ok {
		return
	}
	s.cancel()
	if err := s.pty.Close(); err != nil {
		logWarn("console-pty-close-fail", "", LogFields{"session_id": id, "error": err.Error()})
	}
	logInfo("console-closed", "", LogFields{"session_id": id, "reason": reason})
}

// closeAll — appelé par runWSSession au retour. Kill toutes les sessions
// car le ConPTY ne sait pas que le tube est tombé ; sinon on laisserait des
// shells SYSTEM zombies sur le poste.
func (m *consoleManager) closeAll(reason string) {
	m.mu.Lock()
	ids := make([]string, 0, len(m.sessions))
	for id := range m.sessions {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		m.removeSession(id, reason)
	}
}

func (m *consoleManager) sendError(id, msg string) {
	payload, _ := json.Marshal(map[string]any{"message": msg})
	_ = m.writer.write(context.Background(), "console.error", id, payload)
}
