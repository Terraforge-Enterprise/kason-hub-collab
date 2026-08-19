#!/usr/bin/env bash
# CI-time check: assert the public-card ESLint guard fires on the negative fixture.
# Per spec §9.1 #2 — guard MUST exist and MUST fire.

set -uo pipefail

cd "$(dirname "$0")/.."

FIXTURE="apps/api/src/modules/public-card/__fixtures__/should-fail-lint.ts"
EXPECTED_PATTERN="no-restricted-imports"

if [[ ! -f "$FIXTURE" ]]; then
  echo "FAIL: fixture file missing: $FIXTURE"
  exit 1
fi

cd apps/api
OUT="$(npx eslint --no-ignore "../../$FIXTURE" 2>&1 || true)"

if echo "$OUT" | grep -q "$EXPECTED_PATTERN"; then
  echo "PASS: public-card ESLint guard fires on negative fixture"
  exit 0
else
  echo "FAIL: public-card ESLint guard did NOT fire on negative fixture"
  echo "Expected eslint output to contain: $EXPECTED_PATTERN"
  echo "Got:"
  echo "$OUT"
  exit 1
fi
