# Render the static mockup to PNG with headless Edge.
# Usage: pwsh -File design/tools/render.ps1
$ErrorActionPreference = "Stop"

$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { throw "Microsoft Edge not found at $edge" }

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$mockup = (Join-Path $root "design\mockup.html") -replace '\\', '/'
$outDir = Join-Path $root "design\shots"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$profile = Join-Path $env:TEMP "portnest-mockup-profile"

$shots = @(
  @{ name = "01-workspace-light"; view = "workspace"; theme = "light"; skin = "aurora" },
  @{ name = "02-workspace-dark";  view = "workspace"; theme = "dark";  skin = "aurora" },
  @{ name = "03-workspace-light-dark-term"; view = "workspace"; theme = "light"; skin = "aurora"; term = "dark" },
  @{ name = "04-assets-light";    view = "assets";    theme = "light"; skin = "aurora" },
  @{ name = "05-form-dark";       view = "form";      theme = "dark";  skin = "aurora" },
  @{ name = "06-tokens-light";    view = "tokens";    theme = "light"; skin = "aurora" },
  @{ name = "07-empty-light";     view = "empty";     theme = "light"; skin = "aurora" },
  @{ name = "08-skin-mist-dark";  view = "workspace"; theme = "dark";  skin = "mist" },
  @{ name = "09-skin-ember-light"; view = "workspace"; theme = "light"; skin = "ember" },
  @{ name = "10-skin-midnight-dark"; view = "workspace"; theme = "dark"; skin = "midnight" }
)

foreach ($s in $shots) {
  $query = "view=$($s.view)&theme=$($s.theme)&skin=$($s.skin)"
  if ($s.term) { $query += "&term=$($s.term)" }
  $target = Join-Path $outDir "$($s.name).png"
  if (Test-Path $target) { Remove-Item $target -Force }

  & $edge --headless=new --disable-gpu --no-sandbox --hide-scrollbars `
    --force-device-scale-factor=1 --window-size=1520,1010 `
    --user-data-dir="$profile" --screenshot="$target" "file:///$mockup`?$query" 2>$null | Out-Null

  $deadline = (Get-Date).AddSeconds(20)
  while (-not (Test-Path $target) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
  if (Test-Path $target) {
    "OK   $($s.name)  $((Get-Item $target).Length) bytes"
  } else {
    "FAIL $($s.name)"
  }
}
