# `apps/server` — the JackiOh server runtime

The authority for everything that is not presentation. It owns identity and the invite gate, the
collection ledger, loadouts, matchmaking, and the match itself: one actor per match holding the
`GameState` in memory, one WebSocket per player, `reduce` on every action and `viewFor` pushed to
each player after every change (SPEC §9.1–§9.5, §10.8).

The client sends intent and renders `viewFor`. It never enforces a rule and never sees hidden
information (CLAUDE.md rule 7).

## How it fits together

```
browser ──HTTPS──▶ Supabase Auth          (sign up, sign in, email confirmation)
browser ──HTTPS──▶ apps/server  ──▶ Postgres
browser ──WSS────▶ match actor  ──▶ @jackioh/engine (reduce, viewFor, legalActions)
```

Two arrows out of the browser, exactly as SPEC §9.2 draws it: **the browser authenticates against
Supabase Auth directly** with the publishable key and sends the resulting access token to this
server, which verifies it. The server never brokers a password in normal operation.

Layers, outermost first:

| Layer | Files | Rule |
| --- | --- | --- |
| Transport | `src/index.ts`, `src/match/wsServer.ts` | The only place a framework or a socket library appears |
| Handlers | `src/api/*.ts` | `Request` in, `Response` out; no SQL, no driver, no clock of their own |
| Match | `src/match/actor.ts`, `clock.ts`, `registry.ts` | Holds state in memory; all time comes from the `Timers` port |
| Ports | `src/api/ports.ts`, `src/match/contracts.ts` | Every interface the layers above depend on |
| Persistence | `src/db/**` | Implements the `Store` port against Postgres |
| Rules | `@jackioh/engine`, `@jackioh/cards`, `@jackioh/validator` | Pure; imported at exactly three seams (below) |

Nothing in `src/api` or `src/match` imports a database driver, an HTTP framework or a WebSocket
library. That is what makes the whole runtime testable in memory, and it is why the `Store` port
in `src/api/ports.ts` is the contract between this half of the server and `src/db/**`.

### The three seams to the pure packages

1. `src/match/engine.ts` — the `EnginePort`. The only path to `@jackioh/engine`. `EngineState` is
   opaque: it holds both hands and both libraries, so nothing outside the port inspects it, and
   every per-player payload is a `viewFor`.
2. `src/api/catalog.ts` — reads `packages/cards/catalog.json` (109 entries) and derives
   `CatalogInfo`, including the catalog version §9.4 checks at save and at queue.
3. `src/api/loadout-validator.ts` — the only path to `@jackioh/validator`. Rules L1–L6 live there
   and are never restated here.

## Running it against a Supabase project

You need a Supabase project and a Postgres connection string. Everything else is local.

```bash
pnpm install
cp apps/server/.env.example apps/server/.env    # then fill it in

# 1. Schema. Applies src/db/migrations/*.sql in order.
pnpm --filter @jackioh/server db:migrate

# 2. The card catalog, so loadout rule L6 has something to check against.
pnpm --filter @jackioh/server db:seed-catalog

# 3. An invite code, so an account can get past `pending`.
pnpm --filter @jackioh/server codes:mint

# 4. Run it.
pnpm --filter @jackioh/server dev       # tsx watch
pnpm --filter @jackioh/server start
```

Every script above runs under `--env-file-if-exists=.env`, so `apps/server/.env` is loaded
without a dotenv dependency, a missing file is not an error, and a variable set in the shell
still wins over the file — `DATABASE_URL='postgresql://...' pnpm --filter @jackioh/server
db:migrate` does what it looks like.

Step 3 mints one code. Every account starts `pending` and a pending account can do nothing but
look at the code screen (§9.4). `src/db/mint-code.ts` is a thin wrapper over `mintInviteCode` in
`src/api/codes.ts`, which is the only thing that creates one: the plaintext goes to stdout exactly
once, the metadata to stderr, and the database stores only its keyed hash — so a lost code cannot
be recovered, only replaced. `--max-uses=N` and `--expires-in-days=N` are the two options (R161:
one account per code unless its mint says otherwise). The script loads the *whole* environment
rather than the two variables it reads, because a `CODE_PEPPER` that differs from the running
server's mints a well-formed code that nobody can ever redeem, and nothing would report it.

### Environment

The contract is `ServerEnv` in `src/env.ts`; `loadEnv()` validates it and refuses to start on a
missing or malformed value rather than failing later at the first request.

| Variable | Required | What it is |
| --- | --- | --- |
| `SUPABASE_URL` | yes | `https://<ref>.supabase.co` |
| `SUPABASE_SECRET_KEY` | yes | `sb_secret_…` (or the legacy `service_role` JWT). **Server only** — it bypasses every RLS policy. Never give it a `VITE_` alias |
| `DATABASE_URL` | yes | Postgres connection string for the transactional work in §9.4 and §9.5 |
| `CODE_PEPPER` | yes | ≥32 chars. Keys the HMAC over invite codes and IP addresses, so a stolen table cannot be brute-forced and no raw address is ever stored |
| `CATALOG_VERSION` | yes | Must match what the client ships and what `cards.catalog_version` holds |
| `SUPABASE_JWKS_URL` | no | Defaults to `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` |
| `SUPABASE_JWT_SECRET` | no | HS256 fallback, for a project not yet on asymmetric signing keys. Discouraged |
| `PORT` | no | Defaults to 8787 |
| `PUBLIC_ORIGINS` | no | Allowed browser origins, for CORS and the WebSocket `Origin` check |
| `NODE_ENV` | no | `development` \| `test` \| `production` |
| `E2E` | no | BUILD M8's test-server mode. Must be false in production |

The client's half of the contract is `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`,
`VITE_SERVER_HTTP_URL`, `VITE_SERVER_WS_URL` and `VITE_CATALOG_VERSION`. `PUBLIC_ENV_VARS` and
`SERVER_ONLY_ENV_VARS` in `src/env.ts` are the two lists, and they are disjoint by design.

Two peppers are derived from the one `CODE_PEPPER` at the composition root — `${CODE_PEPPER}:code`
and `${CODE_PEPPER}:ip` — so an invite-code hash and an IP hash can never collide.

### Supabase specifics worth knowing

- **Token verification** is local: JWKS from `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
  verified with `jose`, falling back to the auth server when the project still signs with a shared
  secret.
- **Email verification is read from the auth server, never from the token.** `user_metadata` is
  user-editable in Supabase and can appear in `auth.jwt()`, so an `email_verified` claim there is
  not evidence of anything. §9.4 step 1 requires a verified email, so it comes from
  `auth.admin.getUserById(...).email_confirmed_at`. Authorization data belongs in `app_metadata`.
- **RLS** is on for every table in `public`, and the server holds the secret key, which bypasses
  it. Both halves matter: RLS is what stops a browser reading another profile's collection with the
  publishable key, and the secret key is what lets the server be the sole writer (§9.1, §9.8).
- Deleting a user does not invalidate their existing access tokens. `profiles.status = 'banned'` is
  what shuts an account out of this API.

## HTTP surface

Every response is JSON. Errors are always `{ "error": { "code", "message", "details"? } }`; the
codes are the `ApiErrorCode` union in `src/api/http.ts`. A request body over
`MAX_REQUEST_BODY_BYTES` (64 KiB, R173) is refused on every route with 413 `payload_too_large`
before it is parsed, counted in the bytes actually read whatever Content-Length claims.

Each route declares its own auth requirement, which is where §9.4's gate lives — one place, not the
top of every handler:

- `none` — open.
- `user` — a verified token and a profile, whatever its status. This is the code screen.
- `active` — additionally `profiles.status = 'active'`. A pending account gets 403 here, which is
  what makes "no collection, loadout, queue or match" true rather than aspirational.

| Method | Path | Auth | What |
| --- | --- | --- | --- |
| `POST` | `/api/auth/signup` | none | Convenience only; requires a publishable key to be configured. Normally the browser does this itself |
| `POST` | `/api/auth/signin` | none | Same |
| `GET` | `/api/auth/me` | user | Profile status, and whether an invite code is still needed |
| `POST` | `/api/codes/redeem` | user | The six-step redemption of §9.4 |
| `GET` | `/api/collection` | active | The entitlement ledger. There is deliberately no write route |
| `GET` | `/api/loadout` | active | The three decks and the version they were validated against |
| `PUT` | `/api/loadout` | active | `saveLoadout`: all three decks in one transaction or nothing |
| `GET` | `/api/decks` | active | R171: the library, most recently saved first, with the catalog version and the cap |
| `POST` | `/api/decks` | active | Save a new library deck `{ catalogVersion, name, cards }`; a short deck saves, an illegal one gets 422 with the validator's issues, and 409 at the cap |
| `PUT` | `/api/decks/:id` | active | Replace one of your decks; another profile's id is 404 |
| `DELETE` | `/api/decks/:id` | active | Delete one of your decks; 404 when it is not yours |
| `POST` | `/api/queue` | active | Enqueue with the chosen deck frozen into the ticket: `{ deckIndex }` for a loadout deck or `{ deckId }` for a complete library deck (R172) |
| `DELETE` | `/api/queue` | active | Leave the queue |
| `GET` | `/api/queue/population` | none | §9.5: a number, so the client shows a population instead of an endless spinner |
| `POST` | `/api/rooms` | active | Create a room with `{ deckIndex }` or `{ deckId }`; returns a 6-character code and echoes the choice |
| `POST` | `/api/rooms/:code/join` | active | Claim it, with `{ deckIndex }` or `{ deckId }`. Atomic: a race produces one match and one 409 |

## WebSocket surface

One socket per player, per match. The message union is `src/match/protocol.ts`: the client sends
`hello` and `action`, the server sends `hello`, `view`, `ack`, `error`, `prompt` and `clock`.

Properties the actor holds, each with a test named after it:

- Every action carries a client nonce and is deduped server-side. A reused nonce returns the
  **original** ack — it does not re-reduce, does not append a second log row and does not push a
  second view (§9.3).
- `reduce` refuses illegal actions itself and returns the reason; the actor relays that reason and
  never re-implements a rule. Client greying-out is UX only.
- The server stamps `playerId` from the authenticated seat. A client cannot act as its opponent.
- The only per-player payload is `viewFor(state, player)`. No frame carries a `GameState`, the
  other hand's card ids, or library order (§10.8).
- Every resolved action is appended to `match_actions`. A crashed or evicted actor rebuilds itself
  by folding `(seed, decks, log)` — a reconnect gets a fresh full view, never a log replay (§9.5).

### Clocks (R79)

All of R79's values come from `src/config.ts` and are stated nowhere else: turn clock 75 s, prompt
clock 30 s, disconnect grace 60 s, match ceiling 60 minutes, Elo K = 32 from 1000.

The clock lives here, never in the engine: time reaches the engine only as action data (§9.3), so
an expiry becomes an ordinary server-only action — `timeout`, `disconnectExpired` or
`ceilingReached` — that goes through `reduce` and into the log like any other. That is what keeps
`(seed, log)` sufficient to reconstruct a match.

- The turn clock belongs to the active player. A prompt held by the **non-active** player (a trap
  firing on your turn) pauses it and runs its own prompt clock; on expiry `timeout` answers only
  that prompt. A prompt held by the active player does not pause their clock.
- Disconnect grace runs per player and is stored on the match, so both clients can show the
  countdown. The turn clock keeps running while a player is away.
- Reaching the ceiling is a draw. A reaper resolves anything past it.
- Every terminal reason — hero death, draw accepted, turn cap, concede, disconnect, ceiling —
  writes exactly one `results` row, applies the Elo update once and clears both players' in-match
  state. Writing it twice is a no-op.

## Tests

```bash
cd apps/server
pnpm exec vitest run --config vitest.config.ts     # the whole server suite
pnpm exec tsc -p tsconfig.json                     # typecheck
```

There is no test database and no network in the suite. The doubles in `test/fakes/` are the reason:

- `store.ts` — an in-memory `Store` that is strict where Postgres is strict. `tx` snapshots every
  table and restores it if the callback throws, so "both tables or neither" is a real assertion;
  `codes.claim`, `rooms.claim` and `tickets.claimPair` are single-shot; `match_actions` refuses a
  duplicate seq; `results` refuses a second row for a match. `store.onCall` is the fault-injection
  seam.
- `engine.ts` — a scripted `EnginePort` with the same contract the real engine has where the server
  relies on it. Cards `test-prompt-self`, `test-prompt-enemy` and `test-lethal` reach the
  situations R79 cares about without the real catalog.
- `deps.ts` — `createManualTimers()` (an `advance(ms)` that fires exactly the due callbacks; used
  instead of `vi.useFakeTimers()` because every deadline already goes through the `Timers` port),
  a scripted auth provider, a small catalog and a `ServerDeps` builder.
- `socket.ts` — in-memory sockets with the same interface the `ws` adapter implements.

## What is real and what is stubbed

Real: the ports and the gate; invite codes and the six-step redemption with its identical error and
identical timing; the collection ledger's two-table transaction; loadout save and the queue-time
re-check against the shared validator; the match actor, protocol, nonce dedupe, action log and
log-folding recovery; room codes; the clock; results and Elo; matchmaking with frozen decks,
opportunistic pairing, a sweeper, the widening window and the atomic claim; the catalog loader
against the real 109-entry `catalog.json`.

Stubbed or pending, and why:

- **`src/match/engine.real.ts` is excluded from `tsconfig.json`.** It is the only static import of
  `@jackioh/engine`, and that package does not compile yet (M3 is in flight). `src/match/engine.ts`
  reaches it through a dynamic import and reports exactly which exports are missing. Delete the
  `exclude` entry and make the import static the day
  `pnpm exec tsc -p packages/engine/tsconfig.json` is green — nothing else in `src/` imports the
  engine, so that is the whole change.
- **The `Store` implementation.** `src/api/ports.ts` is the contract; `src/db/**` implements it.
  Until then the runtime boots with a message naming what it needs, and the test suite runs against
  the in-memory store.
- **Sign-up and sign-in through this server** are convenience routes for BUILD M8's fixture
  accounts. Without a publishable key configured they refuse with a message pointing at the
  browser, which is where §9.2 puts that traffic.
- **The ban list** behind loadout rule L6 is a hook that always answers "not banned". `CardDef`
  carries no ban flag and nothing in SPEC §8 is banned at launch; `cards.banned` in the schema is
  where it will come from.
- **Spectating, tournaments, player-facing replays, behavioural anti-cheat and the economy** are
  out of scope per SPEC §9.6, and the action log is what makes replays cheap later.

## Conventions

- Rules constants live in `packages/engine/src/config.ts`; server constants live in
  `src/config.ts`. Nothing else states a number. `src/api/deps.ts` is the single place that reads
  `src/config.ts` and turns it into the injected `ServerConfig` and `ApiLimits`, which is what lets
  a test shrink a clock without editing a constant.
- Anything SPEC does not decide is marked `// NOT IN SPEC:` at the point of decision, so a review
  can grep for every judgement call the code makes.
- `packages/engine` and `packages/cards` are pure — no `Math.random`, no `Date`, no I/O. This app is
  the impure half and holds all of it.
