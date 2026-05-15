package cmd

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"opale/cli/client"
	"opale/cli/output"

	"github.com/spf13/cobra"
)

// jsonFloat unmarshals both JSON numbers and quoted strings (Postgres numerics via node-pg).
type jsonFloat float64

func (f *jsonFloat) UnmarshalJSON(data []byte) error {
	var n float64
	if err := json.Unmarshal(data, &n); err == nil {
		*f = jsonFloat(n)
		return nil
	}
	var s string
	if err := json.Unmarshal(data, &s); err != nil {
		return err
	}
	n, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return err
	}
	*f = jsonFloat(n)
	return nil
}

var reasonCategories = []string{"maintenance", "troubleshoot", "audit", "incident", "other"}

// collectReason prompts for category + note if not already provided via flags.
// Wrapper sur collectReasonFrom utilisé en production avec os.Stdin /
// os.Stdout — la version paramétrable existe pour rendre testable.
func collectReason(category, note string) (map[string]string, error) {
	return collectReasonFrom(os.Stdin, os.Stdout, category, note)
}

// collectReasonFrom expose les entrées/sorties pour tester la logique sans
// piloter os.Stdin. Si category/note sont déjà fournis (via flag), on les
// valide directement sans prompt.
func collectReasonFrom(in io.Reader, out io.Writer, category, note string) (map[string]string, error) {
	sc := bufio.NewScanner(in)

	if category == "" {
		fmt.Fprintln(out, "Catégorie :")
		for i, c := range reasonCategories {
			fmt.Fprintf(out, "  %d. %s\n", i+1, c)
		}
		fmt.Fprint(out, "Choix [1-5] : ")
		if !sc.Scan() {
			return nil, fmt.Errorf("saisie annulée")
		}
		n, err := strconv.Atoi(strings.TrimSpace(sc.Text()))
		if err != nil || n < 1 || n > len(reasonCategories) {
			return nil, fmt.Errorf("choix invalide")
		}
		category = reasonCategories[n-1]
	} else if !contains(reasonCategories, category) {
		// La catégorie a été fournie via flag — on vérifie qu'elle est dans
		// la whitelist (sinon le serveur rejettera de toute façon, autant
		// échouer tôt avec un message clair).
		return nil, fmt.Errorf("catégorie invalide : %q (attendu : %s)", category, strings.Join(reasonCategories, "|"))
	}

	if note == "" {
		fmt.Fprint(out, "Note (min 5 chars) : ")
		if !sc.Scan() {
			return nil, fmt.Errorf("saisie annulée")
		}
		note = strings.TrimSpace(sc.Text())
	}

	if len(note) < 5 {
		return nil, fmt.Errorf("note trop courte (min 5 caractères)")
	}

	return map[string]string{"category": category, "note": note}, nil
}

func contains(slice []string, s string) bool {
	for _, v := range slice {
		if v == s {
			return true
		}
	}
	return false
}

// resolveDevice finds a device ID by hostname (or returns the arg directly if it looks like a UUID).
func resolveDevice(c *client.Client, arg string) (string, error) {
	if isUUID(arg) {
		return arg, nil
	}
	var resp struct {
		Devices []struct {
			ID       string `json:"id"`
			Hostname string `json:"hostname"`
		} `json:"devices"`
	}
	if err := c.Get("/api/devices?search="+url.QueryEscape(arg)+"&limit=10", &resp); err != nil {
		return "", err
	}
	for _, d := range resp.Devices {
		if strings.EqualFold(d.Hostname, arg) {
			return d.ID, nil
		}
	}
	if len(resp.Devices) == 1 {
		return resp.Devices[0].ID, nil
	}
	if len(resp.Devices) == 0 {
		return "", fmt.Errorf("poste introuvable : %s", arg)
	}
	names := make([]string, len(resp.Devices))
	for i, d := range resp.Devices {
		names[i] = d.Hostname
	}
	return "", fmt.Errorf("plusieurs postes correspondent à « %s » : %s", arg, strings.Join(names, ", "))
}

// uuidRegex matche le format UUID v1-v5 standard (RFC 4122). Le check
// précédent `len==36 && count('-')==4` acceptait par ex.
// `aaaaaaaa-bbbb-cccc-dddd-eeeeXXXXXXXX` qui n'en est pas un.
var uuidRegex = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func isUUID(s string) bool {
	return uuidRegex.MatchString(s)
}

func relStr(t *time.Time) string {
	return output.RelTime(t)
}

func str(p *string) string {
	if p == nil {
		return "—"
	}
	return *p
}

func pct(p *jsonFloat) string {
	if p == nil {
		return "—"
	}
	return fmt.Sprintf("%.0f%%", float64(*p))
}

func statusBadge(s string) string {
	switch s {
	case "online":
		return "● online"
	case "critical":
		return "⚠ critical"
	default:
		return "○ offline"
	}
}

// ── map[string]any navigation helpers ────────────────────────────────────────

func mStr(m map[string]any, k string) string {
	if m == nil {
		return ""
	}
	if v, ok := m[k]; ok && v != nil {
		return fmt.Sprintf("%v", v)
	}
	return ""
}

func mFloat(m map[string]any, k string) *float64 {
	if m == nil {
		return nil
	}
	if v, ok := m[k]; ok && v != nil {
		if f, ok := v.(float64); ok {
			return &f
		}
	}
	return nil
}

func mMap(m map[string]any, k string) map[string]any {
	if m == nil {
		return nil
	}
	v, _ := m[k].(map[string]any)
	return v
}

// ── Shell completion helpers ──────────────────────────────────────────────────

func completeDevices(_ *cobra.Command, _ []string, toComplete string) ([]string, cobra.ShellCompDirective) {
	c, err := getClient()
	if err != nil {
		return nil, cobra.ShellCompDirectiveError
	}
	var resp struct {
		Devices []struct {
			Hostname string `json:"hostname"`
		} `json:"devices"`
	}
	if err := c.Get("/api/devices?limit=200", &resp); err != nil {
		return nil, cobra.ShellCompDirectiveError
	}
	var out []string
	for _, d := range resp.Devices {
		if strings.HasPrefix(strings.ToLower(d.Hostname), strings.ToLower(toComplete)) {
			out = append(out, d.Hostname)
		}
	}
	return out, cobra.ShellCompDirectiveNoFileComp
}

func completeScripts(_ *cobra.Command, _ []string, toComplete string) ([]string, cobra.ShellCompDirective) {
	c, err := getClient()
	if err != nil {
		return nil, cobra.ShellCompDirectiveError
	}
	var scripts []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := c.Get("/api/scripts", &scripts); err != nil {
		return nil, cobra.ShellCompDirectiveError
	}
	var out []string
	for _, s := range scripts {
		if strings.HasPrefix(strings.ToLower(s.Name), strings.ToLower(toComplete)) {
			out = append(out, s.Name+"\t"+s.ID)
		}
	}
	return out, cobra.ShellCompDirectiveNoFileComp
}

func completeApps(_ *cobra.Command, _ []string, toComplete string) ([]string, cobra.ShellCompDirective) {
	c, err := getClient()
	if err != nil {
		return nil, cobra.ShellCompDirectiveError
	}
	var apps []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := c.Get("/api/packages", &apps); err != nil {
		return nil, cobra.ShellCompDirectiveError
	}
	var out []string
	for _, a := range apps {
		if strings.HasPrefix(strings.ToLower(a.Name), strings.ToLower(toComplete)) {
			out = append(out, a.Name+"\t"+a.ID)
		}
	}
	return out, cobra.ShellCompDirectiveNoFileComp
}
