package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

const profileVariable = "TENJIN_WINDOWS_PROFILE"
const protectedPathsVariable = "TENJIN_WINDOWS_PROTECTED_PATHS"

const (
	readDataOrList = 0x0001
	writeOrAdd     = 0x0002
	appendOrAdd    = 0x0004
	readEA         = 0x0008
	writeEA        = 0x0010
	deleteChild    = 0x0040
	deleteObject   = 0x10000
	writeDACL      = 0x40000
	writeOwner     = 0x80000
)

var convertSecurityDescriptor = advapi.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW")

func prepareRuntimeLaunch(record *launchRecord) error {
	profile, profileSet := os.LookupEnv(profileVariable)
	paths, pathsSet := os.LookupEnv(protectedPathsVariable)
	if !profileSet && !pathsSet {
		return nil
	}
	runtime := &runtimeLaunch{Profile: profile}
	if !profileSet || !pathsSet || len(paths) > maxLaunchFrame ||
		json.Unmarshal([]byte(paths), &runtime.ProtectedPaths) != nil {
		return errors.New("invalid Windows worker runtime configuration")
	}
	if err := validateRuntimePaths(runtime); err != nil {
		return err
	}
	root := runtime.ProtectedPaths[0]
	for _, path := range runtime.ProtectedPaths[1:] {
		if !insideDirectory(root, path) {
			return errors.New("controller private paths must be within its data directory")
		}
	}
	if info, err := os.Lstat(root); err != nil || !info.IsDir() {
		return errors.New("controller private data directory is unavailable")
	}
	index, err := settingsArgument(record.Arguments)
	if err != nil {
		return err
	}
	runtime.SettingsSource = record.Arguments[index]
	runtime.Settings, err = readRuntimeSettings(runtime.SettingsSource)
	if err != nil {
		return err
	}
	record.Arguments[index] = ""
	record.Runtime = runtime
	return nil
}

func insideDirectory(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && relative != "." && relative != ".." &&
		!strings.HasPrefix(relative, `..\`) && filepath.IsLocal(relative)
}

func readRuntimeSettings(path string) ([]byte, error) {
	failed := errors.New("could not read private worker settings")
	folder := filepath.Dir(path)
	if !validRuntimePath(path) || filepath.Base(path) != "settings.json" ||
		!strings.HasPrefix(filepath.Base(folder), "tenjin-worker-settings-") {
		return nil, failed
	}

	// Node and Windows may have different TMP and TEMP precedence.
	parentFolder, err := os.Stat(filepath.Dir(folder))
	if err != nil || !parentFolder.IsDir() {
		return nil, failed
	}
	underTemp := false
	for _, temp := range []string{os.TempDir(), os.Getenv("TEMP"), os.Getenv("TMP")} {
		if validRuntimePath(temp) {
			if candidate, err := os.Stat(temp); err == nil && os.SameFile(parentFolder, candidate) {
				underTemp = true
				break
			}
		}
	}
	if !underTemp {
		return nil, failed
	}
	if info, err := os.Lstat(folder); err != nil || !info.IsDir() {
		return nil, failed
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxRuntimeSettings {
		return nil, failed
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, failed
	}
	defer file.Close()
	if opened, err := file.Stat(); err != nil || !os.SameFile(info, opened) {
		return nil, failed
	}
	settings, err := io.ReadAll(io.LimitReader(file, maxRuntimeSettings+1))
	if err != nil || !validRuntimeSettings(settings) {
		clear(settings)
		return nil, failed
	}
	return settings, nil
}

func prepareRuntimeBootstrap(record *launchRecord) (func(), error) {
	if record.Runtime == nil {
		return func() {}, nil
	}
	runtime := record.Runtime
	defer clear(runtime.Settings)
	launcher, err := os.Executable()
	if err != nil {
		return nil, errors.New("worker launcher executable is unavailable")
	}
	for _, program := range []string{launcher, record.Executable} {
		if err := verifyImmutableExecutable(program); err != nil {
			return nil, err
		}
	}
	root := runtime.ProtectedPaths[0]
	if err := verifyPrivatePath(root, false); err != nil {
		return nil, err
	}
	if err := verifyDeniedAccess(root, false, deleteChild); err != nil {
		return nil, err
	}
	if err := verifyImmutableParents(root); err != nil {
		return nil, err
	}
	for _, path := range runtime.ProtectedPaths[1:] {
		if !insideDirectory(root, path) {
			return nil, errors.New("controller private paths must be within its data directory")
		}
		if err := verifyPrivatePath(path, true); err != nil {
			return nil, err
		}
	}
	if err := verifyPrivatePath(runtime.SettingsSource, false); err != nil {
		return nil, err
	}
	if err := verifyImmutableParents(runtime.SettingsSource); err != nil {
		return nil, err
	}
	if info, err := os.Stat(runtime.Profile); err != nil || !info.IsDir() {
		return nil, errors.New("shared Claude worker profile is unavailable")
	}

	index, err := settingsArgument(record.Arguments)
	if err != nil {
		return nil, err
	}
	path, cleanup, err := writeRuntimeSettings(runtime.Settings)
	if err != nil {
		return nil, err
	}
	record.Arguments[index] = path
	return cleanup, nil
}

func runtimeEnvironment(record launchRecord, profile []string) []string {
	environment := workerEnvironment(profile, record.Overlay)
	if record.Runtime == nil {
		return environment
	}
	workerProfile := environment[:0]
	for _, entry := range environment {
		key, _, _ := environmentEntry(entry)
		if key != "CLAUDE_CONFIG_DIR" {
			workerProfile = append(workerProfile, entry)
		}
	}
	return append(workerProfile, "CLAUDE_CONFIG_DIR="+record.Runtime.Profile)
}

func verifyImmutableExecutable(path string) error {
	if !validRuntimePath(path) {
		return errors.New("invalid executable path for Windows worker")
	}
	if err := verifyDeniedAccess(path, false, writeOrAdd, appendOrAdd, writeEA,
		syscall.FILE_WRITE_ATTRIBUTES, deleteObject, writeDACL, writeOwner); err != nil {
		return err
	}
	return verifyImmutableParents(path)
}

func verifyImmutableParents(path string) error {
	// Protect every existing name used to reach the path. In particular,
	// NTFS can grant deletion on the parent when the target itself denies it.
	for dir := filepath.Dir(path); ; dir = filepath.Dir(dir) {
		if err := verifyDeniedAccess(dir, false, deleteChild); err != nil {
			return err
		}
		if dir == filepath.Dir(dir) {
			return nil
		}
		if err := verifyDeniedAccess(dir, false, syscall.FILE_WRITE_ATTRIBUTES, deleteObject, writeDACL, writeOwner); err != nil {
			return err
		}
	}
}

func verifyPrivatePath(path string, optional bool) error {
	if err := verifyDeniedAccess(path, optional, readDataOrList, writeOrAdd, appendOrAdd, readEA, writeEA,
		syscall.FILE_WRITE_ATTRIBUTES, deleteObject, writeDACL, writeOwner); err != nil {
		return err
	}
	return verifyDeniedAccess(filepath.Dir(path), optional, deleteChild)
}

func verifyDeniedAccess(path string, optional bool, rights ...uint32) error {
	// Check rights individually. Requesting all at once would report a denial
	// whenever even one of the requested rights was denied.
	for _, access := range rights {
		if err := verifyPathAccess(path, access, optional); err != nil {
			return err
		}
	}
	return nil
}

func verifyPathAccess(path string, access uint32, optional bool) error {
	source, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return errors.New("invalid controller private path")
	}
	const share = syscall.FILE_SHARE_READ | syscall.FILE_SHARE_WRITE | syscall.FILE_SHARE_DELETE
	handle, err := syscall.CreateFile(source, access, share, nil,
		syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OVERLAPPED, 0)
	switch {
	case err == nil:
		syscall.CloseHandle(handle)
		return errors.New("worker account has unsafe access to a controller path")
	case errors.Is(err, syscall.ERROR_ACCESS_DENIED):
		return nil
	case optional && (errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) || errors.Is(err, syscall.ERROR_PATH_NOT_FOUND)):
		return nil
	default:
		return operationError("verify controller path access", err)
	}
}

func writeRuntimeSettings(settings []byte) (string, func(), error) {
	temp, err := filepath.EvalSymlinks(os.TempDir())
	if err != nil || !validRuntimePath(temp) {
		return "", nil, errors.New("worker temporary directory is unavailable")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", nil, errors.New("worker home directory is unavailable")
	}
	home, err = filepath.EvalSymlinks(home)
	if err != nil || !insideDirectory(home, temp) {
		return "", nil, errors.New("worker temporary directory must be within its profile")
	}
	var randomName [16]byte
	if _, err := rand.Read(randomName[:]); err != nil {
		return "", nil, errors.New("could not name private worker settings")
	}
	path := filepath.Join(temp, "tenjin-worker-settings-"+hex.EncodeToString(randomName[:])+".json")
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return "", nil, errors.New("invalid worker settings path")
	}
	attributes, free, err := privateFileAttributes()
	if err != nil {
		return "", nil, err
	}
	defer free()
	handle, err := syscall.CreateFile(name, syscall.GENERIC_WRITE, 0, &attributes,
		syscall.CREATE_NEW, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return "", nil, operationError("create private worker settings", err)
	}
	file := os.NewFile(uintptr(handle), "private worker settings")
	_, writeErr := file.Write(settings)
	closeErr := file.Close()
	cleanup := func() { _ = os.Remove(path) }
	if err := errors.Join(writeErr, closeErr); err != nil {
		cleanup()
		return "", nil, operationError("write private worker settings", err)
	}
	return path, cleanup, nil
}

func privateFileAttributes() (syscall.SecurityAttributes, func(), error) {
	attributes := syscall.SecurityAttributes{}
	current, err := syscall.GetCurrentProcess()
	if err != nil {
		return attributes, nil, operationError("identify settings owner", err)
	}
	token, err := processToken(current)
	if err != nil {
		return attributes, nil, operationError("read settings owner token", err)
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return attributes, nil, operationError("read settings owner", err)
	}
	sid, err := user.User.Sid.String()
	if err != nil {
		return attributes, nil, operationError("read settings owner SID", err)
	}
	dacl, err := syscall.UTF16PtrFromString("D:P(A;;FA;;;SY)(A;;FA;;;" + sid + ")")
	if err != nil {
		return attributes, nil, errors.New("invalid settings owner SID")
	}
	var descriptor uintptr
	const sddlRevision = 1
	ok, _, winErr := convertSecurityDescriptor.Call(uintptr(unsafe.Pointer(dacl)), sddlRevision,
		uintptr(unsafe.Pointer(&descriptor)), 0)
	if ok == 0 {
		return attributes, nil, operationError("prepare private settings permissions", winErr)
	}
	attributes.Length = uint32(unsafe.Sizeof(attributes))
	attributes.SecurityDescriptor = descriptor
	free := func() { _, _ = syscall.LocalFree(syscall.Handle(descriptor)) }
	return attributes, free, nil
}
