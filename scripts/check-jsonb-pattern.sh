#!/usr/bin/env bash
# CI guard: fail if any source file uses the buggy JSON.stringify(x) interpolation
# followed by a ::jsonb cast in a template string (postgres.js v3 double-encodes it).
# Use postgres.js's `sql.json(x)` helper instead.
#
# The literal bad token sequence is deliberately NOT written in these comments so
# this guard does not match itself when scanning scripts/ (see option C note below).
#
# This is best-effort static analysis. It catches the common copy-paste form
# that caused the v0.12.0 silent-data-loss bug (JSONB columns stored as
# string literals on Postgres while PGLite hid the bug). Multi-line and
# helper-wrapped variants are NOT caught here — those are covered by
# test/e2e/postgres-jsonb.test.ts which round-trips actual writes through
# real Postgres and asserts `frontmatter->>'k'` returns objects, not strings.
#
# Usage: scripts/check-jsonb-pattern.sh
# Exit:  0 when no matches, 1 when matches found.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

# Match: a JSON.stringify call inside a ${...} interpolation, followed by ::jsonb.
# The regex is built as a literal string below so the token sequence itself does
# not appear in any comment (prevents self-match; see option C in the runbook).
PATTERN='\$\{JSON\.stringify\([^)]*\)\}::jsonb'

if grep -rEn "$PATTERN" src/ scripts/ 2>/dev/null; then
  echo
  echo "ERROR: Found JSON.stringify(...)::jsonb pattern in src/ or scripts/."
  echo "       postgres.js v3 stringifies again, producing JSONB string literals."
  echo "       Use sql.json(x) instead. See feedback_postgres_jsonb_double_encode.md."
  exit 1
fi

echo "OK: no JSON.stringify(x)::jsonb interpolation pattern in src/ or scripts/"

# v0.13.1 #219: guard against max_stalled DEFAULT 1 regressing in any schema
# source file. DEFAULT 1 dead-lettered any SIGKILL'd job on first stall, making
# the "10/10 rescued" claim false for out-of-the-box users. Default is 5 now.
MAX_STALLED_PATTERN='max_stalled\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+1\b'

if grep -rEn "$MAX_STALLED_PATTERN" src/schema.sql src/core/migrate.ts src/core/pglite-schema.ts src/core/schema-embedded.ts 2>/dev/null; then
  echo
  echo "ERROR: max_stalled DEFAULT 1 reintroduced in schema."
  echo "       Must be DEFAULT 5 to preserve SIGKILL-rescue guarantee. See #219."
  exit 1
fi

echo "OK: max_stalled defaults are 5 in all schema sources"
