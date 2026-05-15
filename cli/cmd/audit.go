package cmd

import (
	"fmt"
	"time"

	"opale/cli/output"

	"github.com/spf13/cobra"
)

type auditRow struct {
	ID             string     `json:"id"`
	Action         string     `json:"action"`
	ByUser         string     `json:"by_user"`
	Target         string     `json:"target"`
	DeviceHostname string     `json:"device_hostname"`
	CreatedAt      *time.Time `json:"created_at"`
}

var auditCmd = &cobra.Command{
	Use:   "audit",
	Short: "Journal d'audit",
}

var auditLsCmd = &cobra.Command{
	Use:   "ls",
	Short: "Affiche les derniers événements d'audit",
	RunE:  runAuditLs,
}

var (
	flagAuditLimit  int
	flagAuditAction string
)

func init() {
	auditCmd.AddCommand(auditLsCmd)
	auditLsCmd.Flags().IntVar(&flagAuditLimit, "limit", 50, "Nombre d'événements")
	auditLsCmd.Flags().StringVar(&flagAuditAction, "action", "", "Filtre par action exacte")
}

func runAuditLs(cmd *cobra.Command, args []string) error {
	c, err := getClient()
	if err != nil {
		return err
	}
	path := fmt.Sprintf("/api/settings/audit?limit=%d", flagAuditLimit)
	if flagAuditAction != "" {
		path += "&action=" + flagAuditAction
	}
	var resp struct {
		Rows  []auditRow `json:"rows"`
		Total int        `json:"total"`
	}
	if err := c.Get(path, &resp); err != nil {
		return err
	}
	if output.JSON {
		output.PrintJSON(resp.Rows)
		return nil
	}
	if len(resp.Rows) == 0 {
		fmt.Println("Aucun événement")
		return nil
	}
	rows := make([][]string, len(resp.Rows))
	for i, r := range resp.Rows {
		target := coalesce(r.DeviceHostname, r.Target, "—")
		rows[i] = []string{
			output.RelTime(r.CreatedAt),
			r.Action,
			coalesce(r.ByUser, "—"),
			target,
		}
	}
	output.Table([]string{"QUAND", "ACTION", "PAR", "CIBLE"}, rows)
	fmt.Printf("\n%d / %d événements\n", len(resp.Rows), resp.Total)
	return nil
}
