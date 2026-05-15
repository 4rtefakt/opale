//go:build darwin

package main

import (
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// Échantillonnage CPU comme sur Linux/Windows : 5 samples × 1s.
const cpuSampleCountDarwin = 5
const cpuSampleIntervalDarwin = 1 * time.Second

func collectSystemPerf() *SystemPerf {
	p := &SystemPerf{}
	queryRAMDarwin(p)
	queryCPULoadDarwin(p)
	queryUptimeDarwin(p)
	queryBatteryDarwin(p)
	return p
}

// ── RAM ───────────────────────────────────────────────────────────────────
// hw.memsize → total. vm.page_pageable_internal_count + page size pour le
// "used" approximatif. En pratique on délègue à `vm_stat` qui est plus simple :
//
//   Pages free:        N
//   Pages active:      N
//   Pages inactive:    N
//   Pages speculative: N
//   Pages wired down:  N
//   Pages purgeable:   N
//   File-backed pages: N
//   Compressed pages:  N
//
// "App Memory" (Activity Monitor) ≈ active + wired + compressed. On simplifie
// en : used = total - (free + inactive + speculative + purgeable).
var vmStatFieldRe = regexp.MustCompile(`(?m)^Pages\s+([\w-]+(?:\s+\w+)*?):\s+(\d+)\.?$`)

func queryRAMDarwin(p *SystemPerf) {
	totalBytes := sysctlUint64("hw.memsize")
	if totalBytes == 0 {
		return
	}
	pageSize := uint64(sysctlUint32("vm.pagesize"))
	if pageSize == 0 {
		pageSize = 4096
	}
	out := runCmd(2*time.Second, "vm_stat")
	if out == "" {
		return
	}
	pages := map[string]uint64{}
	for _, m := range vmStatFieldRe.FindAllStringSubmatch(out, -1) {
		key := strings.ToLower(strings.TrimSpace(m[1]))
		v, _ := strconv.ParseUint(m[2], 10, 64)
		pages[key] = v
	}
	freeIsh := (pages["free"] + pages["inactive"] +
		pages["speculative"] + pages["purgeable"]) * pageSize
	if freeIsh > totalBytes {
		freeIsh = totalBytes
	}
	usedBytes := totalBytes - freeIsh

	p.RAMTotalGB = round2(float64(totalBytes) / (1024 * 1024 * 1024))
	p.RAMUsedGB = round2(float64(usedBytes) / (1024 * 1024 * 1024))
	p.RAMUsedPct = round2(float64(usedBytes) / float64(totalBytes) * 100)
}

// ── Uptime ────────────────────────────────────────────────────────────────
// kern.boottime renvoie un "struct timeval" → on lit en string et on parse,
// ou plus simplement : unix.SysctlTimeval("kern.boottime").
func queryUptimeDarwin(p *SystemPerf) {
	tv, err := unix.SysctlTimeval("kern.boottime")
	if err != nil {
		return
	}
	boot := time.Unix(tv.Sec, int64(tv.Usec)*1000)
	if boot.IsZero() {
		return
	}
	p.UptimeSeconds = int64(time.Since(boot).Seconds())
}

// ── CPU load ──────────────────────────────────────────────────────────────
// Pas de /proc/stat sur macOS. On parse `top -l N -s 1 -n 0` qui imprime
// la ligne "CPU usage: X% user, Y% sys, Z% idle" pour chaque sample, entre
// lesquels top dort 1s. On fait N+1 samples (le 1er est jeté car parfois
// fictif sur le démarrage de top).
//
// Pour CPUMaxPct par-cœur, top ne donne que l'agrégat. On utilise donc avg
// pour les 2 valeurs faute de mieux — info documentée dans le commentaire
// de SystemPerf.CPUMaxPct.
var topCPURe = regexp.MustCompile(`(?i)CPU usage:\s+([\d.]+)%\s+user,\s+([\d.]+)%\s+sys,\s+([\d.]+)%\s+idle`)

func queryCPULoadDarwin(p *SystemPerf) {
	out := runCmd(time.Duration(cpuSampleCountDarwin+2)*time.Second,
		"top", "-l", strconv.Itoa(cpuSampleCountDarwin+1), "-s", "1", "-n", "0")
	if out == "" {
		logWarn("sysperf-cpu-fail", "top output empty", nil)
		return
	}
	matches := topCPURe.FindAllStringSubmatch(out, -1)
	// Skip le 1er sample (ligne "fictive" de top au démarrage).
	if len(matches) > 1 {
		matches = matches[1:]
	}
	if len(matches) == 0 {
		return
	}
	var sum, maxBusy float64
	for _, m := range matches {
		idle, _ := strconv.ParseFloat(m[3], 64)
		busy := 100.0 - idle
		if busy < 0 {
			busy = 0
		}
		if busy > 100 {
			busy = 100
		}
		sum += busy
		if busy > maxBusy {
			maxBusy = busy
		}
	}
	p.CPUAvgPct = round2(sum / float64(len(matches)))
	p.CPUMaxPct = round2(maxBusy)
}

// ── Batterie (pct + status) ───────────────────────────────────────────────
// `pmset -g batt` exemple :
//   Now drawing from 'Battery Power'
//    -InternalBattery-0 (id=4456547)	78%; discharging; 4:23 remaining present: true
var pmsetPctRe = regexp.MustCompile(`(\d+)%\s*;\s*([\w\s]+?)\s*[;,]`)

func queryBatteryDarwin(p *SystemPerf) {
	out := runCmd(2*time.Second, "pmset", "-g", "batt")
	if out == "" {
		return
	}
	m := pmsetPctRe.FindStringSubmatch(out)
	if m == nil {
		return
	}
	pct, err := strconv.Atoi(m[1])
	if err != nil {
		return
	}
	p.BatteryPct = &pct
	state := strings.ToLower(strings.TrimSpace(m[2]))
	switch {
	case strings.Contains(state, "charged") || strings.Contains(state, "finished"):
		p.BatteryStatus = "full"
	case strings.Contains(state, "charging"):
		p.BatteryStatus = "charging"
	case strings.Contains(state, "discharging"):
		if pct <= 5 {
			p.BatteryStatus = "critical"
		} else if pct <= 15 {
			p.BatteryStatus = "low"
		} else {
			p.BatteryStatus = "discharging"
		}
	case strings.Contains(state, "ac"):
		p.BatteryStatus = "ac"
	}
	// pmset header "Now drawing from 'AC Power'" → pas branché si Battery
	if strings.Contains(out, "AC Power") && p.BatteryStatus == "" {
		p.BatteryStatus = "ac"
	}
}
