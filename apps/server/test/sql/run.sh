#!/bin/sh
# Apply the four migrations to a throwaway Postgres and assert the invariants of
# SPEC §9.1 and §9.4 against a real database.
#
#   pnpm test:sql            # or: sh apps/server/test/sql/run.sh
#
# Needs Docker only. This is NOT part of `pnpm test`, and it never will be: the
# vitest suite under apps/server runs against an in-memory fake, and every
# assertion in these files is a property of a real Postgres that a fake cannot
# have — row-level security under the `authenticated` role, the append-only
# deny_row_mutation triggers, SECURITY DEFINER boundaries, and the L4 unique
# index on (profile_id, card_id) that BUILD M6-T3 names as a raw SQL test. Run
# both: `pnpm test` for the server logic, `pnpm test:sql` for the schema.
#
# Exit status is the whole point — this is a gate, not a report. It exits 0 only
# when every migration applied without noise and every check passed. It exits 1
# when psql stops on an error (`\set ON_ERROR_STOP on` plus a `raise exception`
# from a failed assertion), and also when any check merely *prints* FAIL or
# UNEXPECTED: `raise notice` does not stop psql, so the grep below stays as a
# second net even though all three files now raise.
#
# 00_supabase_stub.sql stands in for the Supabase-managed pieces the migrations
# reference (the `anon`/`authenticated`/`service_role` roles, `auth.users` and
# `auth.uid()`), so a plain postgres image is enough. It is never applied to a
# real project — Supabase provides all of it.
set -e

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/../../../.." && pwd)
SQL="$REPO/apps/server/test/sql"
CONTAINER=jackioh-pg-test
PSQL="docker exec $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -q"

failed=0

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres postgres:16 >/dev/null
i=0
ready=0
while [ "$i" -lt 60 ]; do
  if docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then
    ready=1
    break
  fi
  i=$((i + 1))
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "FAIL: postgres in $CONTAINER was not ready after ${i}s" >&2
  exit 1
fi

docker exec "$CONTAINER" psql -U postgres -q -c 'create database jackioh' >/dev/null

for f in "$SQL"/*.sql "$REPO"/apps/server/src/db/migrations/*.sql; do
  docker cp "$f" "$CONTAINER":/tmp/ >/dev/null
done

$PSQL -d jackioh -f /tmp/00_supabase_stub.sql >/dev/null

echo "--- migrations ---"
for f in 0001_profiles_and_invites 0002_collection 0003_loadouts 0004_matches; do
  printf '%s: ' "$f"
  out=$($PSQL -d jackioh -f "/tmp/$f.sql" 2>&1 |
    grep -v "does not exist, skipping" | grep -v "^$" || true)
  if [ -z "$out" ]; then
    echo "clean"
  else
    echo "PROBLEM"
    echo "$out"
    failed=1
  fi
done

for f in 01_schema_invariants 02_rls_as_client 03_match_lifecycle; do
  echo "--- $f ---"
  status=0
  out=$(docker exec "$CONTAINER" psql -U postgres -q -v ON_ERROR_STOP=1 \
    -d jackioh -f "/tmp/$f.sql" 2>&1) || status=$?
  printf '%s\n' "$out"
  if [ "$status" -ne 0 ]; then
    echo "!!! $f: psql exited $status — a check raised, and everything after it was skipped"
    failed=1
  fi
  # A `raise notice 'FAIL ...'` leaves psql's exit status at 0, so the text would be
  # the only signal. All three files raise instead, which is why the exit-status
  # check above is the primary gate; this grep is the backstop for a check that ever
  # regresses to a notice.
  if printf '%s\n' "$out" | grep -E 'FAIL|UNEXPECTED' >/dev/null 2>&1; then
    echo "!!! $f: a check reported FAIL/UNEXPECTED (see the lines above)"
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  echo "--- FAILED (docker rm -f $CONTAINER to clean up) ---"
  exit 1
fi

echo "--- done (docker rm -f $CONTAINER to clean up) ---"
