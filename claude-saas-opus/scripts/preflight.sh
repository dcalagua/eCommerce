#!/usr/bin/env bash
set -euo pipefail
REPO_PATH="${REPO_PATH:-.}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACK_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO="$(cd "$REPO_PATH" && pwd)"

echo "=== Claude SaaS Opus Pack - Preflight ==="
for f in CLAUDE.md package.json; do [[ -f "$REPO/$f" ]] || { echo "Falta $f" >&2; exit 1; }; done
for c in claude git node npm; do command -v "$c" >/dev/null || { echo "Falta $c" >&2; exit 1; }; done
node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(p.length<10) process.exit(2); for(const x of p){if(!fs.existsSync(process.argv[2]+"/prompts/"+x.file)) process.exit(3)}' "$PACK_ROOT/config/phases.json" "$PACK_ROOT"
for f in SUPERVISOR.md RECOVERY.md EXECUTION_CONTRACT.md; do [[ -f "$PACK_ROOT/prompts/$f" ]] || exit 4; done
help="$(claude --help 2>&1 || true)"
grep -q -- '--model' <<<"$help" || { echo "Claude CLI sin --model" >&2; exit 5; }
if ! grep -q -- '--permission-mode' <<<"$help" && ! grep -q -- '--dangerously-skip-permissions' <<<"$help"; then echo "Claude CLI sin modo unattended compatible" >&2; exit 6; fi
echo "Claude: $(claude --version 2>/dev/null || true)"
echo "Node: $(node --version)"
echo "NPM: $(npm --version)"
echo "Fases: $(node -e 'console.log(require(process.argv[1]).length)' "$PACK_ROOT/config/phases.json")"
echo "PREFLIGHT_OK"
