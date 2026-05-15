//go:build !windows

package main

import "errors"

// Stub : l'opération n'a de sens que sur Windows.
func setLocalAdminPassword(username, password string) error {
	return errors.New("setLocalAdminPassword : non supporté hors Windows")
}
