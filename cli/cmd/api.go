package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/spf13/cobra"
)

var flagAPIData string

var apiCmd = &cobra.Command{
	Use:   "api <METHOD> <path>",
	Short: "Requête brute sur l'API Opale (ex: opale api GET /api/tickets)",
	Long: "Envoie une requête authentifiée à l'API et affiche la réponse brute.\n" +
		"--data accepte du JSON, ou « - » pour le lire sur l'entrée standard.",
	Args: cobra.ExactArgs(2),
	RunE: runAPI,
}

func init() {
	apiCmd.Flags().StringVarP(&flagAPIData, "data", "d", "", "Corps JSON de la requête (« - » = stdin)")
	rootCmd.AddCommand(apiCmd)
}

func runAPI(cmd *cobra.Command, args []string) error {
	c, err := getClient()
	if err != nil {
		return err
	}
	method := strings.ToUpper(args[0])
	path := args[1]
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	var body []byte
	switch flagAPIData {
	case "":
	case "-":
		if body, err = io.ReadAll(os.Stdin); err != nil {
			return err
		}
	default:
		body = []byte(flagAPIData)
	}
	status, out, err := c.Raw(method, path, body)
	if err != nil {
		return err
	}
	fmt.Fprintln(cmd.OutOrStdout(), string(out))
	if status >= 400 {
		return fmt.Errorf("HTTP %d", status)
	}
	return nil
}
