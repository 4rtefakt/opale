package cmd

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"opale/cli/output"

	"github.com/spf13/cobra"
)

var completionCmd = &cobra.Command{
	Use:   "completion [bash|zsh|fish|powershell]",
	Short: "Génère le script d'autocompletion pour le shell courant",
	Long: `Génère et affiche le script d'autocompletion sur stdout.

  opale completion zsh > ~/.zsh/completions/_opale

Utilisez « opale completion install » pour l'installer automatiquement.`,
	ValidArgs: []string{"bash", "zsh", "fish", "powershell"},
	Args:      cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		shell := detectShell()
		if len(args) > 0 {
			shell = args[0]
		}
		return generateCompletion(shell)
	},
}

var completionInstallCmd = &cobra.Command{
	Use:   "install",
	Short: "Installe l'autocompletion pour le shell courant",
	RunE:  runCompletionInstall,
}

func init() {
	completionCmd.AddCommand(completionInstallCmd)
	// Désactive la commande completion auto-générée par Cobra
	rootCmd.CompletionOptions.DisableDefaultCmd = true
}

func generateCompletion(shell string) error {
	var buf bytes.Buffer
	var err error
	switch shell {
	case "bash":
		err = rootCmd.GenBashCompletion(&buf)
	case "zsh":
		err = rootCmd.GenZshCompletion(&buf)
	case "fish":
		err = rootCmd.GenFishCompletion(&buf, true)
	case "powershell":
		err = rootCmd.GenPowerShellCompletionWithDesc(&buf)
	default:
		return fmt.Errorf("shell non supporté : %q (bash|zsh|fish|powershell)", shell)
	}
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(buf.Bytes())
	return err
}

func runCompletionInstall(cmd *cobra.Command, args []string) error {
	shell := detectShell()
	if shell == "" {
		return fmt.Errorf("shell non détecté — précisez avec : opale completion <shell>")
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}

	switch shell {
	case "zsh":
		return installZsh(home)
	case "bash":
		return installBash(home)
	case "fish":
		return installFish(home)
	default:
		return fmt.Errorf("installation automatique non supportée pour %s — utilisez : opale completion %s", shell, shell)
	}
}

func installZsh(home string) error {
	dir := filepath.Join(home, ".zsh", "completions")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	dest := filepath.Join(dir, "_opale")
	if err := writeCompletion("zsh", dest); err != nil {
		return err
	}
	output.Successf("Script installé dans %s", dest)

	// Vérifie que fpath contient le répertoire dans .zshrc
	zshrc := filepath.Join(home, ".zshrc")
	fpathLine := `fpath=(~/.zsh/completions $fpath)`
	if !fileContains(zshrc, ".zsh/completions") {
		f, err := os.OpenFile(zshrc, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
		if err != nil {
			output.Infof("Ajoutez manuellement à ~/.zshrc : %s", fpathLine)
		} else {
			fmt.Fprintf(f, "\n# opale CLI completion\n%s\nautoload -Uz compinit && compinit\n", fpathLine)
			f.Close()
			output.Infof("fpath mis à jour dans ~/.zshrc")
		}
	}
	fmt.Println()
	fmt.Println("  Rechargez votre shell :")
	fmt.Println("    source ~/.zshrc")
	return nil
}

func installBash(home string) error {
	// Emplacements candidats selon l'OS
	candidates := []string{
		filepath.Join(home, ".bash_completion.d"),
		"/usr/local/etc/bash_completion.d", // macOS Homebrew
		filepath.Join(home, ".local", "share", "bash-completion", "completions"),
	}
	dir := candidates[0]
	for _, c := range candidates[1:] {
		if _, err := os.Stat(c); err == nil {
			dir = c
			break
		}
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	dest := filepath.Join(dir, "opale")
	if err := writeCompletion("bash", dest); err != nil {
		return err
	}
	output.Successf("Script installé dans %s", dest)

	// Pour ~/.bash_completion.d, vérifie que .bashrc source le dossier
	if strings.Contains(dir, ".bash_completion.d") {
		bashrc := filepath.Join(home, ".bashrc")
		sourceLine := `for f in ~/.bash_completion.d/*; do source "$f"; done`
		if !fileContains(bashrc, ".bash_completion.d") {
			f, err := os.OpenFile(bashrc, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
			if err != nil {
				output.Infof("Ajoutez manuellement à ~/.bashrc : %s", sourceLine)
			} else {
				fmt.Fprintf(f, "\n# opale CLI completion\n%s\n", sourceLine)
				f.Close()
				output.Infof("source ajouté dans ~/.bashrc")
			}
		}
	}
	fmt.Println()
	fmt.Println("  Rechargez votre shell :")
	fmt.Println("    source ~/.bashrc")
	return nil
}

func installFish(home string) error {
	dir := filepath.Join(home, ".config", "fish", "completions")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	dest := filepath.Join(dir, "opale.fish")
	if err := writeCompletion("fish", dest); err != nil {
		return err
	}
	output.Successf("Script installé dans %s", dest)
	fmt.Println("  L'autocompletion est active dans les nouveaux terminaux fish.")
	return nil
}

func writeCompletion(shell, dest string) error {
	var buf bytes.Buffer
	var err error
	switch shell {
	case "zsh":
		err = rootCmd.GenZshCompletion(&buf)
	case "bash":
		err = rootCmd.GenBashCompletion(&buf)
	case "fish":
		err = rootCmd.GenFishCompletion(&buf, true)
	}
	if err != nil {
		return err
	}
	return os.WriteFile(dest, buf.Bytes(), 0644)
}

func detectShell() string {
	s := os.Getenv("SHELL")
	switch {
	case strings.HasSuffix(s, "zsh"):
		return "zsh"
	case strings.HasSuffix(s, "bash"):
		return "bash"
	case strings.HasSuffix(s, "fish"):
		return "fish"
	default:
		return ""
	}
}

func fileContains(path, needle string) bool {
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	return strings.Contains(string(data), needle)
}
