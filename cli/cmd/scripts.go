package cmd

import (
	"encoding/json"
	"fmt"
	"time"

	"opale/cli/output"

	"github.com/spf13/cobra"
)

type scriptItem struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Category  string     `json:"category"`
	ShellType string     `json:"shell_type"`
	ExecCount int        `json:"exec_count"`
	LastRun   *time.Time `json:"last_run"`
}

var scriptsCmd = &cobra.Command{
	Use:   "scripts",
	Short: "Scripts PowerShell",
}

var scriptsLsCmd = &cobra.Command{
	Use:   "ls",
	Short: "Liste les scripts disponibles",
	RunE:  runScriptsLs,
}

var scriptsRunCmd = &cobra.Command{
	Use:   "run <hostname> <script>",
	Short: "Lance un script sur un poste et attend le résultat",
	Args:  cobra.ExactArgs(2),
	RunE:  runScriptsRun,
	ValidArgsFunction: func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
		if len(args) == 0 {
			return completeDevices(cmd, args, toComplete)
		}
		return completeScripts(cmd, args, toComplete)
	},
}

var scriptsExecCmd = &cobra.Command{
	Use:   "exec <hostname> <script>",
	Short: "Exécute un script via SSH (sortie en direct, nécessite Netbird)",
	Args:  cobra.ExactArgs(2),
	RunE:  runScriptsExec,
	ValidArgsFunction: func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
		if len(args) == 0 {
			return completeDevices(cmd, args, toComplete)
		}
		return completeScripts(cmd, args, toComplete)
	},
}

var scriptsHistoryCmd = &cobra.Command{
	Use:               "history <hostname>",
	Short:             "Historique des exécutions sur un poste",
	Args:              cobra.ExactArgs(1),
	RunE:              runScriptsHistory,
	ValidArgsFunction: completeDevices,
}

func init() {
	scriptsCmd.AddCommand(scriptsLsCmd, scriptsRunCmd, scriptsExecCmd, scriptsHistoryCmd)
}

func runScriptsLs(cmd *cobra.Command, args []string) error {
	c, err := getClient()
	if err != nil {
		return err
	}
	var scripts []scriptItem
	if err := c.Get("/api/scripts", &scripts); err != nil {
		return err
	}
	if output.JSON {
		output.PrintJSON(scripts)
		return nil
	}
	if len(scripts) == 0 {
		fmt.Println("Aucun script")
		return nil
	}
	rows := make([][]string, len(scripts))
	for i, s := range scripts {
		rows[i] = []string{
			s.ID[:8],
			s.Category,
			s.Name,
			s.ShellType,
			fmt.Sprintf("%d", s.ExecCount),
			output.RelTime(s.LastRun),
		}
	}
	output.Table([]string{"ID", "CATÉGORIE", "NOM", "SHELL", "EXÉCS", "DERNIÈRE"}, rows)
	return nil
}

func runScriptsRun(cmd *cobra.Command, args []string) error {
	c, err := getClient()
	if err != nil {
		return err
	}
	deviceID, err := resolveDevice(c, args[0])
	if err != nil {
		return err
	}
	scriptID, err := resolveScript(c, args[1])
	if err != nil {
		return err
	}

	var exec struct {
		ID       string `json:"id"`
		ScriptID string `json:"script_id"`
	}
	if err := c.Post("/api/scripts/"+scriptID+"/run", map[string]string{"device_id": deviceID}, &exec); err != nil {
		return err
	}

	output.Infof("Script envoyé (exec %s…), en attente du résultat…", exec.ID[:8])

	// Poll jusqu'à completion (max 3 min)
	deadline := time.Now().Add(3 * time.Minute)
	for time.Now().Before(deadline) {
		time.Sleep(3 * time.Second)

		var execs []map[string]any
		if err := c.Get("/api/scripts/"+scriptID+"/executions", &execs); err != nil {
			continue
		}
		for _, e := range execs {
			if strAny(e["id"]) != exec.ID {
				continue
			}
			status := strAny(e["status"])
			if status == "pending" || status == "running" {
				continue
			}
			if output.JSON {
				output.PrintJSON(e)
				return nil
			}
			exitCode := e["exit_code"]
			dur := strAny(e["duration"])
			if status == "success" {
				output.Successf("Terminé (exit %v, %ss)", exitCode, dur)
			} else {
				output.Errorf("Échoué (exit %v, %ss)", exitCode, dur)
			}
			fmt.Println()
			fmt.Println(strAny(e["output"]))
			return nil
		}
	}
	return fmt.Errorf("timeout : résultat non reçu après 3 min (exec %s)", exec.ID[:8])
}

func runScriptsExec(cmd *cobra.Command, args []string) error {
	c, err := getClient()
	if err != nil {
		return err
	}
	deviceID, err := resolveDevice(c, args[0])
	if err != nil {
		return err
	}
	scriptID, err := resolveScript(c, args[1])
	if err != nil {
		return err
	}

	output.Infof("Exécution SSH sur %s (sortie en direct)…", args[0])
	fmt.Println()

	return c.PostStream("/api/scripts/"+scriptID+"/exec",
		map[string]any{"deviceIds": []string{deviceID}},
		func(data []byte) bool {
			var ev struct {
				Type string `json:"type"`
				Data any    `json:"data"`
			}
			if err := json.Unmarshal(data, &ev); err != nil {
				return true
			}
			switch ev.Type {
			case "stdout", "stderr":
				if s, ok := ev.Data.(string); ok {
					fmt.Print(s)
				}
			case "exit":
				if m, ok := ev.Data.(map[string]any); ok {
					code := m["code"]
					dur := m["duration"]
					fmt.Println()
					if c, ok := code.(float64); ok && c == 0 {
						output.Successf("exit 0 — %.2fs", dur)
					} else {
						output.Errorf("exit %v — %.2fs", code, dur)
					}
				}
				return false
			case "error":
				if s, ok := ev.Data.(string); ok {
					output.Errorf("%s", s)
				}
				return false
			case "end":
				return false
			}
			return true
		},
	)
}

func runScriptsHistory(cmd *cobra.Command, args []string) error {
	c, err := getClient()
	if err != nil {
		return err
	}
	deviceID, err := resolveDevice(c, args[0])
	if err != nil {
		return err
	}
	var execs []map[string]any
	if err := c.Get("/api/scripts/executions/device/"+deviceID, &execs); err != nil {
		return err
	}
	if output.JSON {
		output.PrintJSON(execs)
		return nil
	}
	if len(execs) == 0 {
		fmt.Println("Aucune exécution")
		return nil
	}
	rows := make([][]string, len(execs))
	for i, e := range execs {
		var ts *time.Time
		if s := strAny(e["queued_at"]); s != "" {
			if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
				ts = &t
			}
		}
		rows[i] = []string{
			strAny(e["id"])[:8],
			strAny(e["script_name"]),
			strAny(e["status"]),
			strAny(e["by_name"]),
			output.RelTime(ts),
		}
	}
	output.Table([]string{"ID", "SCRIPT", "STATUT", "PAR", "QUAND"}, rows)
	return nil
}

func resolveScript(c interface {
	Get(string, any) error
}, nameOrID string) (string, error) {
	var scripts []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := c.Get("/api/scripts", &scripts); err != nil {
		return "", err
	}
	lower := nameOrID
	for _, s := range scripts {
		if s.ID == nameOrID || s.Name == nameOrID {
			return s.ID, nil
		}
	}
	_ = lower
	for _, s := range scripts {
		if len(s.ID) >= len(nameOrID) && s.ID[:len(nameOrID)] == nameOrID {
			return s.ID, nil
		}
	}
	return "", fmt.Errorf("script introuvable : %q", nameOrID)
}
