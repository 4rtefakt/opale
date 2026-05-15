package cmd

import (
	"strings"
	"testing"
)

func TestNormalizeServer_httpsImplicit(t *testing.T) {
	flagAllowInsecure = false
	got, err := normalizeServer("opale.example.com")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got != "https://opale.example.com" {
		t.Errorf("got = %q, want https://opale.example.com", got)
	}
}

func TestNormalizeServer_httpsExplicitOK(t *testing.T) {
	flagAllowInsecure = false
	got, err := normalizeServer("https://opale.example.com")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got != "https://opale.example.com" {
		t.Errorf("got = %q", got)
	}
}

func TestNormalizeServer_httpRefusedByDefault(t *testing.T) {
	flagAllowInsecure = false
	_, err := normalizeServer("http://opale.example.com")
	if err == nil {
		t.Fatal("err = nil, want refus de http://")
	}
	if !strings.Contains(err.Error(), "http://") {
		t.Errorf("err = %v, doit mentionner http://", err)
	}
}

func TestNormalizeServer_httpAllowedWithFlag(t *testing.T) {
	flagAllowInsecure = true
	defer func() { flagAllowInsecure = false }()
	got, err := normalizeServer("http://localhost:3010")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got != "http://localhost:3010" {
		t.Errorf("got = %q, want http://localhost:3010", got)
	}
}

func TestNormalizeServer_emptyError(t *testing.T) {
	flagAllowInsecure = false
	_, err := normalizeServer("")
	if err == nil {
		t.Fatal("err = nil, want erreur sur URL vide")
	}
	_, err = normalizeServer("   ")
	if err == nil {
		t.Fatal("err = nil, want erreur sur URL whitespace")
	}
}

func TestNormalizeServer_trailingSlashStripped(t *testing.T) {
	flagAllowInsecure = false
	got, err := normalizeServer("https://opale.example.com/")
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://opale.example.com" {
		t.Errorf("trailing slash non stripé : %q", got)
	}
}

func TestCoalesce(t *testing.T) {
	cases := []struct {
		in   []string
		want string
	}{
		{[]string{"", "", "x"}, "x"},
		{[]string{"a", "b", "c"}, "a"},
		{[]string{"", "", ""}, ""},
		{nil, ""},
	}
	for _, tc := range cases {
		got := coalesce(tc.in...)
		if got != tc.want {
			t.Errorf("coalesce(%v) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
