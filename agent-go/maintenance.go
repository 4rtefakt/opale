package main

import (
	"regexp"
	"strconv"
	"time"

	// Base IANA embarquée (~450 Kio) : Windows n'en fournit pas à Go, et
	// sans elle LoadLocation("Europe/Paris") échoue → fenêtre évaluée en UTC.
	_ "time/tzdata"
)

// MaintenanceWindow — fenêtre déclarée par le serveur durant laquelle
// l'agent autorise les actions perturbantes (auto-update ; les
// déploiements, eux, ne sont réservés par le serveur qu'en fenêtre).
// Les commandes admin (script_executions) ne sont PAS bloquées : elles
// sont initiées explicitement et nécessitent souvent une réponse rapide.
//
// Contrat JSON :
//   { "weekdays":[1,2,3,4,5], "start":"02:00", "end":"04:00", "tz":"Europe/Paris" }
//
// Sémantique :
//   - weekdays : sous-ensemble de [0..6] (0=dim, 1=lun, ..., 6=sam, comme time.Weekday)
//                vide = tous les jours
//   - start/end : "H:MM" ou "HH:MM" ; si end < start, la fenêtre traverse minuit
//   - tz : IANA, défaut UTC ; fuseau inconnu = toujours actif (fail-open)
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
		l, err := time.LoadLocation(w.TZ)
		if err != nil {
			return true // fuseau invalide → fail-open, comme le serveur
		}
		loc = l
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

// hhmmRe — format strict du serveur (/^(\d{1,2}):(\d{2})$/) : « 2:5 »,
// « +2:00 » ou « 002:00 » sont refusés des deux côtés (→ fail-open).
var hhmmRe = regexp.MustCompile(`^(\d{1,2}):(\d{2})$`)

func parseHHMM(s string) (int, bool) {
	m := hhmmRe.FindStringSubmatch(s)
	if m == nil {
		return 0, false
	}
	h, _ := strconv.Atoi(m[1])
	mn, _ := strconv.Atoi(m[2])
	if h > 23 || mn > 59 {
		return 0, false
	}
	return h*60 + mn, true
}
