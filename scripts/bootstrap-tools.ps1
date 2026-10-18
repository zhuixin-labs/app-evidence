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
  Move-Item "$Destination.part" $Destination -Force
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
  Remove-Item -Recurse -Force $TempJdk -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $TempJdk | Out-Null
  Expand-Archive -Path $JdkZip -DestinationPath $TempJdk -Force
  $Java = Get-ChildItem -Path $TempJdk -Recurse -Filter java.exe |
    Where-Object { $_.FullName -match "\\bin\\java.exe$" } |
    Select-Object -First 1
  if (-not $Java) { throw "java.exe not found in JDK archive." }
  $ExtractedHome = Split-Path -Parent (Split-Path -Parent $Java.FullName)
  Remove-Item -Recurse -Force $JdkHome -ErrorAction SilentlyContinue
  Move-Item $ExtractedHome $JdkHome
  Remove-Item -Recurse -Force $TempJdk -ErrorAction SilentlyContinue
}

# ipatool 2.7.0 Windows x64
$IpatoolUrl = "https://github.com/majd/ipatool/releases/download/v2.7.0/ipatool-2.7.0-windows-amd64.zip"
$IpatoolZip = Join-Path $Downloads "ipatool-2.7.0-windows-amd64.zip"
Download $IpatoolUrl $IpatoolZip
if ($env:APPTRACE_IPATOOL_SHA256) {
  Assert-Sha256 $IpatoolZip $env:APPTRACE_IPATOOL_SHA256
} else {
  Write-Warning "APPTRACE_IPATOOL_SHA256 is not set; verify the official GitHub release hash before production use."
}
$IpatoolHome = Join-Path $Tools "ipatool"
if (-not (Test-Path (Join-Path $IpatoolHome "bin\ipatool.exe"))) {
  $TempIpatool = Join-Path $Tools "ipatool.tmp"
  Remove-Item -Recurse -Force $TempIpatool -ErrorAction SilentlyContinue
  Expand-Archive -Path $IpatoolZip -DestinationPath $TempIpatool -Force
  $Exe = Get-ChildItem -Path $TempIpatool -Recurse -Filter ipatool.exe | Select-Object -First 1
  if (-not $Exe) { throw "ipatool.exe not found in archive." }
  Remove-Item -Recurse -Force $IpatoolHome -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Exe.FullName) | Out-Null
  Move-Item (Split-Path -Parent $Exe.FullName) $IpatoolHome
  $Moved = Get-ChildItem -Path $IpatoolHome -Recurse -Filter ipatool.exe | Select-Object -First 1
  New-Item -ItemType Directory -Force -Path (Join-Path $IpatoolHome "bin") | Out-Null
  Copy-Item $Moved.FullName (Join-Path $IpatoolHome "bin\ipatool.exe") -Force
  Remove-Item -Recurse -Force $TempIpatool -ErrorAction SilentlyContinue
}

Write-Host "Ghidra:  $GhidraHome"
Write-Host "JDK:     $JdkHome"
Write-Host "ipatool: $(Join-Path $IpatoolHome 'bin\ipatool.exe')"
Write-Host "Windows tool bootstrap complete."
