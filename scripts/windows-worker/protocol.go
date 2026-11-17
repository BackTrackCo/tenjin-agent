package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

const maxLaunchFrame = 48 * 1024

// Existing shell transport remains on stdin, stdout and stderr. The alternate
// account bootstrap reads exactly one length-delimited launch record first.
type launchRecord struct {
	Executable string
	Directory  string
	Arguments  []string
	Overlay    map[string]string
	Runtime    *runtimeLaunch `json:",omitempty"`
}

type launchOptions struct {
	WorkerSID  string
	ParentPID  uint32
	CancelFile string
	Record     launchRecord
}

var localAccountSID = regexp.MustCompile("^S-1-5-21-([0-9]{1,10}-){3}[0-9]{1,10}$")

func localDrivePath(path string) bool {
	return len(path) >= 3 &&
		strings.ContainsRune("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ", rune(path[0])) &&
		path[1] == ':' && (path[2] == '\\' || path[2] == '/') &&
		!strings.ContainsAny(path[2:], ":\x00\r\n")
}

func parseOptions(args []string) (launchOptions, error) {
	if len(args) < 10 || args[0] != "--worker-sid" || args[2] != "--parent-pid" ||
		args[4] != "--cwd" || args[6] != "--cancel-file" || args[8] != "--" ||
		!localAccountSID.MatchString(args[1]) || !localDrivePath(args[7]) {
		return launchOptions{}, errors.New("invalid launcher options")
	}
	pid, err := strconv.ParseUint(args[3], 10, 32)
	if err != nil || pid == 0 {
		return launchOptions{}, errors.New("invalid parent PID")
	}
	record := launchRecord{Executable: args[9], Directory: args[5], Arguments: args[10:]}
	if err := validateCommand(record); err != nil {
		return launchOptions{}, err
	}
	return launchOptions{WorkerSID: args[1], ParentPID: uint32(pid), CancelFile: args[7], Record: record}, nil
}

func validateCommand(record launchRecord) error {
	if !localDrivePath(record.Executable) ||
		!strings.HasSuffix(strings.ToLower(record.Executable), ".exe") ||
		!localDrivePath(record.Directory) {
		return errors.New("expected a native executable and directory on a local drive")
	}
	for _, arg := range record.Arguments {
		if strings.ContainsRune(arg, '\x00') {
			return errors.New("invalid executable arguments")
		}
	}
	return nil
}

var bridgeKeys = map[string]bool{
	"ANTHROPIC_API_KEY":                        true,
	"ANTHROPIC_AUTH_TOKEN":                     true,
	"ANTHROPIC_BASE_URL":                       true,
	"ANTHROPIC_MODEL":                          true,
	"ANTHROPIC_DEFAULT_OPUS_MODEL":             true,
	"ANTHROPIC_DEFAULT_SONNET_MODEL":           true,
	"ANTHROPIC_DEFAULT_HAIKU_MODEL":            true,
	"ANTHROPIC_MAX_RETRIES":                    true,
	"CLAUDE_CODE_AUTO_COMPACT_WINDOW":          true,
	"CLAUDE_CODE_AUTO_MODE_MODEL":              true,
	"CLAUDE_CODE_AUTO_MODE_SERVER":             true,
	"CLAUDE_CODE_DISABLE_AUTO_MEMORY":          true,
	"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": true,
	"CLAUDE_CODE_ENTRYPOINT":                   true,
	"CLAUDE_CODE_MAX_OUTPUT_TOKENS":            true,
	"CLAUDE_CODE_MCP_STARTUP_WAIT_MS":          true,
	"CLAUDE_CODE_SUBAGENT_MODEL":               true,
	"CLAUDE_CODE_USE_POWERSHELL_TOOL":          true,
	"DISABLE_AUTOUPDATER":                      true,
	"DISABLE_ERROR_REPORTING":                  true,
	"DISABLE_TELEMETRY":                        true,
	"TENJIN_MODEL_WORKER":                      true,
}

// Do not carry provider, proxy or Tenjin wallet environment variables over from
// the alternate profile. Other values come exclusively from that profile.
var excludedProfileKeys = map[string]bool{
	"ALL_PROXY":                        true,
	"ANTHROPIC_BEDROCK_BASE_URL":       true,
	"ANTHROPIC_CUSTOM_HEADERS":         true,
	"ANTHROPIC_FOUNDRY_API_KEY":        true,
	"ANTHROPIC_FOUNDRY_BASE_URL":       true,
	"ANTHROPIC_UNIX_SOCKET":            true,
	"ANTHROPIC_VERTEX_BASE_URL":        true,
	"CLAUDECODE":                       true,
	"CLAUDE_CODE_HOST_AUTH_ENV_VAR":    true,
	"CLAUDE_CODE_HOST_CREDS_FILE":      true,
	"CLAUDE_CODE_HOST_SESSION_ID":      true,
	"CLAUDE_CODE_OAUTH_TOKEN":          true,
	"CLAUDE_CODE_SESSION_ACCESS_TOKEN": true,
	"CLAUDE_CODE_USE_BEDROCK":          true,
	"CLAUDE_CODE_USE_FOUNDRY":          true,
	"CLAUDE_CODE_USE_VERTEX":           true,
	"DEEPSEEK_API_KEY":                 true,
	"DEEPSEEK_KEY":                     true,
	"HTTP_PROXY":                       true,
	"HTTPS_PROXY":                      true,
	"OPENAI_API_KEY":                   true,
	"TENJIN_WALLET_KEY":                true,
	"TENJIN_WALLET_PASSPHRASE":         true,
	"TYPESAFE_API_KEY":                 true,
	"TYPESAFE_KEY":                     true,
}

func environmentEntry(entry string) (string, string, bool) {
	start := 0
	if strings.HasPrefix(entry, "=") {
		start = 1
	}
	pos := strings.IndexByte(entry[start:], '=')
	if pos < 0 || pos+start == 0 {
		return "", "", false
	}
	pos += start
	return strings.ToUpper(entry[:pos]), entry[pos+1:], true
}

func parentOverlay(environ []string) (map[string]string, error) {
	overlay := make(map[string]string)
	for _, entry := range environ {
		key, value, ok := environmentEntry(entry)
		if !ok || !bridgeKeys[key] {
			continue
		}
		if _, duplicate := overlay[key]; duplicate {
			return nil, errors.New("ambiguous bridge environment")
		}
		overlay[key] = value
	}
	return overlay, validateOverlay(overlay)
}

func validateOverlay(overlay map[string]string) error {
	for key, value := range overlay {
		if !bridgeKeys[key] || strings.ContainsRune(value, '\x00') {
			return errors.New("invalid bridge environment")
		}
	}
	endpoint, err := url.Parse(overlay["ANTHROPIC_BASE_URL"])
	if err != nil || endpoint.Scheme != "http" || endpoint.User != nil ||
		(endpoint.Hostname() != "127.0.0.1" && endpoint.Hostname() != "::1") ||
		endpoint.Port() == "" || (endpoint.Path != "" && endpoint.Path != "/") ||
		endpoint.RawQuery != "" || endpoint.Fragment != "" ||
		(overlay["ANTHROPIC_API_KEY"] == "" && overlay["ANTHROPIC_AUTH_TOKEN"] == "") {
		return errors.New("a private loopback bridge and bridge key are required")
	}
	port, err := strconv.ParseUint(endpoint.Port(), 10, 16)
	if err != nil || port == 0 {
		return errors.New("invalid loopback bridge port")
	}
	if mode, supplied := overlay["TENJIN_MODEL_WORKER"]; supplied && mode != "1" {
		return errors.New("invalid worker marker")
	}
	return nil
}

func workerEnvironment(profile []string, overlay map[string]string) []string {
	result := make([]string, 0, len(profile)+len(overlay)+1)
	for _, entry := range profile {
		key, _, ok := environmentEntry(entry)
		if ok && !bridgeKeys[key] && !excludedProfileKeys[key] {
			result = append(result, entry)
		}
	}
	for key, value := range overlay {
		result = append(result, key+"="+value)
	}
	if _, supplied := overlay["TENJIN_MODEL_WORKER"]; !supplied {
		result = append(result, "TENJIN_MODEL_WORKER=1")
	}
	return result
}

func validateLaunch(record launchRecord) error {
	if err := validateCommand(record); err != nil {
		return err
	}
	if err := validateOverlay(record.Overlay); err != nil {
		return err
	}
	for _, key := range []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"} {
		if value := record.Overlay[key]; value != "" {
			for _, argument := range record.Arguments {
				if strings.Contains(argument, value) {
					return errors.New("bridge credential would appear on worker command line")
				}
			}
		}
	}
	return validateRuntime(record)
}

func encodeLaunch(record launchRecord) ([]byte, error) {
	if err := validateLaunch(record); err != nil {
		return nil, err
	}
	frame, err := json.Marshal(record)
	if err != nil || len(frame) > maxLaunchFrame {
		clear(frame)
		return nil, errors.New("launch record exceeds limit")
	}
	return frame, nil
}

func sendLaunch(writer io.Writer, frame []byte) error {
	if err := binary.Write(writer, binary.LittleEndian, uint32(len(frame))); err != nil {
		return err
	}
	written, err := writer.Write(frame)
	if err == nil && written != len(frame) {
		return io.ErrShortWrite
	}
	return err
}

func receiveLaunch(reader io.Reader) (launchRecord, error) {
	var size uint32
	if err := binary.Read(reader, binary.LittleEndian, &size); err != nil || size == 0 || size > maxLaunchFrame {
		return launchRecord{}, errors.New("invalid launch frame length")
	}
	frame := make([]byte, size)
	defer clear(frame)
	if _, err := io.ReadFull(reader, frame); err != nil {
		return launchRecord{}, errors.New("incomplete launch frame")
	}
	var record launchRecord
	if err := json.Unmarshal(frame, &record); err != nil {
		return launchRecord{}, errors.New("invalid launch frame")
	}
	if err := validateLaunch(record); err != nil {
		return launchRecord{}, fmt.Errorf("launch frame: %w", err)
	}
	return record, nil
}

const maxRuntimeSettings = 32 * 1024
const maxProtectedPaths = 64

type runtimeLaunch struct {
	Profile        string
	ProtectedPaths []string
	SettingsSource string
	Settings       json.RawMessage
}

func settingsArgument(args []string) (int, error) {
	index := -1
	for i, arg := range args {
		if strings.HasPrefix(arg, "--settings=") {
			return -1, errors.New("expected a private worker settings file")
		}
		if arg == "--settings" {
			if index != -1 || i+1 == len(args) {
				return -1, errors.New("expected one worker settings argument")
			}
			index = i + 1
		}
	}
	if index == -1 {
		return -1, errors.New("worker settings argument is required")
	}
	return index, nil
}

func validRuntimePath(path string) bool {
	return len(path) <= 1024 && localDrivePath(path)
}

func validateRuntimePaths(runtime *runtimeLaunch) error {
	if !validRuntimePath(runtime.Profile) || len(runtime.ProtectedPaths) == 0 ||
		len(runtime.ProtectedPaths) > maxProtectedPaths {
		return errors.New("invalid Windows worker runtime configuration")
	}
	for _, path := range runtime.ProtectedPaths {
		if !validRuntimePath(path) {
			return errors.New("invalid controller private path")
		}
	}
	return nil
}

func validRuntimeSettings(settings []byte) bool {
	trimmed := bytes.TrimSpace(settings)
	return len(settings) <= maxRuntimeSettings && len(trimmed) > 0 && trimmed[0] == '{' && json.Valid(settings)
}

func validateRuntime(record launchRecord) error {
	runtime := record.Runtime
	if runtime == nil {
		return nil
	}
	if err := validateRuntimePaths(runtime); err != nil {
		return err
	}
	index, err := settingsArgument(record.Arguments)
	if err != nil {
		return err
	}
	if record.Arguments[index] != "" || !validRuntimePath(runtime.SettingsSource) || !validRuntimeSettings(runtime.Settings) {
		return errors.New("invalid private worker settings payload")
	}
	return nil
}
