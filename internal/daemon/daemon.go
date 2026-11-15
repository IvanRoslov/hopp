// Package daemon implements hoppd's lifecycle: pid-file locking, log
// rotation, and running the API server until asked to stop.
package daemon

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/IvanRoslov/hopp/internal/agent"
	_ "github.com/IvanRoslov/hopp/internal/agent/adapters" // register the five harness adapters
	"github.com/IvanRoslov/hopp/internal/api"
	"github.com/IvanRoslov/hopp/internal/bus"
	"github.com/IvanRoslov/hopp/internal/config"
	"github.com/IvanRoslov/hopp/internal/monitor"
	"github.com/IvanRoslov/hopp/internal/runtime"
	"github.com/IvanRoslov/hopp/internal/session"
	"github.com/IvanRoslov/hopp/internal/store"
	"gopkg.in/natefinch/lumberjack.v2"
)

// Run starts hoppd in the foreground: it claims the pid file, sets up
// rotating JSON logging, opens the store and bus, and serves the API until
// the process receives SIGTERM/SIGINT or a client calls POST /v1/shutdown.
// It returns an error if another daemon instance is already running.
func Run(cfg *config.Config) error {
	if err := claimPidFile(cfg.PidPath()); err != nil {
		return err
	}
	defer os.Remove(cfg.PidPath())

	logger := slog.New(slog.NewJSONHandler(&lumberjack.Logger{
		Filename:   cfg.LogPath(),
		MaxSize:    10, // megabytes
		MaxBackups: 3,
	}, nil))
	slog.SetDefault(logger)
	if err := captureStderr(cfg.LogPath()); err != nil {
		// Not fatal: the daemon works without it, it just dies quieter.
		slog.Warn("daemon: stderr stays where it was", "error", err)
	}

	loadFileSecrets(cfg.Home)

	st, err := store.Open(cfg.DBPath())
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer st.Close()

	// First start on a database without a model-profile registry gets the
	// starter profiles; it never happens again, even if the human empties it.
	if err := st.SeedModelProfiles(cfg.DefaultAgent); err != nil {
		slog.Error("seed model profiles failed (non-fatal)", "error", err)
	}

	b := bus.New(st)
	rt := runtime.NewTmux()
	mgr := session.NewManager(st, b, rt, cfg)

	mon := monitor.New(st, b, rt, cfg, agent.Get)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	// Reconcile store vs live sessions and their folders before serving.
	if err := mgr.Reconcile(ctx); err != nil {
		slog.Error("reconcile failed (non-fatal)", "error", err)
	}

	// Sweep activity synchronously once, after reconcile. Run below still
	// does its own initial sweep; that duplicate is harmless.
	mon.SweepOnce(ctx)
	go mon.Run(ctx)

	shutdownCalled := make(chan struct{})
	var shutdownOnce func()
	shutdownOnce = func() {
		select {
		case <-shutdownCalled:
			// already shutting down
		default:
			close(shutdownCalled)
			stop()
		}
	}

	deps := api.Deps{
		Store:     st,
		Bus:       b,
		Cfg:       cfg,
		Manager:   mgr,
		Monitor:   mon,
		Shutdown:  shutdownOnce,
		StartedAt: time.Now(),
	}

	slog.Info("hoppd starting", "pid", os.Getpid(), "socket", cfg.SocketPath())
	err = api.Serve(ctx, deps)
	slog.Info("hoppd stopped")
	return err
}

// stopWaitPollInterval bounds how often WaitForExit re-checks pid liveness.
const stopWaitPollInterval = 100 * time.Millisecond

// StopWaitTimeout bounds how long `hopp daemon stop` (via WaitForExit)
// waits for a daemon to actually exit after POST /v1/shutdown succeeds,
// before giving up and reporting an error.
const StopWaitTimeout = 15 * time.Second

// ReadPid reads and parses cfg's pid file. It returns an error (satisfying
// os.IsNotExist when the file is missing, e.g. no daemon has ever run
// against this home) if the pid file can't be read or its contents aren't a
// valid pid.
func ReadPid(cfg *config.Config) (int, error) {
	data, err := os.ReadFile(cfg.PidPath())
	if err != nil {
		return 0, err
	}
	pid, err := strconv.Atoi(string(data))
	if err != nil {
		return 0, fmt.Errorf("parse pid file %s: %w", cfg.PidPath(), err)
	}
	return pid, nil
}

// WaitForExit polls pid (using the same kill(pid, 0) liveness check
// claimPidFile uses to detect a stale pid file) until it is no longer
// alive, returning nil. If pid is still alive once timeout elapses, it
// returns an error.
//
// `hopp daemon stop` calls this after POST /v1/shutdown succeeds: the
// shutdown handler responds to the client before Run's graceful sweep and
// socket/pid-file cleanup actually finish (see Run and api.Serve), so
// without waiting here, a `daemon start` launched immediately after `stop`
// returns can race a socket/pid file that hasn't been removed yet and fail
// with "daemon unavailable" (this was a recurring papercut with `make
// restart`, which used to paper over it with a fixed `sleep 2`).
func WaitForExit(pid int, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		if !processAlive(pid) {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("daemon (pid %d) did not exit within %s", pid, timeout)
		}
		time.Sleep(stopWaitPollInterval)
	}
}

// claimPidFile creates the pid file exclusively, writing this process's pid.
// If a pid file already exists, it checks whether that pid is alive: if so,
// it's a genuine conflict; if not, the stale file is removed and the claim
// is retried once.
func claimPidFile(path string) error {
	pid := os.Getpid()
	err := writePidFileExclusive(path, pid)
	if err == nil {
		return nil
	}
	if !os.IsExist(err) {
		return fmt.Errorf("write pid file: %w", err)
	}

	existing, readErr := os.ReadFile(path)
	if readErr != nil {
		return fmt.Errorf("read existing pid file: %w", readErr)
	}
	existingPid, parseErr := strconv.Atoi(string(existing))
	if parseErr == nil && processAlive(existingPid) {
		return fmt.Errorf("already running (pid %d)", existingPid)
	}

	// Stale pid file: remove it and retry once.
	if err := os.Remove(path); err != nil {
		return fmt.Errorf("remove stale pid file: %w", err)
	}
	if err := writePidFileExclusive(path, pid); err != nil {
		if os.IsExist(err) {
			// Lost the race: another process claimed the pid file between
			// our removal and retry. Re-read it and report a genuine
			// conflict if a live pid is now present.
			if raced, readErr := os.ReadFile(path); readErr == nil {
				if racedPid, parseErr := strconv.Atoi(string(raced)); parseErr == nil && processAlive(racedPid) {
					return fmt.Errorf("already running (pid %d)", racedPid)
				}
			}
		}
		return fmt.Errorf("write pid file after removing stale one: %w", err)
	}
	return nil
}

func writePidFileExclusive(path string, pid int) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(strconv.Itoa(pid))
	return err
}

// processAlive reports whether pid refers to a live process, using signal 0
// which performs existence/permission checks without actually signaling.
func processAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	if err == nil {
		return true
	}
	if err == syscall.ESRCH {
		return false
	}
	// EPERM (or anything else): the process exists but we can't signal it,
	// treat as alive to be conservative.
	return true
}
