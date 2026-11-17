package main

import (
	"bytes"
	"encoding/binary"
	"io"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func TestLauncherOptionsKeepNativeArgumentVector(t *testing.T) {
	args := []string{
		"--worker-sid", "S-1-5-21-123-456-789-1001", "--parent-pid", "42",
		"--cwd", "C:\\Workspace with spaces", "--cancel-file", "C:\\owner-private\\stop",
		"--", "C:\\Program Files\\Claude\\claude.exe",
		"--output-format", "stream-json", "literal & | %",
	}
	opts, err := parseOptions(args)
	if err != nil {
		t.Fatal(err)
	}
	if opts.ParentPID != 42 || opts.CancelFile != args[7] || !reflect.DeepEqual(opts.Record.Arguments, args[10:]) {
		t.Fatal("native argv changed")
	}
	for _, invalid := range []struct {
		index int
		value string
	}{
		{1, "S-1-5-32-544"},
		{3, "0"},
		{5, "\\\\server\\share"},
		{5, "C:relative"},
		{7, "\\\\server\\share\\stop"},
		{7, "C:relative"},
		{9, "C:\\Claude\\claude.cmd"},
		{9, "C:\\Claude\\claude.exe:alternate"},
	} {
		changed := slices.Clone(args)
		changed[invalid.index] = invalid.value
		if _, err := parseOptions(changed); err == nil {
			t.Fatalf("argument %d accepted an unsafe value", invalid.index)
		}
	}
}

func TestWindowsProfileReceivesOnlyAllowlistedControllerValues(t *testing.T) {
	parent := []string{
		"Path=C:\\controller\\bin",
		"USERPROFILE=C:\\controller",
		"TENJIN_WALLET_KEY=controller-canary",
		"TENJIN_DATA_DIR=C:\\controller\\wallet",
		"CLAUDE_CONFIG_DIR=C:\\controller\\claude",
		"anthropic_base_url=http://127.0.0.1:8520",
		"Anthropic_Api_Key=fixture-token",
		"DISABLE_TELEMETRY=1",
	}
	overlay, err := parentOverlay(parent)
	if err != nil {
		t.Fatal(err)
	}
	profile := []string{
		"Path=C:\\alternate\\bin", "USERPROFILE=C:\\alternate", "APPDATA=C:\\alternate\\AppData",
		"https_proxy=http://proxy.invalid", "Anthropic_Api_Key=profile-canary",
		"Claude_Code_Use_Bedrock=1", "CLAUDE_CODE_OAUTH_TOKEN=profile-canary",
		"TENJIN_WALLET_KEY=profile-canary",
	}
	actual := workerEnvironment(profile, overlay)
	slices.Sort(actual)
	want := []string{
		"ANTHROPIC_API_KEY=fixture-token", "ANTHROPIC_BASE_URL=http://127.0.0.1:8520",
		"APPDATA=C:\\alternate\\AppData", "DISABLE_TELEMETRY=1", "Path=C:\\alternate\\bin",
		"TENJIN_MODEL_WORKER=1", "USERPROFILE=C:\\alternate",
	}
	if !reflect.DeepEqual(actual, want) {
		t.Fatal("unexpected environment across account boundary")
	}
	if _, err := parentOverlay(append(parent, "ANTHROPIC_API_KEY=duplicate")); err == nil {
		t.Fatal("ambiguous casing accepted")
	}
}

func TestWindowsBridgeOnlyAcceptsLiteralLoopback(t *testing.T) {
	for _, host := range []string{
		"https://127.0.0.1:8520", "http://localhost:8520",
		"http://127.0.0.1.example.com:8520", "http://fixture.example:8520",
		"http://u:p@127.0.0.1:8520", "http://127.0.0.1", "http://127.0.0.1:0",
		"http://127.0.0.1:8520/private", "http://127.0.0.1:8520?port=123",
	} {
		if err := validateOverlay(map[string]string{"ANTHROPIC_BASE_URL": host, "ANTHROPIC_API_KEY": "fixture"}); err == nil {
			t.Fatal("non-loopback or non-base bridge URL accepted")
		}
	}
	if err := validateOverlay(map[string]string{"ANTHROPIC_BASE_URL": "http://[::1]:8520", "ANTHROPIC_AUTH_TOKEN": "fixture"}); err != nil {
		t.Fatal(err)
	}
}

func TestLaunchRecordLeavesFollowingSDKBytesInPipe(t *testing.T) {
	record := launchRecord{
		Executable: "C:\\Claude\\claude.exe",
		Directory:  "C:\\repo",
		Arguments:  []string{"--input-format", "stream-json"},
		Overlay:    map[string]string{"ANTHROPIC_BASE_URL": "http://127.0.0.1:8520", "ANTHROPIC_API_KEY": "fixture"},
	}
	frame, err := encodeLaunch(record)
	if err != nil {
		t.Fatal(err)
	}
	var wire bytes.Buffer
	if err := sendLaunch(&wire, frame); err != nil {
		t.Fatal(err)
	}
	const sdkInput = "{\"type\":\"user\"}\n"
	_, _ = wire.WriteString(sdkInput)
	decoded, err := receiveLaunch(&wire)
	if err != nil || !reflect.DeepEqual(decoded, record) {
		t.Fatalf("invalid bootstrap frame: %v", err)
	}
	left, err := io.ReadAll(&wire)
	if err != nil || string(left) != sdkInput {
		t.Fatal("bootstrap consumed SDK bytes")
	}
	_ = binary.Write(&wire, binary.LittleEndian, uint32(maxLaunchFrame+1))
	if _, err := receiveLaunch(&wire); err == nil {
		t.Fatal("oversized frame accepted")
	}
	record.Arguments = []string{strings.Repeat("x", maxLaunchFrame+1)}
	if _, err := encodeLaunch(record); err == nil {
		t.Fatal("oversized output frame accepted")
	}
	record.Arguments = []string{"--header=fixture"}
	if _, err := encodeLaunch(record); err == nil {
		t.Fatal("bridge credential accepted in native argument")
	}
}
