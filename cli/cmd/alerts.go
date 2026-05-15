package cmd

import (
	"fmt"
	"time"

	"opale/cli/output"

	"github.com/spf13/cobra"
)

var alertsCmd = &cobra.Command{
	Use:   "alerts",
	Short: "Alertes actives du parc",
}

var alertsLsCmd = &cobra.Command{
	Use:   "ls",
	Short: "Liste toutes les alertes actives",
	RunE:  runAlertsLs,
}

var alertsSnoozeCmd = &cobra.Command{
	Use:               "snooze <hostname>",
	Short:             "Snooze les alertes d'un poste",
	Args:              cobra.ExactArgs(1),
	RunE:              runAlertsSnooze,
	ValidArgsFunction: completeDevices,
}

var (
	flagSnoozeDays int
	flagSnoozeType string
	flagSnoozeReason string
)

func init() {
	alertsCmd.AddCommand(alertsLsCmd, alertsSnoozeCmd)
	alertsSnoozeCmd.Flags().IntVar(&flagSnoozeDays, "days", 7, "Durée du snooze en jours")
	alertsSnoozeCmd.Flags().StringVar(&flagSnoozeType, "type", "disk_critical", "Type: disk_critical|disk_high|noncompliant|offline")
	alertsSnoozeCmd.Flags().StringVar(&flagSnoozeReason, "reason", "", "Motif du snooze")
	_ = alertsSnoozeCmd.RegisterFlagCompletionFunc("type", func(_ *cobra.Command, _ []string, _ string) ([]string, cobra.ShellCompDirective) {
		return []string{"disk_critical", "disk_high", "noncompliant", "offline"}, cobra.ShellCompDirectiveNoFileComp
	})
}

func runAlertsLs(cmd *cobra.Command, args []string) error {
	c, err := getClient()
	if err != nil {
		return err
	}
	var raw map[string]any
	if err := c.Get("/api/alerts", &raw); err != nil {
		return err
	}
	if output.JSON {
		output.PrintJSON(raw)
		return nil
	}

	toItems := func(key string) []map[string]any {
		arr, _ := raw[key].([]any)
		out := make([]map[string]any, 0, len(arr))
		for _, v := range arr {
			if m, ok := v.(map[string]any); ok {
				out = append(out, m)
			}
		}
		return out
	}

	diskCrit := toItems("disk_critical")
	diskWarn := toItems("disk_warn")
	offline  := toItems("offline")
	nonComp  := toItems("non_compliant")
	total := len(diskCrit) + len(diskWarn) + len(offline) + len(nonComp)

	if total == 0 {
		output.Successf("Aucune alerte active")
		return nil
	}

	printAlertSection := func(title string, items []map[string]any, badge string) {
		if len(items) == 0 {
			return
		}
		section(title)
		rows := make([][]string, len(items))
		for i, item := range items {
			snooze := ""
			if s := strAny(item["snoozed_until"]); s != "" {
				snooze = "⏸ " + s
			}
			rows[i] = []string{
				badge,
				strAny(item["hostname"]),
				coalesce(strAny(item["user_name"]), "—"),
				coalesce(strAny(item["disk_used_pct"]), strAny(item["agent_version"]), strAny(item["label"]), "—"),
				snooze,
			}
		}
		output.Table([]string{"", "POSTE", "UTILISATEUR", "DÉTAIL", "SNOOZE"}, rows)
	}

	printAlertSection("Disque critique", diskCrit, "🔴")
	printAlertSection("Disque dégradé", diskWarn, "🟡")
	printAlertSection("Hors ligne", offline, "⚪")
	printAlertSection("Non-conformité", nonComp, "🟠")

	fmt.Printf("\n%d alerte(s) active(s)\n", total)
	return nil
}

func runAlertsSnooze(cmd *cobra.Command, args []string) error {
	c, err := getClient()
	if err != nil {
		return err
	}
	deviceID, err := resolveDevice(c, args[0])
	if err != nil {
		return err
	}
	until := time.Now().AddDate(0, 0, flagSnoozeDays).UTC().Format(time.RFC3339)
	body := map[string]any{
		"device_id":  deviceID,
		"alert_type": flagSnoozeType,
		"until_at":   until,
	}
	if flagSnoozeReason != "" {
		body["reason"] = flagSnoozeReason
	}
	var result map[string]any
	if err := c.Post("/api/alert-snoozes", body, &result); err != nil {
		return err
	}
	output.Successf("Alertes %s snoozées pour %s jusqu'au %s",
		flagSnoozeType, args[0],
		time.Now().AddDate(0, 0, flagSnoozeDays).Format("2006-01-02"))
	return nil
}
