param(
  [string]$WorkspaceRoot = $env:APPTRACE_WORKSPACE_ROOT
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$ProductRoot = Split-Path -Parent $PSScriptRoot
if (-not $WorkspaceRoot) {
  $WorkspaceRoot = Join-Path $env:APPDATA "AppTrace\workspace"
}
$Tools = if ($env:APPTRACE_TOOLS_DIR) { $env:APPTRACE_TOOLS_DIR } else { Join-Path $WorkspaceRoot "tools" }
$Downloads = Join-Path $Tools "downloads"
New-Item -ItemType Directory -Force -Path $Tools, $Downloads | Out-Null
# Resolve 8.3 paths before PowerShell archive/move cmdlets process their parents.
$Tools = (Get-Item -LiteralPath $Tools).FullName
$Downloads = (Get-Item -LiteralPath $Downloads).FullName

function Assert-ToolPath([string]$Target) {
  $RootPath = [IO.Path]::GetFullPath($Tools).TrimEnd('\') + '\'
  $TargetPath = [IO.Path]::GetFullPath($Target)
  if (-not $TargetPath.StartsWith($RootPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing filesystem operation outside tools: $TargetPath"
  }
}

function Remove-ToolDirectory([string]$Target) {
  Assert-ToolPath $Target
  if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }
}

function Get-Sha256([string]$Path) {
  (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
}

function Assert-Sha256([string]$Path, [string]$Expected) {
  if (-not $Expected) { return }
  $Actual = Get-Sha256 $Path
  if ($Actual -ne $Expected.ToLowerInvariant()) {
    throw "SHA-256 mismatch for $Path. Expected $Expected, got $Actual"
  }
}

function Download([string]$Url, [string]$Destination) {
  if (Test-Path $Destination) { return }
  Write-Host "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile "$Destination.part" -UseBasicParsing
  [IO.File]::Move("$Destination.part", $Destination)
}

# Ghidra 12.1.4
$GhidraZip = Join-Path $Downloads "ghidra_12.1.4_PUBLIC_20260921.zip"
$GhidraUrl = "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.4_build/ghidra_12.1.4_PUBLIC_20260921.zip"
$GhidraSha = "ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db"
Download $GhidraUrl $GhidraZip
Assert-Sha256 $GhidraZip $GhidraSha
$GhidraHome = Join-Path $Tools "ghidra_12.1.4_PUBLIC"
if (-not (Test-Path $GhidraHome)) {
  Expand-Archive -Path $GhidraZip -DestinationPath $Tools -Force
}

# Temurin JDK 21 x64
$JdkApi = "https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse"
$JdkMeta = Invoke-RestMethod -Uri $JdkApi -UseBasicParsing
if (-not $JdkMeta -or -not $JdkMeta[0].binary.package) {
  throw "Adoptium returned no Windows x64 JDK package."
}
$JdkPackage = $JdkMeta[0].binary.package
$JdkZip = Join-Path $Downloads $JdkPackage.name
Download $JdkPackage.link $JdkZip
Assert-Sha256 $JdkZip $JdkPackage.checksum
$JdkHome = Join-Path $Tools "jdk"
if (-not (Test-Path (Join-Path $JdkHome "bin\java.exe"))) {
  $TempJdk = Join-Path $Tools "jdk.tmp"
  Remove-ToolDirectory $TempJdk
  New-Item -ItemType Directory -Force -Path $TempJdk | Out-Null
  Expand-Archive -Path $JdkZip -DestinationPath $TempJdk -Force
  $Java = Get-ChildItem -Path $TempJdk -Recurse -Filter java.exe |
    Where-Object { $_.FullName -match "\\bin\\java.exe$" } |
    Select-Object -First 1
  if (-not $Java) { throw "java.exe not found in JDK archive." }
  $ExtractedHome = Split-Path -Parent (Split-Path -Parent $Java.FullName)
  Remove-ToolDirectory $JdkHome
  Assert-ToolPath $ExtractedHome
  Assert-ToolPath $JdkHome
  Move-Item -LiteralPath $ExtractedHome -Destination $JdkHome
  Remove-ToolDirectory $TempJdk
}

# ipatool 2.7.0 with user-scoped Windows DPAPI credentials.
& (Join-Path $PSScriptRoot 'build-ipatool.ps1') -ToolsRoot $Tools
if ($LASTEXITCODE -ne 0) { throw 'Windows credential adapter installation failed' }

Write-Host "Ghidra:  $GhidraHome"
Write-Host "JDK:     $JdkHome"
Write-Host "ipatool: $(Join-Path $Tools 'ipatool\bin\ipatool-dpapi-v1.exe')"
Write-Host "Windows tool bootstrap complete."
