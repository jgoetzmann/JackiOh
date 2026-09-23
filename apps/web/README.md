# `@jackioh/web`

The JackiOh client: React 19 + Vite. It renders a `PlayerView` and nothing else.

## The one rule

CLAUDE.md rule 7 and SPEC §10.8: **the client sends intent and renders `viewFor`. It never
enforces rules and never sees hidden information.** In practice:

- Every component's only input is a `PlayerView` from `@jackioh/shared`. A component that wants
  something the view does not carry is a finding against §10.8, not a reason to reach past it.
- Legality comes from the engine's `legalActions`, never from the client. `game/actions.ts`
  filters that array; it contains no cost check, no keyword check and no zone check. Anything
  whose `data-testid` is not in the returned `Highlight.legal` renders greyed out and fires
  nothing on click.
- `EngineState` is opaque (`game/engine.ts`). The client passes it back to the port and cannot
  read a field off it, which is how "never sees hidden information" is enforced by the compiler
  rather than by discipline.
- Choices split two ways per SPEC §11 R81: zone, X, embiggen, Tribute and a card's declared
  targets and modes are built **inline into the `play` action**; everything decided during
  resolution is a `PendingChoice` answered with an `answer` action. `game/Prompt.tsx` renders
  both with the same pickers.

## Layout

```
src/
  main.tsx              entry and the pathname switch
  index.css             reset and design tokens
  game/
    engine.ts           the EnginePort: the only seam onto packages/engine
    engine.real.ts      the real binding (see "Blocked on the engine" below)
    contract.ts         data-testid vocabulary, ClickTarget, Highlight, BoardProps
    catalog.ts          card names and rules text (see the §10.8 finding below)
    Board.tsx Zone.tsx Card.tsx Hand.tsx Hero.tsx Backrow.tsx Log.tsx   M5-T1
    actions.ts Prompt.tsx                                               M5-T2
    hotseat.ts decks.ts                                                 M5-T3
    animations.ts                                                       M5-T4
    Game.tsx            board + prompts + animation runner, wired together
  routes/dev/hotseat.tsx  the dev hotseat route
  test/
    setup.ts            jsdom matchers and a matchMedia stub
    fixtures.ts         fixture PlayerViews; every test renders one of these
```

## Commands

```
pnpm --filter @jackioh/web dev          # vite dev server on :5173
pnpm --filter @jackioh/web build        # production build
pnpm --filter @jackioh/web typecheck    # tsc -p apps/web/tsconfig.json
pnpm --filter @jackioh/web test         # vitest (jsdom)
```

The dev hotseat route is `/dev/hotseat?seed=42&a=first20&b=first20`. It runs `reduce` in the
browser and exposes `window.__jackioh = { state, dispatch, seed, … }` whenever
`import.meta.env.MODE !== "production"`, which is what the Cypress specs drive (BUILD M5-T3).

## Practice

`/practice` (SPEC §9.9, R187) is a game against the AI with no account and no server. The engine
and the AI (`packages/ai`) run in a Web Worker, which stands where SPEC §9.1 puts the server, so
rule 7 holds exactly as it does online:

```
src/practice/
  protocol.ts         the request/response shapes: everything the page ever learns about a game
  core.ts             the ONLY practice file that imports @jackioh/engine, @jackioh/cards or
                      @jackioh/ai; holds the GameState, runs both seats and the AI
  practice.worker.ts  the worker entry: core.handle per message
  host.ts             a module Worker in a browser, the in-thread core in jsdom; one answer per
                      request, strictly in order
  controller.ts       one request in flight, and the pacing loop that plays the AI's turn one
                      visible action at a time (think indicator, gaps from config.ts)
  config.ts testids.ts PracticeSetup.tsx ThinkIndicator.tsx PracticeLeave.tsx PracticeResult.tsx practice.css
  decks.ts            random, the three named practice decks (hand-built lists), saved decks
  DeckPreview.tsx     the chosen deck's name, identity, mana curve and cards, before Start
  ModifierList.tsx    every live R169 modifier in full, one tap from the HUD
  table.css           the practice skin over Game.tsx's board (its header says what it leaves alone)
routes/practice.tsx   the route: setup, HUD, and Game.tsx unchanged inside the worker's catalog
```

- The page holds snapshots, never a state: `{ view, legal, aiToAct, error }`, where `view` is
  `viewFor(state, human)` and `legal` is `legalActions(state, human)`. The AI seat's hand and
  library never cross the worker boundary.
- The one exception is `debug`, which carries the raw state, the log, the decks and the handicaps
  for spec 13's replay check. The core answers it only when `MODE !== "production"`, and the route
  sets `window.__jackiohPractice` under the same condition, like `window.__jackioh`.
- A practice game replays exactly from `(seed, decks, handicaps, log)`: nonces are `h<n>` for the
  human and `a<n>` for the AI, counted over accepted actions only, and the AI draws from its own
  stream (`${seed}:ai`), never the match rng.
- URL params (all optional): `?seed=`, `?difficulty=easy|medium|hard`, `?deck=random|preset:<id>`
  (both together start a game at once), `?seat=p1|p2`, and `?pace=fast` for e2e, which a
  production build ignores.
- `vite.config.ts` sets `worker: { format: "es" }` for the module worker.
- The setup previews decks from the catalog a short-lived worker sends (`{ type: "catalog" }`), so
  the page still bundles no card data; an autostarted game (`?difficulty=&deck=`) asks for none.
- The AI's next step waits while anything on the board carries `data-animating`, and while any
  element on the page carries `data-speaking` (the audio layer marks a voice line that way; a mark
  that is never cleared holds the AI for at most `PRACTICE_VOICE_HOLD_MAX_MS`). The controller's
  general form is `setHold(reason, held)`.
- A game in progress asks before a reload or a closed tab ends it (`beforeunload`), and the HUD's
  Menu leaves for the landing page, asking first while the game is on.

## Blocked on the engine

`packages/engine` does not compile yet: `packages/engine/src/index.ts` re-exports `./combat`,
`./playChoices`, `./prompts`, `./triggers`, `./traps` and `./viewFor`, and none of those files
exist (M3 is in flight). **`viewFor` is one of them**, so the client has no way to obtain a
`PlayerView` from a real game today.

Two deliberate consequences, both reversible in one commit:

1. `src/game/engine.real.ts` is the only page-side file that imports `@jackioh/engine` (the other
   importer, `src/practice/core.ts`, is loaded only by the practice worker; see Practice above). It is listed in
   `tsconfig.json`'s `exclude`, and `engine.ts` reaches it through a dynamic import marked
   `/* @vite-ignore */`. That keeps `tsc -p apps/web/tsconfig.json` and `vite build` green
   without the client pretending to have an engine.
2. The dev hotseat route renders an `EngineUnavailableError` panel naming the missing exports.
   It does **not** substitute a client-side `viewFor` — computing a view in the client is
   exactly the hidden-information leak rule 7 forbids.

When `pnpm exec tsc -p packages/engine/tsconfig.json` is green: delete the `exclude` entry in
`tsconfig.json`, change `loadEnginePort` in `engine.ts` to a static
`import { enginePort } from "./engine.real.ts"`, and drop the `@vite-ignore`. Nothing else in
`src/` touches the engine but the practice worker's `src/practice/core.ts`.

## `PlayerView` gaps found while building M5 (SPEC §10.8)

`CardView` is `{ instanceId, defId, radiant, cost }`. BUILD M5-T1 requires a card's **name** on
its face, and a picker needs its type and rules text, so a `PlayerView` alone cannot draw a
card. The catalog is public information (§5.1; §9.4 checks a `catalogVersion` on both sides), so
`game/catalog.ts` holds a lookup behind a React context — but the view does not supply it, and
with no catalog loaded every card renders its `defId` rather than a guessed name. Either
`viewFor` should carry the names of the cards it reveals, or §10.8 should say that the client
loads the catalog separately and pins it to `catalogVersion`.
