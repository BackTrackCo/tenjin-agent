$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'Run this account-provisioning fixture only on a disposable GitHub-hosted runner.'
}

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security;

public static class WorkerFixtureCredential {
    private const string TargetName = "Tenjin.WindowsWorker";

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential {
        public uint Flags, Type;
        public string Target, Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint BlobSize;
        public IntPtr Blob;
        public uint Persist, AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias, Username;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool CredWriteW(ref Credential credential, uint flags);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool CredDeleteW(string target, uint type, uint flags);
    [DllImport("advapi32.dll", ExactSpelling = true)]
    private static extern void CredFree(IntPtr credential);

    public static void Create(string user, SecureString password) {
        IntPtr existing;
        if (CredReadW(TargetName, 1, 0, out existing)) {
            CredFree(existing);
            throw new InvalidOperationException("The credential target already exists.");
        }
        int error = Marshal.GetLastWin32Error();
        if (error != 1168) throw new Win32Exception(error);
        IntPtr blob = Marshal.SecureStringToGlobalAllocUnicode(password);
        try {
            Credential credential = new Credential {
                Type = 1, Target = TargetName, Username = user, Persist = 1,
                Blob = blob, BlobSize = (uint)password.Length * 2,
            };
            if (!CredWriteW(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        } finally {
            Marshal.ZeroFreeGlobalAllocUnicode(blob);
        }
    }

    public static void Remove() {
        if (!CredDeleteW(TargetName, 1, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
}
'@

function Invoke-Checked([string] $Program, [string[]] $Arguments) {
  & $Program @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Program failed with exit code $LASTEXITCODE" }
}

function Grant-DirectoryAccess($Path, $Principal, $Rights) {
  $acl = Get-Acl -LiteralPath $Path
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $Principal, $Rights, 'ContainerInherit, ObjectInherit', 'None', 'Allow'
  )
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $Path -AclObject $acl
}

$fixtureId = [Guid]::NewGuid().ToString('N')
$account = 'tenjin_' + $fixtureId.Substring(0, 10)
$stagePath = Join-Path $env:RUNNER_TEMP "tenjin-windows-$fixtureId"
$binaryPath = Join-Path $stagePath 'bin'
$workspacePath = Join-Path $stagePath 'workspace'
$canaryPath = Join-Path $stagePath 'private-canary.txt'
$launcherPath = Join-Path $binaryPath 'tenjin-windows-worker.exe'
$sdkProbe = Join-Path $PSScriptRoot 'qualify.mjs'
$worker = $null
$storedCredential = $false
$password = ConvertTo-SecureString ('aA1!' + [Guid]::NewGuid().ToString('N')) -AsPlainText -Force
try {
  $worker = New-LocalUser -Name $account -Password $password
  $usersGroup = 'S-1-5-32-545'
  if (-not (Get-LocalGroupMember -SID $usersGroup | Where-Object { $_.SID.Value -eq $worker.SID.Value })) {
    Add-LocalGroupMember -SID $usersGroup -Member $worker
  }
  [WorkerFixtureCredential]::Create(".\$account", $password)
  $storedCredential = $true

  New-Item -ItemType Directory -Path $binaryPath, $workspacePath | Out-Null
  Grant-DirectoryAccess $binaryPath $worker.SID 'ReadAndExecute'
  Grant-DirectoryAccess $workspacePath $worker.SID 'Modify'
  [IO.File]::WriteAllText($canaryPath, 'SYNTHETIC_TENJIN_PRIVATE_FIXTURE')
  $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $canaryAcl = New-Object System.Security.AccessControl.FileSecurity
  $canaryAcl.SetAccessRuleProtection($true, $false)
  $canaryAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($owner, 'FullControl', 'Allow'))
  Set-Acl -LiteralPath $canaryPath -AclObject $canaryAcl

  Push-Location $PSScriptRoot
  try {
    Invoke-Checked 'go' @('test', './...')
    Invoke-Checked 'go' @('build', '-trimpath', '-o', $launcherPath, '.')
  } finally { Pop-Location }

  Push-Location $binaryPath
  try {
    Invoke-Checked 'npm.cmd' @('pack', '--ignore-scripts', '--quiet', '@anthropic-ai/claude-code-win32-x64@2.1.325')
    Invoke-Checked 'tar.exe' @('-xf', 'anthropic-ai-claude-code-win32-x64-2.1.325.tgz')
  } finally { Pop-Location }
  $claudePath = @(Get-ChildItem (Join-Path $binaryPath 'package') -Filter 'claude.exe' -Recurse -File)
  if ($claudePath.Count -ne 1) { throw 'Expected one Claude Code executable' }

  $processProbe = Join-Path $workspacePath 'process-probe.mjs'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'process-probe.mjs') -Destination $processProbe
  Invoke-Checked 'node.exe' @($processProbe, $launcherPath, $worker.SID.Value, $workspacePath)
  foreach ($tool in 'Bash', 'PowerShell') {
    Invoke-Checked 'node.exe' @($sdkProbe, $launcherPath, $claudePath[0].FullName, $worker.SID.Value, $workspacePath, $canaryPath, $tool)
  }
} finally {
  $password.Dispose()
  try {
    if ($storedCredential) { [WorkerFixtureCredential]::Remove() }
  } finally {
    try {
      if ($worker) { Remove-LocalUser -SID $worker.SID }
    } finally {
      if (Test-Path -LiteralPath $stagePath) { Remove-Item -LiteralPath $stagePath -Recurse -Force }
    }
  }
}
