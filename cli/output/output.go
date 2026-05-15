package output

import (
	"encoding/json"
	"fmt"
	"os"
	"text/tabwriter"
	"time"

	"golang.org/x/term"
)

var (
	JSON    bool
	NoColor bool
)

// init désactive automatiquement les couleurs si stdout n'est pas un
// terminal interactif (pipe, redirection vers fichier, CI sans VT100).
// Le flag --no-color et la variable NO_COLOR restent prioritaires (cf.
// PersistentPreRun dans root.go).
func init() {
	if !term.IsTerminal(int(os.Stdout.Fd())) {
		NoColor = true
	}
}

const (
	cReset  = "\033[0m"
	cBold   = "\033[1m"
	cDim    = "\033[2m"
	cRed    = "\033[31m"
	cGreen  = "\033[32m"
	cYellow = "\033[33m"
	cCyan   = "\033[36m"
)

func clr(code, s string) string {
	if NoColor {
		return s
	}
	return code + s + cReset
}

func Table(headers []string, rows [][]string) {
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	for i, h := range headers {
		if i > 0 {
			fmt.Fprint(w, "\t")
		}
		fmt.Fprint(w, clr(cBold+cDim, h))
	}
	fmt.Fprintln(w)
	for _, row := range rows {
		for i, cell := range row {
			if i > 0 {
				fmt.Fprint(w, "\t")
			}
			fmt.Fprint(w, cell)
		}
		fmt.Fprintln(w)
	}
	w.Flush()
}

func PrintJSON(v any) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

func Errorf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, clr(cRed, "error: ")+format+"\n", args...)
}

func Successf(format string, args ...any) {
	fmt.Printf(clr(cGreen, "✓ ")+format+"\n", args...)
}

func Infof(format string, args ...any) {
	fmt.Printf(clr(cCyan, "→ ")+format+"\n", args...)
}

func RelTime(t *time.Time) string {
	if t == nil || t.IsZero() {
		return "—"
	}
	d := time.Since(*t)
	switch {
	case d < time.Minute:
		return "à l'instant"
	case d < time.Hour:
		return fmt.Sprintf("il y a %dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("il y a %dh", int(d.Hours()))
	case d < 7*24*time.Hour:
		return fmt.Sprintf("il y a %dj", int(d.Hours()/24))
	default:
		return t.Format("2006-01-02")
	}
}
