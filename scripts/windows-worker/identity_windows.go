package main

import (
	"errors"
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

var advapi = syscall.NewLazyDLL("advapi32.dll")
var readCredential = advapi.NewProc("CredReadW")
var freeCredential = advapi.NewProc("CredFree")
var launchWithLogon = advapi.NewProc("CreateProcessWithLogonW")

const credentialTarget = "Tenjin.WindowsWorker"

type credential struct {
	flags, kind             uint32
	target, comment         *uint16
	lastWritten             syscall.Filetime
	blobSize                uint32
	blob                    *uint16
	persist, attributeCount uint32
	attributes              uintptr
	targetAlias, username   *uint16
}

func createAlternateBootstrap(executable, cwd *uint16, command []uint16, startup *syscall.StartupInfo) (syscall.ProcessInformation, error) {
	var process syscall.ProcessInformation
	target, _ := syscall.UTF16PtrFromString(credentialTarget)
	var current *credential
	ok, _, winErr := readCredential.Call(uintptr(unsafe.Pointer(target)), 1, 0, uintptr(unsafe.Pointer(&current)))
	if ok == 0 {
		return process, operationError("read worker credential", winErr)
	}
	defer freeCredential.Call(uintptr(unsafe.Pointer(current)))
	if current.blob == nil || current.blobSize == 0 || current.blobSize > 2560 || current.blobSize%2 != 0 || current.username == nil {
		return process, errors.New("invalid worker credential")
	}
	// Credential Manager stores the supplied generic password as UTF-16.
	// Give the API a null-terminated buffer and erase both copies before returning.
	original := unsafe.Slice(current.blob, int(current.blobSize)/2)
	defer clear(original)
	password := make([]uint16, len(original)+1)
	defer func() {
		clear(password)
		runtime.KeepAlive(password)
	}()
	copy(password, original)
	for i, c := range original {
		if c == 0 && i != len(original)-1 {
			return process, errors.New("invalid worker credential")
		}
	}
	if password[0] == 0 {
		return process, errors.New("empty worker password")
	}
	username, err := workerUsername(current.username)
	if err != nil {
		return process, err
	}
	username = strings.TrimPrefix(username, ".\\")
	if username == "" || username != strings.TrimSpace(username) || strings.ContainsAny(username, "\\/@\x00\r\n") {
		return process, errors.New("expected a preconfigured local worker account")
	}
	name, err := syscall.UTF16PtrFromString(username)
	if err != nil {
		return process, errors.New("invalid local worker account")
	}
	domain, _ := syscall.UTF16PtrFromString(".")
	const logonWithProfile = 1
	const createSuspended = 4
	const createNoWindow = 0x08000000
	ok, _, winErr = launchWithLogon.Call(
		uintptr(unsafe.Pointer(name)),
		uintptr(unsafe.Pointer(domain)),
		uintptr(unsafe.Pointer(&password[0])),
		logonWithProfile,
		uintptr(unsafe.Pointer(executable)),
		uintptr(unsafe.Pointer(&command[0])),
		createSuspended|createNoWindow,
		0, // Have Windows populate the alternate account's own profile environment.
		uintptr(unsafe.Pointer(cwd)),
		uintptr(unsafe.Pointer(startup)),
		uintptr(unsafe.Pointer(&process)),
	)
	if ok == 0 {
		return process, operationError("start alternate account", winErr)
	}
	return process, nil
}

func workerUsername(ptr *uint16) (string, error) {
	// CRED_MAX_USERNAME_LENGTH bounds the UTF-16 name returned by CredReadW.
	const maxUnits = 513
	for i := 0; i <= maxUnits; i++ {
		character := *(*uint16)(unsafe.Add(unsafe.Pointer(ptr), 2*i))
		if character == 0 {
			return syscall.UTF16ToString(unsafe.Slice(ptr, i)), nil
		}
	}
	return "", errors.New("invalid worker credential username")
}

func processToken(process syscall.Handle) (syscall.Token, error) {
	var token syscall.Token
	err := syscall.OpenProcessToken(process, syscall.TOKEN_QUERY, &token)
	return token, err
}

func verifyWorker(process syscall.Handle, expected string, caller syscall.Handle) error {
	token, err := processToken(process)
	if err != nil {
		return operationError("read worker token", err)
	}
	defer token.Close()
	worker, err := token.GetTokenUser()
	if err != nil {
		return operationError("read worker user SID", err)
	}
	sid, err := worker.User.Sid.String()
	if err != nil || sid != expected {
		return errors.New("worker SID did not match the configured account")
	}
	callerToken, err := processToken(caller)
	if err != nil {
		return operationError("read controller token", err)
	}
	defer callerToken.Close()
	controller, err := callerToken.GetTokenUser()
	if err != nil {
		return operationError("read controller SID", err)
	}
	callerSID, err := controller.User.Sid.String()
	if err != nil || callerSID == sid {
		return errors.New("worker must use a different Windows account")
	}
	return verifyStandardUser(token)
}

type tokenGroupList struct {
	count uint32
	items [1]syscall.SIDAndAttributes
}

func verifyStandardUser(token syscall.Token) error {
	var elevated, size uint32
	const tokenElevation = 20
	if err := syscall.GetTokenInformation(token, tokenElevation, (*byte)(unsafe.Pointer(&elevated)), 4, &size); err != nil {
		return operationError("read worker elevation", err)
	}
	if elevated != 0 {
		return errors.New("worker account is elevated")
	}
	size = 0
	err := syscall.GetTokenInformation(token, syscall.TokenGroups, nil, 0, &size)
	if !errors.Is(err, syscall.ERROR_INSUFFICIENT_BUFFER) || size < 4 || size > 1024*1024 {
		return errors.New("could not read worker group memberships")
	}
	buffer := make([]byte, size)
	if err := syscall.GetTokenInformation(token, syscall.TokenGroups, &buffer[0], size, &size); err != nil {
		return operationError("read worker group memberships", err)
	}
	groups := (*tokenGroupList)(unsafe.Pointer(&buffer[0]))
	var layout tokenGroupList
	offset := unsafe.Offsetof(layout.items)
	itemSize := unsafe.Sizeof(layout.items[0])
	if size < uint32(offset) || uintptr(groups.count) > (uintptr(size)-offset)/itemSize {
		return errors.New("invalid worker group memberships")
	}
	for _, group := range unsafe.Slice(&groups.items[0], int(groups.count)) {
		sid, err := group.Sid.String()
		if err != nil {
			return operationError("read worker group SID", err)
		}
		// A filtered UAC token can list Administrators as deny-only. That
		// account still does not qualify as a standard user.
		if sid == "S-1-5-32-544" {
			return errors.New("worker account is an administrator")
		}
	}
	runtime.KeepAlive(buffer)
	return nil
}
