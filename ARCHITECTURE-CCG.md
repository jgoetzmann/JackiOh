# Architecture — Collectible 1v1 Card Game

Players own a collection, build decks from it, queue into ranked 1v1, and play turn-based matches against strangers. Accounts are gated behind an invite code, and a player's three decks may not share any card.

Architecture only. Game rules, card design and economy are elsewhere.

---

## 1. Trust model

Three kinds of data, three trust levels. Conflating any two is how games of this shape get exploited.

| Domain | Truth lives | Client may | If you get it wrong |
|---|---|---|---|
| **Identity & entitlement** — who you are, what you own | Server | Read a projection | Players grant themselves cards |
| **Loadout** — the decks you bring | Server validates and stores; client composes | Propose | Players field illegal or unowned decks |
| **Match** — the game in progress | Server | Read a filtered view, submit actions | Players read deck order and the opponent's hand |

One rule covers all three: **the client sends intent, never state.** "Save this loadout", "play the card at index 2". Never "my deck contains these 30 cards", never "I now own a Legendary."

---

## 2. The match runs on the server

Three things make client-side rules impossible here:

- **Deck order is secret and is the game.** A client holding the shuffled library knows every draw. There is no mitigation — the data either is or isn't on their machine.
- **The opponent's hand is secret.** Same.
- **Legality must be enforced somewhere trustworthy.** A client-side check is a suggestion.

So the engine runs server-side and each client receives only `viewFor(state, playerId)`: their own hand, the public board, and *counts* for everything hidden. The opponent's hand is a number. Your own library is a number.

This costs latency and money versus a peer-to-peer design. That's the price of competitive play.

### 2.1 Turn timers force a stateful runtime

A competitive card game needs a server-enforced clock, or players stall indefinitely. **A stateless function cannot run a timer** — it only reacts to requests, and "the opponent never sends one" is exactly the case you must handle.

| Option | Verdict |
|---|---|
| **Stateful actor per match** (Durable Objects or equivalent) | **Take this.** One actor per match holding state in memory, a WebSocket per player, an alarm for the clock. Single-threaded, so action ordering is free — no locks, no compare-and-set. Idle actors hibernate, so cost tracks live matches. |
| Stateless functions + external state + scheduler | Every action pays two storage round trips, and the clock needs a separate scheduled job. Workable, meaningfully more code. |
| Long-running server process | Simple to reason about, but you're operating a server. Fine if you already are. |

A match is naturally an actor: identity, lifetime, exclusive state, a clock. Fighting that costs you a concurrency layer and a scheduler you'd otherwise never write.

### 2.2 Keep an action log anyway

Even server-authoritative, model the match as an ordered append-only log folded by `reduce(state, action, rng)`. The server is the only thing that folds it, but the log gives you:

- **Replay for disputes.** `(seed, log)` reconstructs any match exactly.
- **Crash recovery.** An actor that dies rebuilds rather than losing the game.
- **Balance telemetry.** Card win-rates, mulligan data, curve analysis — all derived offline, no extra instrumentation.

Append each action as it resolves; don't persist snapshots. Periodic snapshots are an optimisation for later if replay gets slow.

### 2.3 Engine requirements

- **`reduce(state, action, rng)` is pure.** No I/O, no framework, no clock reads. Time-dependent rules take the timestamp as action data.
- **Seeded RNG only.** Ban `Math.random()` by lint rule. Without it, replay is impossible and so is dispute resolution.
- **Mid-action choices are state, not callbacks.** "Discard one" sets `state.pending = { player, options }` and returns. The answer arrives as another action. This is what makes prompts identical in live play, replays and tests.
- **Every action carries a client nonce**, deduped server-side, so an unsure client can retry safely.
- **`reduce` refuses illegal actions itself.** Client-side checks grey out buttons; they are never enforcement.

### 2.4 Reconnect

Disconnection is normal — mobile, tab close, lid. State survives in the actor; on reconnect the client authenticates, asks "am I in a match?", and gets a **fresh full view**, not a log replay.

The clock keeps running throughout, or disconnecting becomes a stalling tactic. Set a disconnect grace period after which the absent player concedes, stored on the match so both clients show the same countdown.

---

## 3. Accounts and the invite gate

Use a managed auth provider for email and password. You get hashing, resets, verification, session rotation and breach response, each of which is a way to get this badly wrong. You own a `profiles` row keyed by its user ID.

### 3.1 Gate entitlement, not signup

Let anyone sign up; gate everything that matters.

```
profiles.status ∈ { 'pending', 'active', 'banned' }
```

A `pending` account can log in, verify email, and see the code screen. It cannot own a collection, save a loadout, queue, or play. Redeeming flips it to `active`.

This beats intercepting signup for three reasons:

- The auth provider keeps owning signup, so you don't fork its flow or lose its abuse protections.
- Code checks land on an **authenticated** endpoint, giving you per-account rate limits. Per-IP alone is trivially defeated.
- **Email verification can be required before redemption**, so every brute-force attempt costs an inbox. This constrains attackers more than any rate limit.

### 3.2 Codes

```sql
create table invite_codes (
  id         uuid primary key default gen_random_uuid(),
  code_hash  text not null unique,      -- never the plaintext
  label      text,                       -- 'discord wave 2'
  max_uses   int  not null default 1,
  uses       int  not null default 0,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create table code_attempts (
  id         bigserial primary key,
  profile_id uuid references profiles(id),
  ip_hash    text not null,              -- hashed with a server-side pepper
  succeeded  boolean not null,
  at         timestamptz not null default now()
);
create index code_attempts_recent on code_attempts (profile_id, at desc);
create index code_attempts_ip     on code_attempts (ip_hash, at desc);
```

At least 80 bits of entropy — 16 characters from an unambiguous 32-character alphabet, no `0/O` or `1/I/l`, formatted `XXXX-XXXX-XXXX-XXXX`. A memorable code is brute-forceable in seconds.

Redemption, one server-side transaction:

```
1. reject unless status = 'pending' and email verified
2. reject if this profile's attempts in the last hour  > 5
3. reject if this ip_hash's attempts in the last hour  > 20
4. log the attempt either way
5. look up by hash; reject if revoked, expired, or exhausted
6. increment uses and set status = 'active', atomically
```

Rate-limit before the lookup, so a flood is cheap to reject. Return an **identical error in identical time** for "no such code", "expired" and "exhausted" — distinguishing them tells an attacker when they've found a real one.

Add a global circuit breaker: if system-wide failed redemptions cross a threshold in a window, disable redemption and alert. An attempt distributed across thousands of IPs defeats per-IP limits but not this.

### 3.3 Trusted devices (optional)

On successful redemption, issue a long-lived signed device token stored client-side, so a returning player skips the code screen after a reinstall.

It identifies a device; `profiles.status` authorises the account. Revoking an account must never require hunting down tokens.

---

## 4. Collection

An entitlement ledger, server-owned without exception.

```sql
create table cards (                 -- static catalog, versioned, shipped with the client
  id text primary key, set_id text, rarity text, ...
);

create table collection (
  profile_id uuid references profiles(id),
  card_id    text references cards(id),
  quantity   int not null check (quantity >= 0),
  primary key (profile_id, card_id)
);

create table collection_grants (     -- append-only audit of every change
  id bigserial primary key,
  profile_id uuid, card_id text, delta int,
  reason text,                       -- 'pack' | 'craft' | 'reward' | 'refund' | 'admin'
  ref    text,                       -- pack id, order id
  at timestamptz not null default now()
);
```

Every mutation writes both tables in one transaction. No client path writes `collection` — not via a permissive row-level-security policy, not via an endpoint that trusts a header. The grants table lets you reconstruct how someone came to own something, which you will want the first time a duplication bug ships.

**The card catalog is static data shipped with the client** — names, costs, art, rules text. Only *ownership* is server-side, so the deck builder is fast and a collection read is a short list of `(card_id, quantity)`.

**Version the catalog.** The client sends its version with every loadout save and queue request; a stale one is rejected with "update required". Otherwise a player on an old build fields a card whose cost has changed.

> If every account owns every card, keep this schema and treat ownership as maximum copies of everything. Validation below is then trivially satisfied, and scarcity can arrive later without a migration.

---

## 5. Loadouts: three decks, no shared cards

### 5.1 The loadout is the unit of persistence, not the deck

A player has one loadout of exactly three decks, and no card may appear in more than one of them.

Because editing Deck 2 can invalidate Deck 1, two individually-legal writes can produce an illegal state. So:

- The builder loads **the whole loadout and the whole collection**, and edits all three decks together.
- Saving writes **all three decks in one transaction**, validated as a unit.
- There is no "save deck" endpoint — only `saveLoadout(profileId, catalogVersion, decks[3])`, which wholly succeeds or wholly fails.

### 5.2 The rules

| | Rule |
|---|---|
| **L1** | Exactly 3 decks |
| **L2** | Exactly `DECK_SIZE` cards per deck |
| **L3** | At most `MAX_COPIES` of a card per deck, with rarity overrides (1 for Legendary) |
| **L4** | **A card id appears in at most one deck of the loadout** |
| **L5** | Copies used across the loadout ≤ quantity owned |
| **L6** | Every card exists in the current catalog version and is not banned |

L4 makes L5 nearly redundant — nearly, because with `MAX_COPIES > 1` one deck can still exceed what you own. Keep both; they're cheap and they fail differently, which matters for error messages.

`DECK_SIZE` and `MAX_COPIES` are config. You will change them.

### 5.3 Validate at save and again at queue

The collection is mutable and the catalog moves. Between saving a loadout and queueing with it, a card may have been disenchanted or banned — a loadout legal on Tuesday can be illegal on Wednesday through no action of the player's.

Queue-time rejection needs a specific message (*"Deck 2 contains a card you no longer own"*), or players assume the game is broken.

### 5.4 Freeze decks at queue time

Snapshot the resolved decks into the queue ticket and carry that into the match. Do not resolve from the database at match start.

Without this, a player can queue, edit their loadout while waiting, and enter with cards chosen after matchmaking. It also makes matches reproducible: log plus frozen decklist is a complete record.

### 5.5 Schema

```sql
create table loadouts (
  profile_id      uuid primary key references profiles(id),
  catalog_version text not null,
  updated_at      timestamptz not null default now()
);

create table loadout_decks (
  profile_id uuid references profiles(id),
  slot       int  not null check (slot between 1 and 3),
  name       text not null,
  primary key (profile_id, slot)
);

create table loadout_deck_cards (
  profile_id uuid,
  slot       int,
  card_id    text references cards(id),
  count      int not null check (count > 0),
  primary key (profile_id, slot, card_id),
  foreign key (profile_id, slot) references loadout_decks(profile_id, slot) on delete cascade
);

-- L4 as a database invariant, not just application logic.
create unique index loadout_card_unique
  on loadout_deck_cards (profile_id, card_id);
```

That index means no future migration, admin tool or import feature can violate disjointness even by accident. Application validation supplies the good error message; the index guarantees the property.

### 5.6 Shared validator

Client-side validation mirrors L1–L6 for instant feedback; the server re-runs all of it. **Ship one validator module used by both.** Two implementations of the same six rules will diverge, and the symptom is "it let me save this but won't let me queue".

---

## 6. Matchmaking

```
enqueue(profileId, slot):
  1. assert status = 'active'
  2. assert no active match
  3. validate loadout; resolve deck `slot` to a frozen list
  4. insert ticket { profile, rating, frozen_deck, enqueued_at }
  5. return ticket id; client subscribes

pair(ticketA, ticketB):
  6. create match, spawn actor, seed with both frozen decks
  7. claim both tickets atomically; push match id to both clients
```

**Opportunistic on enqueue, plus a sweeper** every few seconds for leftovers and window widening.

**Widen over time:** start at ±100 rating, widen ±50 every 10 s, uncapped after 60.

**Claim both tickets in one atomic statement**, or two matchers pair the same player into two matches.

### 6.1 Plan for a tiny population

An invite-gated game will not have a healthy anonymous queue for a long time. Your concurrent pool may be single digits at 3am.

- **Ship direct challenge links alongside the queue.** Room-code challenge is likely the primary mode for months, and it's far simpler.
- **Show queue population** instead of an infinite spinner.
- A scheduled play window — everyone queues at the same hour — beats any algorithm at this scale.

### 6.2 Abandonment

Timeouts, disconnects and concedes must resolve the match, record a result, and clear both players' "in a match" state. The recurring bug is a crashed actor leaving two players permanently unable to queue. Give matches a hard wall-clock ceiling and run a reaper over anything past it.

---

## 7. Topology

```
Browser ──────── static client (CDN)
   │
   ├── HTTPS ──► Auth provider        sessions, email/password
   │
   ├── HTTPS ──► API functions        codes, collection, loadouts, queue
   │                  │
   │                  └──► Postgres   profiles, collection, loadouts, tickets, results
   │
   └── WSS ────► Match actor          engine, clock, views — one per live match
                      │
                      └──► Postgres   action log, final result
```

The match actor is the only component that must hold memory and run a clock. Everything else is stateless request/response or managed service.

---

## 8. Abuse surface

| Vector | Mitigation |
|---|---|
| Claiming unowned cards | Collection server-owned; loadouts validated against it |
| Deck swapped after matchmaking | Decks frozen into the ticket (§5.4) |
| Illegal actions | `reduce` rejects; client check is UX only |
| Reading deck order or opponent hand | Never sent — `viewFor` emits counts |
| Stalling for a timeout win | Server clock, disconnect grace, hard match ceiling |
| Action flooding | Per-match limit in the actor, per-account limit at the API |
| Code brute force | High entropy, hashed, per-account + per-IP limits, verified email, circuit breaker |
| Multi-accounting to farm rating | Invite codes are the main control; watch IP-hash clustering |

Two habits catch most of the rest: **log every rejected action with its reason**, and **alert on accounts with anomalous rejection rates**. Repeated server-side rejections mean a broken build or someone probing — both worth knowing.

---

## 9. Build order

| Step | Scope |
|---|---|
| 1 | Pure seeded `reduce`, local two-hand hotseat. No network, no accounts. |
| 2 | Auth, profiles, invite gate. A `pending` account that logs in and redeems. |
| 3 | Collection ledger and read API. Grant everything to everyone initially. |
| 4 | Loadout builder + shared validator (L1–L6), with the unique index in place. |
| 5 | Match actor: state, WebSocket, `viewFor`, action log. **Direct challenge by room code.** |
| 6 | Turn clock, disconnect grace, concede, result recording. |
| 7 | Matchmaking queue with frozen decks, rating, widening. |
| 8 | Economy: packs, crafting, rewards — all through `collection_grants`. |

**Step 5 before step 7 is deliberate.** Direct challenge gets a playable networked game weeks earlier, exercises the entire match runtime, and is what testers will actually use given §6.1. Matchmaking is a queue on top of a working match.

**Steps 1 and 4 are load-bearing.** A pure seeded reducer and one shared loadout validator make everything after them straightforward; compromise on either and you pay for it in every later step.

---

## 10. Out of scope

- **Spectating, tournaments, player-facing replays.** The action log makes all three cheap later.
- **Anti-cheat beyond server authority.** Behavioural detection and client attestation are large efforts with poor returns at this scale.
- **Economy design.** The ledger supports any of it; which cards cost what is a game-design question.
