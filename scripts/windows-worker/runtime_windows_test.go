package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestRuntimeLaunchCarriesPrivateSettingsInTheFrame(t *testing.T) {
	t.Setenv("TEMP", t.TempDir())
	t.Setenv("TMP", os.Getenv("TEMP"))
	root := t.TempDir()
	profile := t.TempDir()
	segments, err := json.Marshal([]string{root, filepath.Join(root, "wallet.json")})
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(profileVariable, profile)
	t.Setenv(protectedPathsVariable, string(segments))
	folder, err := os.MkdirTemp(os.Getenv("TEMP"), "tenjin-worker-settings-")
	if err != nil {
		t.Fatal(err)
	}
	settings := []byte(`{"env":{"ANTHROPIC_API_KEY":"local-bridge-fake"}}`)
	source := filepath.Join(folder, "settings.json")
	if err := os.WriteFile(source, settings, 0600); err != nil {
		t.Fatal(err)
	}
	record := launchRecord{
		Executable: `C:\tools\claude.exe`,
		Directory:  root,
		Arguments:  []string{"--settings", source},
		Overlay:    map[string]string{"ANTHROPIC_BASE_URL": "http://127.0.0.1:2", "ANTHROPIC_API_KEY": "local-bridge-fake"},
	}
	if err := prepareRuntimeLaunch(&record); err != nil {
		t.Fatal(err)
	}
	var pipe bytes.Buffer
	frame, err := encodeLaunch(record)
	if err != nil {
		t.Fatal(err)
	}
	if err := sendLaunch(&pipe, frame); err != nil {
		t.Fatal(err)
	}
	worker, err := receiveLaunch(&pipe)
	if err != nil {
		t.Fatal(err)
	}
	if worker.Runtime.SettingsSource != source || !bytes.Equal(worker.Runtime.Settings, settings) ||
		worker.Arguments[1] != "" {
		t.Fatal("runtime settings did not stay in the private launch payload")
	}
	env := runtimeEnvironment(worker, []string{"Claude_Config_Dir=wrong-profile", "USERPROFILE=worker-home"})
	var entries int
	for _, entry := range env {
		if name, value, _ := environmentEntry(entry); name == "CLAUDE_CONFIG_DIR" {
			entries++
			if value != profile {
				t.Fatal("worker did not get the selected Claude profile")
			}
		}
	}
	if entries != 1 {
		t.Fatal("Claude worker profile was duplicated or missing")
	}
}

func TestRuntimeRejectsSettingsOutsideControllerTemp(t *testing.T) {
	t.Setenv("TEMP", t.TempDir())
	t.Setenv("TMP", os.Getenv("TEMP"))
	folder, err := os.MkdirTemp(t.TempDir(), "tenjin-worker-settings-")
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(folder, "settings.json")
	if err := os.WriteFile(source, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readRuntimeSettings(source); err == nil {
		t.Fatal("worker accepted a settings file outside the controller temp directory")
	}
}

func TestRuntimeRejectsAccessiblePaths(t *testing.T) {
	root := t.TempDir()
	if err := verifyPrivatePath(root, false); err == nil {
		t.Fatal("worker accepted a writable controller data directory")
	}
	program := filepath.Join(root, "claude.exe")
	if err := os.WriteFile(program, []byte("fake program"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := verifyImmutableExecutable(program); err == nil {
		t.Fatal("worker accepted a writable executable")
	}
	missing := filepath.Join(root, "missing")
	if err := verifyPathAccess(missing, readDataOrList, true); err != nil {
		t.Fatal(err)
	}
	if err := verifyPathAccess(missing, readDataOrList, false); err == nil {
		t.Fatal("worker accepted a missing required controller data directory")
	}
}

func TestRuntimeSettingsAreReadableByTheWorkerAndCleanedUp(t *testing.T) {
	home := t.TempDir()
	temp := filepath.Join(home, "Temp")
	if err := os.Mkdir(temp, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("USERPROFILE", home)
	t.Setenv("TEMP", temp)
	t.Setenv("TMP", temp)
	want := []byte(`{"env":{"ANTHROPIC_API_KEY":"fake"}}`)
	path, cleanup, err := writeRuntimeSettings(want)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cleanup)
	if data, err := os.ReadFile(path); err != nil || !bytes.Equal(data, want) {
		t.Fatal("worker could not read its staged settings")
	}
	cleanup()
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("worker did not remove its staged settings")
	}
}
