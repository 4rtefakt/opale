package main

import (
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func tParis(t *testing.T, s string) time.Time {
	t.Helper()
	loc, _ := time.LoadLocation("Europe/Paris")
	tt, err := time.ParseInLocation("2006-01-02 15:04", s, loc)
	if err != nil {
		t.Fatalf("parse %q : %v", s, err)
	}
	return tt
}

func TestMaintenanceWindow_NilAlwaysActive(t *testing.T) {
	var w *MaintenanceWindow
	if !w.IsActive(time.Now()) {
		t.Fatal("nil window devrait être toujours active")
	}
}

func TestMaintenanceWindow_EmptyAlwaysActive(t *testing.T) {
	w := &MaintenanceWindow{}
	if !w.IsActive(time.Now()) {
		t.Fatal("window vide devrait être toujours active")
	}
}

func TestMaintenanceWindow_NormalWindow(t *testing.T) {
	w := &MaintenanceWindow{Start: "02:00", End: "04:00", TZ: "Europe/Paris"}
	cases := []struct {
		when string
		ok   bool
	}{
		{"2026-05-12 01:59", false},
		{"2026-05-12 02:00", true},
		{"2026-05-12 03:30", true},
		{"2026-05-12 04:00", false}, // end exclusif
		{"2026-05-12 12:00", false},
	}
	for _, c := range cases {
		got := w.IsActive(tParis(t, c.when))
		if got != c.ok {
			t.Errorf("at %s : got %v, want %v", c.when, got, c.ok)
		}
	}
}

func TestMaintenanceWindow_OverMidnight(t *testing.T) {
	w := &MaintenanceWindow{Start: "22:00", End: "06:00", TZ: "Europe/Paris"}
	cases := []struct {
		when string
		ok   bool
	}{
		{"2026-05-12 21:59", false},
		{"2026-05-12 22:00", true},
		{"2026-05-12 23:30", true},
		{"2026-05-13 00:00", true},
		{"2026-05-13 05:59", true},
		{"2026-05-13 06:00", false},
		{"2026-05-13 12:00", false},
	}
	for _, c := range cases {
		got := w.IsActive(tParis(t, c.when))
		if got != c.ok {
			t.Errorf("at %s : got %v, want %v", c.when, got, c.ok)
		}
	}
}

func TestMaintenanceWindow_WeekdaysFilter(t *testing.T) {
	// Lundi=1 .. vendredi=5
	w := &MaintenanceWindow{
		Weekdays: []int{1, 2, 3, 4, 5},
		Start:    "02:00", End: "04:00", TZ: "Europe/Paris",
	}
	// 2026-05-12 = mardi. 2026-05-16 = samedi. 2026-05-17 = dimanche.
	cases := []struct {
		when string
		ok   bool
	}{
		{"2026-05-12 03:00", true},  // mardi 03:00
		{"2026-05-16 03:00", false}, // samedi 03:00 → exclu
		{"2026-05-17 03:00", false}, // dimanche 03:00 → exclu
	}
	for _, c := range cases {
		got := w.IsActive(tParis(t, c.when))
		if got != c.ok {
			t.Errorf("at %s : got %v, want %v", c.when, got, c.ok)
		}
	}
}

func TestMaintenanceWindow_BadInputFailOpen(t *testing.T) {
	w := &MaintenanceWindow{Start: "garbage", End: "04:00"}
	if !w.IsActive(time.Now()) {
		t.Fatal("input invalide doit fail-open (rester actif)")
	}
}

// Mêmes verdicts que isMaintenanceWindowActive (api/modules/inventory/
// routes/agent.js) sur les entrées où les deux divergeaient : fuseau
// invalide (fail-open côté serveur, UTC côté agent) et heures hors du
// format strict H:MM / HH:MM (refusées par la regex du serveur → fail-open,
// acceptées par strconv.Atoi côté agent).
func TestMaintenanceWindow_SameVerdictAsServer(t *testing.T) {
	noon := time.Date(2026, 7, 14, 12, 0, 0, 0, time.UTC) // hors 02:00-04:00
	cases := []struct {
		name string
		w    MaintenanceWindow
		want bool
	}{
		{"fuseau invalide → fail-open", MaintenanceWindow{Start: "02:00", End: "04:00", TZ: "Pas/UnFuseau"}, true},
		{"minutes sur 1 chiffre", MaintenanceWindow{Start: "2:5", End: "04:00"}, true},
		{"signe +", MaintenanceWindow{Start: "+2:00", End: "04:00"}, true},
		{"signe -", MaintenanceWindow{Start: "-0:30", End: "04:00"}, true},
		{"heure sur 3 chiffres", MaintenanceWindow{Start: "002:00", End: "04:00"}, true},
		{"espace", MaintenanceWindow{Start: "02:00", End: "04:00 "}, true},
		{"secondes", MaintenanceWindow{Start: "02:00:00", End: "04:00"}, true},
		// Formats acceptés des deux côtés : fenêtre réellement évaluée.
		{"H:MM valide", MaintenanceWindow{Start: "2:00", End: "4:00"}, false},
		{"HH:MM valide", MaintenanceWindow{Start: "02:00", End: "04:00", TZ: "UTC"}, false},
		{"HH:MM valide, dans la fenêtre", MaintenanceWindow{Start: "11:00", End: "13:00"}, true},
	}
	for _, c := range cases {
		if got := c.w.IsActive(noon); got != c.want {
			t.Errorf("%s : IsActive = %v, attendu %v (verdict du serveur)", c.name, got, c.want)
		}
	}
}

// Sous Windows, time.LoadLocation n'a pas de base IANA système : sans
// time/tzdata embarqué, "Europe/Paris" échoue et la fenêtre était évaluée
// en UTC (décalage d'1 à 2 h). Le binaire Windows doit embarquer tzdata.
func TestWindowsBuildEmbedsTZData(t *testing.T) {
	goBin, err := exec.LookPath("go")
	if err != nil {
		t.Skip("toolchain go absente")
	}
	cmd := exec.Command(goBin, "list", "-deps", ".")
	cmd.Env = append(os.Environ(), "GOOS=windows", "GOARCH=amd64", "CGO_ENABLED=0")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("go list : %v\n%s", err, out)
	}
	for _, dep := range strings.Fields(string(out)) {
		if dep == "time/tzdata" {
			return
		}
	}
	t.Fatal("le build windows n'embarque pas time/tzdata : LoadLocation(\"Europe/Paris\") échoue sur les postes")
}

// Europe/Paris doit se charger et la fenêtre s'évaluer en heure de Paris
// (UTC+2 en été) : 01:30 UTC = 03:30 Paris → dans la fenêtre 02:00-04:00.
func TestMaintenanceWindow_EuropeParisLoaded(t *testing.T) {
	if _, err := time.LoadLocation("Europe/Paris"); err != nil {
		t.Fatalf("LoadLocation(Europe/Paris) : %v", err)
	}
	w := &MaintenanceWindow{Start: "02:00", End: "04:00", TZ: "Europe/Paris"}
	if !w.IsActive(time.Date(2026, 7, 14, 1, 30, 0, 0, time.UTC)) {
		t.Fatal("01:30 UTC (03:30 Paris) devrait être dans la fenêtre")
	}
	if w.IsActive(time.Date(2026, 7, 14, 3, 0, 0, 0, time.UTC)) {
		t.Fatal("03:00 UTC (05:00 Paris) devrait être hors fenêtre")
	}
}
