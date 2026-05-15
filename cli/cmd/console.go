package cmd

import (
	"fmt"

	"opale/cli/output"
	"opale/cli/pty"

	"github.com/spf13/cobra"
)

var consoleCmd = &cobra.Command{
	Use:               "console <hostname>",
	Short:             "Ouvre une session console SYSTEM sur un poste (via agent Go)",
	Args:              cobra.ExactArgs(1),
	RunE:              runConsole,
	ValidArgsFunction: completeDevices,
}

var (
	flagConsoleCategory string
	flagConsoleNote     string
	flagConsoleTakeover bool
)

func init() {
	consoleCmd.Flags().StringVar(&flagConsoleCategory, "category", "", "Catégorie: maintenance|troubleshoot|audit|incident|other")
	consoleCmd.Flags().StringVar(&flagConsoleNote, "note", "", "Note explicative (min 5 chars)")
	consoleCmd.Flags().BoolVar(&flagConsoleTakeover, "takeover", false, "Reprendre la main sur une session console active")
}

func runConsole(cmd *cobra.Command, args []string) error {
	c, err := getClient()
	if err != nil {
		return err
	}
	deviceID, err := resolveDevice(c, args[0])
	if err != nil {
		return err
	}
	reason, err := collectReason(flagConsoleCategory, flagConsoleNote)
	if err != nil {
		return err
	}
	var grant struct {
		Nonce string `json:"nonce"`
	}
	if err := c.Post("/api/console/grant", map[string]any{
		"deviceId": deviceID,
		"reason":   reason,
		"takeover": flagConsoleTakeover,
	}, &grant); err != nil {
		return err
	}
	output.Infof("Ouverture console SYSTEM sur %s…", args[0])
	fmt.Println("  (Ctrl+D ou fermer le terminal pour terminer la session)")
	wsPath := fmt.Sprintf("/api/console/%s?nonce=%s", deviceID, grant.Nonce)
	return pty.Connect(c.BaseURL, wsPath)
}
