//go:build darwin

package main

import (
	"net"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// CollectMetrics — collecte via sysctl, system_profiler, /sbin/mount, etc.
// Toute erreur sur une métrique secondaire est non bloquante.
func CollectMetrics() (*CheckinPayload, error) {
	p := &CheckinPayload{}
	p.Hostname, _ = os.Hostname()

	p.Manufacturer = "Apple Inc."
	p.Model = sysctlString("hw.model")
	p.Serial = readSerialNumber()
	p.BIOSVersion = readBootROMVersion()

	osCaption, osBuild := readOSInfoDarwin()
	p.OS = osCaption
	p.OSBuild = osBuild

	p.CPU = readCPUNameDarwin()
	p.RAMGB = readTotalRAMGBDarwin()

	p.Disks = collectDisksDarwin()
	p.Network = collectNetworkDarwin()
	p.IPNetbird = pickNetbirdIP(p.Network)
	p.Bandwidth = collectBandwidthDarwin()
	p.Ping = []PingStats{pingHost("1.1.1.1")}
	p.Health = collectHealth()
	p.SystemInfo = collectSystemInfo()
	// SystemPerf échantillonne le CPU pendant ~5s — dernier pour ne pas
	// polluer les autres collectes.
	p.SystemPerf = collectSystemPerf()
	return p, nil
}

// ── sysctl helpers ────────────────────────────────────────────────────────
// Wrappers fins autour de unix.Sysctl[Uint32|Uint64]. unix.Sysctl renvoie
// la valeur trim de NUL pour les strings.
func sysctlString(name string) string {
	v, err := unix.Sysctl(name)
	if err != nil {
		return ""
	}
	return strings.TrimRight(v, "\x00")
}

func sysctlUint64(name string) uint64 {
	v, err := unix.SysctlUint64(name)
	if err != nil {
		return 0
	}
	return v
}

func sysctlUint32(name string) uint32 {
	v, err := unix.SysctlUint32(name)
	if err != nil {
		return 0
	}
	return v
}

// ── OS / build ────────────────────────────────────────────────────────────
// `sw_vers` expose ProductName / ProductVersion / BuildVersion.
func readOSInfoDarwin() (caption, build string) {
	name := strings.TrimSpace(runCmd(2*time.Second, "sw_vers", "-productName"))
	ver := strings.TrimSpace(runCmd(2*time.Second, "sw_vers", "-productVersion"))
	build = strings.TrimSpace(runCmd(2*time.Second, "sw_vers", "-buildVersion"))
	if name == "" {
		name = "macOS"
	}
	caption = strings.TrimSpace(name + " " + ver)
	return
}

// ── Serial + Boot ROM via ioreg ───────────────────────────────────────────
// `ioreg -c IOPlatformExpertDevice -d 2 -r` expose IOPlatformSerialNumber.
// `system_profiler SPHardwareDataType` plus humain mais beaucoup plus lent
// (1-2s d'init du framework).
var ioregSerialRe = regexp.MustCompile(`"IOPlatformSerialNumber"\s*=\s*"([^"]+)"`)

func readSerialNumber() string {
	out := runCmd(3*time.Second, "ioreg", "-c", "IOPlatformExpertDevice", "-d", "2", "-r")
	if m := ioregSerialRe.FindStringSubmatch(out); m != nil {
		return m[1]
	}
	return ""
}

// readBootROMVersion — sur Apple Silicon, `system_profiler SPHardwareDataType`
// expose "System Firmware Version". Sur Intel, "Boot ROM Version". On parse
// les deux pour rester portable.
var bootROMRe = regexp.MustCompile(`(?i)(?:Boot ROM Version|System Firmware Version):\s*(\S+)`)

func readBootROMVersion() string {
	out := runCmd(5*time.Second, "system_profiler", "SPHardwareDataType")
	if m := bootROMRe.FindStringSubmatch(out); m != nil {
		return m[1]
	}
	return ""
}

// ── CPU name ──────────────────────────────────────────────────────────────
// Intel : machdep.cpu.brand_string. Apple Silicon : non exposé via sysctl ;
// on tombe sur `system_profiler SPHardwareDataType` "Chip:" / "Processor Name:".
func readCPUNameDarwin() string {
	if s := sysctlString("machdep.cpu.brand_string"); s != "" {
		return s
	}
	out := runCmd(5*time.Second, "system_profiler", "SPHardwareDataType")
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		for _, prefix := range []string{"Chip:", "Processor Name:"} {
			if strings.HasPrefix(line, prefix) {
				return strings.TrimSpace(strings.TrimPrefix(line, prefix))
			}
		}
	}
	return ""
}

// ── RAM total ─────────────────────────────────────────────────────────────
// hw.memsize en bytes (uint64). Convertit en GB arrondi entier comme Windows.
func readTotalRAMGBDarwin() int {
	bytes := sysctlUint64("hw.memsize")
	if bytes == 0 {
		return 0
	}
	gb := float64(bytes) / (1024 * 1024 * 1024)
	return int(gb + 0.5)
}

// ── Disques ───────────────────────────────────────────────────────────────
// `mount` liste les FS montés. On filtre les FS persistants (apfs, hfs, …),
// puis statfs pour size/free.
func collectDisksDarwin() []Disk {
	out := runCmd(3*time.Second, "/sbin/mount")
	if out == "" {
		return []Disk{}
	}
	disks := []Disk{}
	seen := map[string]bool{}
	// Format : "/dev/disk1s1 on / (apfs, local, journaled)"
	for _, line := range strings.Split(out, "\n") {
		fields := strings.SplitN(line, " on ", 2)
		if len(fields) != 2 {
			continue
		}
		src := strings.TrimSpace(fields[0])
		rest := fields[1]
		// Parse mount point (jusqu'à " (")
		idx := strings.Index(rest, " (")
		if idx < 0 {
			continue
		}
		mnt := rest[:idx]
		opts := rest[idx+2:]
		opts = strings.TrimSuffix(opts, ")")
		fstype := strings.SplitN(opts, ",", 2)[0]
		fstype = strings.TrimSpace(fstype)

		if !isPersistentFSDarwin(fstype) {
			continue
		}
		if !strings.HasPrefix(src, "/dev/") {
			continue
		}
		if seen[src] {
			continue
		}
		seen[src] = true

		var st unix.Statfs_t
		if err := unix.Statfs(mnt, &st); err != nil {
			continue
		}
		size := st.Blocks * uint64(st.Bsize)
		free := st.Bavail * uint64(st.Bsize)
		if size == 0 {
			continue
		}
		// Skip les snapshots APFS sealed system volume (read-only, taille =
		// boot volume → bruit dans l'UI). Heuristique : mount sur "/" + opt
		// "read-only" → skip.
		if mnt == "/" && strings.Contains(opts, "read-only") {
			continue
		}
		usedPct := round1(float64(size-free) / float64(size) * 100)
		disks = append(disks, Disk{
			Letter:  mnt,
			Label:   strings.TrimPrefix(src, "/dev/"),
			SizeGB:  round1(float64(size) / (1024 * 1024 * 1024)),
			UsedPct: usedPct,
		})
	}
	return disks
}

func isPersistentFSDarwin(fs string) bool {
	switch fs {
	case "apfs", "hfs", "exfat", "msdos", "ntfs", "smbfs", "ufs":
		return true
	}
	return false
}

// ── Réseau (mêmes net.Interfaces que Linux) ───────────────────────────────
func collectNetworkDarwin() []NetIface {
	ifaces, err := net.Interfaces()
	if err != nil {
		logWarn("metrics-net-fail", "net.Interfaces failed", LogFields{"error": err.Error()})
		return []NetIface{}
	}
	out := make([]NetIface, 0, len(ifaces))
	for _, ifi := range ifaces {
		if ifi.Flags&net.FlagLoopback != 0 {
			continue
		}
		if ifi.Flags&net.FlagUp == 0 {
			continue
		}
		// macOS expose plein d'interfaces virtuelles inutiles (awdl, llw, anpi).
		if isMacVirtualNoise(ifi.Name) {
			continue
		}
		ip := firstIPv4Darwin(ifi)
		out = append(out, NetIface{
			MAC:     ifi.HardwareAddr.String(),
			IP:      ip,
			Adapter: ifi.Name,
			Type:    classifyAdapter(ifi.Name),
		})
	}
	return out
}

func firstIPv4Darwin(ifi net.Interface) string {
	addrs, err := ifi.Addrs()
	if err != nil {
		return ""
	}
	for _, a := range addrs {
		var ip net.IP
		switch v := a.(type) {
		case *net.IPNet:
			ip = v.IP
		case *net.IPAddr:
			ip = v.IP
		}
		if ip4 := ip.To4(); ip4 != nil && ipv4Re.MatchString(ip4.String()) {
			return ip4.String()
		}
	}
	return ""
}

// isMacVirtualNoise — interfaces internes macOS qu'on ne veut pas remonter.
func isMacVirtualNoise(name string) bool {
	prefixes := []string{"awdl", "llw", "anpi", "ap", "bridge", "stf", "gif"}
	for _, p := range prefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

// ── Bandwidth via netstat -ibn ────────────────────────────────────────────
// `netstat -ibn` colonnes :
//   Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
// Une interface a plusieurs lignes (1 par adresse) ; on dédupe par Name
// en gardant les compteurs de la 1ère ligne (les autres ont les mêmes valeurs
// — ce sont des compteurs par interface, pas par adresse).
func collectBandwidthDarwin() []BandwidthSample {
	out := runCmd(3*time.Second, "netstat", "-ibn")
	if out == "" {
		return []BandwidthSample{}
	}
	samples := []BandwidthSample{}
	seen := map[string]bool{}
	for i, line := range strings.Split(out, "\n") {
		if i == 0 {
			continue // header
		}
		fields := strings.Fields(line)
		if len(fields) < 10 {
			continue
		}
		name := fields[0]
		if name == "lo0" || seen[name] {
			continue
		}
		seen[name] = true
		ibytes, _ := strconv.ParseUint(fields[6], 10, 64)
		obytes, _ := strconv.ParseUint(fields[9], 10, 64)
		samples = append(samples, BandwidthSample{
			Adapter:   name,
			BytesSent: obytes,
			BytesRecv: ibytes,
		})
	}
	return samples
}
