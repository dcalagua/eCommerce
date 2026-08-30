param(
    [Parameter(Mandatory=$false)]
    [string]$RepoPath = ".",

    [Parameter(Mandatory=$false)]
    [string]$Model = "opus",

    [Parameter(Mandatory=$false)]
    [ValidateRange(0,10)]
    [int]$MaxRetries = 3,

    [Parameter(Mandatory=$false)]
    [ValidateRange(1,10)]
    [int]$TransientRetries = 3,

    [Parameter(Mandatory=$false)]
    [ValidateRange(10,200)]
    [int]$MaxTurns = 70,

    [Parameter(Mandatory=$false)]
    [ValidateRange(10,200)]
    [int]$SupervisorMaxTurns = 55,

    [Parameter(Mandatory=$false)]
    [string]$StartAt = "00",

    [Parameter(Mandatory=$false)]
    [string]$StopAfter = "",

    [Parameter(Mandatory=$false)]
    [string]$GuidelinesPath = "",

    [Parameter(Mandatory=$false)]
    [string]$PermissionMode = "bypassPermissions",

    [Parameter(Mandatory=$false)]
    [int]$RetryDelaySeconds = 8,

    [Parameter(Mandatory=$false)]
    [switch]$RecoveryOnly,

    [Parameter(Mandatory=$false)]
    [switch]$SkipRunnerGates
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$packRoot = Split-Path -Parent $scriptDir
$promptDir = Join-Path $packRoot "prompts"
$configPath = Join-Path $packRoot "config\phases.json"
$logDir = Join-Path $packRoot "logs"
$stateDir = Join-Path $packRoot "state"
$statePath = Join-Path $stateDir "runner-state.json"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

$repo = (Resolve-Path -LiteralPath $RepoPath).Path
Set-Location -LiteralPath $repo

$repoClaudeMd = Join-Path $repo "CLAUDE.md"
if (Test-Path -LiteralPath $repoClaudeMd) {
    $repoRules = Get-Content -LiteralPath $repoClaudeMd -Raw -Encoding UTF8
    if (($repoRules -match "LEER SIEMPRE") -and (-not [string]::IsNullOrWhiteSpace($GuidelinesPath)) -and (-not (Test-Path -LiteralPath $GuidelinesPath -PathType Container))) {
        throw "CLAUDE.md exige lineamientos externos pero GuidelinesPath no esta disponible: $GuidelinesPath"
    }
}

function Write-Utf8NoBom {
    param([string]$Path, [string]$Content)
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Save-RunnerState {
    param(
        [string]$Phase,
        [string]$Status,
        [int]$Attempt,
        [string]$LogPath,
        [string]$Reason
    )

    $obj = [ordered]@{
        updated_at = (Get-Date).ToString("o")
        model = $Model
        phase = $Phase
        status = $Status
        attempt = $Attempt
        log = $LogPath
        reason = $Reason
        start_at = $StartAt
        stop_after = $StopAfter
    }
    Write-Utf8NoBom -Path $statePath -Content (($obj | ConvertTo-Json -Depth 5) + "`n")
}

function Get-LastNonEmptyLine {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return "" }
    $last = Get-Content -LiteralPath $Path -Encoding UTF8 | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Last 1
    if ($null -eq $last) { return "" }
    return ([string]$last).Trim()
}

function Get-TailText {
    param([string]$Path, [int]$Lines = 120)
    if (-not (Test-Path -LiteralPath $Path)) { return "" }
    return ((Get-Content -LiteralPath $Path -Encoding UTF8 -Tail $Lines) -join "`n")
}

function Test-TransientFailure {
    param([int]$ExitCode, [string]$LogPath, [string]$ExpectedPassMarker)
    if ($ExitCode -eq 0) { return $false }
    if ((Get-LastNonEmptyLine -Path $LogPath) -eq $ExpectedPassMarker) { return $false }
    $tail = (Get-TailText -Path $LogPath).ToLowerInvariant()
    $patterns = @(
        "rate limit",
        "rate_limit",
        "too many requests",
        "429",
        "529",
        "overloaded",
        "temporarily unavailable",
        "service unavailable",
        "econnreset",
        "etimedout",
        "connection reset",
        "socket hang up",
        "network error",
        "failed to fetch",
        "connection closed"
    )
    foreach ($pattern in $patterns) {
        if ($tail.Contains($pattern)) { return $true }
    }
    return $false
}

if (-not (Test-Path -LiteralPath $configPath)) {
    throw "No existe config de fases: $configPath"
}

# Compatibilidad Windows PowerShell 5.1: ConvertFrom-Json puede devolver
# el array JSON como una coleccion anidada si se envuelve directamente con @(...).
# Lo enumeramos explicitamente para garantizar un elemento por fase.
$phaseData = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$phases = @()
foreach ($phaseItem in $phaseData) {
    $phases += $phaseItem
}
if ($phases.Count -lt 10) {
    throw "El pack requiere al menos 10 fases; config contiene $($phases.Count)."
}

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    throw "No se encontro Claude Code en PATH."
}

$claudeHelp = (& claude --help 2>&1 | Out-String)
$supportsAddDir = $claudeHelp -match "--add-dir"
$supportsPermissionMode = $claudeHelp -match "--permission-mode"
$supportsDangerousSkip = $claudeHelp -match "--dangerously-skip-permissions"
$supportsNoPersistence = $claudeHelp -match "--no-session-persistence"
$supportsMaxTurns = $claudeHelp -match "--max-turns"

function Get-ClaudeBaseArgs {
    param([int]$Turns)
    $resultArgs = @("--model", $Model, "--output-format", "text")

    if ($supportsMaxTurns) {
        $resultArgs += @("--max-turns", "$Turns")
    }

    if (-not [string]::IsNullOrWhiteSpace($GuidelinesPath) -and (Test-Path -LiteralPath $GuidelinesPath -PathType Container)) {
        if (-not $supportsAddDir) {
            throw "Claude Code no soporta --add-dir pero GuidelinesPath fue configurado."
        }
        $resultArgs += @("--add-dir", $GuidelinesPath)
    }

    if (-not [string]::IsNullOrWhiteSpace($PermissionMode)) {
        if ($supportsPermissionMode) {
            $resultArgs += @("--permission-mode", $PermissionMode)
        }
        elseif (($PermissionMode -eq "bypassPermissions") -and $supportsDangerousSkip) {
            $resultArgs += "--dangerously-skip-permissions"
        }
        else {
            throw "La version de Claude Code no soporta el modo unattended solicitado: $PermissionMode"
        }
    }

    if ($supportsNoPersistence) {
        $resultArgs += "--no-session-persistence"
    }

    return $resultArgs
}

function Invoke-ClaudeOnce {
    param(
        [string]$Label,
        [string]$Prompt,
        [string]$LogPath,
        [int]$Turns
    )

    Write-Host ""
    Write-Host "=== $Label ===" -ForegroundColor Cyan
    Write-Host "Modelo: $Model | MaxTurns: $Turns"
    Write-Host "Log: $LogPath"

    $claudeArgs = @("-p", $Prompt)
    $claudeArgs += @(Get-ClaudeBaseArgs -Turns $Turns)

    # Windows PowerShell 5.1 convierte cualquier escritura nativa a STDERR en
    # NativeCommandError cuando ErrorActionPreference=Stop. Claude/Vitest pueden
    # escribir mensajes informativos a STDERR aun con exit code 0. Para procesos
    # nativos, el criterio real de fallo debe ser $LASTEXITCODE, no el stream STDERR.
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & claude @claudeArgs 2>&1 | Tee-Object -FilePath $LogPath | ForEach-Object { Write-Host ([string]$_) }
        $nativeExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    return $nativeExitCode
}

function Invoke-ClaudeWithTransientRetry {
    param(
        [string]$Label,
        [string]$Prompt,
        [string]$LogBase,
        [int]$Turns,
        [string]$ExpectedPassMarker
    )

    for ($transient = 0; $transient -le $TransientRetries; $transient++) {
        $suffix = if ($transient -eq 0) { "" } else { "-transient-$transient" }
        $log = "$LogBase$suffix.log"
        $code = Invoke-ClaudeOnce -Label $Label -Prompt $Prompt -LogPath $log -Turns $Turns
        $isTransient = Test-TransientFailure -ExitCode $code -LogPath $log -ExpectedPassMarker $ExpectedPassMarker
        if (-not $isTransient) {
            return [pscustomobject]@{ ExitCode = $code; LogPath = $log; TransientExhausted = $false }
        }

        if ($transient -ge $TransientRetries) {
            return [pscustomobject]@{ ExitCode = $code; LogPath = $log; TransientExhausted = $true }
        }

        $wait = [Math]::Min(120, $RetryDelaySeconds * [Math]::Pow(2, $transient))
        Write-Warning "Error transitorio detectado. Reintento en $wait segundos."
        Start-Sleep -Seconds ([int]$wait)
    }
}

function Get-NpmScriptNames {
    $packagePath = Join-Path $repo "package.json"
    if (-not (Test-Path -LiteralPath $packagePath)) { return @() }
    $pkg = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -eq $pkg.scripts) { return @() }
    return @($pkg.scripts.PSObject.Properties.Name)
}

$npmScripts = Get-NpmScriptNames

function Invoke-RunnerGates {
    param(
        [object]$Phase,
        [string]$AttemptLog
    )

    if ($SkipRunnerGates) {
        return [pscustomobject]@{ Pass = $true; Reason = "runner_gates_skipped" }
    }

    foreach ($gate in @($Phase.gates)) {
        if ($npmScripts -notcontains [string]$gate) {
            Add-Content -LiteralPath $AttemptLog -Encoding UTF8 -Value "`nRUNNER_GATE_SKIP: npm script '$gate' no existe."
            continue
        }

        Write-Host "--- Runner gate: npm run $gate ---" -ForegroundColor DarkCyan
        Add-Content -LiteralPath $AttemptLog -Encoding UTF8 -Value "`n=== RUNNER GATE: npm run $gate ==="
        # PowerShell 5.1 puede promover STDERR de node/vitest a NativeCommandError
        # aunque npm termine correctamente. Permitimos STDERR y evaluamos solo
        # el exit code real del proceso nativo.
        $previousErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = "Continue"
            & npm run $gate 2>&1 | Tee-Object -FilePath $AttemptLog -Append | ForEach-Object { Write-Host ([string]$_) }
            $code = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        if ($code -ne 0) {
            Add-Content -LiteralPath $AttemptLog -Encoding UTF8 -Value "RUNNER_GATE_RESULT: FAIL ($gate exit=$code)"
            return [pscustomobject]@{ Pass = $false; Reason = "runner_gate:$gate exit=$code" }
        }
        Add-Content -LiteralPath $AttemptLog -Encoding UTF8 -Value "RUNNER_GATE_RESULT: PASS ($gate)"
    }

    return [pscustomobject]@{ Pass = $true; Reason = "OK" }
}

$executionContractPath = Join-Path $promptDir "EXECUTION_CONTRACT.md"
$executionContract = Get-Content -LiteralPath $executionContractPath -Raw -Encoding UTF8

function Invoke-PhaseAttempt {
    param(
        [object]$Phase,
        [int]$Attempt
    )

    $promptPath = Join-Path $promptDir ([string]$Phase.file)
    if (-not (Test-Path -LiteralPath $promptPath)) {
        throw "Prompt faltante: $promptPath"
    }

    $basePrompt = Get-Content -LiteralPath $promptPath -Raw -Encoding UTF8
    $dynamicContext = @"

# Contexto de runner
PHASE_ID: $($Phase.id)
PHASE_NAME: $($Phase.name)
ATTEMPT: $Attempt
REPO_ROOT: $repo
MODEL: $Model

"@
    $prompt = $basePrompt + "`n`n" + $executionContract + $dynamicContext

    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $logBase = Join-Path $logDir ("{0}-{1}-attempt-{2}" -f $stamp, $Phase.name, $Attempt)
    $run = Invoke-ClaudeWithTransientRetry -Label "$($Phase.name) intento $Attempt" -Prompt $prompt -LogBase $logBase -Turns $MaxTurns -ExpectedPassMarker "PHASE_RESULT: PASS"
    $lastLine = Get-LastNonEmptyLine -Path $run.LogPath
    $reportedPass = ($lastLine -eq "PHASE_RESULT: PASS")

    if (($run.ExitCode -ne 0) -or (-not $reportedPass)) {
        $parts = @()
        if ($run.ExitCode -ne 0) { $parts += "claude_exit=$($run.ExitCode)" }
        if (-not $reportedPass) { $parts += "PHASE_RESULT_PASS_ausente" }
        if ($run.TransientExhausted) { $parts += "transient_retries_exhausted" }
        return [pscustomobject]@{ Pass = $false; LogPath = $run.LogPath; Reason = ($parts -join "; ") }
    }

    $gates = Invoke-RunnerGates -Phase $Phase -AttemptLog $run.LogPath
    if (-not $gates.Pass) {
        return [pscustomobject]@{ Pass = $false; LogPath = $run.LogPath; Reason = $gates.Reason }
    }

    return [pscustomobject]@{ Pass = $true; LogPath = $run.LogPath; Reason = "OK" }
}

function Invoke-Supervisor {
    param(
        [object]$Phase,
        [int]$RetryNumber,
        [string]$FailedLog,
        [string]$FailureReason
    )

    $supervisorPath = Join-Path $promptDir "SUPERVISOR.md"
    $basePrompt = Get-Content -LiteralPath $supervisorPath -Raw -Encoding UTF8
    $context = @"

# CONTEXTO DE ESTA INTERVENCION
PHASE: $($Phase.name)
PHASE_ID: $($Phase.id)
PHASE_PROMPT_FILE: $((Join-Path $promptDir ([string]$Phase.file)))
FAILED_LOG: $FailedLog
FAILURE_REASON: $FailureReason
RETRY_NUMBER: $RetryNumber
MAX_RETRIES: $MaxRetries
REPO_ROOT: $repo

Repara solo la causa que bloquea esta fase. Luego el runner reejecutara la misma fase desde cero sobre el estado reparado.
"@
    $prompt = $basePrompt + $context

    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $logBase = Join-Path $logDir ("{0}-{1}-supervisor-{2}" -f $stamp, $Phase.name, $RetryNumber)
    $run = Invoke-ClaudeWithTransientRetry -Label "SUPERVISOR $($Phase.name) reparacion $RetryNumber" -Prompt $prompt -LogBase $logBase -Turns $SupervisorMaxTurns -ExpectedPassMarker "SUPERVISOR_RESULT: REPAIRED"
    $lastLine = Get-LastNonEmptyLine -Path $run.LogPath
    $repaired = ($run.ExitCode -eq 0) -and ($lastLine -eq "SUPERVISOR_RESULT: REPAIRED")

    return [pscustomobject]@{ Repaired = $repaired; LogPath = $run.LogPath; ExitCode = $run.ExitCode; Marker = $lastLine }
}

function Invoke-PhaseWithSupervisor {
    param([object]$Phase)

    for ($attempt = 1; $attempt -le ($MaxRetries + 1); $attempt++) {
        Save-RunnerState -Phase $Phase.name -Status "RUNNING" -Attempt $attempt -LogPath "" -Reason ""
        $result = Invoke-PhaseAttempt -Phase $Phase -Attempt $attempt

        if ($result.Pass) {
            Save-RunnerState -Phase $Phase.name -Status "PASS" -Attempt $attempt -LogPath $result.LogPath -Reason "OK"
            Write-Host "$($Phase.name) PASS en intento $attempt" -ForegroundColor Green
            return
        }

        Save-RunnerState -Phase $Phase.name -Status "FAILED" -Attempt $attempt -LogPath $result.LogPath -Reason $result.Reason
        Write-Warning "$($Phase.name) fallo en intento ${attempt}: $($result.Reason)"
        Write-Warning "Log: $($result.LogPath)"

        if ($attempt -gt $MaxRetries) {
            throw "$($Phase.name) no pudo completarse despues de $MaxRetries reparaciones. Ultimo log: $($result.LogPath)"
        }

        $supervisor = Invoke-Supervisor -Phase $Phase -RetryNumber $attempt -FailedLog $result.LogPath -FailureReason $result.Reason
        if (-not $supervisor.Repaired) {
            Save-RunnerState -Phase $Phase.name -Status "BLOCKED" -Attempt $attempt -LogPath $supervisor.LogPath -Reason "Supervisor: $($supervisor.Marker)"
            throw "Supervisor no pudo reparar $($Phase.name). Revisa $($supervisor.LogPath)"
        }

        Save-RunnerState -Phase $Phase.name -Status "REPAIRED" -Attempt $attempt -LogPath $supervisor.LogPath -Reason "Reejecutar misma fase"
        Write-Host "Supervisor reparo $($Phase.name). Se reejecutara la misma fase." -ForegroundColor Yellow
        Start-Sleep -Seconds $RetryDelaySeconds
    }
}

function Invoke-Recovery {
    $phase = [pscustomobject]@{
        id = "RECOVERY"
        name = "RECOVERY"
        file = "RECOVERY.md"
        gates = @("typecheck", "lint", "test", "test:db", "build")
    }
    Invoke-PhaseWithSupervisor -Phase $phase
}

if ($RecoveryOnly) {
    Invoke-Recovery
    Write-Host "RECOVERY PASS. Revisa docs/STATE.md y reanuda con -StartAt si corresponde." -ForegroundColor Green
    exit 0
}

$startIndex = -1
for ($i = 0; $i -lt $phases.Count; $i++) {
    if ([string]$phases[$i].id -eq $StartAt) { $startIndex = $i; break }
}
if ($startIndex -lt 0) { throw "StartAt invalido: $StartAt" }

$stopIndex = $phases.Count - 1
if (-not [string]::IsNullOrWhiteSpace($StopAfter)) {
    $stopIndex = -1
    for ($i = 0; $i -lt $phases.Count; $i++) {
        if ([string]$phases[$i].id -eq $StopAfter) { $stopIndex = $i; break }
    }
    if ($stopIndex -lt 0) { throw "StopAfter invalido: $StopAfter" }
    if ($stopIndex -lt $startIndex) { throw "StopAfter no puede ser anterior a StartAt." }
}

Write-Host "=== Claude SaaS Opus Pack ===" -ForegroundColor Cyan
Write-Host "Repo: $repo"
Write-Host "Modelo: $Model"
Write-Host "Fases: $StartAt -> $($phases[$stopIndex].id)"
Write-Host "Max reparaciones por fase: $MaxRetries"
Write-Host "Reintentos transitorios: $TransientRetries"

for ($i = $startIndex; $i -le $stopIndex; $i++) {
    Invoke-PhaseWithSupervisor -Phase $phases[$i]
}

Write-Host ""
Write-Host "ALL_SELECTED_PHASES_PASS" -ForegroundColor Green
Write-Host "Revisa docs/STATE.md, docs/SAAS_RELEASE_BASELINE.md y logs en claude-saas-opus/logs/."
