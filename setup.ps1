# One-paste setup for Windows (PowerShell). Nothing needs to be installed first.
#
#   irm https://raw.githubusercontent.com/TysonChernen/study-videos-kit/main/setup.ps1 | iex
#
# With Brightspace, set the address first:
#   $env:BRIGHTSPACE_URL="https://learn.myschool.edu"; irm https://raw.githubusercontent.com/TysonChernen/study-videos-kit/main/setup.ps1 | iex
#
# 1. Downloads the kit to %USERPROFILE%\study-videos-kit (or updates it).
# 2. Uses your Node.js if it is 18 or newer; otherwise downloads a private copy
#    into the kit folder (no admin rights, nothing installed system-wide).
# 3. Runs install.mjs, which adds the tools to your AI apps.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # makes Invoke-WebRequest much faster

$Repo = "TysonChernen/study-videos-kit"
$Kit = if ($env:STUDY_VIDEOS_KIT) { $env:STUDY_VIDEOS_KIT } else { Join-Path $HOME "study-videos-kit" }
$Runtime = Join-Path $Kit ".runtime"
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("svk-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $Tmp | Out-Null

try {
  Write-Host "Study videos kit setup"

  # 1. The kit
  if ((Test-Path (Join-Path $Kit ".git")) -and (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "  Updating $Kit"
    git -C $Kit pull -q --ff-only
  } else {
    Write-Host "  Downloading the kit to $Kit"
    Invoke-WebRequest "https://github.com/$Repo/archive/refs/heads/main.zip" -OutFile "$Tmp\kit.zip"
    Expand-Archive "$Tmp\kit.zip" -DestinationPath $Tmp
    New-Item -ItemType Directory -Force -Path $Kit | Out-Null
    Copy-Item -Recurse -Force "$Tmp\study-videos-kit-main\*" $Kit
  }

  # 2. Node.js
  $Node = $null
  $Private = Join-Path $Runtime "node\node.exe"
  if (Test-Path $Private) { $Node = $Private }
  elseif (Get-Command node -ErrorAction SilentlyContinue) {
    $major = [int]((node -p "process.versions.node.split('.')[0]") | Out-String).Trim()
    if ($major -ge 18) { $Node = (Get-Command node).Source }
  }
  if (-not $Node) {
    $Arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
    $Base = "https://nodejs.org/dist/latest-v22.x"
    Write-Host "  Node.js not found. Downloading a private copy for win-$Arch (about 30 MB)..."
    $Sums = (Invoke-WebRequest "$Base/SHASUMS256.txt" -UseBasicParsing).Content
    $File = [regex]::Match($Sums, "node-v[0-9.]+-win-$Arch\.zip").Value
    if (-not $File) { throw "Could not find a Node download for win-$Arch" }
    Invoke-WebRequest "$Base/$File" -OutFile "$Tmp\$File"
    $Expected = ([regex]::Match($Sums, "([0-9a-f]{64})\s+$([regex]::Escape($File))")).Groups[1].Value
    $Actual = (Get-FileHash "$Tmp\$File" -Algorithm SHA256).Hash.ToLower()
    if ($Expected -ne $Actual) { throw "Node download failed its checksum. Try again." }
    Expand-Archive "$Tmp\$File" -DestinationPath $Tmp
    New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
    if (Test-Path "$Runtime\node") { Remove-Item -Recurse -Force "$Runtime\node" }
    Move-Item "$Tmp\$($File -replace '\.zip$','')" "$Runtime\node"
    $Node = $Private
    Write-Host "  Node $(& $Node -v) ready"
  }

  # 3. Install
  $env:PATH = (Split-Path $Node) + ";" + $env:PATH
  $InstallArgs = @()
  if ($env:BRIGHTSPACE_URL) { $InstallArgs += @("--brightspace", $env:BRIGHTSPACE_URL) }
  & $Node (Join-Path $Kit "install.mjs") @InstallArgs @args
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
