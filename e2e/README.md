# `e2e/` — the twelve BUILD M8 specs

Cypress runs against `apps/web` in `E2E=1` mode: the `/dev/hotseat` route for the local specs and
a test server with fixture accounts for the networked ones. BUILD M8's house rules hold
everywhere in here:

- every spec sets a seed;
- there is no fixed `cy.wait(ms)` — `support/e2e.ts` throws if a spec calls one. Waits are
  assertions: `data-animating` clearing (`cy.settled()`), an animation appearing
  (`cy.expectAnimating`), a prompt (`cy.waitForPrompt`), or a testid;
- each spec asserts what BUILD's "Key assertions" column says for its row, quoted verbatim in the
  spec's header comment.

## Layout

```
e2e/
  cypress.config.ts        specPattern cypress/e2e, fixturesFolder fixtures, supportFile support/e2e.ts
  cypress/e2e/*.cy.ts      the twelve specs
  fixtures/decks/*.json    scenario decks, named for the spec that uses them
  support/
    commands.ts            seedGame, playCard, attack, answerPrompt, endTurn (+ the waiting helpers)
    testids.ts             every selector the suite uses, in one file
    config.ts              routes, endpoints, fixture accounts, timeouts, SPEC constants
    cards.ts               SPEC §8 index -> name -> `core-NNN` catalog id
    types.ts               structural subsets of the engine types; `window.__jackioh`
    e2e.ts                 support file; enforces the no-fixed-wait rule
    tasks/
      index.ts             registers the node tasks
      wsPlayer.ts          `cy.task("wsPlayer")`: the second player, driven from Node (spec 06)
      replay.ts            `cy.task("replayHash")`: fold the recorded log outside the browser
      replay-runner.ts     runs under the repo's tsx; the only file here that imports packages/*
  scripts/check-fixtures.mjs  pre-flight for the deck fixtures; needs no browser and no client
  artifacts/               recorded logs, screenshots, videos (git-ignored)
```

`e2e/` is its own pnpm root (`e2e/pnpm-workspace.yaml`): the root workspace globs only
`packages/*` and `apps/*`, and nothing outside this directory should have to carry Cypress.
`e2e/tsconfig.json` type-checks without `packages/*` or `apps/*` being buildable, on purpose —
M8 is written before the client and server are finished.

## Install

```
pnpm install            # repo root: provides tsx, which the replayHash task uses
cd e2e && pnpm install  # Cypress + ws; the postinstall fetches the Cypress binary
pnpm exec cypress verify
pnpm exec tsc -p tsconfig.json
pnpm check:fixtures     # every deck fixture obeys L2/L3/L6 before a browser is involved
```

## Run

```
# 1. the client, in E2E mode
E2E=1 pnpm --dir apps/web dev                  # must serve http://localhost:5173

# 2. the server, in E2E mode, for specs 05, 06, 07(networked path), 09, 10
E2E=1 pnpm --dir apps/server dev               # must serve http://localhost:8787 and ws://…/match

# 3. the suite
cd e2e
pnpm test:e2e                                  # headless, default browser
pnpm test:e2e:chrome                           # M8 gate: Chrome
pnpm test:e2e:electron                         # M8 gate: Electron
pnpm open                                      # interactive
pnpm exec cypress run --spec cypress/e2e/01-hotseat-full-game.cy.ts
```

Endpoints are overridable, so nothing in a spec has to change when a port moves:

```
E2E_BASE_URL=http://localhost:4173 pnpm test:e2e
pnpm test:e2e --expose wsUrl=ws://127.0.0.1:8787/match --expose apiUrl=http://127.0.0.1:8787
```

`support/config.ts` lists every overridable key (`loginRoute`, `inviteRoute`, `deckbuilderRoute`,
`playRoute`, `matchRoute`, `apiUrl`, `wsUrl`, the fixture accounts and the invite codes). Cypress
16 replaced `Cypress.env()` with `expose` / `Cypress.expose()`, which is why the flag is
`--expose`.

## What must be true of the app first

The suite is written against the contract BUILD M5-T1 and M5-T4 fix. Until these hold, specs fail
for contract reasons rather than rules reasons.

1. **Testids.** `zone-<side>-<row>-<lane>`, `card-<instanceId>`, `hero-<side>`,
   `hand-card-<instanceId>`, `end-turn`, `offer-draw`, `power`.
2. **`data-animating="<eventType>"`** on the element animating an event, for that event's
   duration, with `prefers-reduced-motion` collapsing durations to 0 (BUILD M5-T4).
3. **`data-prompt-kind="<kind>"`** on the open prompt modal or inline picker (M5-T4
   `promptOpened` / `promptAnswered`).
4. **`/dev/hotseat?seed=&a=&b=`** exposing `window.__jackioh = { state, dispatch, seed }` outside
   production builds (M5-T3).
5. **`E2E=1`** serving the hotseat route and a test server with fixture accounts (M8 preamble).

## Assumptions beyond that contract

Every one of these is either an ask on another team or a convention this suite invented because
BUILD does not fix it. They are all made in `support/`, never in a spec, so each has exactly one
place to change.

| # | Assumption | Where | Ask |
| --- | --- | --- | --- |
| A1 | In E2E mode the hotseat route resolves `a=`/`b=` from `window.__jackiohE2E = { seed, decks }` (also mirrored into `localStorage["jackioh.e2e.decks"]`, so a reload keeps it) before falling back to built-in dev decks. `seedGame` injects it in `onBeforeLoad`. | `support/commands.ts`, `support/types.ts` | `apps/web` |
| A2 | `window.__jackioh` also carries `log: Action[]` (every action reduced, in order, with its nonce) and `decks: [string[], string[]]`. Only spec 01 needs them: they are the "recorded actions" BUILD M8 folds for the replay hash. | `support/types.ts`, `cy.replayCheck` | `apps/web` |
| A3 | `<side>` in `zone-<side>-…` and `hero-<side>` is view-relative, `you` \| `opponent`, matching `PlayerView.you` / `.opponent`. Lanes are 1..5, as `packages/engine/src/zones.ts` numbers them (not an assumption — the engine fixes it). | `support/testids.ts` | `apps/web` |
| A4 | Prompt internals: one option per `PendingOption.key` at `prompt-option-<key>`, a `prompt-submit` confirm button for multi-select kinds, and `prompt-x` for the numeric input of `x`/`embiggen`. `answerPrompt` prefers these and falls back to the board testids for pickers M5-T2 renders on the board (target, zone, tribute). | `support/testids.ts`, `support/commands.ts` | `apps/web` |
| A5 | Chrome not in BUILD's list: `result-overlay`, `turn-banner`, `seat-switch`, `graveyard-count-<side>`, `exile-count-<side>`, `library-count-<side>`, `hand-count-<side>`, `mana-<side>` + `.mana-crystal`, `switch-<instanceId>`, and `data-legal="true|false"` for the highlighting M5-T2 describes. (`.damage-pop`, `.heal-pop`, `.loss-pop`, `.radiant`, `data-locked` are BUILD M5-T4's own.) | `support/testids.ts` | `apps/web` |
| A6 | Routes and fixtures for the non-hotseat specs: `/login`, `/invite`, `/decks`, `/play`, `/match/<id>`; `http://localhost:8787` + `ws://localhost:8787/match`; fixture accounts `e2e-p1`, `e2e-p2` (active, own every card) and `e2e-pending` (pending, verified email); seeded invite codes — one good, one missing, one expired, one exhausted. | `support/config.ts` | `apps/web`, `apps/server` |
| A7 | Catalog ids are `core-` + SPEC §8 index zero-padded to three digits. Confirmed against `packages/cards/catalog.json`, so this is documentation rather than an assumption. | `support/cards.ts` | — |
| A8 | The WS protocol `cy.task("wsPlayer")` speaks: `-> hello {token,matchId?,roomCode?}`, `-> joinRoom {token,roomCode}`, `-> action {action}`; `<- view {view}`, `<- ack {nonce}`, `<- error {error}`, `<- prompt`, `<- clock`. BUILD M6-T4 fixes only the message names. | `support/tasks/wsPlayer.ts` | `apps/server` |
| A9 | Fixture deck shape: `{ id, spec, description, cards }` with `cards` holding exactly `DECK_SIZE` (20) distinct non-Token catalog ids, and `id` equal to the filename. `seedGame` checks all of it before visiting, so a bad fixture fails with a readable message instead of an engine throw. | `support/commands.ts` | — |

## Which spec needs which milestone

| Spec | Needs |
| --- | --- |
| 01, 02, 03, 04, 11, 12 | M4 (the real catalog and card scripts) + M5 (board, prompts, hotseat loop, animations). 01 additionally needs `window.__jackioh.log`/`.decks` (A2) and the repo's `tsx` for the replay fold. |
| 05, 06 | M6 (server, match actor, WS protocol) and, for the clock assertion in 05, M7-T1. |
| 07 | M4 (card #96) + M5. The AI turn runs inside `reduce`, so no server is needed. |
| 08 | M4 + M5 only: it ends turns until the cap. |
| 09 | M6-T3 (validator + loadout endpoints) and the deckbuilder UI. |
| 10 | M6-T1 (auth, invite gate) and the code screen. |

## What the root still needs (not changed from here)

`e2e/` deliberately touches nothing outside itself. Three edits belong to whoever owns the root:

1. `package.json` → `"test:e2e": "pnpm --dir e2e test:e2e"`, which is the command CLAUDE.md
   documents.
2. `package.json` → add `tsc -p e2e/tsconfig.json` to the `typecheck` script, so the specs are
   type-checked by `pnpm typecheck`.
3. CI → run the suite on Chrome and on Electron (the M8 gate), after starting `apps/web` and
   `apps/server` in `E2E=1` mode; a nightly job re-runs spec 01 over 20 seeds (BUILD §4).

No `pnpm-workspace.yaml` entry is needed: `e2e/` is its own pnpm root. If the root ever wants
`e2e` in the workspace instead, add `- e2e` to `packages:` and `cypress: true` to `allowBuilds`,
and delete `e2e/pnpm-workspace.yaml`.
