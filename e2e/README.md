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
    commands.ts            seedGame, playCard, attack, answerPrompt, endTurn (+ the waiting
                           helpers, signIn/visitAs, installLoadout, dragCardToDeck)
    testids.ts             every selector the suite uses, in one file
    config.ts              routes, endpoints, fixture accounts, the session key, timeouts,
                           SPEC constants
    cards.ts               SPEC §8 index -> name -> `core-NNN` catalog id, and the 9 Tokens
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
E2E=1 pnpm --dir apps/server dev               # http://localhost:8787 and ws://…/ws/match (WS_PATH)

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
pnpm test:e2e --expose wsUrl=ws://127.0.0.1:8787/ws/match --expose apiUrl=http://127.0.0.1:8787
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
6. **The session key.** The client reads its access token from
   `localStorage["jackioh.e2e.session"] = { accessToken }` at boot, because spec 05 reloads
   mid-match and the session has to survive it. Already true:
   `apps/web/src/net/session.ts` reads that key alongside the one a real sign-in writes.
   `cy.signIn` / `cy.visitAs` write it, and `support/config.ts` is the only place it is spelled.
7. **The socket path.** `ws://<host>/ws/match` — `WS_PATH` in
   `apps/server/src/match/wsServer.ts`. A handshake off that path is never upgraded, so this is
   not a preference: `support/config.ts`, `cypress.config.ts` and the `wsPlayer` task all default
   to it.

## Assumptions beyond that contract

Every one of these is either an ask on another team or a convention this suite invented because
BUILD does not fix it. They are all made in `support/`, never in a spec, so each has exactly one
place to change.

| # | Assumption | Where | Ask |
| --- | --- | --- | --- |
| A1 | In E2E mode the hotseat route resolves `a=`/`b=` from `window.__jackiohE2E = { seed, decks }` (also mirrored into `localStorage["jackioh.e2e.decks"]`, so a reload keeps it) before falling back to built-in dev decks. `seedGame` injects it in `onBeforeLoad`. | `support/commands.ts`, `support/types.ts` | `apps/web` |
| A2 | `window.__jackioh` also carries `log: Action[]` (every action reduced, in order, with its nonce) and `decks: [string[], string[]]`. Only spec 01 needs them: they are the "recorded actions" BUILD M8 folds for the replay hash. | `support/types.ts`, `cy.replayCheck` | `apps/web` |
| A3 | `<side>` in `zone-<side>-…` and `hero-<side>` is view-relative, `you` \| `opponent`, matching `PlayerView.you` / `.opponent`. Lanes are 1..5, as `packages/engine/src/zones.ts` numbers them (not an assumption — the engine fixes it). | `support/testids.ts` | `apps/web` |
| A4 | Prompt internals: one option per `PendingOption.key` at `prompt-option-<key>`, a `prompt-submit` confirm button for multi-select kinds, and `prompt-x` for the numeric input of `x`/`embiggen`. A chosen option is marked `aria-pressed="true"` (or `data-selected="true"`), which is how `keepMulligans` knows it does not have to click it again. `answerPrompt` prefers these and falls back to the board testids for pickers M5-T2 renders on the board (target, zone, tribute). | `support/testids.ts`, `support/commands.ts` | `apps/web` |
| A5 | Chrome not in BUILD's list: `result-overlay`, `turn-banner`, `seat-switch`, `graveyard-count-<side>`, `exile-count-<side>`, `library-count-<side>`, `hand-count-<side>`, `mana-<side>` + `.mana-crystal`, `switch-<instanceId>`, and `data-legal="true|false"` for the highlighting M5-T2 describes. (`.damage-pop`, `.heal-pop`, `.loss-pop`, `.radiant`, `data-locked` are BUILD M5-T4's own.) Plus R169's badges inside `modifiers-<side>`: `.modifier-badge` carrying `data-modifier-id`, and `data-count` on the list itself — client vocabulary rather than BUILD's, and the list is rendered on both seats even when empty. Plus the shown stats as attributes — `data-attack`, `data-health`, `data-max-health`, `data-armor`, `data-keyword`, `data-position`, `data-radiant` — because M5-T4's `buffed` row is "shown stats equal the view" and a reformat of `{health}/{maxHealth}` must not break a spec; and the regions the animation table targets — `hand-<side>`, `library-<side>`, `graveyard-<side>`, `exile-<side>`, `modifiers-<side>`, `backrow-<side>`, `board`, `game`, `concede`, `log`, `action-error`, `draw-toast`, `prompt-modal`, `prompt-scrim`. Every one of those is a name `apps/web` already renders (`animTestid`, `contract.ts`), so this row documents them rather than asking for them. | `support/testids.ts` | `apps/web` |
| A6 | Routes and fixtures for the non-hotseat specs: `/login`, `/invite`, `/decks`, `/play`, `/match/<id>`; `http://localhost:8787` + `ws://localhost:8787/ws/match` (the path is `WS_PATH`, not an assumption); fixture accounts `e2e-p1`, `e2e-p2` (active, own every card) and `e2e-pending` (pending, verified email); seeded invite codes — one good, one missing, one expired, one exhausted. | `support/config.ts` | `apps/web`, `apps/server` |
| A7 | Catalog ids are `core-` + SPEC §8 index zero-padded to three digits; a Token takes its parent's index with a `.1` suffix (`core-065-1`) or a name (`core-t-sheep`). Confirmed against `packages/cards/catalog.json`, so this is documentation rather than an assumption. `CARD_NAMES` stays the 100 deckable cards and `TOKEN_NAMES` the 9 Tokens, because `asDeck` checks a fixture against `CARD_NAMES` being exactly the deckable set (L3). | `support/cards.ts` | — |
| A8 | The WS protocol `cy.task("wsPlayer")` speaks: `-> hello {token?,matchId?,roomCode?}`, `-> action {action:{…,nonce}}`; `<- view {view}`, `<- ack {nonce,seq}`, `<- error {code,message,nonce?}`, `<- prompt {forYou,…}`, `<- clock {now,clocks}`. Read off `apps/server/src/match/protocol.ts`, which fixes every shape, so this is documentation now rather than an assumption. Joining a room is **not** on the socket: `POST /api/rooms/:code/join` is, and the `joinRoom` frame exists only to answer a client that tries with `error {code:"unsupported"}`. | `support/tasks/wsPlayer.ts` | — |
| A9 | Fixture deck shape: `{ id, spec, description, cards }` with `cards` holding exactly `DECK_SIZE` (20) distinct non-Token catalog ids, and `id` equal to the filename. `seedGame` checks all of it before visiting, so a bad fixture fails with a readable message instead of an engine throw. | `support/commands.ts` | — |
| A10 | A session is `localStorage["jackioh.e2e.session"] = {accessToken}`, installed in `cy.visit`'s `onBeforeLoad` so the first boot already has it. `cy.signIn(account)` remembers an account and every later visit carries it; `cy.visitAs(account, path)` is the two together. Confirmed against `apps/web/src/net/session.ts`, which reads that key. | `support/config.ts`, `support/commands.ts` | — |
| A11 | Deckbuilder testids, which BUILD names none of: `deckbuilder`, `card-pool` + `card-pool-<cardId>`, `deck-tab-<n>`, `deck-drop-<n>`, `deck-list-<n>`, `deck-count-<n>`, `deck-card-<n>-<cardId>` and its row `deck-<n>-card-<cardId>`, `loadout-save` / `-saved` / `-errors` / `loadout-error-<rule>` / `-save-error` (`n` 1-based, as the screen labels the decks), and a drag carrying the catalog id on `application/x-jackioh-card` plus `text/plain`. These mirror `apps/web/src/game/deckbuilder/testids.ts` name for name; keep the two files identical. | `support/testids.ts`, `support/commands.ts` | — |
| A12 | A one-deck scenario fixture is padded into a loadout §9.4 accepts: L1 wants exactly 3 decks and L4 wants them disjoint, so the other two are the next `DECK_SIZE * 2` Core ids the fixture did not use — inside L5, because R111 grants one copy of every non-token card. `cy.installLoadout` saves all three in one `PUT /api/loadout` against the version `GET` just reported. | `support/commands.ts` | — |
| A13 | Invite-screen testids, which BUILD names none of either: `invite-code-input`, `invite-submit`, `invite-error`, `invite-paused`, `invite-not-needed`. Like A11 these are documentation rather than an ask — `apps/web/src/routes/invite.tsx` exports and renders all five already; nothing under `e2e/` had ever named them, which is why spec 10's "code screen shown" was a URL redirect and not a screen. Keep the two files identical. | `support/testids.ts` | — |

## What `support/` owns, so a spec does not

Beyond the five BUILD names (`seedGame`, `playCard`, `attack`, `answerPrompt`, `endTurn`) and the
waiting helpers (`settled`, `expectAnimating`, `waitForPrompt`, `noPrompt`):

| Command | What it is for |
| --- | --- |
| `signIn(account)` / `signOut()` / `visitAs(account, path)` | A10's session. `signIn` is remembered for the file, and every later `cy.visit` installs it in `onBeforeLoad`, so a `cy.reload()` mid-match keeps it. |
| `installLoadout(account, fixtureId, { deckIndex })` | A12's padding plus §9.4's single-transaction save. |
| `dragCardToDeck(cardId, deckIndex)` | A11's whole gesture — `dragstart`, `dragover`, `drop`, `dragend`, one `DataTransfer` built in the app's window. `deckIndex` is 0-based like the API's; the testids are 1-based like the screen's labels. |
| `handIds(player)` / `unitIds(player)` | Which instance ids might I click. Setup only: assertions belong on the DOM, which is `viewFor` (CLAUDE.md rule 7). |
| `advanceToTurn(turn)` | End turns until `turn`, R82-safe: a turn that ended by itself leaves nothing to press, only a device to hand over. |
| `{ expectAnimating }` on `playCard` / `attack` / `endTurn` / `switchPosition` / `usePower` | Every acting command drains `data-animating` before it returns, which closes the window BUILD M5-T4 asks three specs to look through. This asserts the animation between the click and the drain, so a spec never has to hand-roll clicks to get in between. |
| `answerPrompt(kind, { first, embiggen })` | `first: 1` takes the first option offered, which is the only way to answer a Discover (its options are rng-drawn). `embiggen: true` is R81's price as the boolean it is, not the picker's `"true"` key. |

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
