package cmd

import (
	"fmt"

	"opale/cli/output"
	"opale/cli/pty"

	"github.com/spf13/cobra"
)

var sshCmd = &cobra.Command{
	Use:               "ssh <hostname>",
	Short:             "Ouvre une session SSH sur un poste (via Netbird)",
	Args:              cobra.ExactArgs(1),
	RunE:              runSSH,
	ValidArgsFunction: completeDevices,
}

var (
	flagSSHCategory string
	flagSSHNote     string
)

func init() {
	sshCmd.Flags().StringVar(&flagSSHCategory, "category", "", "Catégorie: maintenance|troubleshoot|audit|incident|other")
	sshCmd.Flags().StringVar(&flagSSHNote, "note", "", "Note explicative (min 5 chars)")
}

func runSSH(cmd *cobra.Command, args []string) error {
	c, err := getClient()
	if err != nil {
		return err
	}
	deviceID, err := resolveDevice(c, args[0])
	if err != nil {
		return err
	}
	reason, err := collectReason(flagSSHCategory, flagSSHNote)
	if err != nil {
		return err
	}
	var grant struct {
		Nonce string `json:"nonce"`
	}
	if err := c.Post("/api/ssh/grant", map[string]any{
		"deviceId": deviceID,
		"reason":   reason,
	}, &grant); err != nil {
		return err
	}
	output.Infof("Ouverture session SSH sur %s…", args[0])
	fmt.Println("  (exit ou Ctrl+D pour terminer la session)")
	wsPath := fmt.Sprintf("/api/ssh/%s?nonce=%s", deviceID, grant.Nonce)
	return pty.Connect(c.BaseURL, wsPath)
}
