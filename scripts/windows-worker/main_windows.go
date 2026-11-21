package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"syscall"
	"unsafe"
)

var kernel = syscall.NewLazyDLL("kernel32.dll")
var createJob = kernel.NewProc("CreateJobObjectW")
var setJobInformation = kernel.NewProc("SetInformationJobObject")
var attachToJob = kernel.NewProc("AssignProcessToJobObject")
var pauseGate = kernel.NewProc("ResumeThread")
var waitForObjects = kernel.NewProc("WaitForMultipleObjects")

const alternateBootstrap = "--worker-bootstrap"

type alternateLogon func(*uint16, *uint16, []uint16, *syscall.StartupInfo) (syscall.ProcessInformation, error)

func operationError(operation string, err error) error {
	var code syscall.Errno
	if errors.As(err, &code) {
		return fmt.Errorf("%s failed (Windows error %d)", operation, code)
	}
	return errors.New(operation + " failed")
}

func main() {
	exitLauncher(os.Args[1:], createAlternateBootstrap)
}

func exitLauncher(args []string, logon alternateLogon) {
	code, err := launch(args, logon)
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "tenjin Windows worker:", err)
	}
	os.Exit(code)
}

func launch(args []string, logon alternateLogon) (int, error) {
	if len(args) == 1 && args[0] == alternateBootstrap {
		return runBootstrap()
	}
	opts, err := parseOptions(args)
	if err != nil {
		return 125, err
	}
	return runController(opts, logon)
}

func runBootstrap() (int, error) {
	trace("bootstrap started")
	record, err := receiveLaunch(os.Stdin)
	if err != nil {
		return 125, err
	}
	trace("bootstrap received launch frame")
	cleanup, err := prepareRuntimeBootstrap(&record)
	if err != nil {
		return 125, err
	}
	defer cleanup()
	child := exec.Command(record.Executable, record.Arguments...)
	child.Dir = record.Directory
	child.Env = runtimeEnvironment(record, os.Environ())
	child.Stdin, child.Stdout, child.Stderr = os.Stdin, os.Stdout, os.Stderr
	child.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if err := child.Start(); err != nil {
		return 125, operationError("start native worker executable", err)
	}
	trace("native worker started")
	if err := child.Wait(); err != nil {
		var exited *exec.ExitError
		if errors.As(err, &exited) {
			return exited.ExitCode(), nil
		}
		return 125, operationError("run native worker executable", err)
	}
	return 0, nil
}

func trace(stage string) {
	_, _ = fmt.Fprintln(os.Stderr, "tenjin Windows qualification:", stage)
}

func processCreatedAt(process syscall.Handle) (int64, error) {
	var start, exit, kernelTime, userTime syscall.Filetime
	err := syscall.GetProcessTimes(process, &start, &exit, &kernelTime, &userTime)
	return start.Nanoseconds(), err
}

func openParent(pid uint32, caller syscall.Handle) (syscall.Handle, error) {
	if os.Getppid() != int(pid) {
		return 0, errors.New("launcher must be started by its stated controller")
	}
	const queryLimitedInformation = 0x1000
	parent, err := syscall.OpenProcess(syscall.SYNCHRONIZE|queryLimitedInformation, false, pid)
	if err != nil {
		return 0, operationError("open worker controller", err)
	}
	parentStart, parentErr := processCreatedAt(parent)
	helperStart, helperErr := processCreatedAt(caller)
	live, waitErr := syscall.WaitForSingleObject(parent, 0)
	if parentErr != nil || helperErr != nil || parentStart > helperStart || waitErr != nil || live != syscall.WAIT_TIMEOUT {
		syscall.CloseHandle(parent)
		return 0, errors.New("worker controller is no longer alive")
	}
	return parent, nil
}

type launchOwner struct {
	process    syscall.Handle
	cancelFile string
}

func (owner launchOwner) check() error {
	state, err := syscall.WaitForSingleObject(owner.process, 0)
	if err != nil || state != syscall.WAIT_TIMEOUT {
		return errors.New("worker controller ended")
	}
	_, err = os.Lstat(owner.cancelFile)
	if err == nil {
		return errors.New("worker launch cancelled")
	}
	if !errors.Is(err, os.ErrNotExist) {
		return errors.New("could not verify worker cancellation marker")
	}
	return nil
}

type jobLimits struct {
	processTimeLimit, jobTimeLimit int64
	flags                          uint32
	minWorkingSet, maxWorkingSet   uintptr
	activeProcessLimit             uint32
	affinity                       uintptr
	priorityClass, schedulingClass uint32
}

type extendedJobLimits struct {
	basic        jobLimits
	ioCounters   [6]uint64
	memoryLimits [4]uintptr
}

func openOwnedJob() (syscall.Handle, error) {
	handle, _, winErr := createJob.Call(0, 0)
	if handle == 0 {
		return 0, operationError("create owned worker job", winErr)
	}
	const jobObjectExtendedLimitInformation = 9
	const killOnClose = 0x00002000
	limits := extendedJobLimits{basic: jobLimits{flags: killOnClose}}
	ok, _, winErr := setJobInformation.Call(handle, jobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits))
	if ok == 0 {
		syscall.CloseHandle(syscall.Handle(handle))
		return 0, operationError("configure owned worker job", winErr)
	}
	return syscall.Handle(handle), nil
}

func bootstrapStdio(caller syscall.Handle, input, output, errorsOutput syscall.Handle) (syscall.StartupInfo, func(), error) {
	var handles []syscall.Handle
	close := func() {
		for _, handle := range handles {
			syscall.CloseHandle(handle)
		}
	}
	for _, original := range []syscall.Handle{input, output, errorsOutput} {
		var handle syscall.Handle
		if err := syscall.DuplicateHandle(caller, original, caller, &handle, 0, true, syscall.DUPLICATE_SAME_ACCESS); err != nil {
			close()
			return syscall.StartupInfo{}, nil, operationError("duplicate worker stdio", err)
		}
		handles = append(handles, handle)
	}
	info := syscall.StartupInfo{
		Cb: uint32(unsafe.Sizeof(syscall.StartupInfo{})), Flags: syscall.STARTF_USESTDHANDLES,
		StdInput: handles[0], StdOutput: handles[1], StdErr: handles[2],
	}
	return info, close, nil
}

func runController(opts launchOptions, logon alternateLogon) (int, error) {
	caller, err := syscall.GetCurrentProcess()
	if err != nil {
		return 125, operationError("identify launcher", err)
	}
	parent, err := openParent(opts.ParentPID, caller)
	if err != nil {
		return 125, err
	}
	defer syscall.CloseHandle(parent)
	owner := launchOwner{process: parent, cancelFile: opts.CancelFile}
	if err := owner.check(); err != nil {
		return 125, err
	}
	opts.Record.Overlay, err = parentOverlay(os.Environ())
	if err != nil {
		return 125, err
	}
	if err := prepareRuntimeLaunch(&opts.Record); err != nil {
		return 125, err
	}
	frame, err := encodeLaunch(opts.Record)
	if opts.Record.Runtime != nil {
		clear(opts.Record.Runtime.Settings)
	}
	if err != nil {
		return 125, err
	}
	launcher, err := os.Executable()
	if err != nil || !localDrivePath(launcher) {
		clear(frame)
		return 125, errors.New("launcher executable must be on a local drive")
	}
	process, input, job, err := startOwned(launcher, caller, owner, opts, logon)
	if err != nil {
		clear(frame)
		return 125, err
	}
	defer syscall.CloseHandle(process)
	defer input.Close()
	defer syscall.CloseHandle(job)
	if err := owner.check(); err != nil {
		clear(frame)
		return 125, err
	}
	go func() {
		err := sendLaunch(input, frame)
		clear(frame)
		if err == nil {
			trace("controller sent launch frame")
			_, _ = io.Copy(input, os.Stdin)
		} else {
			trace("controller could not send launch frame")
		}
		_ = input.Close()
	}()
	handles := [...]syscall.Handle{parent, process}
	for {
		// Controller death is signalled immediately. A short wait interval also
		// observes a cooperative cancel without interrupting the Win32 logon call.
		ready, _, winErr := waitForObjects.Call(uintptr(len(handles)), uintptr(unsafe.Pointer(&handles[0])), 0, 100)
		if err := owner.check(); err != nil {
			return 125, err
		}
		switch uint32(ready) {
		case syscall.WAIT_OBJECT_0 + 1:
			var exit uint32
			if err := syscall.GetExitCodeProcess(process, &exit); err != nil {
				return 125, operationError("read worker exit status", err)
			}
			return int(exit), nil
		case syscall.WAIT_TIMEOUT:
			continue
		default:
			return 125, operationError("wait for the worker and controller", winErr)
		}
	}
}

func startOwned(launcher string, caller syscall.Handle, owner launchOwner, opts launchOptions, logon alternateLogon) (_ syscall.Handle, _ *os.File, _ syscall.Handle, launchErr error) {
	job, err := openOwnedJob()
	if err != nil {
		return 0, nil, 0, err
	}
	var process, thread syscall.Handle
	var pipeRead, pipeWrite syscall.Handle
	var input *os.File
	success := false
	defer func() {
		if thread != 0 {
			syscall.CloseHandle(thread)
		}
		if pipeRead != 0 {
			syscall.CloseHandle(pipeRead)
		}
		if !success {
			if process != 0 {
				// Before assignment the suspended bootstrap is not in the job.
				if err := terminateFailedStart(process); err != nil {
					launchErr = errors.Join(launchErr, err)
				}
				syscall.CloseHandle(process)
			}
			if input != nil {
				_ = input.Close()
			}
			syscall.CloseHandle(job)
		}
	}()
	if err := syscall.CreatePipe(&pipeRead, &pipeWrite, nil, 0); err != nil {
		return 0, nil, 0, operationError("create worker input pipe", err)
	}
	input = os.NewFile(uintptr(pipeWrite), "windows-worker-pipe")
	startup, closeStdio, err := bootstrapStdio(caller, pipeRead, syscall.Handle(os.Stdout.Fd()), syscall.Handle(os.Stderr.Fd()))
	if err != nil {
		return 0, nil, 0, err
	}
	defer closeStdio()

	program, _ := syscall.UTF16PtrFromString(launcher)
	// Keep the alternate logon command short. Only the bootstrap flag is
	// passed here; the full SDK argument vector arrives through its input pipe.
	command, err := syscall.UTF16FromString(syscall.EscapeArg(launcher) + " " + alternateBootstrap)
	if err != nil || len(command) > 1024 {
		return 0, nil, 0, errors.New("launcher executable path is too long")
	}
	cwd, _ := syscall.UTF16PtrFromString(opts.Record.Directory)
	if err := owner.check(); err != nil {
		return 0, nil, 0, err
	}
	trace("starting alternate logon")
	info, err := logon(program, cwd, command, &startup)
	if err != nil {
		return 0, nil, 0, err
	}
	process, thread = info.Process, info.Thread
	trace("alternate logon created suspended bootstrap")
	// Node keeps this launcher alive while logon is blocked. If ownership
	// ended in that interval, terminate and wait without ever resuming.
	if err := owner.check(); err != nil {
		return 0, nil, 0, err
	}
	ok, _, winErr := attachToJob.Call(uintptr(job), uintptr(process))
	if ok == 0 {
		return 0, nil, 0, operationError("attach suspended worker to its job", winErr)
	}
	if err := verifyWorker(process, opts.WorkerSID, caller); err != nil {
		return 0, nil, 0, err
	}
	trace("bootstrap identity verified and assigned to job")
	if err := owner.check(); err != nil {
		return 0, nil, 0, err
	}
	previousCount, _, winErr := pauseGate.Call(uintptr(thread))
	if uint32(previousCount) != 1 {
		return 0, nil, 0, operationError("resume verified worker", winErr)
	}
	success = true
	trace("controller resumed bootstrap")
	return process, input, job, nil
}

func terminateFailedStart(process syscall.Handle) error {
	if state, _ := syscall.WaitForSingleObject(process, 0); state == syscall.WAIT_OBJECT_0 {
		return nil
	}
	if err := syscall.TerminateProcess(process, 125); err != nil {
		return operationError("terminate suspended worker", err)
	}
	state, err := syscall.WaitForSingleObject(process, 5_000)
	if err != nil || state != syscall.WAIT_OBJECT_0 {
		return errors.New("could not confirm failed worker launch exited")
	}
	return nil
}
