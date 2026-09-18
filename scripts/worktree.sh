#!/usr/bin/env bash
# Create a ready-to-work git worktree for parallel development.
#
#   scripts/worktree.sh <name> [base-ref]
#
# A fresh worktree has no `node_modules`, so nothing in it can be typechecked, linted or tested
# until dependencies are linked. pnpm's store is content-addressed and hardlinks, so the install is
# about a second rather than a full download, and the workspace links it writes are relative
# (`packages/cards/node_modules/@jackioh/engine -> ../../../engine`). That last part is what makes a
# worktree useful here: an agent's engine edits are picked up by its own cards tests, so each
# worktree verifies only its own changes instead of whatever another worktree happened to be
# half-way through writing.
#
# Worth knowing before reaching for one:
#   - GOOD for work that mutates files and needs its own verification (card scripts, a fuzz
#     harness, a migration sweep, anything where two agents would otherwise race on one file).
#   - BAD for the shared surfaces — SPEC.md §11's numbering, packages/shared/src/events.ts,
#     script.ts, state.ts, the effects barrel. Several isolated copies each appending a row or a
#     field conflict on merge, and one owner editing in place is strictly cheaper.
#   - BAD for read-only auditing, which wants the current tree, not a snapshot.

set -euo pipefail

name="${1:-}"
base="${2:-HEAD}"

if [[ -z "$name" ]]; then
  echo "usage: scripts/worktree.sh <name> [base-ref]" >&2
  exit 2
fi

root="$(git rev-parse --show-toplevel)"
dir="$root/../jackioh-wt/$name"

mkdir -p "$(dirname "$dir")"

if git show-ref --verify --quiet "refs/heads/wt/$name"; then
  git worktree add "$dir" "wt/$name"
else
  git worktree add -b "wt/$name" "$dir" "$base"
fi

cd "$dir"
pnpm install --prefer-offline --silent

echo
echo "worktree ready: $dir (branch wt/$name)"
echo "  verify with:  cd '$dir' && ./node_modules/.bin/vitest run --project engine"
echo "  merge back:   git -C '$root' merge wt/$name"
echo "  remove with:  git -C '$root' worktree remove '$dir'"
