package cmd

import (
	"fmt"
	"os"
	"strings"

	"opale/cli/client"
	"opale/cli/config"
	"opale/cli/output"

	"github.com/spf13/cobra"
)

var (
	flagServer        string
	flagToken         string
	flagJSON          bool
	flagNoColor       bool
	flagAllowInsecure bool
)

var rootCmd = &cobra.Command{
	Use:   "opale",
	Short: "CLI pour Opale",
	Long:  "Outil en ligne de commande pour administrer Opale sans ouvrir le navigateur.",
	PersistentPreRun: func(cmd *cobra.Command, args []string) {
		output.JSON    = flagJSON
		output.NoColor = flagNoColor || os.Getenv("NO_COLOR") != ""
	},
	SilenceUsage: true,
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}

func init() {
	rootCmd.PersistentFlags().StringVar(&flagServer,         "server",                "",    "URL du serveur (ex: https://opale.example.com) ou OPALE_SERVER")
	rootCmd.PersistentFlags().StringVar(&flagToken,          "token",                 "",    "Token API ou OPALE_TOKEN")
	rootCmd.PersistentFlags().BoolVar(&flagJSON,             "json",                  false, "Sortie JSON brute")
	rootCmd.PersistentFlags().BoolVar(&flagNoColor,          "no-color",              false, "Désactive les couleurs ANSI")
	rootCmd.PersistentFlags().BoolVar(&flagAllowInsecure,    "allow-insecure-server", false, "Autorise un serveur http:// (dev local uniquement — JAMAIS en prod)")

	rootCmd.AddCommand(authCmd)
	rootCmd.AddCommand(devicesCmd)
	rootCmd.AddCommand(ticketsCmd)
	rootCmd.AddCommand(auditCmd)
	rootCmd.AddCommand(consoleCmd)
	rootCmd.AddCommand(sshCmd)
	rootCmd.AddCommand(scriptsCmd)
	rootCmd.AddCommand(alertsCmd)
	rootCmd.AddCommand(complianceCmd)
	rootCmd.AddCommand(tokensCmd)
	rootCmd.AddCommand(appsCmd)
	rootCmd.AddCommand(completionCmd)
}

// getClient resolves credentials (flag > env > credentials file) and returns a client.
func getClient() (*client.Client, error) {
	token  := coalesce(flagToken, os.Getenv("OPALE_TOKEN"))
	server := coalesce(flagServer, os.Getenv("OPALE_SERVER"))

	if token == "" || server == "" {
		cfg, err := config.Load()
		if err != nil {
			return nil, fmt.Errorf("lecture credentials : %w", err)
		}
		if token == "" {
			token = cfg.Token
		}
		if server == "" {
			server = cfg.Server
		}
	}

	if token == "" {
		return nil, fmt.Errorf("token manquant — lancez « opale auth login » ou définissez OPALE_TOKEN")
	}
	if server == "" {
		return nil, fmt.Errorf("serveur manquant — lancez « opale auth login » ou définissez OPALE_SERVER")
	}

	normalized, err := normalizeServer(server)
	if err != nil {
		return nil, err
	}
	return client.New(normalized, token), nil
}

// normalizeServer canonicalise une URL serveur. Refuse `http://` non
// explicitement flagué via --allow-insecure-server pour éviter d'envoyer
// des secrets (token CLI, motif de session) en clair par erreur.
func normalizeServer(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", fmt.Errorf("URL serveur vide")
	}
	// Ajoute https:// implicite si pas de schéma — l'utilisateur tape
	// `--server opale.example.com` et c'est interprété en TLS strict.
	if !strings.HasPrefix(s, "http://") && !strings.HasPrefix(s, "https://") {
		s = "https://" + s
	}
	if strings.HasPrefix(s, "http://") && !flagAllowInsecure {
		return "", fmt.Errorf("serveur http:// refusé pour éviter de fuiter les credentials en clair " +
			"(utilisez --allow-insecure-server pour le dev local)")
	}
	return strings.TrimRight(s, "/"), nil
}

func coalesce(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
