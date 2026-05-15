package cmd

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"opale/cli/client"
)

// ─── isUUID ──────────────────────────────────────────────────────────────────

func TestIsUUID_validV4(t *testing.T) {
	cases := []string{
		"550e8400-e29b-41d4-a716-446655440000",
		"6ba7b810-9dad-11d1-80b4-00c04fd430c8", // UUID v1
		"AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", // uppercase
	}
	for _, s := range cases {
		if !isUUID(s) {
			t.Errorf("isUUID(%q) = false, want true", s)
		}
	}
}

func TestIsUUID_invalid(t *testing.T) {
	cases := []string{
		"",
		"550e8400",                                   // trop court
		"550e8400-e29b-41d4-a716-44665544000",        // 35 chars
		"550e8400-e29b-41d4-a716-4466554400000",      // 37 chars
		"aaaaaaaa-bbbb-cccc-dddd-eeeeXXXXXXXX",       // X non-hex
		"aaaaaaaabbbbccccddddeeeeeeeeeeee",            // pas de tirets
		"aaaa-bbbb-cccc-dddd-eeee-fffff-something36char",
		"MUFASA", // hostname
	}
	for _, s := range cases {
		if isUUID(s) {
			t.Errorf("isUUID(%q) = true, want false", s)
		}
	}
}

// ─── collectReasonFrom ──────────────────────────────────────────────────────

func TestCollectReasonFrom_validViaPrompt(t *testing.T) {
	in := strings.NewReader("4\nincident PC-LAB-12 disque plein\n")
	out := &bytes.Buffer{}
	got, err := collectReasonFrom(in, out, "", "")
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if got["category"] != "incident" {
		t.Errorf("category = %q, want incident", got["category"])
	}
	if got["note"] != "incident PC-LAB-12 disque plein" {
		t.Errorf("note = %q", got["note"])
	}
}

func TestCollectReasonFrom_validViaFlags_noPrompt(t *testing.T) {
	in := strings.NewReader("") // pas d'entrée attendue
	out := &bytes.Buffer{}
	got, err := collectReasonFrom(in, out, "audit", "vérification trimestrielle")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got["category"] != "audit" || got["note"] != "vérification trimestrielle" {
		t.Errorf("got = %v", got)
	}
	if out.Len() != 0 {
		t.Errorf("output non vide alors que category+note sont fournis : %q", out.String())
	}
}

func TestCollectReasonFrom_invalidCategoryFlag(t *testing.T) {
	in := strings.NewReader("")
	out := &bytes.Buffer{}
	_, err := collectReasonFrom(in, out, "BAD", "ok ok ok")
	if err == nil {
		t.Fatal("err = nil, want erreur sur catégorie invalide")
	}
	if !strings.Contains(err.Error(), "BAD") {
		t.Errorf("err = %v, doit mentionner la catégorie", err)
	}
}

func TestCollectReasonFrom_choiceOutOfRange(t *testing.T) {
	in := strings.NewReader("99\n")
	out := &bytes.Buffer{}
	_, err := collectReasonFrom(in, out, "", "")
	if err == nil {
		t.Fatal("err = nil, want erreur sur choix > 5")
	}
}

func TestCollectReasonFrom_choiceNonInteger(t *testing.T) {
	in := strings.NewReader("xyz\n")
	out := &bytes.Buffer{}
	_, err := collectReasonFrom(in, out, "", "")
	if err == nil {
		t.Fatal("err = nil, want erreur sur input non-numérique")
	}
}

func TestCollectReasonFrom_noteTooShort(t *testing.T) {
	in := strings.NewReader("1\nok\n") // 2 chars < 5
	out := &bytes.Buffer{}
	_, err := collectReasonFrom(in, out, "", "")
	if err == nil || !strings.Contains(err.Error(), "trop courte") {
		t.Errorf("err = %v, want 'note trop courte'", err)
	}
}

func TestCollectReasonFrom_eofAbortsCategory(t *testing.T) {
	in := strings.NewReader("") // EOF immédiat
	out := &bytes.Buffer{}
	_, err := collectReasonFrom(in, out, "", "")
	if err == nil {
		t.Fatal("err = nil, want erreur sur EOF")
	}
}

// ─── resolveDevice ──────────────────────────────────────────────────────────

func TestResolveDevice_passesThroughUUID(t *testing.T) {
	// Pas de serveur — si isUUID renvoie true, resolveDevice ne doit pas
	// faire d'appel HTTP.
	uuid := "550e8400-e29b-41d4-a716-446655440000"
	c := client.New("http://unused", "")
	got, err := resolveDevice(c, uuid)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got != uuid {
		t.Errorf("got = %q, want %q", got, uuid)
	}
}

func TestResolveDevice_singleHostnameMatch(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"devices": []map[string]string{
				{"id": "abc-1234", "hostname": "MUFASA"},
			},
		})
	}))
	defer srv.Close()
	c := client.New(srv.URL, "")
	got, err := resolveDevice(c, "MUFASA")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got != "abc-1234" {
		t.Errorf("got = %q, want abc-1234", got)
	}
}

func TestResolveDevice_caseInsensitiveExact(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"devices": []map[string]string{
				{"id": "abc-1234", "hostname": "MUFASA"},
				{"id": "xyz-5678", "hostname": "MUFASA-LAB-2"},
			},
		})
	}))
	defer srv.Close()
	c := client.New(srv.URL, "")
	// "mufasa" (minuscule) doit matcher "MUFASA" via EqualFold avant le
	// fallback "single result" (qui retournerait le mauvais id).
	got, err := resolveDevice(c, "mufasa")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got != "abc-1234" {
		t.Errorf("got = %q, want abc-1234 (match exact case-insensitive)", got)
	}
}

func TestResolveDevice_noMatch(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"devices": []any{}})
	}))
	defer srv.Close()
	c := client.New(srv.URL, "")
	_, err := resolveDevice(c, "NOPE")
	if err == nil || !strings.Contains(err.Error(), "introuvable") {
		t.Errorf("err = %v, want 'introuvable'", err)
	}
}

func TestResolveDevice_ambiguous(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"devices": []map[string]string{
				{"id": "a", "hostname": "PC-LAB-01"},
				{"id": "b", "hostname": "PC-LAB-02"},
				{"id": "c", "hostname": "PC-LAB-03"},
			},
		})
	}))
	defer srv.Close()
	c := client.New(srv.URL, "")
	_, err := resolveDevice(c, "PC-LAB")
	if err == nil || !strings.Contains(err.Error(), "plusieurs") {
		t.Errorf("err = %v, want 'plusieurs'", err)
	}
}

// ─── contains ───────────────────────────────────────────────────────────────

func TestContains(t *testing.T) {
	if !contains([]string{"a", "b"}, "a") {
		t.Error("contains([a,b], a) = false")
	}
	if contains([]string{"a", "b"}, "c") {
		t.Error("contains([a,b], c) = true")
	}
	if contains(nil, "x") {
		t.Error("contains(nil, x) = true")
	}
}

