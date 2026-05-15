package cmd

import (
	"fmt"
	"time"

	"opale/cli/output"

	"github.com/spf13/cobra"
)

var tokensCmd = &cobra.Command{
	Use:   "tokens",
	Short: "Tokens CLI",
}

var tokensLsCmd = &cobra.Command{
	Use:   "ls",
	Short: "Liste les tokens CLI actifs",
	RunE:  runTokensLs,
}

var tokensRevokeCmd = &cobra.Command{
	Use:               "revoke <id>",
	Short:             "Révoque un token CLI",
	Args:              cobra.ExactArgs(1),
	RunE:              runTokensRevoke,
	ValidArgsFunction: completeTokens,
}

func init() {
	tokensCmd.AddCommand(tokensLsCmd, tokensRevokeCmd)
}

func runTokensLs(cmd *cobra.Command, args []string) error {
	c, err := getClient()
	if err != nil {
		return err
	}
	var settings struct {
		CLITokens []map[string]any `json:"cli_tokens"`
	}
	if err := c.Get("/api/settings", &settings); err != nil {
		return err
	}
	tokens := settings.CLITokens
	if output.JSON {
		output.PrintJSON(tokens)
		return nil
	}
	if len(tokens) == 0 {
		fmt.Println("Aucun token CLI")
		return nil
	}
	rows := make([][]string, len(tokens))
	for i, t := range tokens {
		revoked := ""
		if strAny(t["revoked_at"]) != "" {
			revoked = "révoqué"
		}
		var lastUsed *time.Time
		if s := strAny(t["last_used_at"]); s != "" {
			if ts, err := time.Parse(time.RFC3339Nano, s); err == nil {
				lastUsed = &ts
			}
		}
		var exp string
		if s := strAny(t["expires_at"]); s != "" {
			if ts, err := time.Parse(time.RFC3339Nano, s); err == nil {
				exp = ts.Format("2006-01-02")
			}
		}
		rows[i] = []string{
			strAny(t["id"])[:8],
			strAny(t["label"]),
			strAny(t["owner_name"]),
			output.RelTime(lastUsed),
			exp,
			revoked,
		}
	}
	output.Table([]string{"ID", "LABEL", "PROPRIÉTAIRE", "DERNIÈRE USE", "EXPIRE", ""}, rows)
	return nil
}

func runTokensRevoke(cmd *cobra.Command, args []string) error {
	c, err := getClient()
	if err != nil {
		return err
	}
	id, err := resolveToken(c, args[0])
	if err != nil {
		return err
	}
	if err := c.Delete("/api/settings/cli-tokens/" + id); err != nil {
		return err
	}
	output.Successf("Token %s révoqué", args[0])
	return nil
}

func completeTokens(_ *cobra.Command, _ []string, toComplete string) ([]string, cobra.ShellCompDirective) {
	c, err := getClient()
	if err != nil {
		return nil, cobra.ShellCompDirectiveError
	}
	var settings struct {
		CLITokens []map[string]any `json:"cli_tokens"`
	}
	if err := c.Get("/api/settings", &settings); err != nil {
		return nil, cobra.ShellCompDirectiveError
	}
	var out []string
	for _, t := range settings.CLITokens {
		id := strAny(t["id"])
		label := strAny(t["label"])
		out = append(out, id+"\t"+label)
	}
	return out, cobra.ShellCompDirectiveNoFileComp
}

func resolveToken(c interface {
	Get(string, any) error
}, idOrPrefix string) (string, error) {
	var settings struct {
		CLITokens []map[string]any `json:"cli_tokens"`
	}
	if err := c.Get("/api/settings", &settings); err != nil {
		return "", err
	}
	for _, t := range settings.CLITokens {
		id := strAny(t["id"])
		if id == idOrPrefix || (len(id) >= len(idOrPrefix) && id[:len(idOrPrefix)] == idOrPrefix) {
			return id, nil
		}
	}
	return "", fmt.Errorf("token introuvable : %q", idOrPrefix)
}
