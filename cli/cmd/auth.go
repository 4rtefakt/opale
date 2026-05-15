package cmd

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"time"

	"opale/cli/client"
	"opale/cli/config"
	"opale/cli/output"

	"github.com/spf13/cobra"
)

var authCmd = &cobra.Command{
	Use:   "auth",
	Short: "Authentification",
}

var authLoginCmd = &cobra.Command{
	Use:   "login",
	Short: "Ouvre le navigateur pour s'authentifier (MSAL PKCE + token CLI 90j)",
	RunE:  runAuthLogin,
}

var authStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Affiche l'identité et l'état du token courant",
	RunE:  runAuthStatus,
}

var authLogoutCmd = &cobra.Command{
	Use:   "logout",
	Short: "Supprime les credentials locaux",
	RunE:  runAuthLogout,
}

var (
	flagLoginServer string
	flagLoginLabel  string
)

func init() {
	authCmd.AddCommand(authLoginCmd, authStatusCmd, authLogoutCmd)
	authLoginCmd.Flags().StringVar(&flagLoginServer, "server", "", "URL du serveur Opale")
	authLoginCmd.Flags().StringVar(&flagLoginLabel, "label", "", "Label du token dans l'UI (défaut: hostname)")
}

func runAuthLogin(cmd *cobra.Command, args []string) error {
	server := coalesce(flagLoginServer, flagServer, os.Getenv("OPALE_SERVER"))
	if server == "" {
		if cfg, err := config.Load(); err == nil {
			server = cfg.Server
		}
	}
	if server == "" {
		return fmt.Errorf("serveur requis — utilisez --server https://opale.example.com")
	}
	var err error
	server, err = normalizeServer(server)
	if err != nil {
		return err
	}

	// Récupère la config OIDC depuis le serveur
	c := client.New(server, "")
	var ac struct {
		ClientID string `json:"client_id"`
		TenantID string `json:"tenant_id"`
	}
	if err := c.Get("/api/auth/config", &ac); err != nil {
		return fmt.Errorf("config OIDC du serveur : %w", err)
	}
	if ac.ClientID == "" || ac.TenantID == "" {
		return fmt.Errorf("config OIDC incomplète (ENTRA_CLIENT_ID / ENTRA_TENANT_ID non définis côté serveur)")
	}

	// PKCE
	verifier, challenge, err := pkceChallenge()
	if err != nil {
		return err
	}
	state := randomHex(16)

	// Port local éphémère
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("port local : %w", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	// Pas de path dans le redirect URI : Entra en "Mobile and desktop" ignore le
	// port pour localhost mais compare le path. http://localhost (sans path) est
	// enregistré → on envoie http://localhost:PORT (path implicite = /).
	redirectURI := fmt.Sprintf("http://localhost:%d", port)

	scope := url.QueryEscape(fmt.Sprintf("api://%s/access_as_user", ac.ClientID))
	authURL := fmt.Sprintf(
		"https://login.microsoftonline.com/%s/oauth2/v2.0/authorize"+
			"?client_id=%s&response_type=code&redirect_uri=%s"+
			"&scope=%s&code_challenge=%s&code_challenge_method=S256&state=%s",
		ac.TenantID, ac.ClientID, url.QueryEscape(redirectURI),
		scope, challenge, state,
	)

	output.Infof("Ouverture du navigateur pour l'authentification Entra…")
	fmt.Printf("  Si le navigateur ne s'ouvre pas : %s\n\n", authURL)
	openBrowser(authURL)

	// Attend le callback
	codeCh := make(chan string, 1)
	errCh  := make(chan error, 1)
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("state") != state {
			errCh <- fmt.Errorf("state invalide dans le callback OIDC")
			http.Error(w, "state invalide", 400)
			return
		}
		if e := q.Get("error"); e != "" {
			errCh <- fmt.Errorf("Entra : %s — %s", e, q.Get("error_description"))
			http.Error(w, "erreur d'authentification", 400)
			return
		}
		code := q.Get("code")
		if code == "" {
			errCh <- fmt.Errorf("code absent du callback")
			http.Error(w, "code manquant", 400)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<!doctype html><html><body style="font-family:sans-serif;padding:2rem;max-width:400px;margin:auto">
<h2>✅ Authentification réussie</h2>
<p>Vous pouvez fermer cet onglet et revenir au terminal.</p></body></html>`)
		codeCh <- code
	})}
	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	var code string
	select {
	case code = <-codeCh:
	case e := <-errCh:
		srv.Shutdown(context.Background())
		return e
	case <-ctx.Done():
		srv.Shutdown(context.Background())
		return fmt.Errorf("timeout : aucune réponse du navigateur après 5 minutes")
	}
	srv.Shutdown(context.Background())

	// Échange code PKCE → access_token Entra
	accessToken, err := exchangeCode(ac.TenantID, ac.ClientID, code, redirectURI, verifier)
	if err != nil {
		return fmt.Errorf("échange PKCE : %w", err)
	}

	// Échange JWT Entra → token CLI longue durée
	label := flagLoginLabel
	if label == "" {
		hn, _ := os.Hostname()
		label = "opale-cli on " + hn
	}
	auth := client.New(server, accessToken)
	var resp struct {
		Token     string     `json:"token"`
		ExpiresAt *time.Time `json:"expires_at"`
	}
	if err := auth.Post("/api/auth/cli-token", map[string]string{"label": label}, &resp); err != nil {
		return fmt.Errorf("création du token CLI : %w", err)
	}
	if err := config.Save(&config.Config{Server: server, Token: resp.Token, ExpiresAt: resp.ExpiresAt}); err != nil {
		return fmt.Errorf("sauvegarde credentials : %w", err)
	}

	output.Successf("Connecté à %s", server)
	if resp.ExpiresAt != nil {
		output.Infof("Token valide jusqu'au %s", resp.ExpiresAt.Format("2006-01-02"))
	}
	output.Infof("Credentials stockés dans %s", config.Path())
	return nil
}

func runAuthStatus(cmd *cobra.Command, args []string) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if cfg.Token == "" {
		fmt.Println("Non authentifié — lancez « opale auth login »")
		return nil
	}
	fmt.Printf("Serveur : %s\n", cfg.Server)
	// Préfixe `opl_` ou hex legacy : on ne montre que les 8 premiers chars
	// pour pouvoir identifier le token sans l'exposer.
	tlen := len(cfg.Token)
	if tlen > 8 {
		tlen = 8
	}
	fmt.Printf("Token   : %s…\n", cfg.Token[:tlen])
	if cfg.ExpiresAt != nil {
		d := time.Until(*cfg.ExpiresAt)
		if d <= 0 {
			fmt.Printf("Expiré  : %s (relancez « opale auth login »)\n", cfg.ExpiresAt.Format("2006-01-02"))
		} else {
			days := int(d.Hours() / 24)
			fmt.Printf("Expire  : %s (dans %d jours)\n", cfg.ExpiresAt.Format("2006-01-02"), days)
		}
	}
	return nil
}

func runAuthLogout(cmd *cobra.Command, args []string) error {
	if err := config.Delete(); err != nil {
		return err
	}
	output.Successf("Credentials supprimés")
	return nil
}

// ── PKCE helpers ──────────────────────────────────────────────────────────────

func pkceChallenge() (verifier, challenge string, err error) {
	b := make([]byte, 32)
	if _, err = rand.Read(b); err != nil {
		return
	}
	verifier = base64.RawURLEncoding.EncodeToString(b)
	h := sha256.Sum256([]byte(verifier))
	challenge = base64.RawURLEncoding.EncodeToString(h[:])
	return
}

func randomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return fmt.Sprintf("%x", b)
}

func openBrowser(u string) {
	var c *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		c = exec.Command("open", u)
	case "windows":
		c = exec.Command("rundll32", "url.dll,FileProtocolHandler", u)
	default:
		c = exec.Command("xdg-open", u)
	}
	_ = c.Start()
}

func exchangeCode(tenantID, clientID, code, redirectURI, verifier string) (string, error) {
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"client_id":     {clientID},
		"code":          {code},
		"redirect_uri":  {redirectURI},
		"code_verifier": {verifier},
	}
	endpoint := fmt.Sprintf("https://login.microsoftonline.com/%s/oauth2/v2.0/token", tenantID)
	// Client dédié avec timeout : http.DefaultClient n'a pas de timeout
	// → un Entra qui ne répond pas bloquerait le login indéfiniment.
	httpc := &http.Client{Timeout: 30 * time.Second}
	resp, err := httpc.PostForm(endpoint, form)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var tok struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
		Description string `json:"error_description"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tok); err != nil {
		return "", err
	}
	if tok.Error != "" {
		return "", fmt.Errorf("%s: %s", tok.Error, tok.Description)
	}
	if tok.AccessToken == "" {
		return "", fmt.Errorf("access_token absent de la réponse Entra")
	}
	return tok.AccessToken, nil
}

// min(a, b int) builtin disponible en Go 1.22 — la version locale a été
// retirée. Le check d'expiration utilise désormais time.Until directement.

