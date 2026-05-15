//go:build !windows

package main

// Stubs : la collecte HW/perf n'est portée que sur Windows pour le moment.
func collectSystemInfo() *SystemInfo  { return nil }
func collectSystemPerf() *SystemPerf  { return nil }
