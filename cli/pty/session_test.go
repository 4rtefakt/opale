package pty

import "testing"

func TestToWS(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"https://opale.example.com", "wss://opale.example.com"},
		{"http://opale.example.com", "ws://opale.example.com"},
		{"https://opale.example.com/", "wss://opale.example.com"},      // trailing slash strip
		{"https://opale.example.com:3010/", "wss://opale.example.com:3010"},
		{"opale.example.com", "opale.example.com"},                      // pas de scheme → inchangé (caller doit avoir normalisé)
	}
	for _, tc := range cases {
		got := toWS(tc.in)
		if got != tc.want {
			t.Errorf("toWS(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
