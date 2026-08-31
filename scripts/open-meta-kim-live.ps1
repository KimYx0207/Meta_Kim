$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot "meta-kim-live.mjs"
$node = (Get-Command node -ErrorAction Stop).Source
$locationPushed = $false

try {
  Push-Location $repoRoot
  $locationPushed = $true
  & $node $launcher --port 4331
  if ($LASTEXITCODE -ne 0) {
    throw "Meta_Kim Live failed to start."
  }
} catch {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show(
    "Meta_Kim Live 无法启动。请确认 Node.js 和项目目录仍然存在。",
    "Meta_Kim Live",
    "OK",
    "Error"
  ) | Out-Null
  exit 1
} finally {
  if ($locationPushed) {
    Pop-Location
  }
}
