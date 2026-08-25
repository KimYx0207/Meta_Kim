#!/usr/bin/env bash
# Legacy wrapper retained for direct callers.
# The real installer is the cross-platform Node entrypoint:
#   node scripts/install-global-skills-all-runtimes.mjs --all --targets claude

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ARGS=(--all --targets claude)
if [ "${1:-}" = "--update" ] || [ "${1:-}" = "-u" ]; then
  ARGS=(--update --all --targets claude)
fi

exec node scripts/install-global-skills-all-runtimes.mjs "${ARGS[@]}"
