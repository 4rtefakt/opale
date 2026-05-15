//go:build darwin

package main

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// collectSystemInfo — métriques HW + user (CPU topology, mainboard, GPU,
// monitors, current user, battery health). Toute erreur est non bloquante.
func collectSystemInfo() *SystemInfo {
	info := &SystemInfo{}
	info.Cores, info.Threads, info.CPUMHz = readCPUTopologyDarwin()
	info.Mainboard = readMainboardDarwin()
	info.GPUs = readGPUsDarwin()
	info.MonitorsCount = readMonitorsCountDarwin()
	info.CurrentUser = readCurrentUserDarwin()
	info.BatteryHealth = collectBatteryHealthDarwin()
	return info
}

// ── CPU topology ──────────────────────────────────────────────────────────
// hw.physicalcpu / hw.logicalcpu / hw.cpufrequency (Hz, Intel uniquement —
// pas exposé sur Apple Silicon, on retombe sur 0 → champ omitempty).
func readCPUTopologyDarwin() (cores, threads, mhz int) {
	cores = int(sysctlUint32("hw.physicalcpu"))
	threads = int(sysctlUint32("hw.logicalcpu"))
	if hz := sysctlUint64("hw.cpufrequency"); hz > 0 {
		mhz = int(hz / 1_000_000)
	}
	if cores == 0 {
		// Fallback historique
		cores = int(sysctlUint32("machdep.cpu.core_count"))
	}
	if threads == 0 {
		threads = int(sysctlUint32("machdep.cpu.thread_count"))
	}
	return
}

// ── Mainboard ─────────────────────────────────────────────────────────────
// Sur Mac : pas de notion classique de "carte mère". On expose le modèle
// Apple comme proxy.
func readMainboardDarwin() *Mainboard {
	model := sysctlString("hw.model")
	if model == "" {
		return nil
	}
	return &Mainboard{
		Manufacturer: "Apple Inc.",
		Product:      model,
	}
}

// ── GPUs ──────────────────────────────────────────────────────────────────
// system_profiler SPDisplaysDataType donne le nom + chipset model.
// Format approximatif :
//   Apple M2 Pro:
//       Chipset Model: Apple M2 Pro
//       Type: GPU
//       Bus: Built-In
var gpuChipsetRe = regexp.MustCompile(`(?m)^\s*Chipset Model:\s*(.+)$`)

func readGPUsDarwin() []GPU {
	out := runCmd(5*time.Second, "system_profiler", "SPDisplaysDataType")
	if out == "" {
		return nil
	}
	gpus := []GPU{}
	seen := map[string]bool{}
	for _, m := range gpuChipsetRe.FindAllStringSubmatch(out, -1) {
		name := strings.TrimSpace(m[1])
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		gpus = append(gpus, GPU{Name: name})
	}
	return gpus
}

// ── Monitors count ────────────────────────────────────────────────────────
// system_profiler SPDisplaysDataType liste les "Display Type:" sous chaque GPU.
// On compte les "Resolution:" qui marquent un display physiquement attaché.
var monitorRe = regexp.MustCompile(`(?m)^\s*Resolution:\s*\d+`)

func readMonitorsCountDarwin() int {
	out := runCmd(5*time.Second, "system_profiler", "SPDisplaysDataType")
	if out == "" {
		return 0
	}
	return len(monitorRe.FindAllString(out, -1))
}

// ── Current user ──────────────────────────────────────────────────────────
// `stat -f %Su /dev/console` renvoie l'utilisateur loggué dans la GUI
// (équivalent de "interactif local"). Renvoie "root" si personne loggué.
func readCurrentUserDarwin() string {
	out := strings.TrimSpace(runCmd(2*time.Second, "stat", "-f", "%Su", "/dev/console"))
	if out == "" || out == "root" {
		return ""
	}
	return out
}

// ── Battery health ────────────────────────────────────────────────────────
// `ioreg -r -c AppleSmartBattery` expose CycleCount, MaxCapacity (mAh),
// DesignCapacity (mAh), AppleRawMaxCapacity, AppleRawCurrentCapacity, Serial…
// Sur Apple Silicon récents, certains champs ont été renommés (NominalChargeCapacity).
var (
	ioregIntFieldRe = func(name string) *regexp.Regexp {
		return regexp.MustCompile(`"` + name + `"\s*=\s*(\d+)`)
	}
)

func collectBatteryHealthDarwin() *BatteryHealth {
	out := runCmd(3*time.Second, "ioreg", "-r", "-c", "AppleSmartBattery")
	if out == "" {
		return nil
	}
	maxCap := ioregInt(out, "MaxCapacity")
	if maxCap == 0 {
		maxCap = ioregInt(out, "AppleRawMaxCapacity")
	}
	if maxCap == 0 {
		maxCap = ioregInt(out, "NominalChargeCapacity")
	}
	designCap := ioregInt(out, "DesignCapacity")
	if maxCap == 0 || designCap == 0 {
		return nil
	}
	cycle := ioregInt(out, "CycleCount")

	healthPct := float64(maxCap) / float64(designCap) * 100
	if healthPct > 100 {
		healthPct = 100
	}
	return &BatteryHealth{
		HealthPct:     round2(healthPct),
		DesignedMWh:   uint32(designCap),
		FullChargeMWh: uint32(maxCap),
		CycleCount:    uint32(cycle),
		Chemistry:     "LION", // Apple ne sort que des Li-ion ; champ informatif
	}
}

func ioregInt(text, field string) int {
	m := ioregIntFieldRe(field).FindStringSubmatch(text)
	if m == nil {
		return 0
	}
	v, err := strconv.Atoi(m[1])
	if err != nil {
		return 0
	}
	return v
}
