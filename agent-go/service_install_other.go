//go:build !windows && !linux && !darwin

package main

import (
	"fmt"
	"runtime"
)

func InstallService(token, url string) error {
	return fmt.Errorf("install-service non supporté sur %s", runtime.GOOS)
}

func UninstallService() error {
	return fmt.Errorf("uninstall-service non supporté sur %s", runtime.GOOS)
}
