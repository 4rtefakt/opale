package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/4rtefakt/opale/agent-go/branding"
)

func main() {
	debug := flag.Bool("debug", false, "Lance l'agent en interactif (un checkin par interval, sans SCM)")
	once := flag.Bool("once", false, "Effectue un seul checkin puis quitte (smoke-test)")
	version := flag.Bool("version", false, "Affiche la version et quitte")
	selftest := flag.Bool("self-test", false, "Vérifie que la config, le réseau et le service sont OK puis quitte")
	showPins := flag.Bool("show-pins", false, "Affiche les pins SPKI embarqués puis quitte")
	flag.Parse()

	if *version {
		fmt.Println(branding.BinName, AgentVersion)
		return
	}
	if *showPins {
		pins := PinsList()
		if len(pins) == 0 {
			fmt.Println("(aucun pin embarqué — pinning désactivé, fallback CA standard)")
			return
		}
		fmt.Printf("%d pin(s) SPKI SHA-256 acceptés :\n", len(pins))
		for _, p := range pins {
			fmt.Println("  " + p)
		}
		return
	}
	if *selftest {
		os.Exit(RunSelfTest())
	}

	// En mode interactif --debug, formater les logs pour humains en plus
	// du JSON dans le fichier. Le service écrit en JSON pur.
	if *debug || *once {
		prettyMode = true
	}
	openLog()
	defer closeLog()

	logf("%s %s starting (pid=%d, args=%v)", branding.BinName, AgentVersion, os.Getpid(), os.Args[1:])

	// Détecter si on tourne sous SCM (sans flag --debug explicite)
	isSvc, err := IsWindowsService()
	if err != nil {
		logf("IsWindowsService : %v", err)
	}

	if isSvc && !*debug {
		if err := RunService(); err != nil {
			logf("service exited with error : %v", err)
			os.Exit(1)
		}
		logf("service exited cleanly")
		return
	}

	// Mode interactif
	cfg, err := LoadConfig()
	if err != nil {
		logf("config invalide : %v", err)
		fmt.Fprintln(os.Stderr, "config invalide :", err)
		os.Exit(1)
	}
	st := LoadState()
	CheckBinaryIntegrity(st)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sig
		logf("signal reçu, arrêt")
		cancel()
	}()

	if *once {
		runCheckin(ctx, cfg, st)
		return
	}
	if err := runDebugLoop(ctx, cfg, st); err != nil {
		logf("loop : %v", err)
		os.Exit(1)
	}
}
