//go:build !windows && !linux && !darwin

package main

// Stubs pour OS non supportés (BSD, Solaris…). Les implémentations réelles
// sont dans sysinfo_{windows,linux,darwin}.go et sysperf_{windows,linux,darwin}.go.
func collectSystemInfo() *SystemInfo { return nil }
func collectSystemPerf() *SystemPerf { return nil }
