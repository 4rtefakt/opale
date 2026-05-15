package client

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClient_Get_ok(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer mytoken" {
			t.Errorf("Authorization header attendu, got %q", r.Header.Get("Authorization"))
		}
		if r.URL.Path != "/api/foo" {
			t.Errorf("path = %q, want /api/foo", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"hello":"world"}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "mytoken")
	var out struct {
		Hello string `json:"hello"`
	}
	if err := c.Get("/api/foo", &out); err != nil {
		t.Fatalf("Get: %v", err)
	}
	if out.Hello != "world" {
		t.Errorf("out.Hello = %q, want world", out.Hello)
	}
}

func TestClient_Post_serializesBody(t *testing.T) {
	var bodyReceived string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			t.Errorf("method = %q, want POST", r.Method)
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", r.Header.Get("Content-Type"))
		}
		buf := make([]byte, 256)
		n, _ := r.Body.Read(buf)
		bodyReceived = string(buf[:n])
		w.WriteHeader(201)
		w.Write([]byte(`{"id":"abc"}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "")
	var out struct {
		ID string `json:"id"`
	}
	if err := c.Post("/api/x", map[string]string{"k": "v"}, &out); err != nil {
		t.Fatalf("Post: %v", err)
	}
	if !strings.Contains(bodyReceived, `"k":"v"`) {
		t.Errorf("body = %q, want contains \"k\":\"v\"", bodyReceived)
	}
	if out.ID != "abc" {
		t.Errorf("out.ID = %q, want abc", out.ID)
	}
}

func TestClient_204NoBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(204)
	}))
	defer srv.Close()

	c := New(srv.URL, "")
	// Delete attend 204 sans body et NE doit PAS échouer.
	if err := c.Delete("/api/x"); err != nil {
		t.Errorf("Delete 204: %v", err)
	}
}

func TestClient_APIError_withErrorField(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(403)
		w.Write([]byte(`{"error":"non autorisé"}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "")
	err := c.Get("/api/x", nil)
	if err == nil {
		t.Fatal("Get sur 403 doit retourner une erreur")
	}
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("err type = %T, want *APIError", err)
	}
	if apiErr.Status != 403 {
		t.Errorf("Status = %d, want 403", apiErr.Status)
	}
	if apiErr.Message != "non autorisé" {
		t.Errorf("Message = %q, want %q", apiErr.Message, "non autorisé")
	}
	if !strings.Contains(apiErr.Error(), "403") {
		t.Errorf("Error() = %q, doit contenir 403", apiErr.Error())
	}
}

func TestClient_APIError_fallbackRawBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		w.Write([]byte(`internal kaboom`)) // pas du JSON
	}))
	defer srv.Close()

	c := New(srv.URL, "")
	err := c.Get("/api/x", nil)
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("err type = %T, want *APIError", err)
	}
	if apiErr.Message != "internal kaboom" {
		t.Errorf("Message = %q, want fallback raw body", apiErr.Message)
	}
}

func TestClient_NoAuthHeaderWhenTokenEmpty(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Errorf("Authorization header set quand token vide : %q", r.Header.Get("Authorization"))
		}
		w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "")
	if err := c.Get("/api/foo", &struct{}{}); err != nil {
		t.Fatal(err)
	}
}
