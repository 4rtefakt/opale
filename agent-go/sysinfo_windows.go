//go:build windows

package main

import (
	"strings"
	"time"

	"github.com/yusufpapurcu/wmi"
)

// collectSystemInfo — métriques statiques-ish (HW + user). Toute erreur sur
// une sonde est non bloquante : champ absent dans le JSON.
func collectSystemInfo() *SystemInfo {
	info := &SystemInfo{}
	info.Cores, info.Threads, info.CPUMHz = queryCPUTopology()
	info.Mainboard = queryMainboard()
	info.GPUs = queryGPUs()
	info.MonitorsCount = queryMonitorsCount()
	info.CurrentUser = queryCurrentUser()
	info.BatteryHealth = collectBatteryHealth()
	return info
}

type win32ProcessorTopo struct {
	NumberOfCores             uint32
	NumberOfLogicalProcessors uint32
	MaxClockSpeed             uint32
}

func queryCPUTopology() (cores, threads, mhz int) {
	var rows []win32ProcessorTopo
	if err := wmi.Query(`SELECT NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed FROM Win32_Processor`, &rows); err != nil {
		logWarn("sysinfo-cpu-topo-fail", "WMI query failed", LogFields{"error": err.Error()})
		return
	}
	for _, r := range rows {
		cores += int(r.NumberOfCores)
		threads += int(r.NumberOfLogicalProcessors)
		if int(r.MaxClockSpeed) > mhz {
			mhz = int(r.MaxClockSpeed)
		}
	}
	return
}

type win32BaseBoard struct {
	Manufacturer string
	Product      string
	SerialNumber string
}

func queryMainboard() *Mainboard {
	var rows []win32BaseBoard
	if err := wmi.Query(`SELECT Manufacturer, Product, SerialNumber FROM Win32_BaseBoard`, &rows); err != nil {
		logWarn("sysinfo-mainboard-fail", "WMI query failed", LogFields{"error": err.Error()})
		return nil
	}
	if len(rows) == 0 {
		return nil
	}
	m := &Mainboard{
		Manufacturer: strings.TrimSpace(rows[0].Manufacturer),
		Product:      strings.TrimSpace(rows[0].Product),
		SerialNumber: strings.TrimSpace(rows[0].SerialNumber),
	}
	if m.Manufacturer == "" && m.Product == "" {
		return nil
	}
	return m
}

type win32VideoController struct {
	Name          string
	DriverVersion string
	DriverDate    time.Time
	Status        string
}

func queryGPUs() []GPU {
	var rows []win32VideoController
	if err := wmi.Query(`SELECT Name, DriverVersion, DriverDate, Status FROM Win32_VideoController`, &rows); err != nil {
		logWarn("sysinfo-gpu-fail", "WMI query failed", LogFields{"error": err.Error()})
		return nil
	}
	out := make([]GPU, 0, len(rows))
	for _, r := range rows {
		// Filtrer les "video controllers" génériques sans nom utile
		if strings.TrimSpace(r.Name) == "" {
			continue
		}
		g := GPU{
			Name:          strings.TrimSpace(r.Name),
			DriverVersion: strings.TrimSpace(r.DriverVersion),
		}
		if !r.DriverDate.IsZero() {
			g.DriverDate = r.DriverDate.Format("2006-01-02")
		}
		out = append(out, g)
	}
	return out
}

// queryMonitorsCount — Win32_DesktopMonitor a une réputation d'imprécision
// sur Win10/11, mais il reste le moyen le plus simple sans toucher à l'API
// EnumDisplayMonitors. On filtre sur Status='OK' pour ignorer les disconnectés.
type win32DesktopMonitor struct {
	DeviceID string
	Status   string
}

func queryMonitorsCount() int {
	var rows []win32DesktopMonitor
	if err := wmi.Query(`SELECT DeviceID, Status FROM Win32_DesktopMonitor`, &rows); err != nil {
		// Fallback : on essaie WmiMonitorID dans root\WMI (plus fiable)
		return queryMonitorsCountWMI()
	}
	count := 0
	for _, r := range rows {
		if strings.EqualFold(r.Status, "OK") {
			count++
		}
	}
	if count == 0 {
		// Si le filtre Status n'a rien retenu, on retombe sur WmiMonitorID
		return queryMonitorsCountWMI()
	}
	return count
}

type wmiMonitorID struct {
	Active bool
}

func queryMonitorsCountWMI() int {
	var rows []wmiMonitorID
	if err := wmi.QueryNamespace(`SELECT Active FROM WmiMonitorID`, &rows, `root\WMI`); err != nil {
		return 0
	}
	count := 0
	for _, r := range rows {
		if r.Active {
			count++
		}
	}
	return count
}

// queryCurrentUser — interactif local. Win32_ComputerSystem.UserName
// retourne "DOMAIN\user" du user actuellement loggué localement, ou null
// si personne. Ne capture PAS les sessions RDP.
type win32CSUser struct {
	UserName string
}

func queryCurrentUser() string {
	var rows []win32CSUser
	if err := wmi.Query(`SELECT UserName FROM Win32_ComputerSystem`, &rows); err != nil {
		return ""
	}
	if len(rows) == 0 {
		return ""
	}
	return strings.TrimSpace(rows[0].UserName)
}
