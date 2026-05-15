package cmd

import (
	"fmt"
	"time"

	"opale/cli/output"

	"github.com/spf13/cobra"
)

func section(title string) {
	fmt.Printf("\n\033[1m── %s\033[0m\n", title)
}

type device struct {
	ID           string     `json:"id"`
	Hostname     string     `json:"hostname"`
	Status       string     `json:"status"`
	AgentVersion string     `json:"agent_version"`
	OS           string     `json:"os"`
	DiskUsedPct  *jsonFloat `json:"disk_used_pct"`
	IPNetbird    string     `json:"ip_netbird"`
	LastSeen     *time.Time `json:"last_seen"`
	User         *struct {
		Name  string `json:"name"`
		Email string `json:"email"`
	} `json:"user"`
}

var devicesCmd = &cobra.Command{
	Use:   "devices",
	Short: "Gestion des postes",
}

var devicesLsCmd = &cobra.Command{
	Use:   "ls",
	Short: "Liste tous les postes",
	RunE:  runDevicesLs,
}

var devicesShowCmd = &cobra.Command{
	Use:               "show <hostname-ou-id>",
	Short:             "Détail d'un poste",
	Args:              cobra.ExactArgs(1),
	RunE:              runDevicesShow,
	ValidArgsFunction: completeDevices,
}

var flagDevicesStatus string

func init() {
	devicesCmd.AddCommand(devicesLsCmd, devicesShowCmd)
	devicesLsCmd.Flags().StringVar(&flagDevicesStatus, "status", "", "Filtre: online|offline|critical|unassigned")
}

func runDevicesLs(cmd *cobra.Command, args []string) error {
	c, err := getClient()
	if err != nil {
		return err
	}
	path := "/api/devices?limit=200"
	if flagDevicesStatus != "" {
		path += "&status=" + flagDevicesStatus
	}
	var resp struct {
		Devices []device `json:"devices"`
		Total   int      `json:"total"`
	}
	if err := c.Get(path, &resp); err != nil {
		return err
	}
	if output.JSON {
		output.PrintJSON(resp.Devices)
		return nil
	}
	rows := make([][]string, len(resp.Devices))
	for i, d := range resp.Devices {
		user := "—"
		if d.User != nil && d.User.Name != "" {
			user = d.User.Name
		}
		rows[i] = []string{
			d.Hostname,
			statusBadge(d.Status),
			user,
			pct(d.DiskUsedPct),
			coalesce(d.AgentVersion, "—"),
			output.RelTime(d.LastSeen),
		}
	}
	output.Table([]string{"HOSTNAME", "STATUS", "UTILISATEUR", "DISQUE", "AGENT", "VU"}, rows)
	fmt.Printf("\n%d / %d postes\n", len(resp.Devices), resp.Total)
	return nil
}

func runDevicesShow(cmd *cobra.Command, args []string) error {
	c, err := getClient()
	if err != nil {
		return err
	}
	id, err := resolveDevice(c, args[0])
	if err != nil {
		return err
	}
	var d map[string]any
	if err := c.Get("/api/devices/"+id, &d); err != nil {
		return err
	}
	if output.JSON {
		output.PrintJSON(d)
		return nil
	}

	health := mMap(d, "health_signals")
	sys := mMap(d, "system_info")
	defender := mMap(health, "defender")
	firewall := mMap(health, "firewall")
	bitlocker := mMap(health, "bitlocker")
	user := mMap(d, "user")

	row := func(k, v string) {
		if v != "" && v != "<nil>" {
			fmt.Printf("  %-22s %s\n", k, v)
		}
	}
	boolMark := func(b any) string {
		if v, ok := b.(bool); ok {
			if v { return "✓" }
			return "✗"
		}
		return "—"
	}

	section("Identité")
	row("hostname", mStr(d, "hostname"))
	row("statut", statusBadge(mStr(d, "status")))
	if user != nil {
		row("utilisateur", fmt.Sprintf("%s <%s>", mStr(user, "name"), mStr(user, "email")))
		if jt := mStr(user, "job_title"); jt != "" {
			row("poste", jt)
		}
	}
	if cu := mStr(sys, "current_user"); cu != "" {
		row("session active", cu)
	}

	section("Matériel")
	row("modèle", fmt.Sprintf("%s (%s)", mStr(d, "model"), mStr(d, "manufacturer")))
	if cores := mFloat(sys, "cores"); cores != nil {
		threads := mFloat(sys, "threads")
		mhz := mFloat(sys, "cpu_mhz")
		if threads != nil && mhz != nil {
			row("cpu", fmt.Sprintf("%dc/%dt — %.0f MHz", int(*cores), int(*threads), *mhz))
		}
	}
	row("ram", fmt.Sprintf("%s GB", mStr(d, "ram_gb")))
	if gpus, ok := sys["gpus"].([]any); ok && len(gpus) > 0 {
		if g, ok := gpus[0].(map[string]any); ok {
			row("gpu", fmt.Sprintf("%s (driver %s)", mStr(g, "name"), mStr(g, "driver_date")))
		}
	}
	row("disque", fmt.Sprintf("%s%% / %s GB", mStr(d, "disk_used_pct"), mStr(d, "disk_total_gb")))
	if bh := mMap(sys, "battery_health"); bh != nil {
		if hp := mFloat(bh, "health_pct"); hp != nil {
			row("batterie", fmt.Sprintf("%.0f%% santé", *hp))
		}
	}
	if mc := mFloat(sys, "monitors_count"); mc != nil {
		row("écrans", fmt.Sprintf("%.0f", *mc))
	}

	section("Réseau")
	row("ip_netbird", mStr(d, "ip_netbird"))

	section("Sécurité")
	row("compliance", mStr(d, "compliance_state"))
	if bitlocker != nil {
		vol := mStr(bitlocker, "volume")
		row(fmt.Sprintf("BitLocker %s", vol), fmt.Sprintf("%s (%s)", boolMark(bitlocker["enabled"]), mStr(bitlocker, "protection_status")))
	}
	if defender != nil {
		row("Defender AV", boolMark(defender["antivirus_enabled"]))
		row("Defender RT", boolMark(defender["realtime_protection"]))
		if age := mFloat(defender, "signature_age_days"); age != nil {
			row("signature AV", fmt.Sprintf("il y a %dj (màj %s)", int(*age), mStr(defender, "signature_last_update")))
		}
		if n := mFloat(defender, "threats_last_30d"); n != nil && *n > 0 {
			row("menaces 30j", fmt.Sprintf("%.0f — dernière %s", *n, mStr(defender, "last_threat_at")))
		} else {
			row("menaces 30j", "aucune")
		}
	}
	if firewall != nil {
		row("firewall", fmt.Sprintf("domaine %s  privé %s  public %s",
			boolMark(firewall["domain_enabled"]),
			boolMark(firewall["private_enabled"]),
			boolMark(firewall["public_enabled"])))
	}
	if v, ok := health["tpm_present"]; ok {
		row("TPM", boolMark(v))
	}
	if v, ok := health["pending_reboot"]; ok {
		if b, _ := v.(bool); b {
			row("reboot requis", "⚠ oui")
		} else {
			row("reboot requis", "non")
		}
	}
	row("MAJ Windows", mStr(health, "last_windows_update"))

	section("Intune")
	row("dernière sync", mStr(d, "intune_last_sync"))
	row("inscrit le", mStr(d, "enrolled_at"))
	row("type de jointure", mStr(d, "join_type"))

	section("Système")
	row("os", fmt.Sprintf("%s (build %s)", mStr(d, "os"), mStr(d, "os_build")))
	row("agent", mStr(d, "agent_version"))
	row("vu", mStr(d, "last_seen"))

	return nil
}
