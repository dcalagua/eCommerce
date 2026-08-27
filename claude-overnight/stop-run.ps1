param(
    [Parameter(Mandatory=$false)]
    [int]$ProcessId = 0,

    [Parameter(Mandatory=$false)]
    [string]$GuidelinesPath = "H:\.shortcut-targets-by-id\18EpkGLYe5uFBNbzY0CkamAMxv9ycP9g4\EBIM-Plataforma"
)

$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
    throw "Este helper esta pensado para Windows."
}

if ($ProcessId -gt 0) {
    Write-Host "Deteniendo arbol PID $ProcessId ..." -ForegroundColor Yellow
    & taskkill /PID $ProcessId /T /F
    exit $LASTEXITCODE
}

$escapedGuidelines = [Regex]::Escape($GuidelinesPath)
$matches = Get-CimInstance Win32_Process | Where-Object {
    $cmd = [string]$_.CommandLine
    ($cmd.Contains("run-all.ps1")) -or
    (($cmd -match "--add-dir") -and ($cmd -match $escapedGuidelines) -and ($cmd -match "--permission-mode"))
}

if (-not $matches) {
    Write-Host "No se encontro una corrida EBIM/Claude coincidente." -ForegroundColor Yellow
    Write-Host "Si la consola original sigue activa, usa Ctrl+C en esa consola."
    exit 0
}

Write-Host "Procesos encontrados:" -ForegroundColor Cyan
$matches | Select-Object ProcessId, ParentProcessId, Name, CommandLine | Format-Table -AutoSize

# Mata primero procesos raiz conocidos; /T incluye hijos. Dedupe por PID.
$pids = @($matches | Select-Object -ExpandProperty ProcessId -Unique)
foreach ($pidValue in $pids) {
    Write-Host "Deteniendo PID $pidValue y su arbol..." -ForegroundColor Yellow
    & taskkill /PID $pidValue /T /F | Out-Host
}

Write-Host "STOP_REQUEST_SENT" -ForegroundColor Green
