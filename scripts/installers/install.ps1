& {
    $ErrorActionPreference = 'Stop'
    $CliVersion = '@CLI_VERSION@'
    $CliSha512 = '@CLI_SHA512@'
    $NodeVersion = '@NODE_VERSION@'
    $NodeHashes = @{
    @NODE_POWERSHELL_HASHES@
    }

    $Stage = $null
    $Client = $null
    try {
        if ($env:TENJIN_DATA_DIR -and [IO.Path]::GetFullPath($env:TENJIN_DATA_DIR) -ne [IO.Path]::Combine($HOME, '.tenjin')) {
            throw 'Plugin installation needs the default data directory. Run without TENJIN_DATA_DIR.'
        }
        $Architecture = $env:PROCESSOR_ARCHITEW6432
        if (-not $Architecture) { $Architecture = $env:PROCESSOR_ARCHITECTURE }
        if ($Architecture -in @('AMD64', 'x64')) { $Architecture = 'x64' }
        elseif ($Architecture -eq 'ARM64') { $Architecture = 'arm64' }
        else { $Architecture = 'unsupported' }
        if ($Architecture -eq 'unsupported' -or [Environment]::OSVersion.Platform -ne 'Win32NT') {
            throw 'Tenjin supports Windows on x64 and arm64. Use the shell installer on macOS or Linux.'
        }
        $Key = "win-$Architecture"
        $Tar = [IO.Path]::Combine($env:SystemRoot, 'System32', 'tar.exe')
        if (-not (Test-Path $Tar)) { throw 'Windows tar.exe is required.' }
        $Stage = [IO.Path]::Combine([IO.Path]::GetTempPath(), "tenjin-install-$([Guid]::NewGuid())")
        New-Item -ItemType Directory -Path $Stage | Out-Null
        $Client = New-Object Net.WebClient
        $ProxyUrl = @($env:HTTPS_PROXY, $env:https_proxy, $env:HTTP_PROXY, $env:http_proxy) | Where-Object { $_ } | Select-Object -First 1
        if ($ProxyUrl) {
            $Client.Proxy = New-Object Net.WebProxy($ProxyUrl)
            $ProxyUri = [Uri]$ProxyUrl
            if ($ProxyUri.UserInfo) {
                $Credentials = $ProxyUri.UserInfo.Split(':', 2)
                $Password = if ($Credentials.Length -gt 1) { [Uri]::UnescapeDataString($Credentials[1]) } else { '' }
                $Client.Proxy.Credentials = New-Object Net.NetworkCredential([Uri]::UnescapeDataString($Credentials[0]), $Password)
            }
        }
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Write-Host "Installing Tenjin $CliVersion..."
        $NodeArchive = [IO.Path]::Combine($Stage, 'node.zip')
        $Client.DownloadFile("https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-$Key.zip", $NodeArchive)
        if ((Get-FileHash $NodeArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $NodeHashes[$Key]) { throw 'The Node download did not match its checksum.' }
        $NodeDir = [IO.Path]::Combine($Stage, 'node')
        Expand-Archive -Path $NodeArchive -DestinationPath $NodeDir
        $Node = [IO.Path]::Combine($NodeDir, "node-v$NodeVersion-$Key", 'node.exe')
        if ((& $Node -p process.version) -ne "v$NodeVersion") { throw 'The downloaded Node cannot run on this system.' }
        $CliArchive = [IO.Path]::Combine($Stage, 'cli.tgz')
        $Client.DownloadFile("https://registry.npmjs.org/tenjin-cli/-/tenjin-cli-$CliVersion.tgz", $CliArchive)
        if ((Get-FileHash $CliArchive -Algorithm SHA512).Hash.ToLowerInvariant() -ne $CliSha512) { throw 'The Tenjin download did not match its checksum.' }
        New-Item -ItemType Directory -Path ([IO.Path]::Combine($Stage, 'cli')) | Out-Null
        Push-Location $Stage
        try { & $Tar -xf cli.tgz -C cli --strip-components=1; if ($LASTEXITCODE -ne 0) { throw 'Could not unpack Tenjin.' } } finally { Pop-Location }
        $PreviousArchive = $env:TENJIN_BOOTSTRAP_NODE_ARCHIVE
        try {
            $env:TENJIN_BOOTSTRAP_NODE_ARCHIVE = $NodeArchive
            & $Node ([IO.Path]::Combine($Stage, 'cli', 'dist', 'index.js')) install @args
            if ($LASTEXITCODE -ne 0) { throw "Tenjin setup exited with code $LASTEXITCODE." }
        } finally { $env:TENJIN_BOOTSTRAP_NODE_ARCHIVE = $PreviousArchive }
    } catch {
        throw "Tenjin could not be installed: $($_.Exception.Message) Retry after fixing this. Your existing setup was kept."
    } finally {
        if ($Client) { $Client.Dispose() }
        if ($Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue }
    }
} @args
