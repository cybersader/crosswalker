#!/usr/bin/env bash
# Decide whether an expensive job has anything to check, and say so in the log.
# usage: changed-paths.sh <extended-regex of relevant paths>
# Writes relevant=true|false to $GITHUB_OUTPUT. Unknown history (manual runs,
# a new branch, a shallow base) always counts as relevant: when in doubt, run.
set -euo pipefail
pattern=$1
base=""
case "${GITHUB_EVENT_NAME:-}" in
  pull_request) base="${PR_BASE_SHA:-}" ;;
  push) base="${PUSH_BEFORE_SHA:-}" ;;
esac
if [[ -z "$base" || "$base" =~ ^0+$ ]] || ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  echo "relevant=true" >> "$GITHUB_OUTPUT"
  echo "No comparable base commit; running the job."
  exit 0
fi
changed=$(git diff --name-only "$base" HEAD)
if grep -Eq "$pattern" <<< "$changed"; then
  echo "relevant=true" >> "$GITHUB_OUTPUT"
  echo "Relevant changes:"; grep -E "$pattern" <<< "$changed" | head -20
else
  echo "relevant=false" >> "$GITHUB_OUTPUT"
  echo "::notice::No relevant changes since $base; the job is skipped."
fi
