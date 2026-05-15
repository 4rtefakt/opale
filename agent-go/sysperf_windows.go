//go:build windows

package main

import (
	"math"
	"strings"
	"time"

	"github.com/yusufpapurcu/wmi"
)

// cpuSampleCount — nombre de samples WMI pour calculer avg/max CPU.
// 5 samples × 1s = 5 secondes ajoutées à la durée du checkin. Compromis
// entre représentativité (vs un instantané) et durée de checkin.
const cpuSampleCount = 5
const cpuSampleInterval = 1 * time.Second

// collectSystemPerf — assemble les métriques perf instantanées.
func collectSystemPerf() *SystemPerf {
	p := &SystemPerf{}
	queryRAM(p)
	queryCPULoad(p)
	queryUptime(p)
	queryBattery(p)
	return p
}

type win32OSPerf struct {
	TotalVisibleMemorySize uint64 // KB
	FreePhysicalMemory     uint64 // KB
	LastBootUpTime         time.Time
}

func queryRAM(p *SystemPerf) {
	var rows []win32OSPerf
	if err := wmi.Query(`SELECT TotalVisibleMemorySize, FreePhysicalMemory, LastBootUpTime FROM Win32_OperatingSystem`, &rows); err != nil {
		logWarn("sysperf-ram-fail", "WMI query failed", LogFields{"error": err.Error()})
		return
	}
	if len(rows) == 0 {
		return
	}
	r := rows[0]
	totalKB := r.TotalVisibleMemorySize
	freeKB := r.FreePhysicalMemory
	if totalKB == 0 {
		return
	}
	p.RAMTotalGB = round2(float64(totalKB) / (1024 * 1024))
	usedKB := totalKB - freeKB
	p.RAMUsedGB = round2(float64(usedKB) / (1024 * 1024))
	p.RAMUsedPct = round2(float64(usedKB) / float64(totalKB) * 100)
}

// queryUptime — appelé séparément pour ne pas dépendre de queryRAM.
func queryUptime(p *SystemPerf) {
	var rows []struct {
		LastBootUpTime time.Time
	}
	if err := wmi.Query(`SELECT LastBootUpTime FROM Win32_OperatingSystem`, &rows); err != nil {
		return
	}
	if len(rows) == 0 || rows[0].LastBootUpTime.IsZero() {
		return
	}
	p.UptimeSeconds = int64(time.Since(rows[0].LastBootUpTime).Seconds())
}

// queryCPULoad — prend cpuSampleCount échantillons par cœur logique
// (Win32_PerfFormattedData_Counters_ProcessorInformation), exclut le
// _Total, calcule avg (moyenne sur tous samples × tous cores) et max
// (pic single-core sur la fenêtre).
type procInfo struct {
	Name                 string
	PercentProcessorTime uint64
}

func queryCPULoad(p *SystemPerf) {
	var sumAll float64
	var sumAllCount int
	var maxAny float64

	for i := 0; i < cpuSampleCount; i++ {
		if i > 0 {
			time.Sleep(cpuSampleInterval)
		}
		var rows []procInfo
		if err := wmi.Query(`SELECT Name, PercentProcessorTime FROM Win32_PerfFormattedData_Counters_ProcessorInformation`, &rows); err != nil {
			logWarn("sysperf-cpu-fail", "WMI query failed", LogFields{"error": err.Error(), "sample": i})
			return
		}
		for _, r := range rows {
			// Exclure agrégats : "_Total" sur l'instance globale,
			// "0,_Total" sur multi-NUMA, et toute Name avec "_Total".
			if strings.Contains(r.Name, "_Total") {
				continue
			}
			pct := float64(r.PercentProcessorTime)
			if pct > 100 {
				pct = 100 // floor sur les rares overshoots du compteur
			}
			sumAll += pct
			sumAllCount++
			if pct > maxAny {
				maxAny = pct
			}
		}
	}

	if sumAllCount > 0 {
		p.CPUAvgPct = round2(sumAll / float64(sumAllCount))
	}
	p.CPUMaxPct = round2(maxAny)
}

type win32Battery struct {
	EstimatedChargeRemaining uint16
	BatteryStatus            uint16
}

func queryBattery(p *SystemPerf) {
	var rows []win32Battery
	if err := wmi.Query(`SELECT EstimatedChargeRemaining, BatteryStatus FROM Win32_Battery`, &rows); err != nil {
		// Pas de batterie (desktop) → champs absents, c'est OK
		return
	}
	if len(rows) == 0 {
		return
	}
	r := rows[0]
	pct := int(r.EstimatedChargeRemaining)
	p.BatteryPct = &pct
	p.BatteryStatus = batteryStatusName(r.BatteryStatus)
}

// Cf. Win32_Battery.BatteryStatus :
//   1=Discharging, 2=AC connected, 3=Fully Charged, 4=Low, 5=Critical,
//   6=Charging, 7=Charging+High, 8=Charging+Low, 9=Charging+Critical,
//   10=Undefined, 11=Partially Charged
func batteryStatusName(s uint16) string {
	switch s {
	case 1:
		return "discharging"
	case 2:
		return "ac"
	case 3:
		return "full"
	case 4:
		return "low"
	case 5:
		return "critical"
	case 6, 7, 8, 9:
		return "charging"
	case 11:
		return "partial"
	}
	return ""
}

func round2(f float64) float64 {
	return math.Round(f*100) / 100
}
