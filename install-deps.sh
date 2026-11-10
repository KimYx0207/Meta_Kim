#!/usr/bin/env bash
# Legacy wrapper retained for direct callers.
# The real installer is the cross-platform Node entrypoint:
#   node scripts/install-global-skills-all-runtimes.mjs --defaults --targets claude

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ARGS=(--defaults --targets claude)
if [ "${1:-}" = "--update" ] || [ "${1:-}" = "-u" ]; then
  ARGS=(--update --defaults --targets claude)
fi

exec node scripts/install-global-skills-all-runtimes.mjs "${ARGS[@]}"
