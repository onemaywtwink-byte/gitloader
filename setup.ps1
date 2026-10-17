# Prepares everything GitLoader needs: Node.js, Git and npm dependencies.
# Missing tools are downloaded as portable copies into .\runtime (no admin rights needed).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtime = Join-Path $root 'runtime'
$nodeDir = Join-Path $runtime 'node'
$gitDir = Join-Path $runtime 'git'
$arm = $env:PROCESSOR_ARCHITECTURE -eq 'ARM64'

function Test-Cmd($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Get-File($url, $out) {
    Write-Host "  $url"
    for ($i = 1; $i -le 3; $i++) {
        try {
            Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing -Headers @{ 'User-Agent' = 'GitLoader' }
            return
        } catch {
            if ($i -eq 3) { throw }
            Write-Host "  Download failed, retrying ($i/3)..."
            Start-Sleep -Seconds (2 * $i)
        }
    }
}

New-Item -ItemType Directory -Force $runtime | Out-Null

# ---------- Node.js ----------
if ((Test-Path (Join-Path $nodeDir 'node.exe')) -or (Test-Cmd 'node')) {
    Write-Host '[ok] Node.js found'
} else {
    Write-Host 'Node.js not found - downloading portable Node.js LTS...'
    $platform = if ($arm) { 'win-arm64' } else { 'win-x64' }
    $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json' -UseBasicParsing
    $lts = $index | Where-Object { $_.lts -and ($_.files -contains "$platform-zip") } | Select-Object -First 1
    if (-not $lts) { throw 'Could not find a Node.js LTS release' }
    $name = "node-$($lts.version)-$platform"
    $zip = Join-Path $runtime "$name.zip"
    Get-File "https://nodejs.org/dist/$($lts.version)/$name.zip" $zip
    Write-Host '  Extracting...'
    Expand-Archive $zip $runtime -Force
    if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
    Move-Item (Join-Path $runtime $name) $nodeDir
    Remove-Item $zip -Force
    Write-Host "[ok] Node.js $($lts.version) installed to runtime\node"
}

# ---------- Git ----------
if ((Test-Path (Join-Path $gitDir 'cmd\git.exe')) -or (Test-Cmd 'git')) {
    Write-Host '[ok] Git found'
} else {
    Write-Host 'Git not found - downloading portable Git (MinGit)...'
    $release = Invoke-RestMethod 'https://api.github.com/repos/git-for-windows/git/releases/latest' -Headers @{ 'User-Agent' = 'GitLoader' } -UseBasicParsing
    $pattern = if ($arm) { '^MinGit-[\d.]+-arm64\.zip$' } else { '^MinGit-[\d.]+-64-bit\.zip$' }
    $asset = $release.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
    if (-not $asset) { throw 'Could not find a MinGit download' }
    $zip = Join-Path $runtime $asset.name
    Get-File $asset.browser_download_url $zip
    Write-Host '  Extracting...'
    if (Test-Path $gitDir) { Remove-Item $gitDir -Recurse -Force }
    Expand-Archive $zip $gitDir -Force
    Remove-Item $zip -Force
    Write-Host "[ok] Git $($release.tag_name) installed to runtime\git"
}

$env:Path = "$nodeDir;$(Join-Path $gitDir 'cmd');$env:Path"

# ---------- Proxy ----------
# Node.js ignores the Windows proxy, so pass it on explicitly (VPN clients usually set one).
$proxy = $env:HTTPS_PROXY
if (-not $proxy) {
    try {
        $inet = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
        if ($inet.ProxyEnable -eq 1 -and $inet.ProxyServer) {
            $server = $inet.ProxyServer
            if ($server -match 'https=([^;]+)') { $server = $Matches[1] }
            elseif ($server -match 'http=([^;]+)') { $server = $Matches[1] }
            if ($server -notmatch '^\w+://') { $server = "http://$server" }
            $proxy = $server
        }
    } catch {}
}
if ($proxy) {
    Write-Host "[ok] Using proxy $proxy"
    $env:HTTPS_PROXY = $proxy
    $env:HTTP_PROXY = $proxy
    $env:ELECTRON_GET_USE_PROXY = '1'
    $env:GLOBAL_AGENT_HTTPS_PROXY = $proxy
    $env:GLOBAL_AGENT_HTTP_PROXY = $proxy
}

# ---------- npm dependencies ----------
function Install-Deps {
    Push-Location $root
    try {
        & npm.cmd install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { return $false }
        # Newer npm versions may skip install scripts, so fetch the Electron binary explicitly
        if (-not (Test-Path (Join-Path $root 'node_modules\electron\dist\electron.exe'))) {
            & node.exe (Join-Path $root 'node_modules\electron\install.js')
            if ($LASTEXITCODE -ne 0) { return $false }
        }
        return Test-Path (Join-Path $root 'node_modules\electron\dist\electron.exe')
    } finally {
        Pop-Location
    }
}

if (Test-Path (Join-Path $root 'node_modules\electron\dist\electron.exe')) {
    Write-Host '[ok] Dependencies installed'
} else {
    Write-Host 'Installing dependencies (Electron ~100 MB, this can take a few minutes)...'
    $ok = Install-Deps
    if (-not $ok) {
        Write-Host ''
        Write-Host 'Download from GitHub failed - trying the npmmirror.com mirror...'
        $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
        $ok = Install-Deps
    }
    if (-not $ok) { throw 'npm install failed' }
    Write-Host '[ok] Dependencies installed'
}
