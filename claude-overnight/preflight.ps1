param(
    [Parameter(Mandatory=$false)]
    [string]$RepoPath = ".",

    [Parameter(Mandatory=$false)]
    [string]$GuidelinesPath = "H:\.shortcut-targets-by-id\18EpkGLYe5uFBNbzY0CkamAMxv9ycP9g4\EBIM-Plataforma"
)

$ErrorActionPreference = "Stop"

Write-Host "=== EBIM Ecommerce - Preflight ===" -ForegroundColor Cyan

$repo = (Resolve-Path -LiteralPath $RepoPath).Path
Write-Host "Repo: $repo"

if (-not (Test-Path -LiteralPath $GuidelinesPath -PathType Container)) {
    throw "No se encuentra la carpeta obligatoria de lineamientos EBIM: $GuidelinesPath. Verifica que Google Drive H: este montado."
}

$guidelineFiles = Get-ChildItem -LiteralPath $GuidelinesPath -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 20
if (-not $guidelineFiles) {
    throw "La carpeta de lineamientos existe pero no se encontraron archivos legibles: $GuidelinesPath"
}

Write-Host "Drive EBIM: OK" -ForegroundColor Green
Write-Host "Muestra de archivos encontrados: $($guidelineFiles.Count)"

$required = @("claude", "git", "node", "npm")
foreach ($cmd in $required) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        throw "Falta comando requerido: $cmd"
    }
    Write-Host "$cmd : OK" -ForegroundColor Green
}

Write-Host "Claude version: $(& claude --version 2>$null)"
Write-Host "Node version:   $(& node --version 2>$null)"
Write-Host "NPM version:    $(& npm --version 2>$null)"
Write-Host "Git version:    $(& git --version 2>$null)"

$help = (& claude --help 2>&1 | Out-String)
if ($help -notmatch "--add-dir") {
    throw "Tu Claude Code no soporta --add-dir. Actualiza Claude Code antes de ejecutar para garantizar acceso a los lineamientos del Drive."
}

Write-Host "--add-dir disponible: OK" -ForegroundColor Green
Write-Host "PREFLIGHT_OK" -ForegroundColor Green
