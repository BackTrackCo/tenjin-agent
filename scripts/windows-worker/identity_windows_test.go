package main

import (
	"syscall"
	"testing"
	"unsafe"
)

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
