//go:build linux

package main

import (
	"bufio"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// collectSystemInfo — métriques HW + user qui changent rarement. Toute
// erreur sur une sonde est non bloquante : champ absent dans le JSON.
func collectSystemInfo() *SystemInfo {
	info := &SystemInfo{}
	info.Cores, info.Threads, info.CPUMHz = readCPUTopology()
	info.Mainboard = readMainboard()
	info.GPUs = readGPUs()
	info.MonitorsCount = readMonitorsCount()
	info.CurrentUser = readCurrentUser()
	info.BatteryHealth = collectBatteryHealth()
	return info
}

// ── CPU topology ──────────────────────────────────────────────────────────
// /proc/cpuinfo : "processor" = thread logique, "core id" + "physical id"
// pour distinguer les cœurs physiques. "cpu MHz" ou "max freq" pour la fréquence.
func readCPUTopology() (cores, threads, mhz int) {
	f, err := os.Open("/proc/cpuinfo")
	if err != nil {
		logWarn("sysinfo-cpu-topo-fail", "open /proc/cpuinfo failed", LogFields{"error": err.Error()})
		return
	}
	defer f.Close()

	type physCore struct{ phys, core int }
	seenCore := map[physCore]bool{}
	seenProcessor := map[int]bool{}
	currentPhys, currentCore, currentProc := -1, -1, -1
	var maxMHz float64

	flushBlock := func() {
		if currentProc >= 0 {
			seenProcessor[currentProc] = true
		}
		if currentPhys >= 0 && currentCore >= 0 {
			seenCore[physCore{currentPhys, currentCore}] = true
		}
		currentPhys, currentCore, currentProc = -1, -1, -1
	}

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if strings.TrimSpace(line) == "" {
			flushBlock()
			continue
		}
		k, v, ok := splitKV(line)
		if !ok {
			continue
		}
		switch k {
		case "processor":
			if n, err := strconv.Atoi(v); err == nil {
				currentProc = n
			}
		case "physical id":
			if n, err := strconv.Atoi(v); err == nil {
				currentPhys = n
			}
		case "core id":
			if n, err := strconv.Atoi(v); err == nil {
				currentCore = n
			}
		case "cpu MHz":
			if f, err := strconv.ParseFloat(v, 64); err == nil && f > maxMHz {
				maxMHz = f
			}
		}
	}
	flushBlock()

	threads = len(seenProcessor)
	cores = len(seenCore)
	if cores == 0 {
		// CPU sans physical id/core id (ARM, conteneur) : on retombe sur threads.
		cores = threads
	}
	mhz = int(maxMHz + 0.5)
	// Fallback : /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq (kHz)
	if mhz == 0 {
		if b := readTrimmedFile("/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq"); b != "" {
			if khz, err := strconv.Atoi(b); err == nil {
				mhz = khz / 1000
			}
		}
	}
	return
}

func splitKV(line string) (k, v string, ok bool) {
	idx := strings.Index(line, ":")
	if idx < 0 {
		return "", "", false
	}
	return strings.TrimSpace(line[:idx]), strings.TrimSpace(line[idx+1:]), true
}

// ── Mainboard ─────────────────────────────────────────────────────────────
func readMainboard() *Mainboard {
	m := &Mainboard{
		Manufacturer: readTrimmedFile("/sys/class/dmi/id/board_vendor"),
		Product:      readTrimmedFile("/sys/class/dmi/id/board_name"),
		SerialNumber: readTrimmedFile("/sys/class/dmi/id/board_serial"),
	}
	if m.Manufacturer == "" && m.Product == "" {
		return nil
	}
	return m
}

// ── GPUs ──────────────────────────────────────────────────────────────────
// Stratégie en 2 niveaux :
//  1. lspci -mm (si dispo, paquet pciutils) → nom humain "NVIDIA GeForce…"
//  2. fallback sur /sys/class/drm/card?/device/{vendor,driver}
//     (vendor name only, driver = nom du module kernel)
func readGPUs() []GPU {
	if gs := readGPUsFromLspci(); len(gs) > 0 {
		return gs
	}
	return readGPUsFromSys()
}

var lspciVgaRe = regexp.MustCompile(`(?im)^\S+\s+"(?:VGA compatible controller|3D controller|Display controller)"\s+"([^"]*)"\s+"([^"]*)"`)

func readGPUsFromLspci() []GPU {
	out := runCmd(3*time.Second, "lspci", "-mm")
	if out == "" {
		return nil
	}
	gpus := []GPU{}
	for _, m := range lspciVgaRe.FindAllStringSubmatch(out, -1) {
		vendor := strings.TrimSpace(m[1])
		device := strings.TrimSpace(m[2])
		// Strip suffixes type "(rev a1)" en fin de device, peu utiles.
		if i := strings.Index(device, " (rev"); i > 0 {
			device = device[:i]
		}
		name := strings.TrimSpace(vendor + " " + device)
		gpus = append(gpus, GPU{Name: name})
	}
	return gpus
}

func readGPUsFromSys() []GPU {
	matches, err := filepath.Glob("/sys/class/drm/card[0-9]*")
	if err != nil || len(matches) == 0 {
		return nil
	}
	out := []GPU{}
	seen := map[string]bool{}
	for _, p := range matches {
		base := filepath.Base(p)
		// skip "card0-DP-1" et autres connecteurs
		if strings.Contains(base, "-") {
			continue
		}
		device := readTrimmedFile(filepath.Join(p, "device", "device"))
		vendor := readTrimmedFile(filepath.Join(p, "device", "vendor"))
		key := vendor + ":" + device
		if seen[key] {
			continue
		}
		seen[key] = true

		driver := readDriverFromUevent(filepath.Join(p, "device", "uevent"))
		name := gpuVendorName(vendor) + " GPU (" + device + ")"

		out = append(out, GPU{
			Name:          name,
			DriverVersion: driver,
		})
	}
	return out
}

func readDriverFromUevent(p string) string {
	f, err := os.Open(p)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "DRIVER=") {
			return strings.TrimPrefix(line, "DRIVER=")
		}
	}
	return ""
}

func gpuVendorName(idHex string) string {
	switch strings.ToLower(idHex) {
	case "0x10de":
		return "NVIDIA"
	case "0x1002":
		return "AMD"
	case "0x8086":
		return "Intel"
	}
	return "Unknown"
}

// ── Monitors count ────────────────────────────────────────────────────────
// /sys/class/drm/*/status contient "connected"/"disconnected" pour chaque
// connecteur. Compte les lignes "connected".
func readMonitorsCount() int {
	matches, err := filepath.Glob("/sys/class/drm/*/status")
	if err != nil {
		return 0
	}
	count := 0
	for _, p := range matches {
		if readTrimmedFile(p) == "connected" {
			count++
		}
	}
	return count
}

// ── Current user ──────────────────────────────────────────────────────────
// utmp est un format binaire — on délègue à `who` (paquet base sur la plupart
// des distros). Renvoie "" si aucun user loggué localement.
func readCurrentUser() string {
	out := runCmd(2*time.Second, "who")
	if out == "" {
		return ""
	}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		// On préfère les sessions tty (interactives) plutôt que pts/ssh
		if strings.HasPrefix(fields[1], "tty") || strings.HasPrefix(fields[1], ":") {
			return fields[0]
		}
	}
	// Fallback : premier user de la liste
	first := strings.SplitN(out, "\n", 2)[0]
	if fields := strings.Fields(first); len(fields) > 0 {
		return fields[0]
	}
	return ""
}

// ── Battery health ────────────────────────────────────────────────────────
// /sys/class/power_supply/BAT*/{energy_full,energy_full_design,charge_full,
// charge_full_design,cycle_count,technology}. energy_* est en µWh, charge_*
// en µAh — selon ce que le firmware de la batterie expose.
func collectBatteryHealth() *BatteryHealth {
	bats, err := filepath.Glob("/sys/class/power_supply/BAT*")
	if err != nil || len(bats) == 0 {
		return nil
	}
	sort.Strings(bats)
	bat := bats[0] // BAT0 par convention

	energyFull := readUintFile(bat + "/energy_full")
	energyDesign := readUintFile(bat + "/energy_full_design")
	chargeFull := readUintFile(bat + "/charge_full")
	chargeDesign := readUintFile(bat + "/charge_full_design")
	cycle := readUintFile(bat + "/cycle_count")
	chemistry := readTrimmedFile(bat + "/technology")

	var full, design uint32
	if energyFull > 0 && energyDesign > 0 {
		// µWh → mWh
		full = uint32(energyFull / 1000)
		design = uint32(energyDesign / 1000)
	} else if chargeFull > 0 && chargeDesign > 0 {
		// µAh — on garde la valeur relative pour healthPct, mais les
		// "designed_mwh" / "full_charge_mwh" exposés deviennent des mAh.
		full = uint32(chargeFull / 1000)
		design = uint32(chargeDesign / 1000)
	} else {
		return nil
	}
	if design == 0 {
		return nil
	}
	healthPct := float64(full) / float64(design) * 100
	if healthPct > 100 {
		healthPct = 100
	}
	return &BatteryHealth{
		HealthPct:     round2(healthPct),
		DesignedMWh:   design,
		FullChargeMWh: full,
		CycleCount:    uint32(cycle),
		Chemistry:     chemistry,
	}
}

func readUintFile(path string) uint64 {
	s := readTrimmedFile(path)
	if s == "" {
		return 0
	}
	v, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		return 0
	}
	return v
}

