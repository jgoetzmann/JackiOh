# `apps/server` — the JackiOh server runtime

The authority for everything that is not presentation. It owns identity and the invite gate, the
collection ledger, saved decks and trios, an active account's copy of its tutorial progress (R320),
matchmaking in three modes, the Best-of-3 series, and the match itself: one actor per match holding the
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
2. `src/api/catalog.ts` — reads `packages/cards/catalog.json` (110 entries) and derives
   `CatalogInfo`, including the catalog version §9.4 checks at save and at queue.
3. `src/api/loadout-validator.ts` — the only path to `@jackioh/validator` for the queue rules
   (L1–L6 for a trio, L2, L3, L5 and L6 for a Best-of-1 deck, R253), and `src/api/decks.ts` calls
   the same package's draft checks (D1–D4, T1–T3, R250, R252). No rule is restated here.

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
| `TRUSTED_PROXY_HOPS` | no | R190: how many `X-Forwarded-For` entries, counted from the right, the deployment's own proxies append; the per-IP limits (§9.4 step 3, R157) key on that entry. `0` to `5`, default `0` (the header is ignored, and a request is keyed on the socket's peer address). Behind Render set it: `render.yaml` starts at `1`, then calibrate it from the `api.forwarded_for` log (docs/architecture.md §10, step 8). Without it, every request behind a proxy is keyed on the proxy's address |

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
codes are the `ApiErrorCode` union in `src/api/http.ts`.

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
| `GET` | `/api/decks` | active | The profile's saved decks and trios, oldest first, and the caps (R250, R252) |
| `PUT` | `/api/decks/:id` | active | Create or replace one deck by the id the client minted (R256); D1–D4 only, a draft may be incomplete |
| `DELETE` | `/api/decks/:id` | active | Idempotent; empties every trio slot that held the deck |
| `PUT` | `/api/trios/:id` | active | Create or replace one trio (T1–T3); a slot may be empty, decks may share cards |
| `DELETE` | `/api/trios/:id` | active | Idempotent |
| `POST` | `/api/queue` | active | Enqueue in a mode (R257): `{ mode: "bo1", deckId }`, `{ mode: "bo3", trioId }` or `{ mode: "random" }`; the deck or trio is validated (R253) and frozen into the ticket |
| `DELETE` | `/api/queue` | active | Leave the queue |
| `GET` | `/api/queue/population` | user | §9.5: the open tickets, in total and per mode |
| `POST` | `/api/rooms` | active | Create a room in a mode (R264); returns a 6-character code |
| `POST` | `/api/rooms/:code/join` | active | Claim it in the room's mode. Atomic: a race produces one match (or series) and one 409 |
| `GET` | `/api/series/:id` | active | A Best-of-3 series as its player may see it: never the other side's pick or decks (R259) |
| `POST` | `/api/series/:id/pick` | active | Pick the next game's deck from the frozen trio; the game starts when both have picked |
| `POST` | `/api/series/:id/forfeit` | active | Leave the series between games; the other side wins it (R261) |
| `GET` | `/api/matches/:id/series` | active | The series a match is a game of, for the board's banner |
| `GET` | `/api/tutorial` | active | The account's tutorial progress (R320): completed lesson ids and the newest Hide/Show choice; empty before the first write |
| `PUT` | `/api/tutorial` | active | Merge a device's progress into the account's (R320): `{ completed, hiddenChoice? }`. The lessons become the union, a choice replaces the stored one only when it is newer (a time after the server's clock counts as now), nothing is ever removed, and the answer is the merged progress. Ids are checked for shape only (lower-case slugs, `TUTORIAL_LESSON_ID_MAX_LENGTH`, at most `TUTORIAL_LESSONS_MAX`); the lessons are the client's |

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
clock 30 s, disconnect grace 60 s, match ceiling 60 minutes, Elo K = 32 from 1000. R268's mulligan
clock, 45 s (`MULLIGAN_CLOCK_SECONDS`), lives beside them.

The clock lives here, never in the engine: time reaches the engine only as action data (§9.3), so
an expiry becomes an ordinary server-only action — `timeout`, `disconnectExpired` or
`ceilingReached` — that goes through `reduce` and into the log like any other. That is what keeps
`(seed, log)` sufficient to reconstruct a match.

- The turn clock belongs to the active player. A prompt held by the **non-active** player (a trap
  firing on your turn) pauses it and runs its own prompt clock; on expiry `timeout` answers only
  that prompt. A prompt held by the active player does not pause their clock.
- The mulligan clock (R268) runs while both mulligans are open (R265): the snapshot's
  `mulliganOwed` is non-empty and no prompt is pending. It is **one** deadline for both seats, armed
  the first time the window is seen and never re-armed or extended when one seat answers, so the
  seat that answers second gets no more time than the first. Setup is nobody's turn, so no turn
  clock runs under it. It is reported as `promptDeadline` (the stored `MatchClocks` keeps its
  shape) and as both seats' `clockMs`. On expiry the actor sends one `timeout` for **each** seat
  still owing at that moment, in seat order, each its own log row; the engine answers that seat's
  mulligan by keeping its whole hand and ends no turn. Once both are in, the ordinary turn clock
  starts from full for turn 1. A card that asks a question during setup (a cast-on-draw card in the
  deal or in a replacement draw) is a real `pending` prompt and is timed by R79 as above. A rebuilt
  actor arms a fresh window (R268), as the turn clock restarts from full.
- Once one seat has answered, each seat gets the `prompt` frame that fits it: a seat that owes its
  mulligan its own prompt (`forYou: true`, its choiceId), a seat that has answered only that the
  other still owes one. None is pushed as the window opens with the match; the client reads both
  mulligans off `view.pending` and the deadline off the `clock` frame.
- Every nonce the actor mints for a clock's action starts `srv-`, and a client frame whose nonce
  does is refused as malformed (R270): the actor answers a known nonce with its stored ack, so a
  client that sent the next expiry's nonce first would swallow it. What a seat kept is sealed (R266) and travels in no frame but its own view.
- Disconnect grace runs per player and is stored on the match, so both clients can show the
  countdown. The turn clock keeps running while a player is away.
- Reaching the ceiling is a draw. A reaper resolves anything past it.
- Every terminal reason — hero death, draw accepted, turn cap, concede, disconnect, ceiling —
  writes exactly one `results` row, applies the Elo update once and clears both players' in-match
  state. Writing it twice is a no-op.

### Draw offers and concede (R36, R269)

A draw offer is an engine rule end to end, and the server does not restate any of it: only the
active player offers, in their main phase, `DRAW_OFFERS_PER_TURN` times a turn; a declined offer
blocks that player for `DRAW_OFFER_BLOCK_TURNS` of their turns; an unanswered offer lapses when the
offerer's turn ends and blocks nothing (R269). Those two constants are in
`packages/engine/src/config.ts`, not here, because hotseat and practice play the same rule with no
server at all. So the rate limit on repeated offers **is** R36's: the actor relays `offerDraw` and
`answerDraw` like any other action, and a refused one comes back as the reducer's own sentence
(§9.8's action flood limit still applies on top, as it does to every frame). The standing offer is
on both seats' views as `drawOffer: { by }`, so it survives a reconnect.

An accepted offer ends the match `{ winner: "draw", reason: "draw-accepted" }` and a concede
`{ winner: <the other seat>, reason: "concede" }` — a concede is open to both seats at all times,
the mulligan window included. Both go through the one results path (`api/results.ts`,
`createRecordResult`): one `results` row, Elo scored 0.5 each for a draw and 1/0 for a concede,
both in-match flags cleared, once.

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
  situations R79 cares about without the real catalog, and `createFakeEngine({ mulligan: true })`
  opens on the concurrent mulligan (R265) for the tests about the mulligan clock.
- `deps.ts` — `createManualTimers()` (an `advance(ms)` that fires exactly the due callbacks; used
  instead of `vi.useFakeTimers()` because every deadline already goes through the `Timers` port),
  a scripted auth provider, a small catalog and a `ServerDeps` builder.
- `socket.ts` — in-memory sockets with the same interface the `ws` adapter implements.

## What is real and what is stubbed

Real: the ports and the gate; invite codes and the six-step redemption with its identical error and
identical timing; the collection ledger's two-table transaction; saved decks and trios as drafts
with client-minted ids, and the queue-time check against the shared validator; the tutorial's
grow-only account copy (R320); the match actor,
protocol, nonce dedupe, action log and log-folding recovery; room codes, in all three modes; the
clock; results and Elo; matchmaking in three modes with frozen decks, opportunistic pairing, a
sweeper, the widening window and the atomic claim; All Random's seeded decks; the Best-of-3 series,
its pick clock, its one rating move and its recovery after a restart; the catalog loader against the
real 110-entry `catalog.json`.

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
