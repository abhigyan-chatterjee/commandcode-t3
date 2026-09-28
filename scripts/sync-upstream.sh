#!/usr/bin/env bash
# Synchronizes this fork with upstream (pingdotgg/t3code) while preserving Command Code support.
#
# Usage:
#   ./scripts/sync-upstream.sh [--rebase]
set -euo pipefail

UPSTREAM_URL="https://github.com/pingdotgg/t3code.git"
CURRENT_BRANCH="$(git branch --show-current)"
MODE="merge"

for arg in "$@"; do
  case "$arg" in
    --rebase) MODE="rebase" ;;
    -h|--help)
      echo "Usage: ./scripts/sync-upstream.sh [--rebase]"
      echo "Fetches upstream/main from $UPSTREAM_URL and merges or rebases it into $CURRENT_BRANCH."
      exit 0
      ;;
  esac
done

echo "==> Configuring upstream remote ($UPSTREAM_URL)..."
if git remote get-url upstream >/dev/null 2>&1; then
  git remote set-url upstream "$UPSTREAM_URL"
else
  git remote add upstream "$UPSTREAM_URL"
fi

echo "==> Fetching upstream/main..."
git fetch upstream main

if [ "$MODE" = "rebase" ]; then
  echo "==> Rebasing $CURRENT_BRANCH onto upstream/main..."
  git rebase upstream/main
else
  echo "==> Merging upstream/main into $CURRENT_BRANCH..."
  git merge upstream/main --no-edit -m "chore(sync): merge upstream/main into $CURRENT_BRANCH"
fi

echo "==> Sync complete! Run 'git push origin $CURRENT_BRANCH' to publish updates."
