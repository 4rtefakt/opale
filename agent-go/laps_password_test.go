package main

import (
	"strings"
	"testing"
)

// Windows (stratégie « le mot de passe doit respecter des exigences de
// complexité », active par défaut sur un domaine) exige 3 catégories sur 4.
// Un mot de passe tiré sans chiffre ni caractère spécial ferait échouer
// l'application locale APRÈS l'escrow : le générateur doit l'exclure.
func TestGenerateAdminPassword_AlwaysComplex(t *testing.T) {
	for i := 0; i < 3000; i++ {
		pw, err := generateAdminPassword(16)
		if err != nil {
			t.Fatal(err)
		}
		if len(pw) != 16 {
			t.Fatalf("longueur %d", len(pw))
		}
		if !strings.ContainsAny(pw, "abcdefghijkmnopqrstuvwxyz") ||
			!strings.ContainsAny(pw, "ABCDEFGHJKLMNPQRSTUVWXYZ") ||
			!strings.ContainsAny(pw, "23456789") {
			t.Fatalf("mot de passe sans minuscule, majuscule ou chiffre : %q", pw)
		}
		for _, c := range pw {
			if !strings.ContainsRune(passwordCharset, c) {
				t.Fatalf("caractère hors alphabet : %q", c)
			}
		}
	}
}
