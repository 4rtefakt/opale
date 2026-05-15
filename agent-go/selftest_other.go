//go:build !windows

package main

// platformSelfTests — vide hors Windows (le service n'existe pas, PS pas testé).
func platformSelfTests() []func() testResult {
	return []func() testResult{
		func() testResult {
			return testResult{Name: "OS", OK: true, Message: runtimeOSLine() + " (tests Windows skippés)"}
		},
	}
}
