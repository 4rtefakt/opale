//go:build windows

package main

import (
	"fmt"
	"math"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/yusufpapurcu/wmi"
)

// CollectMetrics — collecte WMI + Win32 reproduisant l'inventaire de
// inventory.ps1. Toute erreur sur une métrique secondaire est loggée
// mais non bloquante : on remonte ce qu'on a.
func CollectMetrics() (*CheckinPayload, error) {
	p := &CheckinPayload{}
	host, _ := os.Hostname()
	p.Hostname = host

	if cs, err := queryComputerSystem(); err == nil {
		p.Model = cs.Model
		p.Manufacturer = cs.Manufacturer
		p.RAMGB = int(math.Round(float64(cs.TotalPhysicalMemory) / (1024 * 1024 * 1024)))
	} else {
		logf("WMI ComputerSystem : %v", err)
	}

	if osi, err := queryOS(); err == nil {
		p.OS = osi.Caption
		p.OSBuild = osi.BuildNumber
	} else {
		logf("WMI OS : %v", err)
	}

	if bios, err := queryBIOS(); err == nil {
		p.Serial = bios.SerialNumber
		p.BIOSVersion = bios.SMBIOSBIOSVersion
	} else {
		logf("WMI BIOS : %v", err)
	}

	if cpu, err := queryCPU(); err == nil {
		p.CPU = cpu.Name
	} else {
		logf("WMI CPU : %v", err)
	}

	p.Disks = collectDisks()
	p.Network = collectNetwork()
	p.IPNetbird = pickNetbirdIP(p.Network)
	p.Bandwidth = collectBandwidth()
	p.Ping = []PingStats{pingHost("1.1.1.1")}
	p.Health = collectHealth()
	p.SystemInfo = collectSystemInfo()
	// SystemPerf échantillonne le CPU pendant ~5s — le mettre en dernier
	// pour que les autres collectes (bandwidth, disks…) ne mesurent pas
	// déjà notre propre activité.
	p.SystemPerf = collectSystemPerf()
	return p, nil
}

// ── WMI structs (champs nommés exactement comme dans CIM) ─────────────────
type win32ComputerSystem struct {
	Model               string
	Manufacturer        string
	TotalPhysicalMemory uint64
}

type win32OS struct {
	Caption     string
	BuildNumber string
}

type win32BIOS struct {
	SerialNumber       string
	SMBIOSBIOSVersion  string
}

type win32Processor struct {
	Name string
}

type win32LogicalDisk struct {
	DeviceID   string
	VolumeName string
	Size       uint64
	FreeSpace  uint64
	DriveType  uint32
}

type win32NetworkAdapterConfiguration struct {
	MACAddress     string
	IPAddress      []string
	Description    string
	InterfaceIndex uint32
	IPEnabled      bool
}

type win32NetworkAdapter struct {
	InterfaceIndex uint32
	Name           string
	NetEnabled     bool
}

type win32PerfRawDataNetworkInterface struct {
	Name                  string
	BytesSentPerSec       uint64
	BytesReceivedPerSec   uint64
	BytesTotalPerSec      uint64
}

func queryComputerSystem() (*win32ComputerSystem, error) {
	var rows []win32ComputerSystem
	if err := wmi.Query(`SELECT Model, Manufacturer, TotalPhysicalMemory FROM Win32_ComputerSystem`, &rows); err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("vide")
	}
	return &rows[0], nil
}

func queryOS() (*win32OS, error) {
	var rows []win32OS
	if err := wmi.Query(`SELECT Caption, BuildNumber FROM Win32_OperatingSystem`, &rows); err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("vide")
	}
	return &rows[0], nil
}

func queryBIOS() (*win32BIOS, error) {
	var rows []win32BIOS
	if err := wmi.Query(`SELECT SerialNumber, SMBIOSBIOSVersion FROM Win32_BIOS`, &rows); err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("vide")
	}
	return &rows[0], nil
}

func queryCPU() (*win32Processor, error) {
	var rows []win32Processor
	if err := wmi.Query(`SELECT Name FROM Win32_Processor`, &rows); err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("vide")
	}
	return &rows[0], nil
}

func collectDisks() []Disk {
	var rows []win32LogicalDisk
	if err := wmi.Query(`SELECT DeviceID, VolumeName, Size, FreeSpace, DriveType FROM Win32_LogicalDisk`, &rows); err != nil {
		logf("WMI LogicalDisk : %v", err)
		return []Disk{}
	}
	out := make([]Disk, 0, len(rows))
	for _, r := range rows {
		if r.DriveType != 3 { // 3 = local fixed disk
			continue
		}
		sizeGB := round1(float64(r.Size) / (1024 * 1024 * 1024))
		usedPct := 0.0
		if r.Size > 0 {
			usedPct = round1(float64(r.Size-r.FreeSpace) / float64(r.Size) * 100)
		}
		out = append(out, Disk{
			Letter:  r.DeviceID,
			Label:   r.VolumeName,
			SizeGB:  sizeGB,
			UsedPct: usedPct,
		})
	}
	return out
}

var ipv4Re = regexp.MustCompile(`^\d+\.\d+\.\d+\.\d+$`)

func collectNetwork() []NetIface {
	var cfgs []win32NetworkAdapterConfiguration
	if err := wmi.Query(`SELECT MACAddress, IPAddress, Description, InterfaceIndex, IPEnabled FROM Win32_NetworkAdapterConfiguration WHERE IPEnabled = TRUE`, &cfgs); err != nil {
		logf("WMI NetworkAdapterConfiguration : %v", err)
		return []NetIface{}
	}
	var adapters []win32NetworkAdapter
	if err := wmi.Query(`SELECT InterfaceIndex, Name, NetEnabled FROM Win32_NetworkAdapter WHERE NetEnabled = TRUE`, &adapters); err != nil {
		logf("WMI NetworkAdapter : %v", err)
	}
	idxToName := make(map[uint32]string, len(adapters))
	for _, a := range adapters {
		idxToName[a.InterfaceIndex] = a.Name
	}

	out := make([]NetIface, 0, len(cfgs))
	for _, c := range cfgs {
		// On garde même les interfaces sans MAC (ex. tunnel WireGuard) :
		// l'API les ignore pour la table network_interfaces, mais pickNetbirdIP
		// en a besoin pour exposer l'IP Netbird sur le device.
		ip := ""
		for _, addr := range c.IPAddress {
			if ipv4Re.MatchString(addr) {
				ip = addr
				break
			}
		}
		name := idxToName[c.InterfaceIndex]
		if name == "" {
			name = c.Description
		}
		t := classifyAdapter(name)
		out = append(out, NetIface{
			MAC:     c.MACAddress,
			IP:      ip,
			Adapter: name,
			Type:    t,
		})
	}
	return out
}

func classifyAdapter(name string) string {
	low := strings.ToLower(name)
	switch {
	case strings.Contains(low, "netbird"), strings.Contains(low, "wireguard"):
		return "netbird"
	case strings.Contains(low, "wi-fi"), strings.Contains(low, "wifi"), strings.Contains(low, "wireless"):
		return "wifi"
	default:
		return "eth"
	}
}

func pickNetbirdIP(ifaces []NetIface) string {
	for _, i := range ifaces {
		if i.Type == "netbird" {
			return i.IP
		}
	}
	for _, i := range ifaces {
		if strings.HasPrefix(i.IP, "100.") {
			return i.IP
		}
	}
	return ""
}

func collectBandwidth() []BandwidthSample {
	// Win32_PerfRawData_Tcpip_NetworkInterface expose les compteurs absolus
	// (cumulés depuis le boot), comme inventory.ps1 via Get-NetAdapterStatistics.
	var rows []struct {
		Name                string
		BytesSentPersec     uint64
		BytesReceivedPersec uint64
	}
	if err := wmi.Query(`SELECT Name, BytesSentPersec, BytesReceivedPersec FROM Win32_PerfRawData_Tcpip_NetworkInterface`, &rows); err != nil {
		logf("WMI PerfRawData : %v", err)
		return []BandwidthSample{}
	}
	out := make([]BandwidthSample, 0, len(rows))
	for _, r := range rows {
		if r.Name == "" || strings.HasPrefix(r.Name, "_Total") || strings.HasPrefix(r.Name, "isatap") {
			continue
		}
		out = append(out, BandwidthSample{
			Adapter:   normalizePerfName(r.Name),
			BytesSent: r.BytesSentPersec,
			BytesRecv: r.BytesReceivedPersec,
		})
	}
	return out
}

// PerfRawData remplace certains caractères ; on tente de revenir au nom
// d'adaptateur "humain" pour matcher l'inventory.ps1 (qui utilise Get-NetAdapter).
func normalizePerfName(s string) string {
	s = strings.ReplaceAll(s, "[", "(")
	s = strings.ReplaceAll(s, "]", ")")
	s = strings.ReplaceAll(s, "_", " ")
	return strings.TrimSpace(s)
}

// pingHost — délègue à ping.exe natif. Plus simple que de gérer ICMP raw
// (qui requiert SeImpersonatePrivilege), et donne le même format que PS.
func pingHost(host string) PingStats {
	out := PingStats{Host: host, PacketLossPct: 100}
	cmd := exec.Command("ping.exe", "-n", "4", "-w", "2000", host)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}

	type result struct {
		output []byte
		err    error
	}
	ch := make(chan result, 1)
	go func() {
		o, e := cmd.CombinedOutput()
		ch <- result{o, e}
	}()
	select {
	case <-time.After(15 * time.Second):
		_ = cmd.Process.Kill()
		return out
	case r := <-ch:
		if r.err != nil && len(r.output) == 0 {
			return out
		}
		return parsePing(string(r.output), host)
	}
}

var (
	pingReplyRe   = regexp.MustCompile(`(?i)temps[<=](\d+)\s*ms|time[<=](\d+)\s*ms`)
	pingLossRe    = regexp.MustCompile(`(?i)\((\d+)%\s+(?:de\s+)?(?:perte|loss)`)
)

func parsePing(out, host string) PingStats {
	stats := PingStats{Host: host, PacketLossPct: 100}
	var samples []float64
	for _, m := range pingReplyRe.FindAllStringSubmatch(out, -1) {
		v := m[1]
		if v == "" {
			v = m[2]
		}
		if n, err := strconv.Atoi(v); err == nil {
			samples = append(samples, float64(n))
		}
	}
	if len(samples) > 0 {
		var sum float64
		for _, s := range samples {
			sum += s
		}
		avg := round1(sum / float64(len(samples)))
		stats.LatencyMs = &avg
	}
	if m := pingLossRe.FindStringSubmatch(out); m != nil {
		if n, err := strconv.Atoi(m[1]); err == nil {
			stats.PacketLossPct = n
		}
	} else if len(samples) == 4 {
		stats.PacketLossPct = 0
	} else if len(samples) > 0 {
		stats.PacketLossPct = int(math.Round(float64(4-len(samples)) / 4 * 100))
	}
	return stats
}

func round1(f float64) float64 { return math.Round(f*10) / 10 }
