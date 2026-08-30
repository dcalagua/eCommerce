param(
    [string]$RepoPath = ".",
    [string]$GuidelinesPath = ""
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$packRoot = Split-Path -Parent $scriptDir
$repo = (Resolve-Path -LiteralPath $RepoPath).Path

Write-Host "=== Claude SaaS Opus Pack - Preflight ===" -ForegroundColor Cyan
Write-Host "Repo: $repo"
Write-Host "Pack: $packRoot"

$requiredRepoFiles = @("CLAUDE.md", "package.json")
foreach ($file in $requiredRepoFiles) {
    $path = Join-Path $repo $file
    if (-not (Test-Path -LiteralPath $path)) { throw "Falta archivo requerido del repo: $file" }
    Write-Host "$file : OK" -ForegroundColor Green
}

$configPath = Join-Path $packRoot "config\phases.json"
if (-not (Test-Path -LiteralPath $configPath)) { throw "Falta phases.json" }
# Compatibilidad Windows PowerShell 5.1: ConvertFrom-Json puede devolver
# el array JSON como una coleccion anidada si se envuelve directamente con @(...).
# Lo enumeramos explicitamente para garantizar un elemento por fase.
$phaseData = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$phases = @()
foreach ($phaseItem in $phaseData) {
    $phases += $phaseItem
}
if ($phases.Count -lt 10) { throw "Se requieren al menos 10 prompts/fases." }
Write-Host "Fases configuradas: $($phases.Count)" -ForegroundColor Green

foreach ($phase in $phases) {
    $prompt = Join-Path $packRoot ("prompts\" + [string]$phase.file)
    if (-not (Test-Path -LiteralPath $prompt)) { throw "Prompt faltante: $prompt" }
}

foreach ($extra in @("prompts\SUPERVISOR.md", "prompts\RECOVERY.md", "prompts\EXECUTION_CONTRACT.md")) {
    if (-not (Test-Path -LiteralPath (Join-Path $packRoot $extra))) { throw "Falta $extra" }
}

$commands = @("claude", "git", "node", "npm")
foreach ($cmd in $commands) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "Falta comando: $cmd" }
    Write-Host "$cmd : OK" -ForegroundColor Green
}

$previousErrorActionPreference = $ErrorActionPreference
try {
    $ErrorActionPreference = "Continue"
    $help = (& claude --help 2>&1 | Out-String)
    $claudeHelpExitCode = $LASTEXITCODE
}
finally {
    $ErrorActionPreference = $previousErrorActionPreference
}
if ($claudeHelpExitCode -ne 0) { throw "No se pudo consultar claude --help (exit=$claudeHelpExitCode)." }
if (($help -notmatch "--permission-mode") -and ($help -notmatch "--dangerously-skip-permissions")) {
    throw "Claude Code no expone un modo unattended compatible con este runner."
}
if ($help -notmatch "--model") { throw "Claude Code no expone --model." }
Write-Host "Claude Code CLI compatible: OK" -ForegroundColor Green

if (-not [string]::IsNullOrWhiteSpace($GuidelinesPath)) {
    if (Test-Path -LiteralPath $GuidelinesPath -PathType Container) {
        if ($help -notmatch "--add-dir") { throw "GuidelinesPath existe pero Claude Code no soporta --add-dir." }
        Write-Host "Lineamientos externos: OK ($GuidelinesPath)" -ForegroundColor Green
    }
    else {
        $claudeRules = Get-Content -LiteralPath (Join-Path $repo "CLAUDE.md") -Raw -Encoding UTF8
        if ($claudeRules -match "LEER SIEMPRE") {
            throw "CLAUDE.md exige lineamientos externos y GuidelinesPath no esta montado: $GuidelinesPath"
        }
        Write-Warning "GuidelinesPath no esta montado: $GuidelinesPath"
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $repo "node_modules"))) {
    Write-Warning "node_modules no existe. Ejecuta npm ci antes de la corrida si el repo no esta preparado."
}

Set-Location -LiteralPath $repo
Write-Host "Branch: $(& git branch --show-current 2>$null)"
Write-Host "Claude: $(& claude --version 2>$null)"
Write-Host "Node:   $(& node --version 2>$null)"
Write-Host "NPM:    $(& npm --version 2>$null)"
Write-Host "PREFLIGHT_OK" -ForegroundColor Green
