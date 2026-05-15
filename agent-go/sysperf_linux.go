//go:build linux

package main

import (
	"bufio"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Échantillonnage CPU : 5 samples espacés d'1s, comme la version Windows.
// Donne du contexte sur la fenêtre du checkin sans gonfler sa durée.
const cpuSampleCountLinux = 5
const cpuSampleIntervalLinux = 1 * time.Second

// collectSystemPerf — assemble les métriques perf instantanées.
func collectSystemPerf() *SystemPerf {
	p := &SystemPerf{}
	queryRAMLinux(p)
	queryCPULoadLinux(p)
	queryUptimeLinux(p)
	queryBatteryLinux(p)
	return p
}

// ── RAM ───────────────────────────────────────────────────────────────────
// /proc/meminfo : MemTotal, MemAvailable (depuis kernel 3.14, calcul "vrai"
// du free incluant le cache récupérable). Fallback MemFree+Buffers+Cached
// si MemAvailable absent.
func queryRAMLinux(p *SystemPerf) {
	totalKB := readMeminfoKB("MemTotal:")
	if totalKB == 0 {
		return
	}
	availKB := readMeminfoKB("MemAvailable:")
	if availKB == 0 {
		// Fallback approximatif sur vieux kernels.
		availKB = readMeminfoKB("MemFree:") +
			readMeminfoKB("Buffers:") +
			readMeminfoKB("Cached:")
	}
	if availKB > totalKB {
		availKB = totalKB
	}
	usedKB := totalKB - availKB
	p.RAMTotalGB = round2(float64(totalKB) / (1024 * 1024))
	p.RAMUsedGB = round2(float64(usedKB) / (1024 * 1024))
	p.RAMUsedPct = round2(float64(usedKB) / float64(totalKB) * 100)
}

// ── Uptime ────────────────────────────────────────────────────────────────
// /proc/uptime : "secondes_uptime secondes_idle". On prend le 1er.
func queryUptimeLinux(p *SystemPerf) {
	b, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return
	}
	fields := strings.Fields(string(b))
	if len(fields) == 0 {
		return
	}
	if up, err := strconv.ParseFloat(fields[0], 64); err == nil {
		p.UptimeSeconds = int64(up)
	}
}

// ── CPU load (5 samples × 1s, avg/max sur cores logiques) ─────────────────
// /proc/stat : "cpu" = agrégat, "cpu0", "cpu1"… = par core. Format :
//
//   cpu  user nice system idle iowait irq softirq steal guest guest_nice
//
// Total = somme de tous, idle "vrai" = idle + iowait.
type cpuTimes struct {
	total uint64
	idle  uint64
}

func queryCPULoadLinux(p *SystemPerf) {
	first, err := readCPUStat()
	if err != nil {
		logWarn("sysperf-cpu-fail", "read /proc/stat failed", LogFields{"error": err.Error()})
		return
	}

	var sumPctAcrossSamples float64
	var nSamples int
	var maxPctAny float64

	for i := 0; i < cpuSampleCountLinux; i++ {
		time.Sleep(cpuSampleIntervalLinux)
		next, err := readCPUStat()
		if err != nil {
			logWarn("sysperf-cpu-fail", "read /proc/stat failed", LogFields{"error": err.Error(), "sample": i})
			return
		}
		// Avg = moyenne sur tous les cores logiques cette window
		var sumPctCores float64
		var nCores int
		for k, prev := range first {
			cur, ok := next[k]
			if !ok {
				continue
			}
			if k == "cpu" {
				continue // on traite les agrégats par-core, pas la ligne globale
			}
			pct := pctBusy(prev, cur)
			sumPctCores += pct
			nCores++
			if pct > maxPctAny {
				maxPctAny = pct
			}
		}
		if nCores > 0 {
			sumPctAcrossSamples += sumPctCores / float64(nCores)
			nSamples++
		}
		first = next
	}

	if nSamples > 0 {
		p.CPUAvgPct = round2(sumPctAcrossSamples / float64(nSamples))
	}
	p.CPUMaxPct = round2(maxPctAny)
}

func readCPUStat() (map[string]cpuTimes, error) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return nil, err
	}
	defer f.Close()
	out := map[string]cpuTimes{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "cpu") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}
		name := fields[0]
		var total uint64
		var idle uint64
		for i, s := range fields[1:] {
			v, err := strconv.ParseUint(s, 10, 64)
			if err != nil {
				continue
			}
			total += v
			if i == 3 || i == 4 { // idle, iowait
				idle += v
			}
		}
		out[name] = cpuTimes{total: total, idle: idle}
	}
	return out, nil
}

func pctBusy(prev, cur cpuTimes) float64 {
	dTotal := float64(cur.total) - float64(prev.total)
	dIdle := float64(cur.idle) - float64(prev.idle)
	if dTotal <= 0 {
		return 0
	}
	pct := (dTotal - dIdle) / dTotal * 100
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	return pct
}

// ── Batterie (pct + status) ───────────────────────────────────────────────
// /sys/class/power_supply/BAT*/{capacity,status}. On préfère BAT0, sinon
// premier match alphabétique. Renvoie nil si pas de batterie.
func queryBatteryLinux(p *SystemPerf) {
	bats, err := filepath.Glob("/sys/class/power_supply/BAT*")
	if err != nil || len(bats) == 0 {
		return
	}
	sort.Strings(bats)
	bat := bats[0]

	capStr := readTrimmedFile(bat + "/capacity")
	if capStr == "" {
		return
	}
	pct, err := strconv.Atoi(capStr)
	if err != nil {
		return
	}
	p.BatteryPct = &pct

	status := strings.ToLower(readTrimmedFile(bat + "/status"))
	switch status {
	case "discharging":
		p.BatteryStatus = "discharging"
	case "charging":
		p.BatteryStatus = "charging"
	case "full":
		p.BatteryStatus = "full"
	case "not charging":
		p.BatteryStatus = "ac"
	default:
		// "Unknown" arrive si le firmware répond pas — on essaye le status
		// AC sibling pour distinguer "branché" de "déchargement".
		if onAC := readTrimmedFile("/sys/class/power_supply/AC/online"); onAC == "1" {
			p.BatteryStatus = "ac"
		}
	}
	if pct <= 5 && (p.BatteryStatus == "discharging" || p.BatteryStatus == "") {
		p.BatteryStatus = "critical"
	} else if pct <= 15 && p.BatteryStatus == "discharging" {
		p.BatteryStatus = "low"
	}
}
