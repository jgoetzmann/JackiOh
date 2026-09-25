#!/bin/sh
# Runs the database suite — `src/db/store.ts` against a real Postgres.
#
#   pnpm test:db             # or: sh apps/server/test/db/run.sh
#   KEEP_DB=1 pnpm test:db   # leave the container up for poking at
#   DB_PORT=55555 pnpm test:db
#
# Needs Docker only, and takes a couple of seconds. This is NOT part of `pnpm test` and never will
# be: `pnpm test` runs the server against the in-memory fake in `src/api/e2e-store.ts` and must stay
# hermetic. The same contract runs in both places — `test/db/contract.memory.test.ts` in `pnpm test`,
# `test/db/contract.postgres.spec.ts` here — which is the point of the pair.
#
# Steps, in the order a real bring-up takes them (docs/architecture.md):
#   1. a throwaway Postgres, with its port published so the driver can reach it from the host;
#   2. test/db/bootstrap.sql — the Supabase-managed pieces (roles, auth.users, auth.uid, the
#      privileges service_role has in a real project);
#   3. apps/server/src/db/migrate.ts — the real migration runner, over every real migration (0001-0010);
#   4. test/db/grants.sql — service_role's table privileges, repeated after the migrations;
#   5. vitest, with DATABASE_URL pointing at it.
#
# Exit status is the gate: non-zero if any step or any test fails.
set -e

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/../../../.." && pwd)
HERE="$REPO/apps/server/test/db"
CONTAINER=jackioh-pg-store-test
PORT=${DB_PORT:-55433}
URL="postgres://postgres:postgres@127.0.0.1:$PORT/jackioh"

cleanup() {
  if [ "${KEEP_DB:-0}" = "1" ]; then
    echo "--- container $CONTAINER left running on port $PORT (docker rm -f $CONTAINER) ---"
  else
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres -p "$PORT":5432 postgres:16 >/dev/null

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

echo "--- bootstrap (the Supabase-managed pieces) ---"
docker cp "$HERE/bootstrap.sql" "$CONTAINER":/tmp/ >/dev/null
docker exec "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -q -d jackioh -f /tmp/bootstrap.sql

echo "--- migrations (src/db/migrate.ts) ---"
DATABASE_URL="$URL" "$REPO/node_modules/.bin/tsx" "$REPO/apps/server/src/db/migrate.ts"

echo "--- grants ---"
docker cp "$HERE/grants.sql" "$CONTAINER":/tmp/ >/dev/null
docker exec "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -q -d jackioh -f /tmp/grants.sql

echo "--- vitest (apps/server/test/db) ---"
DATABASE_URL="$URL" "$REPO/node_modules/.bin/vitest" run --config "$HERE/vitest.config.ts"
