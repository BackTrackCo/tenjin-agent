package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

func TestMain(suite *testing.M) {
	if len(os.Args) > 1 && (os.Args[1] == "--worker-sid" || os.Args[1] == alternateBootstrap) {
		exitLauncher(os.Args[1:], holdSuspendedBootstrap)
	}
	os.Exit(suite.Run())
}

func holdSuspendedBootstrap(executable, cwd *uint16, command []uint16, startup *syscall.StartupInfo) (syscall.ProcessInformation, error) {
	process, err := createAlternateBootstrap(executable, cwd, command, startup)
	if err != nil {
		return process, err
	}
	ready := os.Getenv("TENJIN_TEST_LOGIN_READY")
	release := os.Getenv("TENJIN_TEST_LOGIN_RELEASE")
	if ready == "" || release == "" {
		return process, nil
	}
	// Hold the real suspended process before the production caller can attach
	// it to the job. Always hand the handles back to production cleanup.
	marker, _ := json.Marshal(map[string]int{
		"launcher":  os.Getpid(),
		"bootstrap": int(process.ProcessId),
	})
	if os.WriteFile(ready+".tmp", marker, 0o600) != nil || os.Rename(ready+".tmp", ready) != nil {
		return process, nil
	}
	for expires := time.Now().Add(30 * time.Second); time.Now().Before(expires); {
		if _, err := os.Lstat(release); err == nil {
			return process, nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	return process, nil
}

func TestWindowsNativeStructLayout(t *testing.T) {
	if size := unsafe.Sizeof(credential{}); size != 80 {
		t.Fatalf("unexpected CREDENTIALW size %d", size)
	}
	if size := unsafe.Sizeof(extendedJobLimits{}); size != 144 {
		t.Fatalf("unexpected JOBOBJECT_EXTENDED_LIMIT_INFORMATION size %d", size)
	}
	if size := unsafe.Sizeof(syscall.StartupInfo{}); size != 104 {
		t.Fatalf("unexpected STARTUPINFOW size %d", size)
	}
}

func TestWindowsOwnerDetectsCooperativeCancellation(t *testing.T) {
	self, err := syscall.GetCurrentProcess()
	if err != nil {
		t.Fatal(err)
	}
	owner := launchOwner{process: self, cancelFile: filepath.Join(t.TempDir(), "cancel")}
	if err := owner.check(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(owner.cancelFile, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := owner.check(); err == nil {
		t.Fatal("an existing owner cancellation marker did not stop the launch")
	}
}
