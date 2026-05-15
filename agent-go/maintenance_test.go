package main

import (
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
