//go:build !windows

package pty

import (
	"os"
	"os/signal"
	"syscall"
)

func newResizeChan() chan os.Signal {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGWINCH)
	return ch
}

func stopResizeChan(ch chan os.Signal) {
	signal.Stop(ch)
}
