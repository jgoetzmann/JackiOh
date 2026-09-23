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
  cards/                card faces, procedural art, inspect and card settings (docs/polish/6-cards.md)
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

## Blocked on the engine

`packages/engine` does not compile yet: `packages/engine/src/index.ts` re-exports `./combat`,
`./playChoices`, `./prompts`, `./triggers`, `./traps` and `./viewFor`, and none of those files
exist (M3 is in flight). **`viewFor` is one of them**, so the client has no way to obtain a
`PlayerView` from a real game today.

Two deliberate consequences, both reversible in one commit:

1. `src/game/engine.real.ts` is the only file that imports `@jackioh/engine`. It is listed in
   `tsconfig.json`'s `exclude`, and `engine.ts` reaches it through a dynamic import marked
   `/* @vite-ignore */`. That keeps `tsc -p apps/web/tsconfig.json` and `vite build` green
   without the client pretending to have an engine.
2. The dev hotseat route renders an `EngineUnavailableError` panel naming the missing exports.
   It does **not** substitute a client-side `viewFor` — computing a view in the client is
   exactly the hidden-information leak rule 7 forbids.

When `pnpm exec tsc -p packages/engine/tsconfig.json` is green: delete the `exclude` entry in
`tsconfig.json`, change `loadEnginePort` in `engine.ts` to a static
`import { enginePort } from "./engine.real.ts"`, and drop the `@vite-ignore`. Nothing else in
`src/` touches the engine.

## `PlayerView` gaps found while building M5 (SPEC §10.8)

`CardView` is `{ instanceId, defId, radiant, cost }`. BUILD M5-T1 requires a card's **name** on
its face, and a picker needs its type and rules text, so a `PlayerView` alone cannot draw a
card. The catalog is public information (§5.1; §9.4 checks a `catalogVersion` on both sides), so
`game/catalog.ts` holds a lookup behind a React context — but the view does not supply it, and
with no catalog loaded every card renders its `defId` rather than a guessed name. Either
`viewFor` should carry the names of the cards it reveals, or §10.8 should say that the client
loads the catalog separately and pins it to `catalogVersion`.
