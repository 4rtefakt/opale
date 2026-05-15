//go:build !windows && !linux && !darwin

package main

import (
	"os"
	"runtime"
)

// CollectMetrics — stub pour OS non supportés (BSD, Solaris…). Les
// implémentations réelles sont dans metrics_{windows,linux,darwin}.go.
func CollectMetrics() (*CheckinPayload, error) {
	host, _ := os.Hostname()
	return &CheckinPayload{
		Hostname:  host,
		OS:        runtime.GOOS + " (stub)",
		Disks:     []Disk{},
		Network:   []NetIface{},
		Bandwidth: []BandwidthSample{},
		Ping:      []PingStats{{Host: "1.1.1.1"}},
	}, nil
}
