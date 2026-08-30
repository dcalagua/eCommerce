param(
    [Parameter(Mandatory=$true)]
    [string]$Phase,
    [string]$RepoPath = ".",
    [string]$Model = "opus",
    [int]$MaxRetries = 3,
    [int]$TransientRetries = 3,
    [int]$MaxTurns = 70,
    [int]$SupervisorMaxTurns = 55,
    [string]$GuidelinesPath = "",
    [string]$PermissionMode = "bypassPermissions",
    [switch]$SkipRunnerGates
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $scriptDir "run-all.ps1"

& $runner `
    -RepoPath $RepoPath `
    -Model $Model `
    -MaxRetries $MaxRetries `
    -TransientRetries $TransientRetries `
    -MaxTurns $MaxTurns `
    -SupervisorMaxTurns $SupervisorMaxTurns `
    -GuidelinesPath $GuidelinesPath `
    -PermissionMode $PermissionMode `
    -StartAt $Phase `
    -StopAfter $Phase `
    -SkipRunnerGates:$SkipRunnerGates

exit $LASTEXITCODE
