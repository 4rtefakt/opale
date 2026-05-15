package output

import (
	"strings"
	"testing"
	"time"
)

func TestClr_noColorReturnsPlain(t *testing.T) {
	prev := NoColor
	NoColor = true
	defer func() { NoColor = prev }()

	got := clr(cRed, "hello")
	if got != "hello" {
		t.Errorf("clr(NoColor=true) = %q, want %q", got, "hello")
	}
}

func TestClr_colorWrapsInAnsi(t *testing.T) {
	prev := NoColor
	NoColor = false
	defer func() { NoColor = prev }()

	got := clr(cRed, "hello")
	if !strings.HasPrefix(got, "\033[") || !strings.HasSuffix(got, cReset) {
		t.Errorf("clr() = %q, doit être wrappé d'ANSI codes", got)
	}
	if !strings.Contains(got, "hello") {
		t.Errorf("clr() = %q, doit contenir le payload", got)
	}
}

func TestRelTime_nilOrZero(t *testing.T) {
	if got := RelTime(nil); got != "—" {
		t.Errorf("RelTime(nil) = %q, want %q", got, "—")
	}
	zero := time.Time{}
	if got := RelTime(&zero); got != "—" {
		t.Errorf("RelTime(zero) = %q, want %q", got, "—")
	}
}

func TestRelTime_recent(t *testing.T) {
	now := time.Now()
	cases := []struct {
		name string
		t    time.Time
		want string
	}{
		{"just now (30s)", now.Add(-30 * time.Second), "à l'instant"},
		{"5 minutes ago", now.Add(-5 * time.Minute), "il y a 5m"},
		{"2 hours ago", now.Add(-2 * time.Hour), "il y a 2h"},
		{"3 days ago", now.Add(-3 * 24 * time.Hour), "il y a 3j"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := RelTime(&tc.t)
			if got != tc.want {
				t.Errorf("RelTime(%s) = %q, want %q", tc.name, got, tc.want)
			}
		})
	}
}

func TestRelTime_oldFallsBackToDate(t *testing.T) {
	old := time.Date(2020, 1, 15, 0, 0, 0, 0, time.UTC)
	got := RelTime(&old)
	if got != "2020-01-15" {
		t.Errorf("RelTime(2020) = %q, want %q", got, "2020-01-15")
	}
}
