//go:build linux

package main

import (
	"bufio"
	"net"
	"os"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// CollectMetrics — collecte via /proc, /sys et net.Interfaces. Toute erreur
// sur une métrique secondaire est non bloquante : on remonte ce qu'on a.
func CollectMetrics() (*CheckinPayload, error) {
	p := &CheckinPayload{}
	p.Hostname, _ = os.Hostname()

	dmi := readDMIInfo()
	p.Manufacturer = dmi.sysVendor
	p.Model = dmi.productName
	p.Serial = dmi.productSerial
	p.BIOSVersion = dmi.biosVersion

	osCaption, osBuild := readOSInfo()
	p.OS = osCaption
	p.OSBuild = osBuild

	p.CPU = readCPUName()
	p.RAMGB = readTotalRAMGB()

	p.Disks = collectDisks()
	p.Network = collectNetwork()
	p.IPNetbird = pickNetbirdIP(p.Network)
	p.Bandwidth = collectBandwidth()
	p.Ping = []PingStats{pingHost("1.1.1.1")}
	p.Health = collectHealth()
	p.SystemInfo = collectSystemInfo()
	// SystemPerf échantillonne le CPU pendant ~5s — le mettre en dernier
	// pour que les autres collectes ne mesurent pas notre propre activité.
	p.SystemPerf = collectSystemPerf()
	return p, nil
}

// ── DMI / SMBIOS ──────────────────────────────────────────────────────────
// /sys/class/dmi/id/* expose tous les champs SMBIOS sans nécessiter dmidecode
// (qui est root-only). Les fichiers sont accessibles à tout user — sauf
// product_serial/board_serial qui requièrent root sur la plupart des distros.
type dmiInfo struct {
	sysVendor     string
	productName   string
	productSerial string
	biosVersion   string
}

func readDMIInfo() dmiInfo {
	return dmiInfo{
		sysVendor:     readTrimmedFile("/sys/class/dmi/id/sys_vendor"),
		productName:   readTrimmedFile("/sys/class/dmi/id/product_name"),
		productSerial: readTrimmedFile("/sys/class/dmi/id/product_serial"),
		biosVersion:   readTrimmedFile("/sys/class/dmi/id/bios_version"),
	}
}

// ── OS / kernel ───────────────────────────────────────────────────────────
// /etc/os-release → PRETTY_NAME (caption humain), VERSION_ID, ID, etc.
// Build = uname -r (kernel) car concept de "BuildNumber" Windows non équivalent.
func readOSInfo() (caption, build string) {
	caption = osReleasePretty()
	if caption == "" {
		caption = "Linux"
	}
	var u unix.Utsname
	if err := unix.Uname(&u); err == nil {
		build = unixCStr(u.Release[:])
	}
	return
}

func osReleasePretty() string {
	for _, p := range []string{"/etc/os-release", "/usr/lib/os-release"} {
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		defer f.Close()
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			line := sc.Text()
			if !strings.HasPrefix(line, "PRETTY_NAME=") {
				continue
			}
			v := strings.TrimPrefix(line, "PRETTY_NAME=")
			v = strings.Trim(v, `"`)
			return v
		}
	}
	return ""
}

// unixCStr convertit un buffer C-string (utsname) en string Go en s'arrêtant
// au premier NUL.
func unixCStr(b []byte) string {
	for i, c := range b {
		if c == 0 {
			return string(b[:i])
		}
	}
	return string(b)
}

// ── CPU name ──────────────────────────────────────────────────────────────
// /proc/cpuinfo : "model name" (x86) ou "Hardware"/"Model" (ARM/RPi).
func readCPUName() string {
	f, err := os.Open("/proc/cpuinfo")
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		for _, key := range []string{"model name", "Hardware", "cpu model", "Processor"} {
			if strings.HasPrefix(line, key) {
				if idx := strings.Index(line, ":"); idx >= 0 {
					return strings.TrimSpace(line[idx+1:])
				}
			}
		}
	}
	return ""
}

// ── RAM total (GB arrondi entier) ─────────────────────────────────────────
// /proc/meminfo : MemTotal en kB.
func readTotalRAMGB() int {
	kb := readMeminfoKB("MemTotal:")
	if kb == 0 {
		return 0
	}
	gb := float64(kb) / (1024 * 1024)
	return int(gb + 0.5)
}

func readMeminfoKB(prefix string) uint64 {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, prefix) {
			continue
		}
		fields := strings.Fields(strings.TrimPrefix(line, prefix))
		if len(fields) == 0 {
			return 0
		}
		v, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			return 0
		}
		return v
	}
	return 0
}

// ── Disques ───────────────────────────────────────────────────────────────
// /proc/mounts → on filtre les FS "réels" (ext4/btrfs/xfs/zfs/f2fs/vfat/…).
// Skip /proc, /sys, /dev, snap, overlay, tmpfs et bind mounts dupliqués.
func collectDisks() []Disk {
	f, err := os.Open("/proc/mounts")
	if err != nil {
		logWarn("metrics-disks-fail", "open /proc/mounts failed", LogFields{"error": err.Error()})
		return []Disk{}
	}
	defer f.Close()

	out := []Disk{}
	seenSource := map[string]bool{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 3 {
			continue
		}
		src, mnt, fstype := fields[0], fields[1], fields[2]
		if !isPersistentFS(fstype) {
			continue
		}
		if !strings.HasPrefix(src, "/dev/") {
			continue
		}
		// Skip overlay snap/flatpak mounts qui réfèrent à des loop dev
		if strings.Contains(mnt, "/snap/") || strings.Contains(mnt, "/var/lib/docker") {
			continue
		}
		// Dédup : si le même /dev/sdaN est monté à plusieurs endroits (bind),
		// on garde le premier.
		if seenSource[src] {
			continue
		}
		seenSource[src] = true

		var st unix.Statfs_t
		if err := unix.Statfs(mnt, &st); err != nil {
			continue
		}
		size := st.Blocks * uint64(st.Bsize)
		free := st.Bavail * uint64(st.Bsize)
		if size == 0 {
			continue
		}
		usedPct := round1(float64(size-free) / float64(size) * 100)
		out = append(out, Disk{
			Letter:  mnt,                                    // pas de notion de "lettre" sous Linux ; on met le mountpoint
			Label:   strings.TrimPrefix(src, "/dev/"),       // ex: "sda1", "nvme0n1p2"
			SizeGB:  round1(float64(size) / (1024 * 1024 * 1024)),
			UsedPct: usedPct,
		})
	}
	return out
}

func isPersistentFS(fs string) bool {
	switch fs {
	case "ext2", "ext3", "ext4", "btrfs", "xfs", "zfs", "f2fs",
		"vfat", "exfat", "ntfs", "ntfs3", "fuseblk", "reiserfs", "jfs":
		return true
	}
	return false
}

// ── Réseau ────────────────────────────────────────────────────────────────
// On utilise net.Interfaces() (portable). Hardware addr = MAC, on ne garde
// que les interfaces UP. On expose même celles sans MAC (tunnels Netbird/WG)
// pour que pickNetbirdIP puisse remonter l'IP 100.x au device.
func collectNetwork() []NetIface {
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
		ip := firstIPv4(ifi)
		out = append(out, NetIface{
			MAC:     ifi.HardwareAddr.String(),
			IP:      ip,
			Adapter: ifi.Name,
			Type:    classifyAdapter(ifi.Name),
		})
	}
	return out
}

func firstIPv4(ifi net.Interface) string {
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

// ── Bandwidth (compteurs cumulés) ─────────────────────────────────────────
// /proc/net/dev : Inter-|   Receive ...                |   Transmit ...
// face|bytes packets errs drop fifo frame compressed multicast|bytes packets …
func collectBandwidth() []BandwidthSample {
	f, err := os.Open("/proc/net/dev")
	if err != nil {
		logWarn("metrics-bandwidth-fail", "open /proc/net/dev failed", LogFields{"error": err.Error()})
		return []BandwidthSample{}
	}
	defer f.Close()

	out := []BandwidthSample{}
	sc := bufio.NewScanner(f)
	lineNo := 0
	for sc.Scan() {
		lineNo++
		if lineNo <= 2 {
			continue // skip 2 lignes d'en-tête
		}
		line := sc.Text()
		idx := strings.Index(line, ":")
		if idx < 0 {
			continue
		}
		name := strings.TrimSpace(line[:idx])
		if name == "lo" {
			continue
		}
		fields := strings.Fields(line[idx+1:])
		// 16 colonnes attendues : 8 Receive + 8 Transmit
		if len(fields) < 16 {
			continue
		}
		recv, _ := strconv.ParseUint(fields[0], 10, 64)
		sent, _ := strconv.ParseUint(fields[8], 10, 64)
		out = append(out, BandwidthSample{
			Adapter:   name,
			BytesSent: sent,
			BytesRecv: recv,
		})
	}
	return out
}

