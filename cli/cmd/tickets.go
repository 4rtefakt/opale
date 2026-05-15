package cmd

import (
	"fmt"
	"strings"
	"time"

	"opale/cli/output"

	"github.com/spf13/cobra"
)

type ticket struct {
	ID            string     `json:"id"`
	Title         string     `json:"title"`
	Status        string     `json:"status"`
	Priority      string     `json:"priority"`
	Hostname      string     `json:"hostname"`
	RequesterName string     `json:"requester_name"`
	CreatedAt     *time.Time `json:"created_at"`
	UpdatedAt     *time.Time `json:"updated_at"`
}

var ticketsCmd = &cobra.Command{
	Use:   "tickets",
	Short: "Gestion des tickets",
}

var ticketsLsCmd = &cobra.Command{
	Use:   "ls",
	Short: "Liste les tickets",
	RunE:  runTicketsLs,
}

var ticketsShowCmd = &cobra.Command{
	Use:               "show <id>",
	Short:             "Détail et fil de messages d'un ticket",
	Args:              cobra.ExactArgs(1),
	RunE:              runTicketsShow,
	ValidArgsFunction: completeTickets,
}

var ticketsCreateCmd = &cobra.Command{
	Use:   "create <titre>",
	Short: "Ouvre un nouveau ticket",
	Args:  cobra.ExactArgs(1),
	RunE:  runTicketsCreate,
}

var ticketsCommentCmd = &cobra.Command{
	Use:               "comment <id> <message>",
	Short:             "Ajoute un message dans le fil d'un ticket",
	Args:              cobra.ExactArgs(2),
	RunE:              runTicketsComment,
	ValidArgsFunction: completeTickets,
}

var ticketsUpdateCmd = &cobra.Command{
	Use:               "update <id>",
	Short:             "Modifie le statut, la priorité ou l'assignation d'un ticket",
	Args:              cobra.ExactArgs(1),
	RunE:              runTicketsUpdate,
	ValidArgsFunction: completeTickets,
}

var ticketsCloseCmd = &cobra.Command{
	Use:               "close <id>",
	Short:             "Résout un ticket",
	Args:              cobra.ExactArgs(1),
	RunE:              runTicketsClose,
	ValidArgsFunction: completeTickets,
}

var (
	flagTicketsStatus      string
	flagTicketDevice       string
	flagTicketPriority     string
	flagTicketDescription  string
	flagTicketUpdateStatus   string
	flagTicketUpdatePriority string
)

func init() {
	ticketsCmd.AddCommand(ticketsLsCmd, ticketsShowCmd, ticketsCreateCmd,
		ticketsCommentCmd, ticketsUpdateCmd, ticketsCloseCmd)

	ticketsLsCmd.Flags().StringVar(&flagTicketsStatus, "status", "", "Filtre: open|in_progress|resolved (défaut: tous sauf résolus)")

	ticketsCreateCmd.Flags().StringVar(&flagTicketDevice, "device", "", "Hostname du poste concerné")
	ticketsCreateCmd.Flags().StringVar(&flagTicketPriority, "priority", "normal", "Priorité: low|normal|high")
	ticketsCreateCmd.Flags().StringVar(&flagTicketDescription, "description", "", "Description détaillée")
	_ = ticketsCreateCmd.RegisterFlagCompletionFunc("device", completeDevices)
	_ = ticketsCreateCmd.RegisterFlagCompletionFunc("priority", func(_ *cobra.Command, _ []string, _ string) ([]string, cobra.ShellCompDirective) {
		return []string{"low", "normal", "high"}, cobra.ShellCompDirectiveNoFileComp
	})

	ticketsUpdateCmd.Flags().StringVar(&flagTicketUpdateStatus, "status", "", "Nouveau statut: open|in_progress|resolved")
	ticketsUpdateCmd.Flags().StringVar(&flagTicketUpdatePriority, "priority", "", "Nouvelle priorité: low|normal|high")
	_ = ticketsUpdateCmd.RegisterFlagCompletionFunc("status", func(_ *cobra.Command, _ []string, _ string) ([]string, cobra.ShellCompDirective) {
		return []string{"open", "in_progress", "resolved"}, cobra.ShellCompDirectiveNoFileComp
	})
	_ = ticketsUpdateCmd.RegisterFlagCompletionFunc("priority", func(_ *cobra.Command, _ []string, _ string) ([]string, cobra.ShellCompDirective) {
		return []string{"low", "normal", "high"}, cobra.ShellCompDirectiveNoFileComp
	})
}

func runTicketsLs(cmd *cobra.Command, args []string) error {
	c, err := getClient()
	if err != nil {
		return err
	}
	path := "/api/tickets?limit=50"
	if flagTicketsStatus != "" {
		path += "&status=" + flagTicketsStatus
	}
	var tickets []ticket
	if err := c.Get(path, &tickets); err != nil {
		return err
	}
	if output.JSON {
		output.PrintJSON(tickets)
		return nil
	}
	// Sans filtre explicite, masque les résolus
	if flagTicketsStatus == "" {
		filtered := tickets[:0]
		for _, tk := range tickets {
			if tk.Status != "resolved" {
				filtered = append(filtered, tk)
			}
		}
		tickets = filtered
	}
	if len(tickets) == 0 {
		fmt.Println("Aucun ticket")
		return nil
	}
	rows := make([][]string, len(tickets))
	for i, tk := range tickets {
		rows[i] = []string{
			tk.ID[:8],
			priorityBadge(tk.Priority),
			statusLabel(tk.Status),
			coalesce(tk.Hostname, "—"),
			tk.Title,
			output.RelTime(tk.UpdatedAt),
		}
	}
	output.Table([]string{"ID", "PRIORITÉ", "STATUT", "POSTE", "TITRE", "MÀJ"}, rows)
	return nil
}

func runTicketsShow(cmd *cobra.Command, args []string) error {
	c, err := getClient()
	if err != nil {
		return err
	}
	id, err := resolveTicket(c, args[0])
	if err != nil {
		return err
	}
	var tk map[string]any
	if err := c.Get("/api/tickets/"+id, &tk); err != nil {
		return err
	}
	if output.JSON {
		output.PrintJSON(tk)
		return nil
	}
	row := func(k, v string) {
		if v != "" {
			fmt.Printf("  %-16s %s\n", k, v)
		}
	}

	section("Ticket")
	row("id", strAny(tk["id"]))
	row("titre", strAny(tk["title"]))
	row("statut", statusLabel(strAny(tk["status"])))
	row("priorité", strAny(tk["priority"]))
	row("poste", coalesce(strAny(tk["hostname"]), "—"))
	row("demandeur", fmt.Sprintf("%s <%s>", strAny(tk["requester_name"]), strAny(tk["requester_email"])))
	row("créé par", strAny(tk["created_by_name"]))
	if assignee := strAny(tk["assigned_to_name"]); assignee != "" {
		row("assigné à", assignee)
	}
	if aw, ok := tk["awaiting_reply"].(bool); ok && aw {
		row("en attente", "réponse utilisateur")
	}
	if tags, ok := tk["tags"].([]any); ok && len(tags) > 0 {
		var names []string
		for _, t := range tags {
			if tag, ok := t.(map[string]any); ok {
				names = append(names, strAny(tag["name"]))
			}
		}
		row("tags", strings.Join(names, ", "))
	}
	row("ouvert le", strAny(tk["created_at"]))
	row("màj", strAny(tk["updated_at"]))

	section("Messages")
	msgs, _ := tk["messages"].([]any)
	if len(msgs) == 0 {
		fmt.Println("  (aucun message)")
	}
	for _, m := range msgs {
		msg, _ := m.(map[string]any)
		if msg == nil {
			continue
		}
		if strAny(msg["type"]) == "system" {
			fmt.Printf("  [sys]  %s\n", strAny(msg["content"]))
		} else {
			fmt.Printf("  [%s]  %s\n", strAny(msg["author"]), strAny(msg["content"]))
		}
	}
	fmt.Println()
	return nil
}

func runTicketsCreate(cmd *cobra.Command, args []string) error {
	c, err := getClient()
	if err != nil {
		return err
	}
	body := map[string]any{
		"title":    args[0],
		"priority": flagTicketPriority,
	}
	if flagTicketDescription != "" {
		body["description"] = flagTicketDescription
	}
	if flagTicketDevice != "" {
		id, err := resolveDevice(c, flagTicketDevice)
		if err != nil {
			return err
		}
		body["device_id"] = id
	}
	var tk map[string]any
	if err := c.Post("/api/tickets", body, &tk); err != nil {
		return err
	}
	if output.JSON {
		output.PrintJSON(tk)
		return nil
	}
	output.Successf("Ticket créé : %s", strAny(tk["id"])[:8])
	fmt.Printf("  %s — %s\n", strAny(tk["title"]), statusLabel(strAny(tk["status"])))
	return nil
}

func runTicketsComment(cmd *cobra.Command, args []string) error {
	c, err := getClient()
	if err != nil {
		return err
	}
	id, err := resolveTicket(c, args[0])
	if err != nil {
		return err
	}
	var result map[string]any
	if err := c.Post("/api/tickets/"+id+"/messages", map[string]string{"content": args[1]}, &result); err != nil {
		return err
	}
	output.Successf("Message ajouté")
	return nil
}

func runTicketsUpdate(cmd *cobra.Command, args []string) error {
	c, err := getClient()
	if err != nil {
		return err
	}
	if flagTicketUpdateStatus == "" && flagTicketUpdatePriority == "" {
		return fmt.Errorf("précisez --status et/ou --priority")
	}
	id, err := resolveTicket(c, args[0])
	if err != nil {
		return err
	}
	body := map[string]any{}
	if flagTicketUpdateStatus != "" {
		body["status"] = flagTicketUpdateStatus
	}
	if flagTicketUpdatePriority != "" {
		body["priority"] = flagTicketUpdatePriority
	}
	var tk map[string]any
	if err := c.Patch("/api/tickets/"+id, body, &tk); err != nil {
		return err
	}
	if output.JSON {
		output.PrintJSON(tk)
		return nil
	}
	output.Successf("Ticket %s mis à jour", args[0][:8])
	return nil
}

func runTicketsClose(cmd *cobra.Command, args []string) error {
	c, err := getClient()
	if err != nil {
		return err
	}
	id, err := resolveTicket(c, args[0])
	if err != nil {
		return err
	}
	var tk map[string]any
	if err := c.Patch("/api/tickets/"+id, map[string]string{"status": "resolved"}, &tk); err != nil {
		return err
	}
	output.Successf("Ticket %s résolu", args[0][:8])
	return nil
}

// ── helpers ───────────────────────────────────────────────────────────────────

func priorityBadge(p string) string {
	switch p {
	case "high":
		return "↑ high"
	case "low":
		return "↓ low"
	default:
		return "  normal"
	}
}

func statusLabel(s string) string {
	switch s {
	case "in_progress":
		return "en cours"
	case "resolved":
		return "résolu"
	default:
		return s
	}
}

func strAny(v any) string {
	if v == nil {
		return ""
	}
	s, _ := v.(string)
	return s
}

func resolveTicket(c interface {
	Get(string, any) error
}, idOrPrefix string) (string, error) {
	// UUID complet ou préfixe → cherche dans la liste
	if len(idOrPrefix) == 36 {
		return idOrPrefix, nil
	}
	var tickets []struct {
		ID string `json:"id"`
	}
	if err := c.Get("/api/tickets?limit=200", &tickets); err != nil {
		return "", err
	}
	for _, t := range tickets {
		if strings.HasPrefix(t.ID, idOrPrefix) {
			return t.ID, nil
		}
	}
	return "", fmt.Errorf("ticket introuvable : %q", idOrPrefix)
}

func completeTickets(_ *cobra.Command, _ []string, toComplete string) ([]string, cobra.ShellCompDirective) {
	c, err := getClient()
	if err != nil {
		return nil, cobra.ShellCompDirectiveError
	}
	var tickets []struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	}
	if err := c.Get("/api/tickets?limit=200", &tickets); err != nil {
		return nil, cobra.ShellCompDirectiveError
	}
	var out []string
	for _, t := range tickets {
		if strings.HasPrefix(t.ID, toComplete) {
			out = append(out, t.ID[:8]+"\t"+t.Title)
		}
	}
	return out, cobra.ShellCompDirectiveNoFileComp
}
