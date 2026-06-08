//go:build windows

package pty

import "os"

// Windows has no SIGWINCH. Resize-on-window-drag is not propagated; the
// initial size is sent once at connect time. A future implementation could
// poll GetConsoleScreenBufferInfo, but that's out of scope for this stub.
func newResizeChan() chan os.Signal {
	return make(chan os.Signal, 1)
}

func stopResizeChan(ch chan os.Signal) {}
