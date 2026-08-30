param(
    [int]$ProcessId = 0,
    [string]$RepoPath = "."
)

$ErrorActionPreference = "Stop"

if ($ProcessId -gt 0) {
    Write-Host "Terminando arbol PID $ProcessId ..." -ForegroundColor Yellow
    & taskkill /PID $ProcessId /T /F
    exit $LASTEXITCODE
}

$repo = (Resolve-Path -LiteralPath $RepoPath).Path
$escaped = [Regex]::Escape($repo)
$targets = Get-CimInstance Win32_Process | Where-Object {
    ($_.ProcessId -ne $PID) -and
    ($_.CommandLine -match "claude-saas-opus") -and
    (($_.CommandLine -match $escaped) -or ($_.Name -match "powershell|pwsh|claude|node"))
}

if (-not $targets) {
    Write-Host "No se encontraron procesos del pack."
    exit 0
}

$targets | Sort-Object ProcessId -Descending | ForEach-Object {
    Write-Host "PID $($_.ProcessId) $($_.Name)" -ForegroundColor Yellow
    & taskkill /PID $_.ProcessId /T /F | Out-Host
}
