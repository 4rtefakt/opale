package cmd

import (
	"fmt"

	"opale/cli/output"

	"github.com/spf13/cobra"
)

var complianceCmd = &cobra.Command{
	Use:   "compliance",
	Short: "Conformité des postes",
}

var complianceLsCmd = &cobra.Command{
	Use:   "ls",
	Short: "Vue parc — taux de conformité par règle",
	RunE:  runComplianceLs,
}

var complianceShowCmd = &cobra.Command{
	Use:               "show <hostname>",
	Short:             "Résultats des règles de conformité pour un poste",
	Args:              cobra.ExactArgs(1),
	RunE:              runComplianceShow,
	ValidArgsFunction: completeDevices,
}

func init() {
	complianceCmd.AddCommand(complianceLsCmd, complianceShowCmd)
}

func runComplianceLs(cmd *cobra.Command, args []string) error {
	c, err := getClient()
	if err != nil {
		return err
	}
	var resp struct {
		Rules []map[string]any `json:"rules"`
	}
	if err := c.Get("/api/compliance", &resp); err != nil {
		return err
	}
	if output.JSON {
		output.PrintJSON(resp.Rules)
		return nil
	}
	if len(resp.Rules) == 0 {
		fmt.Println("Aucune règle")
		return nil
	}
	rows := make([][]string, len(resp.Rules))
	for i, r := range resp.Rules {
		pass := mFloat(r, "pass")
		fail := mFloat(r, "fail")
		total := mFloat(r, "total")
		pct := "—"
		if pass != nil && total != nil && *total > 0 {
			pct = fmt.Sprintf("%.0f%%", *pass / *total * 100)
		}
		failStr := "—"
		if fail != nil {
			failStr = fmt.Sprintf("%.0f", *fail)
		}
		rows[i] = []string{
			strAny(r["severity"]),
			strAny(r["label"]),
			pct,
			failStr,
		}
	}
	output.Table([]string{"SÉVÉRITÉ", "RÈGLE", "CONFORMITÉ", "ÉCHECS"}, rows)
	return nil
}

func runComplianceShow(cmd *cobra.Command, args []string) error {
	c, err := getClient()
	if err != nil {
		return err
	}
	deviceID, err := resolveDevice(c, args[0])
	if err != nil {
		return err
	}

	var resp struct {
		Device  map[string]any   `json:"device"`
		Results []map[string]any `json:"results"`
	}
	if err := c.Get("/api/devices/"+deviceID+"/compliance", &resp); err != nil {
		return err
	}
	if output.JSON {
		output.PrintJSON(resp)
		return nil
	}

	pass, fail, skip := 0, 0, 0
	for _, r := range resp.Results {
		switch strAny(r["status"]) {
		case "pass":
			pass++
		case "fail":
			fail++
		default:
			skip++
		}
	}

	fmt.Printf("\n%s — conformité : %d✓  %d✗  %d—\n\n",
		strAny(resp.Device["hostname"]), pass, fail, skip)

	rows := make([][]string, len(resp.Results))
	for i, r := range resp.Results {
		status := strAny(r["status"])
		badge := "✓"
		if status == "fail" {
			badge = "✗"
		} else if status != "pass" {
			badge = "—"
		}
		rows[i] = []string{
			badge,
			strAny(r["severity"]),
			strAny(r["label"]),
		}
	}
	output.Table([]string{"", "SÉVÉRITÉ", "RÈGLE"}, rows)
	return nil
}
