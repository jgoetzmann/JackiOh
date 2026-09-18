#!/bin/sh
# Apply the four migrations to a throwaway Postgres and assert the invariants of
# SPEC §9.1 and §9.4 against a real database.
#
# Needs Docker only. Not part of `pnpm test`; BUILD M6-T1..T4 acceptance tests
# will drive the same SQL from vitest once apps/server has a test harness.
#
#   sh apps/server/test/sql/run.sh
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

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres postgres:16 >/dev/null
i=0
while [ "$i" -lt 60 ]; do
  docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  i=$((i + 1))
  sleep 1
done

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
  if [ -z "$out" ]; then echo "clean"; else echo "PROBLEM"; echo "$out"; fi
done

for f in 01_schema_invariants 02_rls_as_client 03_match_lifecycle; do
  echo "--- $f ---"
  docker exec "$CONTAINER" psql -U postgres -q -d jackioh -f "/tmp/$f.sql" 2>&1
done

echo "--- done (docker rm -f $CONTAINER to clean up) ---"
