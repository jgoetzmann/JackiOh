# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# JackiOh — project instructions for Claude Code

JackiOh is a 1v1 card game: Hearthstone-style mana, combat and keywords on Yu-Gi-Oh-style lanes with a hidden trap backrow. Three documents drive all work:

- `SPEC.md` — the master game specification. The only source of rules, cards and engine design. Section references (§) everywhere point here.
- `BUILD.md` — the work order: repo layout, constants, milestones M1–M8 with tasks, files and acceptance criteria, the per-card must-pass table, animations, e2e specs, definition of done.
- `REVIEW.md` — the audit procedure: Part A checks SPEC.md against the source design notes; Part B checks the code against SPEC.md and BUILD.md.

Supporting docs: `docs/architecture.md` (server deployment: Supabase, match actor, R104–R112), and the READMEs in `packages/cards`, `apps/server`, `apps/web` and `e2e`, which set the contracts inside each package. `JackiOh_Mechanics.md`, `JackiOh_Core_Cards.md` and `ARCHITECTURE-CCG.md` (the generic trust model and match-actor design that SPEC §9 and `docs/architecture.md` build on) are the source design notes that REVIEW Part A checks SPEC against. `JackiOh_Tokens.md` holds the source text for the tokens (SPEC §7). Past audit reports are in `reviews/`. If a doc disagrees with SPEC.md, SPEC wins and the doc is the bug.

## Rules of engagement

1. Read SPEC.md fully before the first task and re-read the relevant section before each task. Never implement a rule from memory of Hearthstone or Yu-Gi-Oh when SPEC.md states it.
2. Work BUILD.md in order. A task is done when its acceptance items are green tests. Do not open the next milestone until the current gate passes.
3. Rulings live in SPEC §11. If you need a decision the spec does not make, follow Hearthstone semantics, append a new R-row to SPEC §11 in the same PR, and name the proving test after it (`it("R58 …")`). The proof can live in any package. Then add the row to the index `packages/engine/test/rulings.test.ts`, which has one `it("R<n> …")` per §11 row, in order, pointing at the proof with `provenIn(n, file)`; its completeness test fails without that entry. Use the next free number. `pnpm rulings:coverage` fails on three things: a row with no test, a test naming a row that doesn't exist, or an `R<n>` cited anywhere in `packages/` or `apps/` (comments included) that §11 doesn't have.
4. `packages/engine` and `packages/cards` are pure: no `Math.random`, no `Date`, no I/O, no promises inside `reduce`. Every random draw goes through `rng` in state; every player choice is a `PendingChoice` in state. ESLint enforces this (it also bans timers, `fetch`, `process`, `crypto`, `node:*` imports and async functions in those packages); tooling that needs `fs` goes in a package's `scripts/`, never in `src/`.
5. Card scripts return `Effect[]` from `packages/engine/src/effects`. Never mutate state in a card file.
6. Every card has one script file and one test file covering base and radiant behaviour per the BUILD M4-T4 table.
7. The client sends intent and renders `viewFor`; it never enforces rules and never sees hidden information.
8. Before claiming a milestone is done, run the paste-in prompt at the end of REVIEW.md as a separate session and attach the report.
9. Every number is a named constant: rules numbers in `packages/engine/src/config.ts` (BUILD §2; the "decide" rulings R1, R2, R4, R5, R14, R26, R39 included), server numbers such as clocks, Elo and rate limits in `apps/server/src/config.ts`. Nothing else states a number.

Code comments cite these rules by number ("CLAUDE.md rule 7"), so add new rules at the end and never renumber.

## Commands

Node ≥ 22.13 (`.nvmrc`: 24.19.0), pnpm 11.

```
pnpm install
pnpm lint              # includes the Math.random / Date ban in engine and cards
pnpm typecheck         # regenerates the cards registry first, then tsc for every project
pnpm test              # vitest projects: shared, engine, cards, validator, server, web (fuzz at seeds 1–100)
pnpm test:coverage     # 90% line floor, engine + cards
pnpm fuzz              # the CI gate: seeds 1–1000 of random-policy games with replay hashing, ~100 s
pnpm validate:catalog  # catalog.json data checks (100 cards, 9 tokens, rarity counts)
pnpm rulings:coverage  # SPEC §11 rows vs named tests vs R-ids cited in code (rule 3)
pnpm --filter @jackioh/cards missing-tests   # catalog ids with no test file, and the path each one expects
pnpm test:sql          # schema, RLS and trigger invariants: Docker only, starts a throwaway postgres:16
pnpm test:db           # src/db/store.ts against a throwaway postgres:16 (Docker only; KEEP_DB=1 keeps it)
```

Replay one failing fuzz seed: `JACKIOH_FUZZ_FROM=<seed> JACKIOH_FUZZ_SEEDS=1 pnpm fuzz`.

Server against a real Supabase project (copy `apps/server/.env.example` to `.env` first; the client's half is `apps/web/.env.example`): `pnpm --filter @jackioh/server db:migrate`, then `db:seed-catalog`, then `codes:mint` for an invite code (or `db:seed-accounts` for active test accounts that skip the invite gate; it refuses under `NODE_ENV=production`), then `dev`.

Running a subset:

```
pnpm vitest run --project engine                       # one project
pnpm vitest run packages/cards/test/002-bigot.test.ts  # one file
pnpm vitest run --project cards -t "R58"               # by test name
```

E2E (Cypress). The root `pnpm install` covers `e2e/`, as CI relies on. `e2e/` also carries its own `pnpm-workspace.yaml` and lockfile, so `cd e2e && pnpm install` works on its own too.

```
E2E=1 pnpm --dir apps/web dev       # http://localhost:5173, serves /dev/hotseat
E2E=1 pnpm --dir apps/server dev    # :8787 + /ws/match; needed for networked specs 05, 06, 07, 09, 10, 13
cd e2e && pnpm exec cypress run --spec cypress/e2e/01-hotseat-full-game.cy.ts
pnpm --dir e2e test:component       # component/pixel specs, no server needed
```

The server reseeds fixture accounts and invite codes at boot (R144). Spec 10 uses them up, so restart the server before re-running it. `vite dev` reloads the page mid-run whenever `apps/web/src` changes, which restarts a hotseat game at turn 0. If you're editing while specs run, serve a built client the way CI does: `pnpm build:e2e`, then `pnpm --dir apps/web exec vite preview --port 5173 --strictPort` (a plain `build` strips `window.__jackioh`, and every spec fails). `99-online-smoke.cy.ts` drives the deployed stack with real accounts. It is skipped unless enabled, and its header gives the command.

CI (`.github/workflows/ci.yml`) runs four parallel jobs:
- `checks`: lint, typecheck, validate:catalog, missing-tests, rulings:coverage, test, fuzz, test:coverage, in that order.
- `sql`: `test:sql`.
- `db`: `test:db`.
- `e2e`: the specs on Chrome and on Electron, plus the component spec on Chrome.

## Architecture

Workspace packages, from pure to impure:

- `packages/shared` holds the types every layer shares: `Action`, `GameEvent`, `PlayerId`, and the event list in `events.ts`.
- `packages/engine` is the rules. Its entry points are `reduce(state, action, rng)`, `legalActions` and `viewFor(state, playerId)`. `reduce` clones state, applies the action and returns new state plus events. An illegal action comes back as an error with the state unchanged. Each rule has one owning module (`combat.ts`, `playSteps.ts`, `turn.ts`, `traps.ts`, `layers.ts`, `subsystems/*`, …), and `legalActions` and the reducer's refusals call the same function, so the two can't disagree. `reduce.ts`'s header maps each action to its owning module.
- The resolution loop (`triggers.settle`, SPEC §10.3) runs after every action. It dispatches events, drains `state.work`, runs the state check (`stateCheck.ts`) and pops the trigger queue until everything is empty or a prompt stops it.
- Prompts end the action (`state.pending`). Any sequence that can pause mid-way parks its remainder on `state.work` (`work.ts`) as plain-data `Resume` records, never closures. That lets a paused state survive `JSON.parse(JSON.stringify(...))` and replay exactly. Resume order follows R113 (a cursor, not a queue or a stack). Read `work.ts`'s header before touching anything that can open a prompt.
- `replay.ts` folds an action log back into state. The fuzz suite and e2e check replay hashes against it.
- The engine doesn't depend on `packages/cards`. An engine test that needs a card's behaviour uses a test-only script in `packages/engine/test/fixtures/`, and the real card's test covers the same case again.
- `packages/cards` holds `catalog.json` (the card data, proved against SPEC §8) and `src/scripts/NNN-slug.ts`, one per card: `{ def, base, radiant }`. `def` always comes from `cardDef("core-NNN")` and is never retyped. A script writes through `@jackioh/engine/effects` and reads state only through the read helpers `@jackioh/engine` exports (`heroOf`, `zoneCards`, `activeUnitsOf`, …, listed in the cards README), never `state.players[…]`. If a verb or fact is missing, add it to the engine (new board facts go in `packages/engine/src/query.ts`) and test it there. `src/scripts/_generated.ts` is generated by `pnpm --filter @jackioh/cards gen`, which typecheck and the test globalSetup also run, so never edit it by hand. Card tests live at `test/NNN-slug.test.ts` and must build games through `test/_harness.ts`'s `scenario()`. Every random pool goes through `query.ts`. The package README is the card-file contract.
- `packages/validator` checks loadouts (SPEC §9.4: 3 decks with no card shared between them, and only owned cards).
- `apps/server` is one Node process that runs both the HTTP API (`src/api`) and one in-memory match actor per match (`src/match`), which pushes `viewFor` to each player over a WebSocket. Handlers and the actor depend only on ports (`src/api/ports.ts`, `src/match/contracts.ts`). `src/db/**` implements the `Store` port against Supabase Postgres. Vitest runs against an in-memory fake store, so RLS and triggers are only checked by `test:sql`/`test:db`. `test/db/contract.ts` is one suite run against both stores, the fake in `pnpm test` and Postgres in `test:db`, so a change to the `Store` port goes there. The engine is reached only through `src/match/engine.ts`, whose dynamic import of `engine.real.ts` is deliberate (its header says why). The wire protocol is fixed in `src/match/protocol.ts`. Env is parsed in `src/env.ts` (`E2E` must never be set together with `NODE_ENV=production`).
- `apps/web` is a Vite/React client. Components take a `PlayerView` and nothing else. The engine is reached only through `src/game/engine.ts`, where `EngineState` is opaque, and legality comes from `legalActions`, never a client-side check. `/dev/hotseat` runs the engine locally and exposes `window.__jackioh` only in non-production builds, which is why `build:e2e` exists. Online play uses Supabase Auth directly and sends the token to the server.

Deployment: `apps/web` is a static bundle on Vercel (`vercel.json`), and `apps/server` runs on Render (`render.yaml`). Render's free tier sleeps when idle, and a match survives the restart by folding `(seed, log)`. Postgres and Auth are on Supabase. `docs/architecture.md` has the bring-up checklist and the env-var contract.

## Parallel work

`scripts/worktree.sh <name> [base-ref]` creates a git worktree at `../jackioh-wt/<name>` on branch `wt/<name>` with dependencies linked, so each worktree tests only its own changes. It suits isolated work like card scripts. Don't use it for shared surfaces (SPEC §11 numbering, `packages/shared/src/events.ts`, `script.ts`, `state.ts`, the effects barrel): parallel edits to those conflict on merge.
