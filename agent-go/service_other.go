//go:build !windows

package main

import "errors"

func RunService() error {
	return errors.New("RunService : non supporté hors Windows")
}

func IsWindowsService() (bool, error) {
	return false, nil
}
