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
  cards/                card faces, procedural art, inspect and card settings (docs/polish/6-cards.md). A face is
                        the card in play or the card as printed (SPEC §10.10): `faceModel` with `inPlay` reads
                        the view's own facts (a hand Unit's stats, a unit's keywords and Vanilla mark, a #98's
                        rolled power, R243) and inPlay.ts's words (#98's power, ??? for Call to Chaos); with no
                        `inPlay` it is the collection's printed card. The inspect overlays in play show the
                        printed text beside a face wherever the two differ (inspect/Printed.tsx)
  game/
    engine.ts           the EnginePort: the only seam onto packages/engine
    engine.real.ts      the real binding (see "Blocked on the engine" below)
    contract.ts         data-testid vocabulary, ClickTarget, Highlight, BoardProps
    catalog.ts          card names and rules text (see the §10.8 finding below), and `MatchCardsContext`: the
                        match-made definitions the view carries (`PlayerView.defs`, a Fuse's, R243) and each field
                        Heroic Power's rolled power, which Board, Prompt and DragLayer provide from their view
    Board.tsx Zone.tsx Card.tsx Hand.tsx Hero.tsx Backrow.tsx Log.tsx   M5-T1; a graveyard or exile pile that
                        holds cards (public on both seats, §10.8) opens its cards on hover and in a dialog on a
                        click (cards/inspect/CardList.tsx), and a log line that names a card opens that card
    actions.ts Prompt.tsx                                               M5-T2
    hotseat.ts decks.ts                                                 M5-T3
    animations.ts                                                       M5-T4
    Game.tsx            board + prompts + animation runner + effects layer + audio + drag layer + showcase, wired together
    ConfirmConcede.tsx  "Concede this game?": the Concede control only asks (see "Three flows at the table")
    DrawOffer.tsx       the draw offer's notices and the answering seat's Accept / Decline (same section)
    notices.css         the look of both: over the board, never taking height from it
    showcase/           the opponent's play held up beside the field for about a second (SHOWCASE_HOLD_MS over the
                        effects speed): plan.ts picks the opponent's `cardPlayed` out of the redacted events,
                        per viewer, and a card the view hides (R97, R227) is a back with "Opponent set a card".
                        Click-through, never on `data-animating`; `data-showcase` holds practice's AI while it is up
    faces.ts            the face in play of a card the view lists or names (the board, a prompt, the showcase,
                        a log line, a pile): as it stands where the view lists it, else its definition
    inspectable.css     the look of what can be looked into: a browsable pile and a log line that names a card
    board.css prompt.css  layout and look: the game screen budgeted to the viewport (the
                        route's bar and the board share its height, and the cards are sized
                        off the board's with `cqh`), the board grid (a play area and sidebar
                        on desktops and landscape tablets, one column on portrait tablets and
                        phones held upright, sideways on phones held landscape), the playmat,
                        the hand fan, 44px touch targets, safe areas, the log behind a toggle
                        on phones, the prompt's bottom sheet on phones, and small pickers
                        docked clear of the field
    glow.ts             data-glow / data-condition-active helpers: green from
                        Highlight.glow, yellow from the view's conditionActive
    highlights.css      the green and yellow glow colours, imported after board.css
    drag/               drag to play: pointer events for mouse and touch, the targeting
                        arrow and reticle, and a dropped card held where it landed until
                        the board shows the play; click-click keeps working in every mode
  audio/                sound (SPEC §10.11); index.ts is the barrel Game.tsx imports, appAudio.ts
                        the page-wide unlock and UI ticks main.tsx holds, mix.ts the buses and limiter
    engine.ts sfx.ts unlock.ts settings.ts   lazy AudioContext and buses, procedural SFX, gesture unlock, the settings store
    cues.ts director.ts useGameAudio.ts      SOUND_CUES (a total map over GameEventType) and the runner-synced director
    AudioToggle.tsx AudioControls.tsx        the mute button (in the board's control bar) and the full panel
    useVoiceSpeaking.ts                      the engine's `speaking()`, which Game marks as data-speaking
    voice-lines.json voice-manifest.json     every card's lines and personas; the generated hash and size of each file
  fx/                   the effects layer (docs/polish/1-animations.md; SPEC §10.10, R200–R202)
    types.ts constants.ts   the cue contract and every FX number
    settings.ts         effects speed, intensity and motion (localStorage, jackioh.fx.v1)
    cues.ts memory.ts   the planner: an entry's events → cues, pure (and the killing blow a game over replays)
    stage.ts            stage cues, pure: a stand-in for a moved card, a hidden card, an aimed lunge (B46–B48)
    rng.ts presets.ts sprites.ts particles.ts canvasFx.ts surface.ts loop.ts shake.ts   the canvas engine
    anchors.ts          anchor → viewport box at fire time (a hand: its cards); the board shake sink
    director.ts         one frame loop: fires cues, steps and draws, expires DOM and stage effects
    dom.ts fx.css       DOM flourishes (splats, rays, banners, ghosts, stand-ins) and their keyframes
    FxLayer.tsx         the overlay Game mounts after the board; listens to the runner's signals
    index.ts            FxLayer, settings and types
  settings/             the settings store (localStorage, in try/catch) and the panel the
                        gear opens from the game's control bar and the nav
    slots.ts controls.tsx   the other tasks' controls the panel mounts (effects speed and
                        intensity, animated foil, the audio panel), each with its reset
  routes/dev/hotseat.tsx  the dev hotseat route
  test/
    setup.ts            jsdom matchers and a matchMedia stub
    fixtures.ts         fixture PlayerViews; every test renders one of these
scripts/
  gen-voice.mjs         renders voice-lines.json to public/audio/voice/<card-id>-<play|death|cast>.m4a
```

## Three flows at the table

None of them is a rule (CLAUDE.md rule 7): each reads the view, takes its moves from `legal`, and
sends intent. The testids are `contract.ts`'s `testid`, and e2e reads the same strings.

**The mulligan is both seats' at once** (SPEC §2.1, R265–R268). Each seat answers its own, in
either order; an answer is sealed until the other is in, and the hand does not change until then.
The view says so: a seat that still owes sees its own `pending` mulligan, one that has answered sees
`pending: { forYou: false, pendingFor }`, and `view.mulligan = { youReady, opponentReady, kept? }` is
present for exactly that window.

- The picker (`Prompt.tsx`) keeps its testids (`prompt-modal` with `data-prompt-kind="mulligan"`,
  `prompt-option-<id>`, `prompt-submit`); its confirm reads "Ready". Under the count,
  `mulligan-opponent-status` (`data-ready="true|false"`) says "Opponent is choosing…" or holds
  `mulligan-opponent-ready`, "Opponent is ready".
- After Ready, until the game starts: `mulligan-waiting`, "Waiting for your opponent…", with the
  hand and each card stamped Keep or Redraw from `kept` (`mulligan-waiting-card-<id>`,
  `data-verdict`; `data-returning` counts the cards going back). It has no `data-prompt-kind`, so no
  picker helper takes it for a question.
- Practice: the AI owes its mulligan from the first snapshot and answers it after
  `promptAnswerMs` (controller.ts), never after the human; the human's Ready goes out whenever it is
  pressed, queued behind an AI step already in flight.
- Hotseat: the device follows the view's `pending.pendingFor`, so after one seat's Ready it goes to
  the seat that still owes one, whichever answered first (p2 may answer first after a manual
  hand-over). Turn 1 is then handed over with the button, as every turn is.
- Online, the window has one clock (R268): the server reports its deadline as the frame's
  `promptDeadline` and as each seat's `clockMs`, and `Clock.tsx` (with `mulligan` set by the match
  route for exactly the window) shows it on both sides, the seat that is ready included, as
  `data-kind="mulligan"` over `MULLIGAN_CLOCK_MS`, with no turn clock.

**Concede asks first** (`ConfirmConcede.tsx`, mounted by `Game.tsx`, so every mode has it). The
`concede` control opens `concede-dialog`, a modal `alertdialog` "Concede this game?"; only
`concede-confirm` ("Concede") sends `{ type: "concede" }`. `concede-cancel` ("Keep playing") has the
focus on open and is what Escape and a click outside do; Tab stays in the dialog, and the focus goes
back to the control when it closes. A hotseat hand-over or the game's end drops the question.

**A draw offer is a question with two answers** (SPEC §2.5, R36, R269). Only the active player
offers, and `view.drawOffer = { by }` stands on both seats until the offer is answered or lapses at
the end of the offerer's turn. `DrawOffer.tsx` draws one element, `draw-toast` (the element the
animation table's `drawOffered` and `drawAnswered` rows play on), inside an always-present
`aria-live` region across the top of the screen:

- the offerer: `draw-offer-status`, "Draw offered — waiting for reply";
- the other seat: `draw-offer` (a `region`, not a modal), "Your opponent offers a draw", with
  `draw-accept` and `draw-decline`, live exactly when `legal` lists the matching `answerDraw` (the
  engine withholds it while a prompt is open) and sending that listed body;
- afterwards, `draw-outcome` with `data-outcome`: "You declined the draw" / "Your opponent declined
  the draw" for the rest of that turn, "Draw accepted" (the result reads "Game drawn by
  agreement."), and "The draw offer expired" through the turn after an unanswered offer lapsed.
- Sound (`audio/cues.ts`): the answering seat hears an urgent notify (a doorbell, `urgent: true`);
  the offerer hears `cancel` on a decline, and an acceptance is sounded by the `gameOver` that
  follows. That is online: in hotseat the offer and the answer each hand the device over, and a
  hand-over plays nothing (SPEC §10.11), so there the notice itself is the whole of it.
- Hotseat: an offer from the seat holding the device hands it to the other seat to answer, and the
  answer hands it back to the player whose turn it is (`hotseat.ts`). Only the offer moves it: if
  the players pass the device back unanswered with the seat switch, the offerer plays on and the
  offer lapses with the turn (R269). Practice hides the Offer draw
  control (SPEC §9.9, R188); an offer made anyway is declined at once and reads as declined.

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
- The AI's next step waits while anything on the board carries `data-animating`, while any
  element on the page carries `data-speaking` (Game marks its root while a voice line holds the
  audio engine's channel; a mark that is never cleared holds the AI for at most
  `PRACTICE_VOICE_HOLD_MAX_MS`), and while the showcase holds up the card the AI has just played
  (`data-showcase`, at most `PRACTICE_SHOWCASE_HOLD_MAX_MS`). `?pace=fast` waits for neither the
  voice nor the showcase. The controller's general form is `setHold(reason, held)`. The settings panel's "Reduce motion" gives the reduced pacing,
  as the media query does.
- A game in progress asks before a reload or a closed tab ends it (`beforeunload`), and the HUD's
  Menu leaves for the landing page, asking first while the game is on.

## Regenerating the voice lines

The voice files are generated from `src/audio/voice-lines.json` and committed, so CI never runs
`say`. After editing a line or a persona, run `pnpm --filter @jackioh/web gen:voice` on a Mac (it
needs macOS `say` and `afconvert`, and exits 2 anywhere else). It renders only the keys whose input
hash changed, deletes orphan files, rewrites `src/audio/voice-manifest.json`, and fails if the set
passes 3 MiB or a line runs past 4 s. `--only <defId>` limits it to one card and `--force` renders
everything again (legacy voices such as Fred are not byte-deterministic, so expect a large diff).
Commit the manifest together with `public/audio/voice/`. `node apps/web/scripts/gen-voice.mjs
--check` needs no `say`, runs on any OS and is what the asset test calls. A line must stay flavour
text: `voice-lines.test.ts` enforces the word limits and bans rules words. At runtime a file missing
from the manifest falls back to the browser's `speechSynthesis`.

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
