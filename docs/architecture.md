# JackiOh server architecture

**Scope.** How to take a fresh Supabase project and a checkout of this repo and end up with two
browsers playing a room-code match. This document is derived from SPEC.md §9 and §10.8 and from
BUILD.md M6–M7; where it says something SPEC §9 does not, it says so and names the SPEC §11 row that
records the decision (§11 below collects all nine, R104–R112). SPEC is the contract — if this document
and SPEC disagree, SPEC wins and this document is the bug.

**Audience.** A developer executing BUILD M6 and M7. Nothing here is a game rule; rules live in SPEC
§§2–8 and are implemented once, in `packages/engine`.

---

## 1. Component map

```mermaid
flowchart TD
  B["Browser<br/>apps/web (static bundle)"]
  CDN["Static host / CDN"]
  AUTH["Supabase Auth<br/>email + password, verification"]
  PGR["Supabase Data API (PostgREST)<br/>role: authenticated"]
  API["apps/server HTTP routes<br/>codes, collection, loadouts, queue, rooms"]
  ACT["apps/server match actor<br/>one per live match"]
  PG[("Supabase Postgres<br/>13 tables + private app schema")]
  ENG["packages/engine<br/>reduce / viewFor / fold"]
  CAT["packages/cards<br/>catalog.json + scripts"]

  CDN -.serves.-> B
  B -->|HTTPS, publishable key + user JWT| AUTH
  B -->|HTTPS, publishable key + user JWT| PGR
  B -->|HTTPS, Bearer user JWT| API
  B -->|WSS, Bearer user JWT| ACT
  PGR -->|RLS enforced| PG
  API -->|DATABASE_URL, service_role| PG
  ACT -->|DATABASE_URL, service_role| PG
  API --> ENG
  ACT --> ENG
  ENG --> CAT
```

This is SPEC §9.2's topology with each box named. The only departure from the diagram in SPEC is that
the "API functions" and the "Match actor" are two responsibilities of **one Node process**
(`apps/server`) rather than two deployment units; §5.3 below explains why, and the split is a
deployment decision that can be made later without touching the code.

| Component | Where it runs | Stateful? | Owns |
| --- | --- | --- | --- |
| `apps/web` | Static bundle on any CDN | No | Rendering `viewFor`, composing intent, the bundled catalog |
| Supabase Auth | Supabase | Managed | Signup, password hashing, email verification, sessions, JWTs |
| Supabase Postgres | Supabase | Yes (durable) | The 13 tables of BUILD M6, RLS, the private `app` schema |
| Supabase Data API | Supabase | No | Read-only projections to the browser, RLS-enforced |
| `apps/server` HTTP routes | One Node process | No | Redemption, collection reads, `saveLoadout`, enqueue, room create/join |
| `apps/server` match actor | The same Node process | **Yes (in memory)** | `GameState`, two WebSockets, the turn clock, the action log |
| `packages/engine` + `packages/cards` | Imported by both of the above | No (pure) | Every rule, `reduce`, `viewFor`, `fold` |

---

## 2. What the client is allowed to do

SPEC §9.1, restated as channels rather than domains:

| Channel | Credential | What it carries |
| --- | --- | --- |
| Browser → Supabase Auth | publishable key (`sb_publishable_…`) | signup, login, email verification, token refresh |
| Browser → Data API | publishable key + the user's JWT | **reads only**: own profile row, own collection, own loadout, own tickets, own results, the `cards` projection |
| Browser → server HTTP | the user's JWT as `Authorization: Bearer` | intent: "redeem this code", "save this loadout", "enqueue slot 2", "create a room", "join ABC234" |
| Browser → server WebSocket | the user's JWT in the `hello` frame | intent: one `Action` at a time; receives `viewFor` and nothing else |

One rule, from SPEC §9.1: **the client sends intent, never state.** "Play instance 7 in zone 3 with
target 12", never "my deck contains these 20 cards", never "I own a Mythic".

---

## 3. Trust boundaries

Five boundaries. Each row names what crosses it, what enforces the crossing, and the failure mode if
the enforcement is missing.

| # | Boundary | What crosses | Enforced by | Failure mode if absent |
| --- | --- | --- | --- | --- |
| 1 | Browser → Supabase Auth | credentials | Supabase Auth | password handling done badly by us instead of them (SPEC §9.4: "managed auth provider") |
| 2 | Browser → Data API | read queries as `authenticated` | **RLS on every table**, default deny | a player reads another player's collection, or any invite code |
| 3 | Browser → server HTTP | intent + a JWT | JWKS signature verification; the profile id is the verified `sub` and never a request field | account takeover by claiming someone else's id |
| 4 | Browser → server WS | `Action` objects | `reduce` itself (SPEC §9.3: "`reduce` refuses illegal actions itself"); actor-side nonce dedupe and rate limit | illegal plays, action flooding (SPEC §9.8) |
| 5 | Server → Postgres | SQL as `service_role` / `postgres` | the secret key and `DATABASE_URL` are server-only env; the private `app` schema is not exposed | a leaked secret key bypasses every policy in the project |

### 3.1 Three things that must never reach a client

SPEC §9.1 and §10.8 name them; SPEC §9.8 lists the vector. They drive concrete policy decisions:

1. **Library order.** Consequence: `matches.seed` is not client-readable, and neither is
   `match_actions`. `(seed, log)` reconstructs the shuffle (SPEC §9.3), so handing a player the log is
   handing them every future draw. This is why `matches` and `match_actions` have RLS enabled and
   **no** SELECT policy at all, and why SPEC §9.5 says "Reconnect gets a fresh full view, never a log
   replay."
2. **The opponent's hand.** Consequence: only `viewFor` crosses the WebSocket, and the opponent's hand
   is a count (SPEC §10.8). BUILD M6-T4 makes this a protocol-level test.
3. **Face-down traps and the other player's pending options.** Consequence: `viewFor` renders the
   opponent's backrow as face-down markers and an open prompt held by the opponent as
   `{ forYou: false }`.

### 3.2 RLS matrix

`anon` gets nothing anywhere. Everything below is for the `authenticated` role, further narrowed by
the policy in the third column. `service_role` bypasses RLS and is the only writer.

| Table | Client read | Policy | Client write |
| --- | --- | --- | --- |
| `profiles` | own row | `id = auth.uid()` | **none** — identity is server-owned (§9.1) |
| `invite_codes` | **none** | no policy | none — a readable code row defeats the gate (§9.8) |
| `code_attempts` | **none** | no policy | none |
| `cards` | all rows | `true` | none — the catalog is static data (§9.4) |
| `collection` | own rows | `profile_id = auth.uid()` | **none** — §9.4: "no client path writes either" |
| `collection_grants` | own rows | `profile_id = auth.uid()` | none; append-only by trigger |
| `loadouts` | own row | `profile_id = auth.uid()` | **none** — saving is all-three-decks-or-nothing (§9.4) |
| `loadout_decks` | own rows | `profile_id = auth.uid()` | none |
| `loadout_deck_cards` | own rows | `profile_id = auth.uid()` | none |
| `tickets` | own rows | `profile_id = auth.uid()` | none — enqueue freezes a deck (§9.5) |
| `matches` | **none** | no policy | none — holds `seed` and both decks (§3.1) |
| `match_actions` | **none** | no policy | none — append-only by trigger (§9.3) |
| `results` | rows you played in | `auth.uid() in (p1_profile_id, p2_profile_id)` | none |

Three Supabase-specific traps this schema avoids on purpose:

- **Views bypass RLS.** There are no views in the exposed schema. If one is added it must be
  `create view … with (security_invoker = true)`.
- **`SECURITY DEFINER` functions in an exposed schema are reachable over HTTP.** Every one of ours
  lives in the private `app` schema, which is not in the Data API's exposed schema list, so
  `app.redeem_invite_code` and `app.save_loadout` have **no HTTP path at all** — they are reachable
  only over `DATABASE_URL`.
- **`user_metadata` is user-editable** and can appear in `auth.jwt()`. No policy or function reads it.
  Authorization comes from `profiles.status`, which only the server writes.

### 3.3 The gate

SPEC §9.4: `profiles.status ∈ pending | active | banned`, and "a pending account can log in, verify
its email and see the code screen, and nothing else: no collection, loadout, queue or match."

Two layers, both required:

- **Database.** `app.profile_is_active()` guards the write functions; a `pending` profile simply has no
  `collection` rows yet, because the launch grant fires on the `pending → active` transition.
- **API.** Every route but `/api/codes/redeem` and `/api/me` asserts `status = 'active'` and returns
  403 otherwise (BUILD M6-T1 acceptance).

---

## 4. Why the match actor cannot be a stateless function

SPEC §9.2: "The match actor (Durable Object or equivalent) is the only stateful component: it holds
the state in memory, one WebSocket per player, an alarm for the turn clock, and it appends every
resolved action to the log."

The binding constraint is the clock. SPEC §9.5 and R79 require a 75-second turn clock, a separate
30-second prompt clock for a prompt held by the non-active player, a 60-second disconnect grace and a
60-minute match ceiling. ARCHITECTURE-CCG §2.1 states the consequence plainly: **a stateless function
cannot run a timer** — it only reacts to requests, and "the opponent never sends one" is exactly the
case the clock exists to handle. A player who closes their laptop mid-turn must lose the turn, then
the match; nobody is going to send the request that makes that happen.

Three further properties push the same way:

- **Ordering.** A single-threaded actor makes action ordering free. Two players acting in the same
  tick through separate stateless invocations would need a lock or a compare-and-set on every action.
- **Cost per action.** A stateless function reloads and re-persists `GameState` on every action, or
  re-folds the log. The actor holds it in memory and writes one append-only row.
- **Push.** After every change the server pushes `viewFor` to both sockets (SPEC §9.3, §10.8). That is
  a server-initiated write to a connection the function does not own.

### 4.1 Specifically: Supabase Edge Functions cannot host it

Edge Functions are request-scoped Deno isolates. They have no durable per-match identity, no alarm or
timer that survives the response, and no way to hold two WebSockets open for the life of a match with
in-memory state between them. There is no Supabase primitive equivalent to a Durable Object. So the
actor is the one piece of this system Supabase does not supply.

ARCHITECTURE-CCG §2.1 offers three options and this design takes the third:

| Option | Verdict here |
| --- | --- |
| Stateful actor per match (Durable Objects) | The reference design. Available if the deployment target becomes Cloudflare; the actor code is written against an interface that allows it (§5.2). |
| Stateless functions + external state + scheduler | Rejected: two storage round trips per action, plus a separate scheduled job for every clock. |
| **Long-running Node process hosting one actor object per live match** | **Taken.** One process, one `Map<matchId, MatchActor>`, `setTimeout` for the clocks, `ws` for the sockets. ARCHITECTURE-CCG: "Simple to reason about, but you're operating a server." |

What "operating a server" costs us, and the mitigation each cost already has in SPEC:

| Cost | Mitigation |
| --- | --- |
| A restart drops every live match | `(seed, log)` rebuild on boot — SPEC §9.5: "A crashed actor rebuilds its state by folding `(seed, log)`". `app.live_matches()` is the query. |
| One process is one point of failure | The hard ceiling and the reaper (§9.5) guarantee no match and no player is stuck forever, whatever happens to the process. |
| Horizontal scale needs match affinity | Out of scope at this population (ARCHITECTURE-CCG §6.1: "single digits at 3am"). When it is needed, `matches.status` plus a claim column is the smallest change. |

### 4.2 Where each clock lives

| Clock | Value | Held by | Also stored on `matches` | Why stored |
| --- | --- | --- | --- | --- |
| Turn clock | 75 s (`TURN_CLOCK_SECONDS`) | actor `setTimeout` | `turn_deadline_at` | so both clients render it and a rebuild restores it |
| Prompt clock | 30 s (`PROMPT_CLOCK_SECONDS`) | actor `setTimeout` | `prompt_deadline_at` | a trap prompt held by the non-active player pauses the turn clock (R79) |
| Disconnect grace | 60 s (`DISCONNECT_GRACE_SECONDS`) | actor `setTimeout` | `grace_deadline_at` | SPEC §9.5: "the grace countdown is stored on the match so both clients show it" |
| Match ceiling | 60 min (`MATCH_CEILING_MINUTES`) | actor + the DB reaper | `ceiling_at` | the reaper must be able to resolve a match whose actor died (§9.5) |

Expiry never mutates state directly. It submits an action — `timeout`, `disconnectExpired`,
`ceilingReached` — through the same `reduce` as a player's click (R79, BUILD M7-T2). The engine stays
pure; only the actor knows what time it is.

---

## 5. How the actor calls the pure engine

SPEC §9.3: "`reduce(state, action, rng)` is pure: no I/O, no clock reads, no framework. Timestamps
arrive as action data." The engine's public surface is already what the actor needs:

```ts
import { createGame, beginGame, reduce, legalActions, viewFor, fold, hashState } from "@jackioh/engine";
import { catalog } from "@jackioh/cards";
```

### 5.1 The loop

```
on socket open:
   verify the JWT -> profileId; check it is p1 or p2 of this match; attach the socket
   push viewFor(state, seat)

on action frame:
   1. rate-limit the socket                              (SPEC §9.8, MATCH_ACTIONS_PER_SECOND)
   2. if action.nonce was already applied -> return the original ack
                                                          (SPEC §9.3, BUILD M6-T4)
   3. stamp seat from the verified JWT; never trust action.playerId from the wire
   4. { state, events, error } = reduce(state, action)
   5. if error -> ack { ok: false, reason: error }; log the rejection with its reason (SPEC §9.8)
   6. append the action to match_actions via app.append_match_action  (SPEC §9.3)
   7. push viewFor(state, 'p1') to p1 and viewFor(state, 'p2') to p2  (SPEC §10.8)
   8. reset the clocks from the new state; if state.result -> app.end_match and close
```

Notes that matter:

- **Step 3 is the whole trust model in one line.** The seat comes from the verified token. An action
  claiming `playerId: "p2"` on p1's socket is rejected before it reaches `reduce`.
- **Step 4 does not need `rng` passed in.** Randomness is `(state.seed, state.rngCursor)`, advanced
  inside the reducer (SPEC §10.7), so the actor never sources entropy. `Math.random` is banned by
  lint in `packages/engine` and `packages/cards`.
- **Step 6 appends after `reduce` succeeds.** The log is a log of *resolved* actions (SPEC §9.3:
  "Append-only action log per match"), so a fold of it never has to skip rejects.
- **Step 7 pushes two different objects.** `viewFor` is the filter; there is no "full state" frame and
  no debug mode that sends one.
- **Prompts are state, not callbacks** (SPEC §9.3). A choice mid-resolution sets `state.pending` and
  returns; the answer is another action through the same path. That is why a trap firing on the
  opponent's turn (BUILD e2e `03`) needs no special case in the actor: it is one more `reduce`.
- **Play-time choices travel in the `play` action** (R81), so zone, X, embiggen, Tribute, targets and
  modes do not pause resolution and do not round-trip.

### 5.2 Actor lifecycle

| Event | What the actor does |
| --- | --- |
| Room created | nothing yet; the row is `open` and no state exists |
| Second player joins | `createGame({ seed, decks })` then `beginGame`; status `live`; `started_at` and `ceiling_at` stamped |
| Both sockets attached | push `viewFor` to each; start the turn clock |
| One socket drops | start the grace timer, write `grace_deadline_at`, push the countdown to the other player; **the clock keeps running** (SPEC §9.5) |
| Reconnect inside grace | fresh `viewFor`, never a replay (SPEC §9.5); cancel the grace timer |
| Grace expires | submit `disconnectExpired` → a loss (R79) |
| Terminal state | `app.end_match` writes one `results` row, updates both ratings, clears both `profiles.current_match_id` and any queued ticket, then the actor is dropped from the map |
| Process boot | `app.live_matches()`, then for each: `fold({ seed, decks, log })` and re-arm the clocks from the stored deadlines |
| Idle | The Node process has no hibernation; an actor with no sockets and an expired grace has already ended. On Durable Objects this row would read "hibernate". |

The actor is written against a small interface — `now()`, `setAlarm()`, `appendAction()`,
`send(seat, frame)` — so the Durable Object port is a different implementation of four methods rather
than a rewrite.

### 5.3 Why the API routes share the process

They do not have to. They are stateless and could be Edge Functions. They share the process because:

- They import `@jackioh/validator` and `@jackioh/engine`, which are TypeScript workspace packages;
  one Node process resolves them the way the rest of the repo does, with no bundling step.
- `saveLoadout`, the redemption transaction and the ticket claim need multi-statement transactions
  over `DATABASE_URL`, which is a server-only credential either way.
- Matchmaking's opportunistic pairing on enqueue (SPEC §9.5) wants to hand the paired match straight
  to a local actor.

If they are ever split out, nothing in the trust model changes: they would still hold the secret key
and still be the only writers.

---

## 6. Why `(seed, log)` is the source of truth

SPEC §9.3: "Seeded RNG only… `(seed, log)` reconstructs any match." The in-memory `GameState` is a
cache of a fold, not the record.

What this buys, in the order it will be needed:

1. **Crash recovery.** SPEC §9.5. The process restarts, reads `matches` where `status = 'live'`, folds
   each log and re-arms the clocks. No snapshots to keep consistent, no half-written state. BUILD
   M6-T4's acceptance is exactly this: "killing the actor mid-game and reconnecting yields the same
   `viewFor` for both players."
2. **Determinism as a test oracle.** `hashState(fold(seed, decks, log))` computed twice must match.
   BUILD's e2e `01` compares the final hash from a browser game against a vitest replay of the
   recorded actions; the fuzz gate folds 1,000 seeded games twice and compares.
3. **Dispute resolution and balance telemetry.** ARCHITECTURE-CCG §2.2. Card win rates, mulligan data
   and curve analysis are derived offline from the log, with no extra instrumentation.
4. **Replays later for free.** Out of scope (SPEC §9.6) but already paid for.

What the database therefore stores per match, and nothing more:

| Column | Role in the fold |
| --- | --- |
| `matches.seed` | the only entropy in the system |
| `matches.p1_deck`, `matches.p2_deck` | the frozen decklists — SPEC §9.5: decks are frozen into the ticket, never resolved from the loadout at match start |
| `matches.catalog_version` | which card definitions the fold must use |
| `match_actions (match_id, seq, action)` | the ordered log; `seq` is assigned under a row lock |
| `match_actions (match_id, nonce)` unique | server-side dedupe so a retrying client is safe (SPEC §9.3) |

No snapshots. ARCHITECTURE-CCG §2.2: "Append each action as it resolves; don't persist snapshots.
Periodic snapshots are an optimisation for later if replay gets slow." A 30-player-turn cap (R2) puts
a hard bound on log length, so that day is far off.

`match_actions` is append-only as a **database** property: `app.deny_row_mutation()` is attached
`before update or delete`. `collection_grants` gets the same trigger for the same reason.

---

## 7. The catalog

SPEC §9.4: "catalog is static, versioned, shipped with the client; stale catalog version is rejected
at save and queue."

| Copy | Lives in | Used for |
| --- | --- | --- |
| `packages/cards/catalog.json` | the repo, bundled into `apps/web` | every card name, cost, stat and rules text the client renders |
| `packages/cards/src/scripts/*` | imported by the engine, server-side only | what cards actually do |
| `public.cards` | Postgres | referential integrity for `collection` and `loadout_deck_cards`, and the server-side L6 check ("exists in the current catalog version and is not banned") |

`public.cards` is a projection, loaded by `pnpm --filter @jackioh/server db:seed-catalog`, which stamps
`catalog_version` on every row and writes the same value to `app.settings`. It is not a source of
truth for rules: the deck builder is fast because a collection read is a short list of
`(card_id, quantity)` and the card data is already in the bundle.

Version mismatch has one behaviour everywhere: `app.assert_catalog_version` raises `update required`,
the server maps that to a 409 with the same message, and the client prompts a reload. Checked at
`saveLoadout` and again at enqueue (SPEC §9.4, §9.5).

---

## 8. Env-var contract

Two disjoint halves. The rule is mechanical: **anything the browser needs is prefixed `VITE_` and is
public by construction; anything without that prefix must never appear in a client bundle.**

### 8.1 Public — shipped to the browser

| Variable | Value | Where it comes from |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | `https://<ref>.supabase.co` | Dashboard → Project Settings → Data API → Project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` | Dashboard → Project Settings → API Keys → Publishable key |
| `VITE_SERVER_HTTP_URL` | `https://api.example.com` | wherever `apps/server` is deployed |
| `VITE_SERVER_WS_URL` | `wss://api.example.com/ws` | same host, WebSocket path |
| `VITE_CATALOG_VERSION` | e.g. `core-1` | must equal the server's `CATALOG_VERSION` |

A publishable key is safe in a browser **because RLS is the access control**, not because the key is
secret. It maps to the `anon` role before login and `authenticated` after, and §3.2's matrix is the
whole of what it can reach. Legacy `anon` JWT keys still work and are compatibility only.

### 8.2 Server-only — never in a client bundle, never in git

| Variable | Required | Purpose | Where it comes from |
| --- | --- | --- | --- |
| `SUPABASE_URL` | yes | project URL for admin auth calls and the JWKS default | Dashboard → Project Settings → Data API |
| `SUPABASE_SECRET_KEY` | yes | `sb_secret_…`; maps to `service_role` and **bypasses every RLS policy** | Dashboard → Project Settings → API Keys → Secret key |
| `DATABASE_URL` | yes | direct Postgres; the transactions the Data API cannot express (§9.4 redemption, `saveLoadout`, §9.5 ticket claim) | Dashboard → Project Settings → Database → Connection string → URI |
| `SUPABASE_JWKS_URL` | no | defaults to `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`; verifies browser JWTs (RS256/ES256) | derived |
| `SUPABASE_JWT_SECRET` | no | legacy HS256 fallback; discouraged | Dashboard → Project Settings → JWT Keys |
| `CODE_PEPPER` | yes, ≥32 chars | HMAC pepper for `invite_codes.code_hash` and `code_attempts.ip_hash` | `openssl rand -base64 48`; rotating it invalidates unredeemed codes |
| `PORT` | no (8787) | listen port | — |
| `PUBLIC_ORIGINS` | yes | comma-separated allowed origins for CORS and the WebSocket `Origin` check | your web host |
| `NODE_ENV` | no (`development`) | `development \| test \| production` | — |
| `CATALOG_VERSION` | yes | the catalog version this server accepts (§9.4) | must match what `db:seed-catalog` stamped |
| `E2E` | no (`0`) | BUILD M8's test-server mode; refused when `NODE_ENV=production` | — |

`apps/server/src/env.ts` loads these, reports **every** missing or malformed variable in one error
naming where to get each, and never logs a secret value — not even truncated. It exports
`PUBLIC_ENV_VARS` and `SERVER_ONLY_ENV_VARS` so a test can assert the halves never cross. Template:
`apps/server/.env.example`.

Two things that are **not** env vars, deliberately:

- **R79's lifecycle values** — turn clock, prompt clock, grace, ceiling, room-code length, Elo K and
  start. They are gameplay, so they are named exports in `apps/server/src/config.ts` and change only
  with a code change and a review. BUILD §2 requires exactly that.
- **The code pepper in Postgres.** Hashing happens in the server, so the pepper never reaches the
  database and `invite_codes` only ever holds `code_hash`. A database dump therefore does not yield a
  single redeemable code.

---

## 9. Local versus hosted

The same four SQL files, the same server, two connection strings.

| | Local | Hosted |
| --- | --- | --- |
| Postgres + Auth + Data API | `supabase start` (Docker) | the Supabase project |
| API URL | `http://127.0.0.1:54321` | `https://<ref>.supabase.co` |
| `DATABASE_URL` | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` | Project Settings → Database → URI |
| Studio | `http://127.0.0.1:54323` | the dashboard |
| Outgoing email | captured locally at `http://127.0.0.1:54324`, nothing is actually sent | your SMTP provider; configure it before inviting anyone, because §9.4 requires a verified email before redemption |
| Keys | printed by `supabase start` | Project Settings → API Keys |
| `apps/server` | `pnpm --filter @jackioh/server dev` | the same process, behind TLS |
| `apps/web` | `pnpm --filter @jackioh/web dev` (Vite, :5173) | static bundle on a CDN |

Notes:

- **The email step is the one real local/hosted difference.** SPEC §9.4 requires a verified email
  before redemption, which means a hosted project needs working SMTP before the first invite goes
  out. Locally, click the link in the captured mail UI. `[auth.email] enable_confirmations` in
  `supabase/config.toml` controls it; leave it **on**, because turning it off locally makes the gate's
  step 1 untestable.
- **Connection modes.** `db:migrate` takes a `pg_advisory_lock` across statements, so it needs a
  **session-mode** connection (the direct `:5432` URI, or Supavisor's session port). The runtime
  server is fine on either; transaction-mode pooling is the cheaper default for it.
- **Exposed schemas.** Confirm `app` is not in the Data API's exposed schema list — `[api] schemas`
  in `supabase/config.toml` locally, Project Settings → Data API in the dashboard. The default
  (`public`, `graphql_public`) is correct. If `app` is ever exposed, every `SECURITY DEFINER` function
  in it becomes an HTTP endpoint.
- **Supabase CLI users.** The canonical SQL is at `apps/server/src/db/migrations/` per BUILD §1. The
  CLI only reads `supabase/migrations/<timestamp>_<name>.sql`, so if you want `supabase db push` and
  `supabase db reset`, add `supabase/migrations/` entries that are symlinks or `\i` includes pointing
  at the canonical files, and keep the ordering identical. The bring-up checklist below uses the
  repo's own runner instead, so this is optional.

---

## 10. Bring-up checklist

From nothing to two browsers in a room-code match. Steps 1–8 are the "hand over the keys" path; a
step that is not yet implemented says which BUILD task delivers it.

1. **Create the Supabase project** (or run `supabase start` for local). Note the project URL, the
   publishable key and the secret key. Confirm Project Settings → Data API exposes `public` and
   `graphql_public` only.
2. **Enable email/password auth with confirmations.** Auth → Providers → Email: enabled,
   "Confirm email" on. Hosted: configure SMTP now. SPEC §9.4 makes a verified email a precondition of
   redemption, so this is not optional.
3. **Fill the server environment.** `cp apps/server/.env.example apps/server/.env` and set
   `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `DATABASE_URL`, `CODE_PEPPER` (`openssl rand -base64 48`),
   `PUBLIC_ORIGINS` and `CATALOG_VERSION`. Then `pnpm install`. Every `@jackioh/server` script runs
   under `--env-file-if-exists=.env`, so this file is read without a dotenv dependency; a variable
   set in the shell still overrides it, and a missing file is a warning rather than an error.
4. **Apply the migrations.** `pnpm --filter @jackioh/server db:migrate`, which applies
   `0001_profiles_and_invites.sql` → `0002_collection.sql` → `0003_loadouts.sql` →
   `0004_matches.sql` in order and records them in `app.migrations`. Expected result: 13 tables in
   `public`, all with RLS enabled, plus the private `app` schema.
5. **Verify the invariants before trusting anything.** `sh apps/server/test/sql/run.sh` runs all of
   §12's checks against a throwaway Docker Postgres, which is the fast way to confirm the migrations
   are intact before you point them at a real project. Against the project itself, in Studio's SQL
   editor:
   - `select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;` → **must return zero rows.**
   - `select indexdef from pg_indexes where indexname = 'loadout_card_unique';` → the unique index on
     `loadout_deck_cards (profile_id, card_id)`, which is L4 as a database invariant (§9.4).
   - `insert into public.collection …` as an `authenticated` user → must be refused. There is no
     policy, so there is no path (§9.4).
6. **Seed the catalog.** `pnpm --filter @jackioh/server db:seed-catalog`. Requires
   `packages/cards/catalog.json` (BUILD M4-T1). Check `select count(*) from public.cards;` → 109
   (100 cards + 9 tokens) and `select app.catalog_version();` → your `CATALOG_VERSION`.
7. **Mint an invite code.** `pnpm --filter @jackioh/server codes:mint`. It generates 16 characters
   from `CODE_ALPHABET`, formats them `XXXX-XXXX-XXXX-XXXX`, HMACs with `CODE_PEPPER` and inserts
   only the hash (§9.4). The plaintext goes to stdout **once** — the database cannot give it back —
   and the metadata to stderr, so `codes:mint > code.txt` captures the code alone. `--max-uses=N`
   (default 1, R161) and `--expires-in-days=N` (default never) are the options; for two accounts on
   one code, `--max-uses=2`. Check `select count(*) from public.invite_codes;` → 1.
   `src/db/mint-code.ts` validates the whole environment through `loadEnv()` rather than the two
   variables it reads, because a `CODE_PEPPER` that differs from the server's mints a well-formed
   code that nobody can ever redeem.
8. **Start the server and the client.** `pnpm --filter @jackioh/server dev` and
   `pnpm --filter @jackioh/web dev`. The server must print its resolved config and refuse to start
   with a missing env var.
9. **Sign up two accounts** (BUILD M6-T1). Each gets a `profiles` row at `pending` from the
   `auth.users` trigger. Verify both emails. Confirm a pending account gets 403 from
   `/api/collection`, `/api/loadouts` and `/api/queue`.
10. **Redeem a code on each** (BUILD M6-T1). `status` flips to `active`, the activation trigger fires
    the launch grant, and `select count(*) from public.collection;` shows every non-token card for
    both profiles (§9.1: "Everyone owns every card at launch; keep the ledger anyway"). Confirm the
    three failure kinds — missing, expired, exhausted — return the identical message.
11. **Save a legal loadout on each** (BUILD M6-T3). Three decks, 20 cards each, no card in two decks.
    Confirm `@jackioh/validator` names the rule on a failure, and that raw SQL putting one card in two
    decks is refused by `loadout_card_unique` even with the application check bypassed.
12. **Create a room** (BUILD M6-T4). `POST /api/rooms { slot }` → a 6-character code from
    `CODE_ALPHABET` (R79). A `matches` row appears at `status = 'open'` with the seed and p1's frozen
    deck.
13. **Join it from the second browser.** `POST /api/rooms/:code/join { slot }` → `app.join_room`
    claims the open row atomically, sets p2 and flips it to `live`.
14. **Play.** Both sockets connect with their JWTs, the actor calls `createGame` and `beginGame`, and
    each player gets their own `viewFor`. Every action appends one `match_actions` row and pushes two
    views. **This is the milestone: a working room-code match.**
15. **Prove the log is the truth.** Kill the server mid-match and restart it: both players reconnect
    to the same `viewFor`, rebuilt by folding `(seed, log)` (BUILD M6-T4 acceptance).
16. **Finish the match** and confirm one `results` row, both ratings moved by the Elo update
    (K = 32 from 1000, R79), both `profiles.current_match_id` cleared and both players queue-eligible
    again (BUILD M7-T2).

---

## 11. Decisions this document made that SPEC §9 does not state

All nine are now rulings in SPEC §11, **R104 to R112**. Each is cited by number at the point in the
source that implements it (`SPEC §11 Rnnn` in the SQL and in `config.ts`), so the comment is the
cross-reference between the code and the table. A choice that is local robustness rather than a rule —
an input-shape check, a `max_uses >= 1` constraint, a nullable `display_name` — is marked "no R-row"
instead, so an unnumbered marker never reads as an unrecorded gap.

| Row | Topic | Decision, and where it is implemented |
| --- | --- | --- |
| R104 | The code alphabet as a literal | `23456789ABCDEFGHJKLMNPQRSTUVWXYZ` — uppercase alphanumerics minus `0`, `1`, `I`, `O`. Exactly 32 symbols, so 16 characters are exactly 80 bits and a 6-character room code is 30 bits. SPEC's exclusion of lowercase `l` is satisfied by normalising input to upper case. This is the only 32-symbol set matching SPEC's exclusions: dropping `0`, `1`, `I`, `O` **and** `L` from the 36 alphanumerics leaves 31. |
| R105 | Catalog version format | A short opaque string stamped on every `public.cards` row and mirrored in `app.settings`; `core-1` for the Core set. SPEC requires a version and a rejection but never says what one looks like. |
| R106 | Circuit-breaker threshold and window | 100 system-wide failed redemptions in 600 seconds disables redemption and alerts. SPEC §9.4 requires "a threshold in a window" and names neither. |
| R107 | Constant-time failure floor | Every redemption response is padded to a fixed floor (250 ms) so the three failure kinds are indistinguishable in time. SPEC requires "identical time"; BUILD M6-T1 tests within 5 ms over 50 samples; SQL alone cannot deliver it. |
| R108 | Sweeper and reaper cadence | Matchmaker sweep every 3 seconds (SPEC §9.5 says "a sweeper every few seconds"); the reaper polls every 30 seconds against a 60-minute ceiling. |
| R109 | Rate limits for action flooding | Per-match actions per second and per-account API requests per minute. SPEC §9.8 requires both limits and names no numbers. |
| R110 | Room-code reuse | A room code is unique among matches that are not `over`, so codes are reusable once a match ends. SPEC says codes are 6 characters and nothing about their lifetime. |
| R111 | Launch grant quantity | One copy of every non-token card, which with `MAX_COPIES = 1` and 3 decks of 20 is exactly enough for a legal loadout, and keeps the ledger shape scarcity will need later. Granted by a trigger on the `pending → active` transition, idempotent by skipping cards that already carry a `launch` grant. |
| R112 | A match the reaper resolves, not the actor | `app.reap_stale_matches()` finishes a stuck match itself rather than flagging it for a server that may be the crashed component. The consequence: a ceiling draw resolved by the reaper records `turns = 0` (the turn counter lives only in the actor's in-memory `GameState`) and leaves both ratings unchanged, where a draw resolved by a live actor applies the real Elo update. SPEC §9.5 requires the reaper and says nothing about either value. |

---

## 12. Verifying the schema

The four migrations are not taken on faith. `sh apps/server/test/sql/run.sh` needs nothing but Docker:
it starts a throwaway Postgres, applies `apps/server/test/sql/00_supabase_stub.sql` (stand-ins for the
Supabase-managed pieces the migrations reference — the `anon`, `authenticated` and `service_role`
roles, `auth.users` and `auth.uid()`; a real project supplies all of it), applies the four migrations
in order, and then asserts:

| File | What it proves |
| --- | --- |
| `01_schema_invariants.sql` | 13 tables in `public`, **every one with RLS enabled**; `loadout_card_unique` is on `(profile_id, card_id)` and refuses a cross-deck duplicate inserted by raw SQL (BUILD M6-T3); no `SECURITY DEFINER` function in `public`; no non-SELECT policy and no INSERT/UPDATE/DELETE privilege for `anon` or `authenticated` anywhere; the `auth.users` trigger creates a `pending` profile; the six-step redemption returns `email_unverified`, and one identical `invalid_code` for both a missing and a revoked code; success flips the profile to `active` and the activation trigger grants every non-token card to both `collection` and `collection_grants`; `collection_grants` refuses an UPDATE; a stale catalog version raises `update required`. |
| `02_rls_as_client.sql` | Acting as the `authenticated` role inside a transaction (so `SET LOCAL` really takes effect): a profile sees exactly its own `profiles`, `collection`, `collection_grants`, `loadouts` and `loadout_deck_cards` rows and **zero** of the other profile's; `invite_codes`, `code_attempts`, `matches` and `match_actions` are refused outright; every client write — `collection` insert, `profiles` update, `loadout_deck_cards` insert — is refused, as are `app.redeem_invite_code` and `app.save_loadout`. This is §3's trust boundary, executed. |
| `03_match_lifecycle.sql` | `save_loadout` naming the rule it failed; `create_room` → `join_room` (own room refused, a live room refused a second joiner, both players marked in-match, the ceiling stamped on join); `append_match_action` assigning `seq` and returning the **original** seq for a replayed nonce without a second row (BUILD M6-T4); a server action with no author; `live_matches()` returning what a restarting server would fold; `end_match` writing one `results` row, moving both ratings, clearing both `current_match_id`, and staying idempotent on a second call; the room code reusable once the match is `over`; one queued ticket per profile; `claim_ticket_pair` returning true once and **false** to the second matcher (BUILD M7-T3's race test); the reaper turning a match past its ceiling into a `match-ceiling` draw and clearing both players. |

Each SPEC §11 row this schema implements is proved under a `### Rnnn: … ###` heading, which is how
REVIEW's B4 check and the §11 index find a row's evidence. **That heading form is the signal; a bare
mention in prose is not.** The six database-provable rows:

| Row | Heading | What it asserts |
| --- | --- | --- |
| R104 | `03` | Six malformed room codes (`I`, `O`, `0`, `1`, lower case, wrong length) each refused by the `matches.room_code` format check. |
| R105 | `03`, and `01` CHECK 15 | A stale catalog version is refused at save and at queue, with the message `update required`, from both `app.assert_catalog_version` and `app.save_loadout`. |
| R106 | `03` | An open breaker returns `circuit_open`, still logs the attempt, consumes no use and activates nobody; the untouched code redeems once the breaker closes. |
| R110 | `03` | A room code is reusable once its match is `over`. |
| R111 | `03` | A second launch grant leaves quantities at 1, adds no grant row and still owns no token. |
| R112 | `03` | The reaper's `results` row carries `turns = 0` and identical before/after ratings. |

**R107**, **R108** and **R109** are `config.ts` values with no database behaviour to assert, so they
get no heading; they are proved at the server level by BUILD M6-T1 (the 5 ms timing test), M7-T1 and
M7-T3. Those three ids appear in `03`'s header comment as explicit exclusions, so an id search that
keys on any occurrence rather than on the heading form would misread them as proved.

One finding worth keeping: `app.profile_is_active()` is `language plpgsql`, not `language sql`, because
a `language sql` body is parsed at creation time and it reads `public.profiles`, which the same
migration creates further down. The shared helpers stay together at the top of 0001 where the other
migrations look for them, and plpgsql defers the name resolution.

A second: `authenticated` holds `USAGE` on schema `app` and `EXECUTE` on exactly two helpers,
`app.current_profile_id()` and `app.profile_is_active()`. That is not a loosening — an RLS policy
expression is evaluated with the querying role's privileges, so without it every own-row read fails
with "permission denied for schema app". Schema `USAGE` conveys nothing by itself, the Data API does
not expose `app`, and `02_rls_as_client.sql` asserts that the privileged functions stay unreachable.

## 13. File map

Files this milestone owns. "M6-T*/M7-T*" marks what is designed here and delivered by that task.

```
apps/server/
  package.json                     deps and scripts
  tsconfig.json                    types: ["node"] — the server is the impure half
  vitest.config.ts                 the "server" vitest project
  .env.example                     the server-only half of §8
  src/
    config.ts                      R79's values and the code alphabet, as named exports (BUILD §2)
    env.ts                         typed loader, fails fast naming every missing variable
    db/
      migrate.ts                   applies migrations/*.sql in order, ledger in app.migrations
      seed-catalog.ts              packages/cards/catalog.json -> public.cards
      mint-code.ts                 `codes:mint`: one invite code, plaintext to stdout once
      migrations/
        0001_profiles_and_invites.sql   app schema, profiles, invite_codes, code_attempts,
                                        app.redeem_invite_code (the six steps of §9.4)
        0002_collection.sql             cards, collection, collection_grants, app.grant_cards,
                                        the launch grant on activation
        0003_loadouts.sql               loadouts, loadout_decks, loadout_deck_cards,
                                        loadout_card_unique (L4), app.save_loadout
        0004_matches.sql                tickets, matches, match_actions, results,
                                        app.join_room, app.claim_ticket_pair, app.end_match
    api/       codes.ts collection.ts loadouts.ts queue.ts results.ts      M6-T1..T3, M7-T2, M7-T3
    match/     actor.ts protocol.ts                                        M6-T4, M7-T1
    auth/      jwt.ts (JWKS verification, seat resolution)                 M6-T1
  test/
    sql/run.sh                     Docker-only schema validation (§12)
    sql/00_supabase_stub.sql       stand-in for auth.users, auth.uid(), the three roles
    sql/01_schema_invariants.sql   RLS everywhere, the L4 index, the redemption steps
    sql/02_rls_as_client.sql       the trust boundary, executed as `authenticated`
    sql/03_match_lifecycle.sql     room code -> log -> result -> reaper
docs/
  architecture.md                  this file
```
