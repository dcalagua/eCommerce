#!/usr/bin/env bash
set -uo pipefail

REPO_PATH="${REPO_PATH:-.}"
MODEL="${MODEL:-opus}"
MAX_RETRIES="${MAX_RETRIES:-3}"
TRANSIENT_RETRIES="${TRANSIENT_RETRIES:-3}"
MAX_TURNS="${MAX_TURNS:-70}"
SUPERVISOR_MAX_TURNS="${SUPERVISOR_MAX_TURNS:-55}"
START_AT="${START_AT:-00}"
STOP_AFTER="${STOP_AFTER:-}"
GUIDELINES_PATH="${GUIDELINES_PATH:-}"
PERMISSION_MODE="${PERMISSION_MODE:-bypassPermissions}"
RETRY_DELAY_SECONDS="${RETRY_DELAY_SECONDS:-8}"
SKIP_RUNNER_GATES="${SKIP_RUNNER_GATES:-0}"
RECOVERY_ONLY="${RECOVERY_ONLY:-0}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACK_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROMPT_DIR="$PACK_ROOT/prompts"
CONFIG_PATH="$PACK_ROOT/config/phases.json"
LOG_DIR="$PACK_ROOT/logs"
STATE_DIR="$PACK_ROOT/state"
STATE_PATH="$STATE_DIR/runner-state.json"
mkdir -p "$LOG_DIR" "$STATE_DIR"

REPO="$(cd "$REPO_PATH" && pwd)"
cd "$REPO" || exit 1

if ! command -v claude >/dev/null 2>&1; then echo "Claude Code no esta en PATH" >&2; exit 1; fi
if ! command -v node >/dev/null 2>&1; then echo "Node no esta en PATH" >&2; exit 1; fi
if ! command -v npm >/dev/null 2>&1; then echo "npm no esta en PATH" >&2; exit 1; fi

CLAUDE_HELP="$(claude --help 2>&1 || true)"

save_state() {
  local phase="$1" status="$2" attempt="$3" log="$4" reason="$5"
  PHASE_STATE="$phase" STATUS_STATE="$status" ATTEMPT_STATE="$attempt" LOG_STATE="$log" REASON_STATE="$reason" MODEL_STATE="$MODEL" STATE_PATH_ENV="$STATE_PATH" \
  node -e 'const fs=require("fs"); const o={updated_at:new Date().toISOString(),model:process.env.MODEL_STATE,phase:process.env.PHASE_STATE,status:process.env.STATUS_STATE,attempt:Number(process.env.ATTEMPT_STATE||0),log:process.env.LOG_STATE,reason:process.env.REASON_STATE}; fs.writeFileSync(process.env.STATE_PATH_ENV,JSON.stringify(o,null,2)+"\n");'
}

last_nonempty() {
  awk 'NF{line=$0} END{print line}' "$1" 2>/dev/null || true
}

is_transient() {
  local exit_code="$1" log="$2" marker="$3"
  [[ "$exit_code" -eq 0 ]] && return 1
  [[ "$(last_nonempty "$log")" == "$marker" ]] && return 1
  tail -n 120 "$log" 2>/dev/null | tr '[:upper:]' '[:lower:]' | grep -Eq 'rate limit|rate_limit|too many requests|(^|[^0-9])429([^0-9]|$)|(^|[^0-9])529([^0-9]|$)|overloaded|temporarily unavailable|service unavailable|econnreset|etimedout|connection reset|socket hang up|network error|failed to fetch|connection closed'
}

claude_args() {
  local turns="$1"
  local -a a=(--model "$MODEL" --output-format text)
  grep -q -- '--max-turns' <<<"$CLAUDE_HELP" && a+=(--max-turns "$turns")
  if [[ -n "$GUIDELINES_PATH" && -d "$GUIDELINES_PATH" ]]; then
    if ! grep -q -- '--add-dir' <<<"$CLAUDE_HELP"; then echo "Claude Code no soporta --add-dir" >&2; return 1; fi
    a+=(--add-dir "$GUIDELINES_PATH")
  fi
  if [[ -n "$PERMISSION_MODE" ]]; then
    if grep -q -- '--permission-mode' <<<"$CLAUDE_HELP"; then
      a+=(--permission-mode "$PERMISSION_MODE")
    elif [[ "$PERMISSION_MODE" == "bypassPermissions" ]] && grep -q -- '--dangerously-skip-permissions' <<<"$CLAUDE_HELP"; then
      a+=(--dangerously-skip-permissions)
    else
      echo "Modo unattended no soportado: $PERMISSION_MODE" >&2
      return 1
    fi
  fi
  grep -q -- '--no-session-persistence' <<<"$CLAUDE_HELP" && a+=(--no-session-persistence)
  printf '%s\0' "${a[@]}"
}

invoke_claude_retry() {
  local label="$1" prompt="$2" log_base="$3" turns="$4" marker="$5"
  local transient=0
  while (( transient <= TRANSIENT_RETRIES )); do
    local suffix=""; (( transient > 0 )) && suffix="-transient-$transient"
    local log="${log_base}${suffix}.log"
    echo
    echo "=== $label ==="
    echo "Modelo: $MODEL | MaxTurns: $turns"
    echo "Log: $log"
    local -a extra=()
    while IFS= read -r -d '' arg; do extra+=("$arg"); done < <(claude_args "$turns")
    set +e
    claude -p "$prompt" "${extra[@]}" 2>&1 | tee "$log"
    local code=${PIPESTATUS[0]}
    set -e
    if ! is_transient "$code" "$log" "$marker"; then
      INVOKE_EXIT="$code"; INVOKE_LOG="$log"; return 0
    fi
    if (( transient >= TRANSIENT_RETRIES )); then
      INVOKE_EXIT="$code"; INVOKE_LOG="$log"; return 0
    fi
    local wait=$(( RETRY_DELAY_SECONDS * (1 << transient) )); (( wait > 120 )) && wait=120
    echo "Error transitorio. Reintentando en ${wait}s..." >&2
    sleep "$wait"
    transient=$((transient+1))
  done
}

npm_has_script() {
  node -e 'const p=require(process.cwd()+"/package.json"); process.exit(p.scripts && Object.prototype.hasOwnProperty.call(p.scripts,process.argv[1])?0:1)' "$1"
}

run_gates() {
  local gates_csv="$1" log="$2"
  [[ "$SKIP_RUNNER_GATES" == "1" ]] && return 0
  IFS=',' read -r -a gates <<<"$gates_csv"
  for gate in "${gates[@]}"; do
    [[ -z "$gate" ]] && continue
    if ! npm_has_script "$gate"; then echo "RUNNER_GATE_SKIP: $gate" >> "$log"; continue; fi
    echo "=== RUNNER GATE: npm run $gate ===" | tee -a "$log"
    set +e
    npm run "$gate" 2>&1 | tee -a "$log"
    local code=${PIPESTATUS[0]}
    set -e
    if (( code != 0 )); then GATE_REASON="runner_gate:$gate exit=$code"; return 1; fi
  done
  GATE_REASON="OK"
  return 0
}

invoke_supervisor() {
  local id="$1" name="$2" file="$3" retry="$4" failed_log="$5" reason="$6"
  local base context prompt stamp log_base
  base="$(cat "$PROMPT_DIR/SUPERVISOR.md")"
  context=$'\n\n# CONTEXTO DE ESTA INTERVENCION\n'
  context+="PHASE: $name"$'\n'
  context+="PHASE_ID: $id"$'\n'
  context+="PHASE_PROMPT_FILE: $PROMPT_DIR/$file"$'\n'
  context+="FAILED_LOG: $failed_log"$'\n'
  context+="FAILURE_REASON: $reason"$'\n'
  context+="RETRY_NUMBER: $retry"$'\n'
  context+="MAX_RETRIES: $MAX_RETRIES"$'\n'
  context+="REPO_ROOT: $REPO"$'\n'
  prompt="$base$context"
  stamp="$(date +%Y%m%d-%H%M%S)"
  log_base="$LOG_DIR/${stamp}-${name}-supervisor-${retry}"
  invoke_claude_retry "SUPERVISOR $name reparacion $retry" "$prompt" "$log_base" "$SUPERVISOR_MAX_TURNS" "SUPERVISOR_RESULT: REPAIRED"
  SUPERVISOR_LOG="$INVOKE_LOG"
  [[ "$INVOKE_EXIT" -eq 0 && "$(last_nonempty "$INVOKE_LOG")" == "SUPERVISOR_RESULT: REPAIRED" ]]
}

run_phase() {
  local id="$1" name="$2" file="$3" gates="$4"
  local attempt
  for ((attempt=1; attempt<=MAX_RETRIES+1; attempt++)); do
    save_state "$name" "RUNNING" "$attempt" "" ""
    local base contract context prompt stamp log_base
    base="$(cat "$PROMPT_DIR/$file")"
    contract="$(cat "$PROMPT_DIR/EXECUTION_CONTRACT.md")"
    context=$'\n\n# Contexto de runner\n'
    context+="PHASE_ID: $id"$'\n'
    context+="PHASE_NAME: $name"$'\n'
    context+="ATTEMPT: $attempt"$'\n'
    context+="REPO_ROOT: $REPO"$'\n'
    context+="MODEL: $MODEL"$'\n'
    prompt="$base"$'\n\n'"$contract$context"
    stamp="$(date +%Y%m%d-%H%M%S)"
    log_base="$LOG_DIR/${stamp}-${name}-attempt-${attempt}"
    invoke_claude_retry "$name intento $attempt" "$prompt" "$log_base" "$MAX_TURNS" "PHASE_RESULT: PASS"
    local result_log="$INVOKE_LOG" reason=""
    if [[ "$INVOKE_EXIT" -ne 0 || "$(last_nonempty "$result_log")" != "PHASE_RESULT: PASS" ]]; then
      reason="claude_exit=$INVOKE_EXIT; PHASE_RESULT_PASS_ausente"
    elif ! run_gates "$gates" "$result_log"; then
      reason="$GATE_REASON"
    else
      save_state "$name" "PASS" "$attempt" "$result_log" "OK"
      echo "$name PASS en intento $attempt"
      return 0
    fi

    save_state "$name" "FAILED" "$attempt" "$result_log" "$reason"
    echo "$name fallo: $reason" >&2
    if (( attempt > MAX_RETRIES )); then echo "Reintentos agotados en $name" >&2; return 1; fi
    if ! invoke_supervisor "$id" "$name" "$file" "$attempt" "$result_log" "$reason"; then
      save_state "$name" "BLOCKED" "$attempt" "$SUPERVISOR_LOG" "supervisor blocked"
      echo "Supervisor bloqueado en $name: $SUPERVISOR_LOG" >&2
      return 1
    fi
    save_state "$name" "REPAIRED" "$attempt" "$SUPERVISOR_LOG" "retry same phase"
    sleep "$RETRY_DELAY_SECONDS"
  done
}

set -e

if [[ "$RECOVERY_ONLY" == "1" ]]; then
  run_phase "RECOVERY" "RECOVERY" "RECOVERY.md" "typecheck,lint,test,test:db,build"
  echo "RECOVERY PASS"
  exit 0
fi

mapfile -t PHASE_LINES < <(node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); for(const x of p) console.log([x.id,x.name,x.file,(x.gates||[]).join(",")].join("|"));' "$CONFIG_PATH")
if (( ${#PHASE_LINES[@]} < 10 )); then echo "Config requiere al menos 10 fases" >&2; exit 1; fi

started=0
for line in "${PHASE_LINES[@]}"; do
  IFS='|' read -r id name file gates <<<"$line"
  if [[ "$id" == "$START_AT" ]]; then started=1; fi
  (( started == 0 )) && continue
  run_phase "$id" "$name" "$file" "$gates" || exit 1
  if [[ -n "$STOP_AFTER" && "$id" == "$STOP_AFTER" ]]; then break; fi
done

if (( started == 0 )); then echo "START_AT invalido: $START_AT" >&2; exit 1; fi

echo "ALL_SELECTED_PHASES_PASS"
