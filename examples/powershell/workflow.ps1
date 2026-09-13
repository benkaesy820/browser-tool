#Requires -Version 5.1
<#
Independent daemon client using Windows PowerShell 5.1 built-ins only.
Assumes a running daemon (start one first, stop it when done):
  1. bridge daemon start --detach
  2. .\workflow.ps1 -FixtureUrl "file:///C:/path/to/index.html"
  3. bridge daemon stop
Parameters allow an isolated rendezvous dir for tests:
  .\workflow.ps1 -FixtureUrl <url> -DaemonDir <dir>
Prints PASS on success; throws (exit 1) on any failed step.
#>
param(
  [Parameter(Mandatory = $true)][string]$FixtureUrl,
  [string]$BridgeBin = "bridge",
  [string]$DaemonDir = ""
)

$ErrorActionPreference = "Stop"
$script:counter = 0

function Invoke-Bridge {
  param([hashtable]$op)
  $script:counter++
  $body = @{ protocolVersion = "1.0"; requestId = ("exps-" + $script:counter) }
  foreach ($key in $op.Keys) { $body[$key] = $op[$key] }
  $json = $body | ConvertTo-Json -Compress -Depth 8
  $bridgeArgs = @()
  if ($DaemonDir -ne "") { $bridgeArgs += @("--daemon-dir", $DaemonDir) }
  $response = $json | & $BridgeBin @bridgeArgs call --stdin | ConvertFrom-Json
  if ($response.status -ne "completed") {
    throw ("op {0} failed: {1} {2}" -f $op["op"], $response.code, $response.message)
  }
  return $response
}

function Find-Ref {
  param($controls, [scriptblock]$pred, [string]$what)
  $found = @($controls | Where-Object $pred | Select-Object -First 1)
  if ($found.Count -eq 0) { throw "control not found: $what" }
  return $found[0].ref
}

$created = Invoke-Bridge @{ op = "create" }
$session = $created.sessionId
$opened = Invoke-Bridge @{ op = "open"; sessionId = $session; url = $FixtureUrl }
$input = Find-Ref $opened.observation.controls { $_.role -eq "textbox" } "item input"
$filled = Invoke-Bridge @{ op = "fill"; sessionId = $session; ref = $input; text = "apples" }
$add = Find-Ref $filled.observation.controls { $_.name -eq "Add to cart" } "add button"
$clicked = Invoke-Bridge @{ op = "click"; sessionId = $session; ref = $add }
if ($clicked.observation.text -notlike "*Item added: apples*") { throw "expected confirmation text missing" }
$shot = Invoke-Bridge @{ op = "screenshot"; sessionId = $session }
if (-not (Test-Path $shot.artifacts[0].path)) { throw "screenshot artifact missing" }
Invoke-Bridge @{ op = "close"; sessionId = $session } | Out-Null
"PASS: powershell workflow"
