//go:build !windows

package main

import (
	"os"
	"runtime"
)

// CollectMetrics — stub non-Windows. Permet de compiler/tester l'agent
// sur macOS/Linux. La vraie collecte se fait dans metrics_windows.go.
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
