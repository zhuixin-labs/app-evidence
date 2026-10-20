param([Parameter(Mandatory=$true)][string]$ToolsRoot)
$ErrorActionPreference = 'Stop'
$ToolsRoot = [IO.Path]::GetFullPath($ToolsRoot)
$Cache = Join-Path $ToolsRoot 'downloads'
New-Item -ItemType Directory -Force -Path $Cache | Out-Null
function Fetch([string]$Url, [string]$File, [string]$Hash) {
  if (-not (Test-Path -LiteralPath $File)) { Invoke-WebRequest -Uri $Url -OutFile $File }
  if ((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLower() -ne $Hash) { throw "Checksum mismatch: $File" }
}
$GoZip = Join-Path $Cache 'go1.27.3.windows-amd64.zip'
Fetch 'https://go.dev/dl/go1.27.3.windows-amd64.zip' $GoZip 'f26081f438319757f8a1b46d7d0b2c5ec7583d4038e485e0aa725cfde7885fff'
$GoRoot = Join-Path $ToolsRoot 'go-sdk-1.27.3'
if (-not (Test-Path (Join-Path $GoRoot 'go/bin/go.exe'))) { Expand-Archive -LiteralPath $GoZip -DestinationPath $GoRoot -Force }
$SourceZip = Join-Path $Cache 'ipatool-4484b55.zip'
Fetch 'https://codeload.github.com/majd/ipatool/zip/4484b55d366e177ae6c89758c61588712c572fad' $SourceZip 'b9d497f70e4756720bef8081059c4a40fa3f9719ea8d001cc2bb76a2de5eb00d'
$SourceRoot = Join-Path $ToolsRoot 'ipatool-source-dpapi-v1'
Expand-Archive -LiteralPath $SourceZip -DestinationPath $SourceRoot -Force
$Source = Join-Path $SourceRoot 'ipatool-4484b55d366e177ae6c89758c61588712c572fad'
$DefaultKeyring = Join-Path $Source 'cmd/keyring_default.go'
[IO.File]::WriteAllText($DefaultKeyring, ([IO.File]::ReadAllText($DefaultKeyring).Replace('//go:build !ios', '//go:build !ios && !windows')))
Copy-Item -Path (Join-Path $PSScriptRoot 'ipatool-overlay/*.go') -Destination (Join-Path $Source 'cmd') -Force
$Go = Join-Path $GoRoot 'go/bin/go.exe'
$Destination = Join-Path $ToolsRoot 'ipatool/bin'
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
Push-Location $Source
try {
  & $Go test ./cmd -run '^TestDPAPI' -count=1
  if ($LASTEXITCODE -ne 0) { throw 'DPAPI credential verification failed' }
  & $Go build -trimpath -ldflags '-s -w -X github.com/majd/ipatool/v2/cmd.version=2.7.0-apptrace-dpapi-v1' -o (Join-Path $Destination 'ipatool-dpapi-v1.exe') .
  if ($LASTEXITCODE -ne 0) { throw 'ipatool build failed' }
  Copy-Item -LiteralPath (Join-Path $Source 'LICENSE') -Destination (Join-Path $Destination 'IPATOOL-LICENSE') -Force
} finally { Pop-Location }
Write-Host 'ipatool Windows DPAPI adapter built and verified.'
