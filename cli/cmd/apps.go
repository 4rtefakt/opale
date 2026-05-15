package cmd

import (
	"fmt"
	"strings"
	"time"

	"opale/cli/output"

	"github.com/spf13/cobra"
)

var appsCmd = &cobra.Command{
	Use:   "apps",
	Short: "Packages et déploiements",
}

var appsLsCmd = &cobra.Command{
	Use:   "ls",
	Short: "Liste les packages disponibles",
	RunE:  runAppsLs,
}

var appsSearchCmd = &cobra.Command{
	Use:   "search <query>",
	Short: "Recherche un package dans le catalogue winget",
	Args:  cobra.ExactArgs(1),
	RunE:  runAppsSearch,
}

var appsDeployCmd = &cobra.Command{
	Use:   "deploy <package> <hostname>...",
	Short: "Déploie un package sur un ou plusieurs postes",
	Args:  cobra.MinimumNArgs(2),
	RunE:  runAppsDeploy,
	ValidArgsFunction: func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
		if len(args) == 0 {
			return completeApps(cmd, args, toComplete)
		}
		return completeDevices(cmd, args, toComplete)
	},
}

var appsDeploymentsCmd = &cobra.Command{
	Use:   "deployments",
	Short: "Liste les déploiements récents",
	RunE:  runAppsDeployments,
}

var appsCancelCmd = &cobra.Command{
	Use:   "cancel <deployment-id>",
	Short: "Annule un déploiement pending",
	Args:  cobra.ExactArgs(1),
	RunE:  runAppsCancel,
}

var appsRetryCmd = &cobra.Command{
	Use:   "retry <deployment-id>",
	Short: "Relance un déploiement failed ou cancelled",
	Args:  cobra.ExactArgs(1),
	RunE:  runAppsRetry,
}

var (
	flagDeploymentsStatus string
	flagDeploymentsDevice string
)

func init() {
	appsCmd.AddCommand(appsLsCmd, appsSearchCmd, appsDeployCmd, appsDeploymentsCmd, appsCancelCmd, appsRetryCmd)
	appsDeploymentsCmd.Flags().StringVar(&flagDeploymentsStatus, "status", "", "Filtre: pending|running|success|failed|cancelled")
	appsDeploymentsCmd.Flags().StringVar(&flagDeploymentsDevice, "device", "", "Filtre par hostname")
}

func runAppsLs(cmd *cobra.Command, args []string) error {
	c, err := getClient()
	if err != nil {
		return err
	}
	var pkgs []map[string]any
	if err := c.Get("/api/packages", &pkgs); err != nil {
		return err
	}
	if output.JSON {
		output.PrintJSON(pkgs)
		return nil
	}
	if len(pkgs) == 0 {
		fmt.Println("Aucun package")
		return nil
	}
	rows := make([][]string, len(pkgs))
	for i, p := range pkgs {
		pkgType := strAny(p["type"])
		if strAny(p["winget_id"]) != "" {
			pkgType = "winget:" + strAny(p["winget_id"])
		}
		rows[i] = []string{
			strAny(p["id"])[:8],
			strAny(p["name"]),
			pkgType,
			strAny(p["status"]),
			fmt.Sprintf("%s✓  %s✗  %s⏳", strAny(p["success_count"]), strAny(p["failed_count"]), strAny(p["pending_count"])),
		}
	}
	output.Table([]string{"ID", "NOM", "TYPE", "STATUT", "DÉPLOIEMENTS"}, rows)
	return nil
}

func runAppsSearch(cmd *cobra.Command, args []string) error {
	c, err := getClient()
	if err != nil {
		return err
	}
	var results []map[string]any
	if err := c.Get("/api/packages/winget/search?q="+strings.ReplaceAll(args[0], " ", "+"), &results); err != nil {
		return err
	}
	if output.JSON {
		output.PrintJSON(results)
		return nil
	}
	if len(results) == 0 {
		fmt.Println("Aucun résultat")
		return nil
	}
	rows := make([][]string, len(results))
	for i, r := range results {
		rows[i] = []string{
			strAny(r["packageIdentifier"]),
			strAny(r["packageName"]),
			coalesce(strAny(r["latestVersion"]), "—"),
		}
	}
	output.Table([]string{"WINGET ID", "NOM", "VERSION"}, rows)
	return nil
}

func runAppsDeploy(cmd *cobra.Command, args []string) error {
	c, err := getClient()
	if err != nil {
		return err
	}

	pkgID, err := resolveApp(c, args[0])
	if err != nil {
		return err
	}

	deviceIDs := make([]string, 0, len(args)-1)
	for _, h := range args[1:] {
		id, err := resolveDevice(c, h)
		if err != nil {
			return fmt.Errorf("%s : %w", h, err)
		}
		deviceIDs = append(deviceIDs, id)
	}

	var resp map[string]any
	if err := c.Post("/api/packages/"+pkgID+"/deploy", map[string]any{
		"scope":      "device",
		"device_ids": deviceIDs,
	}, &resp); err != nil {
		return err
	}
	if output.JSON {
		output.PrintJSON(resp)
		return nil
	}
	output.Successf("Déploiement lancé sur %d poste(s)", len(deviceIDs))
	if jobID := strAny(resp["job_id"]); jobID != "" {
		fmt.Printf("  job : %s\n", jobID[:8])
	}
	fmt.Println("  Suivez avec : opale apps deployments")
	return nil
}

func runAppsDeployments(cmd *cobra.Command, args []string) error {
	c, err := getClient()
	if err != nil {
		return err
	}
	path := "/api/deployments?limit=50"
	if flagDeploymentsStatus != "" {
		path += "&status=" + flagDeploymentsStatus
	}
	if flagDeploymentsDevice != "" {
		id, err := resolveDevice(c, flagDeploymentsDevice)
		if err != nil {
			return err
		}
		path += "&device_id=" + id
	}
	var resp struct {
		Rows []map[string]any `json:"rows"`
	}
	if err := c.Get(path, &resp); err != nil {
		return err
	}
	if output.JSON {
		output.PrintJSON(resp.Rows)
		return nil
	}
	if len(resp.Rows) == 0 {
		fmt.Println("Aucun déploiement")
		return nil
	}
	rows := make([][]string, len(resp.Rows))
	for i, d := range resp.Rows {
		var ts *time.Time
		for _, field := range []string{"completed_at", "started_at", "queued_at"} {
			if s := strAny(d[field]); s != "" {
				if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
					ts = &t
					break
				}
			}
		}
		statusIcon := map[string]string{
			"success":   "✓",
			"failed":    "✗",
			"pending":   "⏳",
			"running":   "▶",
			"cancelled": "⊘",
		}[strAny(d["status"])]
		rows[i] = []string{
			statusIcon + " " + strAny(d["status"]),
			strAny(d["package_name"]),
			strAny(d["hostname"]),
			strAny(d["deployed_by_name"]),
			output.RelTime(ts),
		}
	}
	output.Table([]string{"STATUT", "PACKAGE", "POSTE", "PAR", "QUAND"}, rows)
	return nil
}

func runAppsCancel(cmd *cobra.Command, args []string) error {
	c, err := getClient()
	if err != nil {
		return err
	}
	var result map[string]any
	if err := c.Patch("/api/deployments/"+args[0]+"/cancel", nil, &result); err != nil {
		return err
	}
	output.Successf("Déploiement %s annulé", args[0][:8])
	return nil
}

func runAppsRetry(cmd *cobra.Command, args []string) error {
	c, err := getClient()
	if err != nil {
		return err
	}
	var result map[string]any
	if err := c.Post("/api/deployments/"+args[0]+"/retry", nil, &result); err != nil {
		return err
	}
	output.Successf("Déploiement %s remis en queue", args[0][:8])
	return nil
}

func resolveApp(c interface {
	Get(string, any) error
}, nameOrID string) (string, error) {
	var pkgs []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := c.Get("/api/packages", &pkgs); err != nil {
		return "", err
	}
	for _, p := range pkgs {
		if p.ID == nameOrID || p.Name == nameOrID {
			return p.ID, nil
		}
	}
	for _, p := range pkgs {
		if len(p.ID) >= len(nameOrID) && p.ID[:len(nameOrID)] == nameOrID {
			return p.ID, nil
		}
	}
	return "", fmt.Errorf("package introuvable : %q", nameOrID)
}
