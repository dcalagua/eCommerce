param(
    [Parameter(Mandatory=$false)]
    [string]$RepoPath = ".",

    [Parameter(Mandatory=$false)]
    [string]$GuidelinesPath = "H:\.shortcut-targets-by-id\18EpkGLYe5uFBNbzY0CkamAMxv9ycP9g4\EBIM-Plataforma",

    [Parameter(Mandatory=$false)]
    [ValidateSet("sonnet", "opus")]
    [string]$Model = "opus",

    [Parameter(Mandatory=$false)]
    [ValidateSet("00","01","02","03","04","05","06","07","08")]
    [string]$StartAt = "00",

    [Parameter(Mandatory=$false)]
    [int]$MaxTurns = 100,

    [Parameter(Mandatory=$false)]
    [ValidateRange(0,10)]
    [int]$MaxRetries = 3,

    [Parameter(Mandatory=$false)]
    [switch]$RecoveryOnly
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$promptDir = Join-Path $scriptRoot "prompts"
$logDir = Join-Path $scriptRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

& (Join-Path $scriptRoot "preflight.ps1") -RepoPath $RepoPath -GuidelinesPath $GuidelinesPath

$repo = (Resolve-Path -LiteralPath $RepoPath).Path
Set-Location -LiteralPath $repo

# Evita suspension del sistema durante la corrida; no obliga a mantener la pantalla encendida.
if ($env:OS -eq "Windows_NT") {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class EbimAwake {
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
"@ -ErrorAction SilentlyContinue
    [EbimAwake]::SetThreadExecutionState([uint32]2147483649) | Out-Null
}

$claudeHelp = (& claude --help 2>&1 | Out-String)
$supportsNoPersistence = $claudeHelp -match "--no-session-persistence"

function Get-LastNonEmptyLogLine {
    param([string]$LogPath)
    if (-not (Test-Path -LiteralPath $LogPath)) { return "" }
    $last = Get-Content -LiteralPath $LogPath -Encoding UTF8 | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Last 1
    if ($null -eq $last) { return "" }
    return ([string]$last).Trim()
}

function Test-GuidelinesVerified {
    $state = Join-Path $repo "docs\STATE.md"
    $trace = Join-Path $repo "docs\EBIM_GUIDELINES_TRACE.md"
    $claudeMd = Join-Path $repo "CLAUDE.md"

    if (-not (Test-Path -LiteralPath $state)) { return $false }
    if (-not (Test-Path -LiteralPath $trace)) { return $false }
    if (-not (Test-Path -LiteralPath $claudeMd)) { return $false }

    $stateContent = Get-Content -LiteralPath $state -Raw -Encoding UTF8
    return ($stateContent -match "GUIDELINES_STATUS\s*:\s*VERIFIED")
}

function Assert-GuidelinesVerified {
    if (-not (Test-GuidelinesVerified)) {
        throw "Gate EBIM invalido: faltan CLAUDE.md/docs o GUIDELINES_STATUS: VERIFIED. Ejecuta desde P00 para volver a validar el Drive."
    }
}

function Invoke-ClaudeRaw {
    param(
        [string]$Label,
        [string]$Prompt,
        [string]$LogPath
    )

    Write-Host ""
    Write-Host "=== $Label ===" -ForegroundColor Cyan
    Write-Host "Modelo: $Model | MaxTurns: $MaxTurns"
    Write-Host "Log: $LogPath"

    $claudeArgs = @(
        "-p", $Prompt,
        "--model", $Model,
        "--add-dir", $GuidelinesPath,
        "--permission-mode", "bypassPermissions",
        "--max-turns", "$MaxTurns",
        "--output-format", "text"
    )

    if ($supportsNoPersistence) {
        $claudeArgs += "--no-session-persistence"
    }

    & claude @claudeArgs 2>&1 | Tee-Object -FilePath $LogPath | ForEach-Object { Write-Host $_ }
    return $LASTEXITCODE
}

function Invoke-ClaudePhaseAttempt {
    param(
        [string]$PhaseName,
        [string]$PromptFile,
        [int]$Attempt
    )

    $path = Join-Path $promptDir $PromptFile
    if (-not (Test-Path -LiteralPath $path)) {
        throw "No existe prompt: $path"
    }

    $basePrompt = Get-Content -LiteralPath $path -Raw -Encoding UTF8
    $contract = @"

RUNNER CONTRACT (obligatorio):
- Trabaja solo en esta fase y respeta CLAUDE.md + lineamientos EBIM del Drive.
- Antes de declarar exito ejecuta las verificaciones exigidas por esta fase.
- Si una verificacion requerida falla, intenta corregirla dentro de esta misma ejecucion.
- No ocultes fallos, no elimines tests para hacerlos pasar y no saltes requisitos.
- La ULTIMA linea de tu respuesta debe ser exactamente una de estas:
PHASE_RESULT: PASS
PHASE_RESULT: FAIL
- Usa PASS solo si esta fase quedo realmente completada y sus verificaciones requeridas pasaron.
"@
    $prompt = $basePrompt + $contract

    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $log = Join-Path $logDir ("{0}-{1}-attempt-{2}.log" -f $stamp, $PhaseName, $Attempt)
    $code = Invoke-ClaudeRaw -Label "$PhaseName / intento $Attempt / $PromptFile" -Prompt $prompt -LogPath $log
    $lastLine = Get-LastNonEmptyLogLine -LogPath $log
    $reportedPass = ($lastLine -eq "PHASE_RESULT: PASS")

    $guidelinesOk = $true
    if ($PhaseName -eq "P00") {
        $guidelinesOk = Test-GuidelinesVerified
        if ($guidelinesOk) {
            Write-Host "Gate lineamientos EBIM: VERIFIED" -ForegroundColor Green
        }
        else {
            Write-Warning "P00 no dejo evidencia valida de lineamientos EBIM."
        }
    }

    $pass = ($code -eq 0) -and $reportedPass -and $guidelinesOk
    $reasonParts = @()
    if ($code -ne 0) { $reasonParts += "exit_code=$code" }
    if (-not $reportedPass) { $reasonParts += "PHASE_RESULT_PASS_ausente" }
    if (-not $guidelinesOk) { $reasonParts += "GUIDELINES_STATUS_no_verificado" }
    $reason = if ($reasonParts.Count -gt 0) { $reasonParts -join "; " } else { "OK" }

    return [pscustomobject]@{
        Pass = $pass
        ExitCode = $code
        LogPath = $log
        Reason = $reason
    }
}

function Invoke-Supervisor {
    param(
        [string]$PhaseName,
        [string]$PromptFile,
        [int]$RetryNumber,
        [string]$FailedLog,
        [string]$FailureReason
    )

    $supervisorPath = Join-Path $promptDir "SUPERVISOR.md"
    if (-not (Test-Path -LiteralPath $supervisorPath)) {
        throw "No existe prompt supervisor: $supervisorPath"
    }

    $basePrompt = Get-Content -LiteralPath $supervisorPath -Raw -Encoding UTF8
    $relativeLog = $FailedLog

    $context = @"

CONTEXTO DE ESTA INTERVENCION:
PHASE: $PhaseName
PHASE_PROMPT_FILE: claude-overnight/prompts/$PromptFile
FAILED_LOG: $relativeLog
FAILURE_REASON: $FailureReason
RETRY_NUMBER: $RetryNumber de $MaxRetries

Repara el estado actual del repo. No implementes fases posteriores.
La ULTIMA linea de tu respuesta debe ser exactamente una de estas:
SUPERVISOR_RESULT: REPAIRED
SUPERVISOR_RESULT: BLOCKED
"@

    $prompt = $basePrompt + $context
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $log = Join-Path $logDir ("{0}-{1}-supervisor-{2}.log" -f $stamp, $PhaseName, $RetryNumber)
    $code = Invoke-ClaudeRaw -Label "SUPERVISOR $PhaseName / reparacion $RetryNumber" -Prompt $prompt -LogPath $log
    $lastLine = Get-LastNonEmptyLogLine -LogPath $log
    $repaired = ($code -eq 0) -and ($lastLine -eq "SUPERVISOR_RESULT: REPAIRED")

    return [pscustomobject]@{
        Repaired = $repaired
        ExitCode = $code
        LogPath = $log
    }
}

function Invoke-PhaseWithSupervisor {
    param(
        [string]$PhaseName,
        [string]$PromptFile
    )

    for ($attempt = 1; $attempt -le ($MaxRetries + 1); $attempt++) {
        $result = Invoke-ClaudePhaseAttempt -PhaseName $PhaseName -PromptFile $PromptFile -Attempt $attempt
        if ($result.Pass) {
            Write-Host "$PhaseName PASS en intento $attempt" -ForegroundColor Green
            return
        }

        Write-Warning "$PhaseName fallo en intento ${attempt}: $($result.Reason)"
        Write-Warning "Log fallido: $($result.LogPath)"

        if ($attempt -gt $MaxRetries) {
            throw "$PhaseName no pudo completarse despues de $MaxRetries reintentos correctivos. Ultimo log: $($result.LogPath)"
        }

        $retryNumber = $attempt
        $supervisor = Invoke-Supervisor `
            -PhaseName $PhaseName `
            -PromptFile $PromptFile `
            -RetryNumber $retryNumber `
            -FailedLog $result.LogPath `
            -FailureReason $result.Reason

        if (-not $supervisor.Repaired) {
            throw "Supervisor no pudo reparar $PhaseName. Revisa $($supervisor.LogPath)"
        }

        Write-Host "Supervisor reparo $PhaseName. Se reejecutara la MISMA fase." -ForegroundColor Yellow
    }
}

try {
    if ($RecoveryOnly) {
        if (Test-Path -LiteralPath (Join-Path $repo "docs\STATE.md")) {
            Assert-GuidelinesVerified
        }
        Invoke-PhaseWithSupervisor -PhaseName "RECOVERY" -PromptFile "RECOVERY.md"
        Write-Host "RECOVERY_EXECUTED" -ForegroundColor Green
        exit 0
    }

    $phases = @(
        @{ Id = "00"; Name = "P00"; File = "00_guidelines.md" },
        @{ Id = "01"; Name = "P01"; File = "01_frontend_foundation.md" },
        @{ Id = "02"; Name = "P02"; File = "02_supabase_multitenant.md" },
        @{ Id = "03"; Name = "P03"; File = "03_auth_admin.md" },
        @{ Id = "04"; Name = "P04"; File = "04_catalog_admin.md" },
        @{ Id = "05"; Name = "P05"; File = "05_storefront.md" },
        @{ Id = "06"; Name = "P06"; File = "06_cart_checkout.md" },
        @{ Id = "07"; Name = "P07"; File = "07_orders_settings.md" },
        @{ Id = "08"; Name = "P08"; File = "08_quality_gate.md" }
    )

    $startIndex = -1
    for ($j = 0; $j -lt $phases.Count; $j++) {
        if ($phases[$j].Id -eq $StartAt) {
            $startIndex = $j
            break
        }
    }
    if ($startIndex -lt 0) { throw "StartAt invalido: $StartAt" }

    if ($StartAt -ne "00") {
        Assert-GuidelinesVerified
    }

    for ($i = $startIndex; $i -lt $phases.Count; $i++) {
        $p = $phases[$i]
        if ($p.Id -ne "00") {
            Assert-GuidelinesVerified
        }
        Invoke-PhaseWithSupervisor -PhaseName $p.Name -PromptFile $p.File
    }

    Write-Host ""
    Write-Host "ALL_PHASES_EXECUTED" -ForegroundColor Green
    Write-Host "Revisa docs\STATE.md y docs\OVERNIGHT_REPORT.md en el repo."
}
finally {
    if ($env:OS -eq "Windows_NT") {
        [EbimAwake]::SetThreadExecutionState([uint32]2147483648) | Out-Null
    }
}
