package main

import (
	"strconv"
	"strings"
	"time"
)

// MaintenanceWindow — fenêtre déclarée par le serveur durant laquelle
// l'agent autorise les actions perturbantes (auto-update, deployments).
// Les commandes admin (script_executions) ne sont PAS bloquées : elles
// sont initiées explicitement et nécessitent souvent une réponse rapide.
//
// Contrat JSON :
//   { "weekdays":[1,2,3,4,5], "start":"02:00", "end":"04:00", "tz":"Europe/Paris" }
//
// Sémantique :
//   - weekdays : sous-ensemble de [0..6] (0=dim, 1=lun, ..., 6=sam, comme time.Weekday)
//                vide = tous les jours
//   - start/end : "HH:MM" ; si end < start, la fenêtre traverse minuit
//   - tz : IANA, défaut UTC
//   - tout champ absent ou MaintenanceWindow nil = toujours actif
type MaintenanceWindow struct {
	Weekdays []int  `json:"weekdays,omitempty"`
	Start    string `json:"start,omitempty"`
	End      string `json:"end,omitempty"`
	TZ       string `json:"tz,omitempty"`
}

// IsActive retourne true si `now` tombe dans la fenêtre. Une window
// nil ou vide est traitée comme "toujours actif" pour ne pas bloquer
// par défaut (fail-open sur la maintenance).
func (w *MaintenanceWindow) IsActive(now time.Time) bool {
	if w == nil {
		return true
	}
	if len(w.Weekdays) == 0 && w.Start == "" && w.End == "" {
		return true
	}

	loc := time.UTC
	if w.TZ != "" {
		if l, err := time.LoadLocation(w.TZ); err == nil {
			loc = l
		}
	}
	n := now.In(loc)

	if len(w.Weekdays) > 0 {
		wd := int(n.Weekday())
		match := false
		for _, d := range w.Weekdays {
			if d == wd {
				match = true
				break
			}
		}
		if !match {
			return false
		}
	}

	start, okS := parseHHMM(w.Start)
	end, okE := parseHHMM(w.End)
	if !okS || !okE {
		return true // contrat invalide → fail-open
	}
	cur := n.Hour()*60 + n.Minute()
	if start == end {
		// fenêtre vide : ne bloque rien
		return true
	}
	if start < end {
		return cur >= start && cur < end
	}
	// Traverse minuit
	return cur >= start || cur < end
}

func parseHHMM(s string) (int, bool) {
	parts := strings.SplitN(s, ":", 2)
	if len(parts) != 2 {
		return 0, false
	}
	h, err := strconv.Atoi(parts[0])
	if err != nil || h < 0 || h > 23 {
		return 0, false
	}
	m, err := strconv.Atoi(parts[1])
	if err != nil || m < 0 || m > 59 {
		return 0, false
	}
	return h*60 + m, true
}
