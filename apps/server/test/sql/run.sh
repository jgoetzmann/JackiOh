#!/bin/sh
# Apply every migration (0001-0009) to a throwaway Postgres and assert the
# invariants of SPEC §9.1, §9.4 and §9.5 against a real database.
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
# real project — Supabase provides all of it. 0005 and 0006 need nothing more
# from it: 0005 grants service_role what the stub already grants (a GRANT that
# is already held is a no-op), and 0006 only replaces a function body.
#
# The migrations go in two batches with a seed between them, because R254 is a
# DATA migration: 0007 turns every loadout that exists when it runs into three
# decks and a trio, so there has to be a loadout for it to find. 03b seeds one
# — through 0003's own app.save_loadout, as a player of the old server saved
# it — after 0001-0006 and before 0007-0009, exactly the order a database that
# predates 0007 sees. 04 then checks what 0007 made of it.
#
# The CONTAINER name is fixed so a run can be inspected afterwards; the script
# removes a previous container of that name before it starts, so never point it
# at a name another tool uses.
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

# One migration file, applied the way src/db/migrate.ts applies it: inside a
# transaction of its own, so a file lands whole or not at all. "Clean" means
# psql said nothing but the expected "does not exist, skipping" notices of a
# drop-if-exists on a first run.
apply_migration() {
  printf '%s: ' "$1"
  out=$($PSQL -d jackioh -1 -f "/tmp/$1.sql" 2>&1 |
    grep -v "does not exist, skipping" | grep -v "^$" || true)
  if [ -z "$out" ]; then
    echo "clean"
  else
    echo "PROBLEM"
    echo "$out"
    failed=1
  fi
}

echo "--- migrations 0001-0006 ---"
for f in 0001_profiles_and_invites 0002_collection 0003_loadouts 0004_matches \
         0005_service_role_reads_auth_users 0006_redeem_ip_lock; do
  apply_migration "$f"
done

echo "--- 03b: a loadout saved before 0007 (R254's input) ---"
if ! $PSQL -d jackioh -f /tmp/03b_legacy_loadout_seed.sql; then
  echo "!!! 03b_legacy_loadout_seed: the legacy loadout could not be seeded"
  failed=1
fi

echo "--- migrations 0007-0009 ---"
for f in 0007_decks_and_trios 0008_queue_modes 0009_series; do
  apply_migration "$f"
done

# A migration directory with a file this list does not name is a migration no
# check ever ran against. Refuse it rather than pass without it.
for f in "$REPO"/apps/server/src/db/migrations/*.sql; do
  name=$(basename "$f" .sql)
  case " 0001_profiles_and_invites 0002_collection 0003_loadouts 0004_matches 0005_service_role_reads_auth_users 0006_redeem_ip_lock 0007_decks_and_trios 0008_queue_modes 0009_series " in
    *" $name "*) ;;
    *) echo "!!! migration $name is not applied by this script; add it above"; failed=1 ;;
  esac
done

for f in 01_schema_invariants 02_rls_as_client 03_match_lifecycle 04_decks_and_series; do
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
  # the only signal. All four files raise instead, which is why the exit-status
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
