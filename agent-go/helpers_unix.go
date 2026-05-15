//go:build linux || darwin

package main

import (
	"context"
	"math"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Helpers partagés Linux + macOS. Évite de dupliquer pickNetbirdIP /
// classifyAdapter / round1 / round2 / parsePing dans chaque fichier OS.

var ipv4Re = regexp.MustCompile(`^\d+\.\d+\.\d+\.\d+$`)

func round1(f float64) float64 { return math.Round(f*10) / 10 }
func round2(f float64) float64 { return math.Round(f*100) / 100 }

// classifyAdapter — heuristique basée sur le nom de l'interface.
// Linux : eth0, ens33, wlp3s0, wg0, netbird0, …
// macOS : en0, en1, awdl0, utun0, utun7 (Netbird), …
func classifyAdapter(name string) string {
	low := strings.ToLower(name)
	switch {
	case strings.Contains(low, "netbird"),
		strings.Contains(low, "wireguard"),
		strings.HasPrefix(low, "wg"):
		return "netbird"
	case strings.HasPrefix(low, "wl"),
		strings.HasPrefix(low, "wlan"),
		strings.HasPrefix(low, "wlp"),
		strings.Contains(low, "wifi"),
		strings.Contains(low, "wi-fi"),
		strings.Contains(low, "wireless"),
		strings.HasPrefix(low, "airport"):
		return "wifi"
	default:
		return "eth"
	}
}

// pickNetbirdIP — IP servie en priorité à partir d'une interface Netbird /
// WireGuard, sinon toute IP du réseau Carrier-Grade NAT 100.x utilisé par
// Netbird par défaut.
func pickNetbirdIP(ifaces []NetIface) string {
	for _, i := range ifaces {
		if i.Type == "netbird" && i.IP != "" {
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

// pingHost — délègue à /bin/ping (Linux) ou /sbin/ping (macOS). Format
// d'output similaire entre les deux ("time=N ms" + "X% packet loss").
func pingHost(host string) PingStats {
	out := PingStats{Host: host, PacketLossPct: 100}
	args := pingArgs(host)
	if len(args) == 0 {
		return out
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	o, err := cmd.CombinedOutput()
	if err != nil && len(o) == 0 {
		return out
	}
	return parsePing(string(o), host)
}

func pingArgs(host string) []string {
	if runtime.GOOS == "darwin" {
		// macOS : -W est en millisecondes, ping souvent dans /sbin/ping.
		return []string{"/sbin/ping", "-c", "4", "-W", "2000", host}
	}
	// Linux : -W est en secondes. On utilise PATH (busybox /bin/ping ou
	// iputils-ping) pour rester portable entre distros.
	return []string{"ping", "-c", "4", "-W", "2", host}
}

var (
	pingTimeUnixRe = regexp.MustCompile(`(?i)time[<=](\d+(?:\.\d+)?)\s*ms`)
	pingLossUnixRe = regexp.MustCompile(`(\d+(?:\.\d+)?)%\s+packet\s+loss`)
)

func parsePing(out, host string) PingStats {
	stats := PingStats{Host: host, PacketLossPct: 100}
	var samples []float64
	for _, m := range pingTimeUnixRe.FindAllStringSubmatch(out, -1) {
		if v, err := strconv.ParseFloat(m[1], 64); err == nil {
			samples = append(samples, v)
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
	if m := pingLossUnixRe.FindStringSubmatch(out); m != nil {
		if v, err := strconv.ParseFloat(m[1], 64); err == nil {
			stats.PacketLossPct = int(math.Round(v))
		}
	} else if len(samples) == 4 {
		stats.PacketLossPct = 0
	} else if len(samples) > 0 {
		stats.PacketLossPct = int(math.Round(float64(4-len(samples)) / 4 * 100))
	}
	return stats
}

// readTrimmedFile — lit le contenu trimé d'un fichier (typique de /sys/…),
// renvoie "" si ça échoue. Évite de polluer les call-sites avec des err.
func readTrimmedFile(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// runCmd — exécute une commande avec timeout court et renvoie stdout.
// Pratique pour les utilitaires système (sysctl, pmset, system_profiler…).
// Erreur silencieuse (logged à info) car ces sondes sont best-effort.
func runCmd(timeout time.Duration, name string, args ...string) string {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).Output()
	if err != nil {
		return ""
	}
	return string(out)
}
