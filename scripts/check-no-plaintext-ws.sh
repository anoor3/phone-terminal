#!/usr/bin/env bash
# check-no-plaintext-ws.sh
# Greps source code for ws:// (plaintext WebSocket URLs).
# Exits 1 if any non-comment usage is found.
#
# Usage: ./scripts/check-no-plaintext-ws.sh
#
# This is a CI/pre-commit safety net: the codebase must NEVER contain
# a ws:// code path (per §10 — TLS/WSS everywhere).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Search source files for ws:// — excluding:
#   - node_modules
#   - .git
#   - dist/build output
#   - this script itself
#   - documentation files (docs/) — they reference ws:// to say "don't use it"
#   - PROGRESS.md — tracking file

MATCHES=$(grep -rn "ws://" \
  --include="*.ts" \
  --include="*.tsx" \
  --include="*.js" \
  --include="*.jsx" \
  --include="*.mjs" \
  --include="*.cjs" \
  "$PROJECT_ROOT/backend/src" \
  "$PROJECT_ROOT/cli/src" \
  "$PROJECT_ROOT/phone-app/src" \
  2>/dev/null || true)

# Filter out lines that are purely comments (// or * or #)
NON_COMMENT_MATCHES=""
while IFS= read -r line; do
  [ -z "$line" ] && continue
  # Extract the code portion (after filename:linenum:)
  code="${line#*:*:}"
  # Trim leading whitespace
  code="$(echo "$code" | sed 's/^[[:space:]]*//')"
  # Skip if line starts with // or * or # (comment)
  if [[ "$code" == //* ]] || [[ "$code" == \** ]] || [[ "$code" == \#* ]]; then
    continue
  fi
  NON_COMMENT_MATCHES="${NON_COMMENT_MATCHES}${line}\n"
done <<< "$MATCHES"

if [ -n "$NON_COMMENT_MATCHES" ]; then
  echo "ERROR: Found ws:// (plaintext WebSocket) in non-comment source code!"
  echo ""
  echo "The following lines contain ws:// outside of comments:"
  echo -e "$NON_COMMENT_MATCHES"
  echo ""
  echo "All WebSocket connections MUST use wss:// (TLS). See docs/local-dev-tls.md"
  exit 1
fi

echo "✓ No plaintext ws:// found in source code."
exit 0
