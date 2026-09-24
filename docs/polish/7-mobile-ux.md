# Polish task 7: mobile layout, drag to play, settings and highlights

Branch `polish/7-mobile-ux`, worktree `.claude/worktrees/polish-7-mobile-ux`. The brief is
[`reference.md`](reference.md) section 7; its ownership tables bind this task. SPEC rows: **R195**
and **R196** (range R195–R199; R197–R199 are left unused). SPEC sections: §10.8, §10.9. Ports: web
5177, server 8787, component 5287.

## Goal

JackiOh should play well on a phone and feel like Hearthstone everywhere. That means four things.
First, the board lays out cleanly at 390×844, 844×390, 768×1024 and 1280×720, with 44 px touch
targets, safe-area padding, no horizontal page scroll, the hand as an overlapping fan with
tap-to-lift, and prompts as bottom sheets on phones. Second, every action can be done by drag:
drag a hand card onto a zone or a target to play it, or drag a unit onto an enemy to attack, using
unified pointer events, a targeting arrow and a reticle. Click-click keeps working in every mode,
and a "Drag to play" setting (on by default) can be turned off. Third, a settings store and panel
(`apps/web/src/settings/`) is opened from a gear in the game HUD and in the nav. Fourth, a green
glow comes only from `legalActions` (through `Highlight`) and a yellow glow only from a new
engine-computed `conditionActive` flag (CLAUDE.md rule 7), which five §8 cards with a printed
condition implement through a new `Script.conditionMet` hook.

## Research

What Hearthstone does, and what we borrow:

- **Glow colours.** A green border means the card can be played now. A yellow border means a
  special condition for the card is met. No glow means it can't be played now
  ([Blizzard how-to-play, board overview](https://hearthstone.blizzard.com/en-us/how-to-play?section=your-minions&topic=board-overview),
  [Hand, Hearthstone Wiki](https://hearthstone.fandom.com/wiki/Hand),
  [HearthPwn thread on the conditional glow](https://www.hearthpwn.com/forums/hearthstone-general/general-discussion/184269-i-just-had-an-idea-for-conditional-cards-glow-red)).
  Combo cards light up once a card has been played this turn
  ([Combo, wiki.gg](https://hearthstone.wiki.gg/wiki/Combo)).
  *Borrowed:* green = "the engine lists an action for this" (a playable card, a unit with an
  attack, a valid target while targeting). Yellow replaces green on a playable card whose
  condition is met. A hand card that can't be played shows no glow even when its condition holds.
  Combo, "if your hero is below N" and similar all use one yellow; there's no separate orange.
- **End turn.** The End Turn button changes colour once the player has no moves left
  ([HearthPwn thread](https://www.hearthpwn.com/forums/hearthstone-general/general-discussion/19771-can-we-have-an-automatic-end-turn-option)).
  *Borrowed:* `end-turn` glows green when nothing else is playable. The optional "Confirm end
  turn" setting asks twice when something still is.
- **Targeting.** A bold arrow runs from the action's source to the pointer and moves as the
  selection changes. Releasing over an empty area cancels the action. A minion drag that is
  cancelled is "undone": its board position is forgotten and it returns to the hand
  ([Target, wiki.gg](https://hearthstone.wiki.gg/wiki/Target)).
  *Borrowed:* the arrow for attacks and for target-only plays, a card ghost for placing a card, a
  reticle over a valid target, and a release anywhere invalid or back over the hand cancels and
  returns to idle. *Not borrowed:* Hearthstone shows the arrow to the opponent. We send nothing
  until the action, so there are no new wire messages.
- **Phones.** On a phone the hand sits minimized at the edge; you tap it to enlarge the cards,
  then drag one onto the board. Dragging straight from the minimized hand sometimes grabs the
  neighbouring card by mistake
  ([iLLGaming, Hearthstone on phones](https://illgaming.net/hearthstone-for-mobile-phones-how-does-it-hold-up/)).
  *Borrowed:* tap-to-lift in the fan. *Mitigation for the mis-grab:* each card keeps a strip
  ≥ 44 px wide with up to 7 cards in hand, and a drag starts only after 8 px of travel.
- **Web platform prior art.** Pointer Events unify mouse, pen and touch. `touch-action: none` on a
  drag source stops the browser from panning mid-drag
  ([MDN touch-action](https://developer.mozilla.org/en-US/docs/Web/CSS/touch-action)).
  `setPointerCapture` keeps the move and up events coming
  ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture)), and
  `document.elementsFromPoint` hit-tests the drop
  ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Document/elementsFromPoint)); it skips
  `pointer-events: none` overlays. Touch targets are ≥ 44 px
  ([WCAG 2.5.5 Target Size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html),
  [Apple HIG](https://developer.apple.com/design/human-interface-guidelines/accessibility)).
  Safe areas use `env(safe-area-inset-*)`
  ([MDN env()](https://developer.mozilla.org/en-US/docs/Web/CSS/env)), which works because
  `apps/web/index.html` already sets `viewport-fit=cover`.
- **In-repo prior art being retired.** `Card.tsx` has an HTML5 drag-to-attack path (`DRAG_MIME`,
  `beginDrag`, `completeDrop`). HTML5 drag never fires on touch, and on desktop its `dragstart`
  sends `pointercancel`, which would kill a pointer drag. So the board stops passing `draggable`
  and drops its `onDrop`/`onDragOver` handlers. The helpers stay in `Card.tsx`, which belongs to
  task 6, and become unused. BUILD M5-T2's "attack by drag or click-click" is met by the pointer
  path (B37). The deckbuilder's own HTML5 drag belongs to task 6 and is untouched.

## Surface

Every cross-slice boundary, with real types. "Slice N" refers to the Slices section.

### S1. `packages/engine/src/script.ts` (slice 1)

```ts
/** R195: where `viewFor` is asking about a card. */
export type ConditionZone = "hand" | "field";

/**
 * R195, §10.9: the argument of the Hearthstone "yellow glow" predicate. A hook is a PURE READ — it
 * never writes, never draws from `rng`, never returns effects — and must agree with the branch the
 * card's own resolution would take if it resolved now.
 */
export type ConditionContext = {
  state: GameState;
  self: CardInstance;
  /** The card's controller. R195 only ever asks about the viewer's own cards, so this is the viewer. */
  controller: PlayerId;
  /** Whether the Radiant face is the one running (§5.2). */
  radiant: boolean;
  /** "hand": as if played now. "field": as the card on the field reads it now. */
  zone: ConditionZone;
  /** `state.active === controller`, so a card file never reads `state.active` itself. */
  yourTurn: boolean;
};

export type ConditionHook = (ctx: ConditionContext) => boolean;

// Added to `Script`, after `modes`:
//   /** R195: the condition `viewFor` surfaces as `conditionActive` (§10.8). */
//   conditionMet?: ConditionHook;
```

### S2. `packages/engine/src/condition.ts` (new, slice 1) and `viewFor.ts`

```ts
import type { PlayerId } from "@jackioh/shared";
import type { ConditionZone } from "./script";
import type { CardInstance, GameState } from "./state";

/** R195: whether `viewer` sees `card` glowing yellow. Pure; calls the hook at most once. */
export function conditionActive(
  state: GameState,
  card: CardInstance,
  viewer: PlayerId,
  zone: ConditionZone,
): boolean;
```

Rules, in order. The first that applies decides:

| # | Condition | Result |
|---|---|---|
| 1 | `state.result !== null` | `false` |
| 2 | `zone === "field"` and `card.controller !== viewer` | `false` (hook not called) |
| 3 | `zone === "hand"` and not (`state.phase === "main"` and `state.active === viewer` and `state.pending === null`) | `false` (hook not called) |
| 4 | `scriptOf(card).conditionMet` is undefined (a transient def with no registered script gets `EMPTY_SCRIPT`; a fused def carries its ingredients' hooks, or-ed, R196) | `false` |
| 5 | otherwise | `hook({ state, self: card, controller: viewer, radiant: card.radiant, zone, yourTurn: state.active === viewer }) === true` |

`viewFor.ts` asks exactly three places. The edits stay at these call sites so they merge with
task 3:

- the viewer's own hand (`player === viewer` branch of `sideView`): each card with `zone: "hand"`;
- `unitViewOf(state, pile, viewer)`, which gains a `viewer` parameter: the top card of the pile with `zone: "field"`;
- `backrowView`'s public branch: the card with `zone: "field"`.

A private helper `withCondition<T extends CardView>(view: T, active: boolean): T` returns
`active ? { ...view, conditionActive: true } : view`. Graveyard, exile, resolving, buried cards
and every card on the opponent's side are never asked.

### S3. `packages/shared/src/view.ts` (slice 1)

```ts
export type CardView = {
  instanceId: string;
  defId: string;
  radiant: boolean;
  cost: number;
  /**
   * R195, §10.8: Hearthstone's yellow glow. Present, and `true`, only on the viewer's own card
   * whose printed condition holds now. Absent otherwise: never `false`, never on the opponent's
   * cards. `UnitView` and the public `BackrowView` inherit it.
   */
  conditionActive?: true;
};
```

### S4. The five card hooks (slice 1)

Each hook is added to **both** faces. It reuses the constant or predicate the card's own
resolution uses, extracted into one local function so the two can't drift apart.

| Card | File | `conditionMet` returns true when | Zones |
|---|---|---|---|
| #10 Rapid Replenish | `010-rapid-replenish.ts` | `subsystems.playsThisTurn(state, controller) >= COMBO` (no −1 in hand: the card is not yet counted) | hand only |
| #53 Reno | `053-reno.ts` | `heroOf(state, controller).health < floor` (30 base, 60 radiant) | hand only |
| #68 Twisted Sorcerer | `068-twisted-sorcerer.ts` | `heroOf(state, controller).health < LOW_HERO_HEALTH` (10, strict) | hand only |
| #71 Intern Stimmy | `071-intern-stimmy.ts` | `zoneCount(…, controller, "library") > zoneCount(…, opponentOf(controller), "library")` (refactor `libraryIsLarger` to take `(state, controller)`) | hand and field |
| #93 Combo-Index | `093-combo-index.ts` | `yourTurn && subsystems.gradeRises(state, self)` | field only |

"Hand only" means the hook returns `false` when `zone === "field"`, and vice versa.

A fusion (R77, `subsystems/fuse.ts`) registers a combined script for its def. `conditionMet`
answers a boolean, so `fuse.ts` does not concatenate it the way it concatenates the list hooks
(two hooks became one returning `[true, true]`, which `=== true` never accepts). It handles it
like `setStat`: one hooked ingredient's hook is the fusion's unchanged, and two or three are or-ed,
so the fused card glows when any ingredient's printed condition holds (R196). Its concatenated
Cry takes each ingredient's branch on its own, so one branch is enough for the glow to be true.

### S5. Web highlight contract (slice 4)

`apps/web/src/game/contract.ts`:

```ts
export type Highlight = {
  legal: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  /**
   * The green glow (Hearthstone's "can act"): a subset of `legal`, derived by `highlightFor` from
   * `legalActions` and the open prompt's options alone. Absent means nothing glows.
   */
  glow?: ReadonlySet<string>;
};
// NO_HIGHLIGHT is unchanged ({ legal: new Set(), selected: new Set() }).
```

`apps/web/src/game/actions.ts`: the signature of `highlightFor(view, legal, interaction): Highlight`
is unchanged. It now also fills `glow`:

| Stage | `glow` holds exactly |
|---|---|
| any, with `legal.length === 0` and a non-idle interaction | nothing: return `NO_HIGHLIGHT` as today |
| idle | `hand-card-<id>` for every `play`, `card-<attackerId>` for every `attack`, `power` if any `activatePower`, every testid `pendingHighlight(view, view.pending)` names, and `end-turn` iff `endTurn` is legal **and** no `play`/`attack`/`activatePower` is legal **and** `view.pending === null` |
| playing | for each remaining candidate: its zone's testid, `card-<id>` per tribute, `selectionTestid` of each declared target. Never other hand cards, never the selected card |
| attacking | `attackTargetTestid(view, targetId)` for each candidate of the selected attacker. Never other attackers |

Invariant: `glow ⊆ legal`. `offer-draw`, `concede` and `switch-*` never glow. A unit whose only
action is `switchPosition` stays `data-legal="true"` but does not glow.

`apps/web/src/game/glow.ts` (new; pure, no CSS import):

```ts
import type { CardView } from "@jackioh/shared";
import type { Highlight } from "./contract.ts";

export type GlowAttr = "ready";
/** `data-glow`: "ready" when `testId` is in `highlight.glow`; undefined (attribute omitted) otherwise. */
export function glowAttr(highlight: Highlight | undefined, testId: string | undefined): GlowAttr | undefined;
/** `data-condition-active`: "true" when the view says so; undefined otherwise. */
export function conditionAttr(card: Pick<CardView, "conditionActive"> | null | undefined): "true" | undefined;
/** True when `glow` holds a playable card, an attacker or the power: any testid starting `hand-card-` or `card-`, or `power`. */
export function hasMovesLeft(highlight: Highlight | undefined): boolean;
```

### S6. DOM attributes: the board's contract

| Element (testid) | Attribute | Values | Written by |
|---|---|---|---|
| card root (`hand-card-*`, `card-*`) | `data-glow` | `"ready"` or absent | `Card.tsx` (slice 4), via `glowAttr` in its `shared` props |
| card root, face-up only | `data-condition-active` | `"true"` or absent | `Card.tsx` (slice 4), via `conditionAttr(card)` |
| `hero-<side>` | `data-glow` | `"ready"` or absent | `Hero.tsx` (slice 4) |
| `power` button | `data-glow` | `"ready"` or absent | `Hero.tsx` (slice 4) |
| `zone-<side>-<row>-<lane>` | `data-glow` | `"ready"` or absent | `Zone.tsx` (slice 5) |
| `end-turn` | `data-glow` | `"ready"` or absent | `Board.tsx` (slice 5) |
| `end-turn` | `data-confirm` | `"armed"` or absent (label becomes "Confirm end turn") | `Board.tsx` (slice 5) |
| `board` | `data-drag` | `"on"` / `"off"` from `dragToPlay` | `Board.tsx` (slice 5) |
| `hand-you`, `hand-opponent` | `data-count` | the hand size | `Hand.tsx` (slice 5) |
| `hand-you` | `data-hover-preview` | `"on"` / `"off"` from `hoverPreviews` | `Hand.tsx` (slice 5) |
| `.hand-cards` | inline `--n` | the hand size | `Hand.tsx` (slice 5) |
| `.hand-slot` (wraps each hand card) | inline `--i`; `data-lifted` | index; `"true"` or absent (your hand only) | `Hand.tsx` (slice 5) |
| `<html>` | `data-dragging` | `"play"` / `"attack"` while a drag is in flight | `DragLayer.tsx` (slice 3) |
| `<html>` | `data-reduce-motion` | `"true"` or absent | settings store (slice 2) |
| `board` | `data-log` | `"open"` or absent: the phone log sheet is open | `Board.tsx` (fix stage, B43) |
| `log-toggle` | `aria-expanded` | a `<button>` in `.control-bar`, shown on phones only; toggles `data-log` | `Board.tsx` (fix stage, B43) |
| `.hand-slot` | `data-landing` | `"true"` while its card, just dropped and played, waits for the board to catch up | `Hand.tsx` via `drag/landing.ts` (fix stage, B42) |
| `prompt-modal` | `data-prompt-source` | `"engine"` (`view.pending`) or `"play"` (a play in flight, R81) | `Prompt.tsx` (fix stage, B44) |
| `drag-landing`, `drag-landing-card` | `data-instance-id`, `data-landing` | the dropped card drawn where it landed, outside `drag-layer` | `DragLayer.tsx` (fix stage, B42) |

Every existing `data-testid`, `data-legal`, `data-selected` and `data-animating` is kept exactly
as it is. `data-legal` stays the only click gate.

### S7. CSS files, tokens and import order

- `apps/web/src/game/highlights.css` (slice 4) declares
  `:root { --glow-ready: #4ade80; --glow-condition: #facc15; }`. The computed colours are
  `rgb(74, 222, 128)` and `rgb(250, 204, 21)`. The rules:
  - A glowing element's **first** `box-shadow` layer is `0 0 0 2px var(--glow-ready)`, unmixed.
    Any keyframes keep that first layer's colour in every frame.
  - A card with both `[data-glow="ready"][data-condition-active="true"]` uses `--glow-condition`
    in the first layer instead.
  - A field or backrow card with `[data-condition-active="true"]` and no glow gets a yellow first
    layer.
  - A hand card (`.card-hand`) with the flag and no glow gets no glow colour.
  - `data-selected` keeps its own styling on top.
- `board.css` (slice 5) stops painting `[data-legal="true"]` green. A legal element without glow
  gets a pointer cursor and full opacity, and no `--legal`/glow colour.
- `Board.tsx` imports `./board.css` **then** `./highlights.css`, in that order.
- `settings.css` is imported by `SettingsPanel.tsx`/`SettingsButton.tsx`, and `drag.css` by
  `DragLayer.tsx`.
- `drag.css` (slice 3) owns these rules:
  - `.board[data-drag="on"] .hand-you .card, .board[data-drag="on"] .zone .card[data-legal="true"] { touch-action: none; }`
  - `.board[data-drag="on"] { user-select: none; -webkit-touch-callout: none; }`
  - `:root[data-dragging] .prompt-scrim { visibility: hidden; }`
  - the overlay styles.
- `settings.css` (slice 2) owns `:root[data-reduce-motion="true"] { --anim-scale: 0; }`.
- Media queries (exact strings; slice 5 unless noted):
  - touch sizing: `(max-width: 1024px), (pointer: coarse)`
  - phone portrait: `(max-width: 600px)`
  - phone landscape: `(orientation: landscape) and (max-height: 500px)`
  - the prompt bottom sheet (`prompt.css`) applies under `(max-width: 600px), (orientation: landscape) and (max-height: 500px)`

### S8. Settings: `apps/web/src/settings/` (slice 2)

```ts
// store.ts
export type Settings = {
  /** Gameplay. Drag cards and units to act. Off: tap to select, then the Prompt pickers. */
  dragToPlay: boolean;        // default true
  /** Gameplay. Ask before ending the turn while a card is playable or a unit can attack. */
  confirmEndTurn: boolean;    // default false (must stay false: every e2e spec ends turns with one click)
  /** Gameplay. Hovering a hand card with a fine pointer lifts it; task 6's hover inspect reads it at integration. */
  hoverPreviews: boolean;     // default true
  /** Visuals. Force reduced motion on top of the OS preference. */
  reduceMotion: boolean;      // default false
};
export type SettingKey = keyof Settings;
export const SETTINGS_STORAGE_KEY = "jackioh.settings";
export const DEFAULT_SETTINGS: Readonly<Settings>;
/** Tolerant: unknown keys dropped, wrong-typed or missing values replaced by the default. */
export function parseSettings(raw: unknown): Settings;
/** The current snapshot. Same object until something changes (useSyncExternalStore needs that). Loads storage on first call. */
export function readSettings(): Settings;
/** Merge, persist (try/catch), re-apply <html> attributes, notify each subscriber once. Returns the new snapshot. */
export function writeSettings(patch: Partial<Settings>): Settings;
export function resetSettings(): Settings;
export function subscribeSettings(listener: () => void): () => void;
export function useSettings(): Settings;
export function useSetting<K extends SettingKey>(key: K): Settings[K];
/** Test seam: forget the cached snapshot so the next read re-parses storage. */
export function __resetSettingsForTests(): void;
```

- Storage is `localStorage[SETTINGS_STORAGE_KEY]` holding a JSON object of the four keys. Every
  storage access sits inside `try/catch`; a failure reads as "nothing stored" and a failed write
  keeps the in-memory value.
- A `storage` event on `window` for the key re-parses and notifies. The listener is attached
  while at least one subscriber exists.
- `<html data-reduce-motion="true">` is set whenever `reduceMotion` is true and removed
  otherwise, on first load and on every change.

```ts
// slots.ts: the integration seam for tasks 1 and 2
import type { ReactNode } from "react";
export type SettingsSectionId = "gameplay" | "visuals" | "audio";
export type SettingsSlot = { section: SettingsSectionId; id: string; render: () => ReactNode };
/** Empty on this branch. Integration appends task 1's fx speed and intensity (visuals) and task 2's audio controls (audio). */
export const SETTINGS_SLOTS: readonly SettingsSlot[] = [];

// SettingsPanel.tsx
export type SettingsPanelProps = { onClose: () => void; slots?: readonly SettingsSlot[] }; // slots defaults to SETTINGS_SLOTS
export default function SettingsPanel(props: SettingsPanelProps): ReactElement;

// SettingsButton.tsx: the gear; renders the panel through createPortal(document.body) while open
export type SettingsButtonProps = { placement: "game" | "nav" };
export default function SettingsButton(props: SettingsButtonProps): ReactElement;

// index.ts: the barrel every other slice imports from
export * from "./store.ts";
export * from "./slots.ts";
export { default as SettingsPanel, type SettingsPanelProps } from "./SettingsPanel.tsx";
export { default as SettingsButton, type SettingsButtonProps } from "./SettingsButton.tsx";
```

| testid | Element |
|---|---|
| `settings-open-game` / `settings-open-nav` | gear `<button aria-label="Settings" aria-haspopup="dialog" aria-expanded>`, a drawn 20 px SVG gear (the ⚙ glyph rendered as a dot; integration fix stage), the top-right control of every screen, the landing included |
| `settings-scrim` | full-screen scrim; a click on it (not on the panel) closes |
| `settings-panel` | `role="dialog" aria-modal="true" aria-label="Settings"`; focus moves to its first switch on open. Escape inside it closes it and calls `stopPropagation()`. Focus goes back to the gear on close |
| `settings-close`, `settings-reset` | buttons |
| `settings-section-gameplay` / `-visuals` / `-audio` | a `<section>` with an `<h2>`. A section with no controls (built-in or slot) is not rendered |
| `setting-dragToPlay`, `setting-confirmEndTurn`, `setting-hoverPreviews`, `setting-reduceMotion` | `<input type="checkbox" role="switch">` labelled "Drag to play", "Confirm end turn", "Hover previews", "Reduce motion" |

Built-in controls: gameplay = `dragToPlay`, `confirmEndTurn`, `hoverPreviews`; visuals =
`reduceMotion`. Slot controls render after them in their section.

### S9. Drag: `apps/web/src/game/drag/` (slice 3)

```ts
// model.ts (pure)
import type { ActionBody, PlayerView } from "@jackioh/shared";
import type { ClickResult, Interaction } from "../actions.ts";
import type { ClickTarget } from "../contract.ts";

/** Pointer travel, in CSS px, before a press becomes a drag. Below it the press is a click. */
export const DRAG_THRESHOLD_PX = 8;

export type DragKind = "play" | "attack";
export type DragSource = Extract<ClickTarget, { on: "hand" } | { on: "unit" }>;

export type DragPlan = {
  kind: DragKind;
  source: DragSource;
  /** `hand-card-<id>` or `card-<id>`. */
  sourceTestid: string;
  /** What the drag holds while in flight: every candidate for the source, NOT settled. */
  lifted: Extract<Interaction, { stage: "playing" } | { stage: "attacking" }>;
  /** `highlightFor(view, legal, lifted).glow ?? new Set()`: the testids a drop may land on. */
  dropTestids: ReadonlySet<string>;
  /** kind "play" and (dropTestids is empty, or outstandingNeed(lifted) === null): a drop anywhere on the board commits. */
  freeDrop: boolean;
  /** kind "attack", or a play where no remaining candidate has a zone and some has targets. Otherwise a card ghost. */
  arrow: boolean;
};

export type DropSpot =
  | { at: "target"; target: ClickTarget; testid: string }
  | { at: "board" }    // inside [data-testid="board"], outside [data-testid="hand-you"], on no drop target
  | { at: "outside" }; // anywhere else, the viewer's own hand included

/**
 * hand source: the `play`s naming it, or null if none, or if the interaction is playing and the
 * card's testid is in the current glow (it's a declared target; its press stays a click).
 * unit source (`side: "you"`): the `attack`s naming it, or null if none or `interaction.stage === "playing"`.
 * Anything else: null.
 */
export function planDrag(
  view: PlayerView,
  legal: readonly ActionBody[],
  interaction: Interaction,
  source: ClickTarget,
): DragPlan | null;

/**
 * target spot in dropTestids: r = onClickTarget(view, legal, plan.lifted, spot.target); return
 * r if r.action is set or r.interaction !== plan.lifted, else { interaction: IDLE }.
 * board spot and plan.freeDrop: pickInPlay(plan.lifted, {}), which is an action, or a play still
 * needing a picker. Anything else: { interaction: IDLE } and no action.
 */
export function resolveDrop(
  view: PlayerView,
  legal: readonly ActionBody[],
  plan: DragPlan,
  spot: DropSpot,
): ClickResult;
```

```ts
// targets.ts (DOM, no React)
/**
 * The ClickTarget an element reports, from the nearest ancestor-or-self whose testid matches:
 *   hand-card-<id>                   -> { on: "hand", instanceId }
 *   card-<id> inside a zone-*        -> { on: "unit" | "backrow", instanceId, side, lane } (from the zone's data-row/data-side/data-lane)
 *   card-<id> outside any zone       -> null (e.g. the resolving strip)
 *   hero-you | hero-opponent         -> { on: "hero", side }   (a press on `power` inside a hero reports the hero)
 *   zone-<side>-<row>-<lane>         -> { on: "zone", side, row, lane }
 * A press on a <button>, <input> or [role=button] inside a card (the switch button) is NOT a drag source.
 */
export function targetFromElement(element: Element): { target: ClickTarget; testid: string } | null;
/** The first element of `stack` (topmost first) mapping to a testid in `allowed` gives a target spot; otherwise board/outside by stack[0]. */
export function pickDropSpot(stack: readonly Element[], allowed: ReadonlySet<string>): DropSpot;
```

```ts
// DragLayer.tsx
export type DragLayerProps = {
  view: PlayerView;
  legal: readonly ActionBody[];
  interaction: Interaction;
  onInteraction: (next: Interaction) => void;
  onAction: (body: ActionBody) => void;
};
// The drop is hit-tested with document.elementsFromPoint (topmost first). jsdom lacks it, so the
// tests stub it on `document`; the cull removed an optional `hitTest` prop no caller passed.
export default function DragLayer(props: DragLayerProps): ReactElement | null;
```

The DragLayer's listeners go on `window`, added in an effect and removed on unmount, which also
removes `<html data-dragging>`. One pointer is tracked by `pointerId`. `isPrimary` and
`pointerType` are **not** required, because synthetic events from Cypress and jsdom leave them at
their defaults.

| Event | State | Effect |
|---|---|---|
| `pointerdown`, `button === 0`, target inside `[data-testid="board"]`, `targetFromElement` gives a hand or `unit` (side `you`) source | idle | if `readSettings().dragToPlay`: record `{ pointerId, x, y, source, element }` and go to **pressed**. Never `preventDefault` |
| `pointermove`, same `pointerId` | pressed | once the distance is ≥ `DRAG_THRESHOLD_PX`: `plan = planDrag(...)`. If null, go to idle (the click proceeds). Otherwise go to **dragging**: `onInteraction(plan.lifted)`, set `<html data-dragging=kind>`, `element.setPointerCapture?.(pointerId)` inside `try/catch`, render the overlay |
| `pointermove` | dragging | update the pointer. `spot = pickDropSpot(document.elementsFromPoint(x, y), plan.dropTestids)` drives the reticle and `data-valid`. `button === 2` means cancel |
| `pointerup` | pressed | go to idle (the click proceeds) |
| `pointerup` | dragging | `r = resolveDrop(view, legal, plan, pickDropSpot(document.elementsFromPoint(x, y), plan.dropTestids))`, then `onInteraction(r.interaction)`; `if (r.action) onAction(r.action)`. Clean up and arm the click swallow. A `play` that sent an action also *lands* (B42): the card is drawn as `drag-landing-card` at the middle of the target it was dropped on (or the pointer, for a drop on the board), and `drag/landing.ts` names it so `Hand.tsx` marks its slot `data-landing` and board.css hides it. Both go when the board shows a newer view than the one it was dropped on (the runner holds the old one back while the play's events animate), or after `LANDING_TIMEOUT_MS` (4 s) if the view never moves |
| `pointercancel`, `blur` | pressed / dragging | cancel |
| `keydown` `Escape` | dragging | cancel |
| `keydown` `Escape` | idle, `interaction.stage !== "idle"` | `onInteraction(IDLE)` |
| `contextmenu` with target inside the board | dragging, or idle with a non-idle interaction | `preventDefault()`, then cancel or `onInteraction(IDLE)` |
| `click` (capture phase, once) | armed after a drag | `stopPropagation()` and `preventDefault()`. Disarmed by the next `pointerdown` if no click arrives |

"Cancel" means `onInteraction(IDLE)`, no action, overlay removed, `data-dragging` removed.

Overlay DOM, rendered only while dragging. It is fixed-position with `pointer-events: none`, and
nothing in it carries a `hand-card-*` or `card-*` testid:

| testid | Attributes | Shown when |
|---|---|---|
| `drag-layer` | `data-kind="play"\|"attack"` | always, while dragging |
| `drag-ghost` | `data-instance-id`; shows the card's cost, name, rules text and a unit's printed attack and health (`useCardInfo`) | `!plan.arrow` |
| `drag-arrow` | an `<svg>`; `data-from=<sourceTestid>`, `data-valid="true"\|"false"` (the spot is a target, or board with `freeDrop`) | `plan.arrow` |
| `drag-reticle` | `data-target=<testid>`; `data-shape`: `ring` on a hero's health gem, `frame` just off a card an arrow is aimed at (so its name and numbers stay readable), `pad` over the zone a card is being placed in | the spot is a target |

### S10. Mounts in shared files

- `apps/web/src/game/Game.tsx` (slice 3, minimal additive edit): one import
  `import DragLayer from "./drag/DragLayer.tsx";` and one line after `<Prompt …/>`:
  `<DragLayer view={shown} legal={legal} interaction={interaction} onInteraction={setInteraction} onAction={onAction} />`.
  The fix stage adds a second, small edit (B41): `useSetting("reduceMotion") || prefersReducedMotion()`
  is what the queue is built with, a change of it builds a new queue, and the subscription effect
  catches the board up when the old one is replaced. Task 1's speed setting belongs beside it at
  integration.
- `apps/web/src/game/Log.tsx` (no owner in the reference table; task 4 also edits it): a
  `useLayoutEffect` keeps the log scrolled to its newest line whenever `view.events` changes. The
  desktop sidebar and the phone sheet are fixed-height boxes, and without it the newest line, the
  one worth reading, was below the fold. It merges cleanly with `polish/4-edge-cases` today; the PR
  names it as a cross-task touch.
- `packages/engine/src/subsystems/fuse.ts` (no owner): `conditionMet` joins `cost` and `setStat` as
  a hook R77's concatenation does not combine; it is or-ed (R196, S4).
- `apps/web/src/game/Prompt.tsx` (slice 5's layout): `data-prompt-source` on the modal (S6).
- `apps/web/src/routes/nav.tsx` (slice 2, minimal additive edit): one import, and
  `<SettingsButton placement="nav" />` as the last child of `BackLink`'s `<nav>`.
- `apps/web/src/game/Board.tsx` (slice 5, owned):
  - `<SettingsButton placement="game" />` as the last child of `.control-bar`;
  - `data-drag` on the board root;
  - `end-turn` glow and confirm, using `glowAttr` and `hasMovesLeft` from `./glow.ts` and
    `useSetting` from `../settings/index.ts`.
- `apps/web/src/game/Card.tsx` (task 6's file; slice 4 adds **root attributes only**):
  `"data-glow": glowAttr(props.highlight, testId)` in `shared`, and
  `data-condition-active={conditionAttr(card)}` on the face root.

### S11. Layout guarantees (slice 5)

- **The game screen is budgeted, not only the board (B46).** A route's `.app-shell--wide` holding
  `.game` is exactly `100dvh` tall and a grid: BackLink's nav and the match bar share its first
  row, a notice takes a row of its own, and `.game` (a flex column: the turn banner, then the
  board) gets the last row. The board there is `container-type: size`, and every layout sizes the
  card as `clamp(min, (100cqh − its fixed parts) / the card heights it stacks, max)`, so the route's
  bar, the banner or a phone's browser toolbars shrink the cards instead of pushing End turn or
  your hand below the screen. The field is the board's one `1fr` row; spare height becomes mat
  above and below its centred lanes. Off a route (no size container) `cqh` is the small viewport
  height, the same budget. On phones the shell pads 6 px top and bottom (the top with the notch's
  inset), the chrome row is inset by the side notches, and the match bar is one line with an
  ellipsis. Before this, the match route overflowed at all four target sizes (the hand of a phone
  held landscape was below the screen), and so did 390×664 and 1024×768 without it.
- **Grid.** `.board` becomes a CSS grid. Its children keep today's order: opponent seat, opponent
  hand, `.field`, your seat, your hand, `.control-bar`, `log`.
  - Desktop (≥ 1025 px, and a tablet held landscape: ≥ 900 px wide, landscape, > 500 px tall): the
    play area on the left (opponent seat, `.field`, your seat, your hand) and a 250 px sidebar on
    the right: the opponent's hand at the top, the controls at the height of the field (End turn
    is a wide amber button there, as in Hearthstone), and the log beside your seat and hand. From
    1025 px the card height is also capped so ten hand cards sit side by side (B30); a landscape
    tablet's fan overlaps instead.
  - Tablet portrait (761–899 px either way, 900–1024 px portrait): a single column, with the
    controls and the log sharing the last row.
  - Phone portrait: a single column, with the opponent's hand beside the opponent's seat. The
    control bar is one row: End turn takes what Offer draw, Concede, the log toggle and the gear
    leave.
  - Phone landscape: seats in a left column, the field in the middle, the opponent's hand and
    the controls in a right column, and your hand along the bottom.
  - On both phones the log's place is `display: none`, and `log-toggle` (a 44 px icon button in
    the control bar) opens it as an opaque sheet over the top of the board until it is pressed
    again (B43).
  - Where a lane is much wider than a portrait card (desktop, phone landscape) a field card is a
    square tile, so the name fits; the hand keeps tall cards.
- **Hand fan.** `.hand-cards` lays cards out with step `min(card width + gap, (available − card
  width) / (n − 1))`; container query units (`cqi`) are allowed. On phones `hand-count-you`
  overlays the fan instead of taking width from it.
  - Phones and tablets: a small arc tilt. A lift is either *reading* (a tap on a card that is not
    the play in flight, or keyboard focus on it) or *playing* (the card selected for a play):
    - phone portrait: reading rises and scales 1.6×, growing away from the screen's edge at either
      end of the hand; playing only steps up 10 px, so the zones, units and your own hero it is
      aimed at stay in sight and in reach;
    - phone landscape: both rise the hidden half of the card; reading also scales 1.7×;
    - tablet: both rise 0.12 of the card and scale 1.08.
  - Desktop: no tilt, and the lift is `translateY(-8px)`, kept inside the hand's padding.
  - A lifted card is opaque even when it cannot be played; a hero glowing as a target sits above
    a lifted card (`z-index`); a card with `:focus-visible` rises like a tapped one (B45).
  - `.hand-you[data-hover-preview="on"] .hand-slot:hover` lifts under
    `(hover: hover) and (pointer: fine)`.
- **Touch sizing.** Under the touch-sizing query, `.control` buttons, the gear, the log toggle,
  `.power-button` and `.hero` are at least 44×44 px, and each zone's smaller side is at least
  44 px. The in-card switch (⟳) keeps its small glyph but gains a transparent `::before` hit area
  reaching 14 px left of it and below it; the card clips it (`overflow: hidden`), so it is about
  32×32 px, which leaves the rest of a phone tile to the card's own tap and drag (B29).
- **Safe areas.** Under the phone queries, `.board` pads with
  `max(6px, env(safe-area-inset-*))` on the left, right and bottom. The prompt sheet pads its
  bottom with `env(safe-area-inset-bottom)`.
- **Bottom sheet.** `.prompt-scrim` aligns its panel to the bottom, and `.prompt` takes the full
  width with top corners rounded only and `max-height: 85vh`. The prompt's buttons and
  `[role="button"]` elements are at least 44 px tall. `Prompt.tsx` itself is not edited.
- **Small pickers stay off the field.** A zone, target or tribute pick is answered on the board,
  and a play in flight can ask for a direction, mode, X or price while its zone still glows. So
  those seven kinds (by `data-prompt-kind`) never sit centred on the field: they dock to the right
  sidebar on a desktop, low on a tablet, down the right edge of a phone held landscape, and are the
  usual sheet on a phone held upright, and their scrim does not dim the board. The card pickers
  (mulligan, discover, hand) keep the centred modal (B32's desktop case) and the sheet.
  On a phone held upright with drag to play on, a *play's* zone, target or tribute pick
  (`data-prompt-source="play"`) is a slim bar along the bottom edge over the control bar: its
  title, Confirm and Cancel, and no list, because the answers glow on the board and are picked
  there (B44). With drag to play off it is the full sheet, which is the brief's "selection UI";
  an engine prompt keeps its sheet either way.
- **Colour language.** Green is "can act" and yellow is "condition met" (S7), so the board's own
  selection ring is ice blue (`.board { --selected }`), never gold. End turn, once nothing else is
  left, turns green (its fill and its ring, B18), with a selector that outranks board.css's amber
  one. A Radiant card is foil inside its frame (a pale gold border and an inner sheen) with no
  outer halo, so an outer yellow glow means a met condition and nothing else (B18).

### S12. What does not change

- There are no new `GameEvent` types, no protocol or server changes and no new runtime
  dependencies.
- `PlayerView` gains only `CardView.conditionActive`.
- `ClickTarget`, `BoardProps`, `HandProps`, `ZoneProps`, `HeroProps` and `PromptProps` keep their
  current shapes.

## Behaviors

B1. A test-only script whose `conditionMet` returns true makes `viewFor(state, viewer).you.hand`
carry `conditionActive: true` on that card during the viewer's main phase with no prompt and no
result. When the hook returns false, `"conditionActive" in card` is false.

B2. During the opponent's turn, the mulligan, with a prompt open, or after the game has ended,
the viewer's hand cards carry no `conditionActive`, and a spy shows the hook is never called with
`zone: "hand"`.

B3. A unit the viewer controls (top of its pile) and a backrow card the viewer controls carry
`conditionActive: true` whenever the hook returns true, on either player's turn. The hook is
called with `zone: "field"` and `yourTurn === (state.active === viewer)`. Graveyard, exile,
resolving and buried cards never carry the flag.

B4. The opponent's view of the same cards (units, public backrow, face-down backrow, hand count)
never carries the key, a spy shows the hook is never called for a card the viewer doesn't
control, and a card with no hook (a transient def with no registered script included) never
carries it on either seat. How a fused card glows is R196's (below).

B5. #10 Rapid Replenish in hand carries `conditionActive` exactly when its controller has already
played 3 or more cards this turn, and playing it then draws 3 (radiant 6). After 2 plays it
carries no flag and draws nothing.

B6. #53 Reno in hand carries `conditionActive` exactly when the controller's hero is below 30
(radiant: below 60), and its Cry then raises the hero to that floor. A Reno on the field never
carries the flag.

B7. #68 Twisted Sorcerer in hand carries `conditionActive` exactly when the controller's hero is
below 10 (at exactly 10 it doesn't), matching the 8 damage (radiant 12) it then deals instead of
4 (radiant 6).

B8. #71 Intern Stimmy carries `conditionActive` in its controller's hand and backrow exactly when
the controller's library is strictly larger than the opponent's. The opponent's view of it stays
`{ faceDown: true }`.

B9. #93 Combo-Index in its controller's backrow carries `conditionActive` exactly when it is the
controller's turn, the cards they played this turn reach its grade and it is not at S. In hand it
never does.

B10. SPEC §11 carries R195, `packages/engine/test/rulings.test.ts` has `it("R195 …")` pointing at
both R195 test files, and `pnpm rulings:coverage` passes.

B11. In idle, `highlightFor(...).glow` holds every hand card a `play` names, every unit an
`attack` names, and `power` when `activatePower` is legal. It never holds a unit whose only
action is `switchPosition`, `offer-draw` or `concede`, and `glow ⊆ legal` always.

B12. In the playing stage, `glow` is exactly the zones, tribute units and declared-target
testids of the remaining candidates. It holds neither the other hand cards nor the selected card.

B13. In the attacking stage, `glow` is exactly the selected attacker's target testids (enemy
units and/or hero), and never another attacker.

B14. With the viewer's engine prompt open, `glow` is exactly the board cells its options name.
With no legal actions and a stale non-idle interaction, `highlightFor` still returns
`NO_HIGHLIGHT`.

B15. `end-turn` is in `glow` exactly when `endTurn` is legal, no `play`, `attack` or
`activatePower` is legal, no prompt is open and the interaction is idle.

B16. Rendered through `Board`, every card, zone, hero, `power` button and `end-turn` button
carries `data-glow="ready"` exactly when its testid is in `highlight.glow`, and no `data-glow`
attribute otherwise.

B17. A card root carries `data-condition-active="true"` exactly when its `CardView` has
`conditionActive: true`, for hand, unit and backrow cards alike. Card backs never carry it.

B18. In a real browser:
- a `data-glow="ready"` card's computed `box-shadow` contains `rgb(74, 222, 128)`;
- with `data-condition-active="true"` added, it contains `rgb(250, 204, 21)` and not the green;
- a hand card with the flag but no glow contains neither colour;
- a field card with the flag contains the yellow;
- a `data-legal="true"` card without `data-glow` contains neither colour.

B19. With empty, corrupt or throwing `localStorage`, `readSettings()` returns `DEFAULT_SETTINGS`
(`dragToPlay: true`, `confirmEndTurn: false`, `hoverPreviews: true`, `reduceMotion: false`), and
no store function throws.

B20. `writeSettings(patch)` merges, persists JSON under `jackioh.settings`, notifies each
subscriber once and returns the new snapshot. `parseSettings` drops unknown keys and replaces
wrong-typed values with defaults, and `resetSettings()` restores the defaults.

B21. A `storage` event for `jackioh.settings` updates `readSettings()` and re-renders every
component that uses `useSetting`.

B22. `reduceMotion: true` sets `data-reduce-motion="true"` on `<html>`, and false removes it.
`settings.css` sets `--anim-scale: 0` under `:root[data-reduce-motion="true"]`.

B23. `settings-open-game` (in the board's control bar) and `settings-open-nav` (in `BackLink`)
open the `settings-panel` dialog. `settings-close`, Escape and a click on `settings-scrim` close
it and return focus to the gear that opened it.

B24. The panel shows `settings-section-gameplay` (`setting-dragToPlay`, `setting-confirmEndTurn`,
`setting-hoverPreviews`) and `settings-section-visuals` (`setting-reduceMotion`). Each switch
reflects the store and writes to it, and `settings-reset` restores the defaults. A section with
no controls isn't rendered, and an `audio` slot makes `settings-section-audio` appear with the
slot inside it.

B25. With `confirmEndTurn` on and `hasMovesLeft(highlight)`, the first click on `end-turn` sets
`data-confirm="armed"` and calls no `onControl`, the second calls `onControl("end-turn")`, and a
new `view` disarms it. With the setting off, or no moves left, one click ends the turn.

B26. Each of the viewer's hand cards sits in a `.hand-slot`. A click lifts it
(`data-lifted="true"`) even when it isn't legal, a second click or a `pointerdown` outside the
hand lowers it, and the selected hand card is always lifted.

B27. The board carries `data-drag="on"|"off"` from `dragToPlay` and `hand-you` carries
`data-hover-preview="on"|"off"` from `hoverPreviews`. Both update live when the setting changes.

B28. The existing component spec `board-layout.cy.tsx` measures no horizontal overflow
(document, body, board) and all 20 field cards visible at 1280×720, 844×390, 768×1024 and
390×844.

B29. At 390×844, 844×390 and 768×1024, `end-turn`, `offer-draw`, `concede`,
`settings-open-game`, `power`, `hero-you`, `hero-opponent` and every zone measure at least
44×44 px.

B30. At 390×844 a 10-card hand stays inside `hand-you` with each card exposing at least 28 px,
and a 7-card hand at least 44 px. At 1280×720 no two cards of a 10-card hand overlap.

B31. At 844×390:
- the `control-bar`'s left edge is at or right of `.field`'s right edge;
- the board is at most 378 px tall and ends on the screen (the shell pads a phone 6 px top and
  bottom);
- `log` is not visible.

At 390×844 the board is at most 820 px tall and `log` is not visible. At 1280×720 `log` is
visible.

B32. At 390×844 an open prompt is a bottom sheet: `prompt-modal` spans the viewport width and
its bottom edge is the viewport's, and `prompt-submit` and each `prompt-option-*` are at least
44 px tall. At 1280×720 it is a centred modal narrower than the viewport.

B33. `board.css` and `prompt.css` pad with `env(safe-area-inset-bottom)` (plus left and right in
`board.css`), and `board.css` still declares no width over 390 px (Board.test's scan).

B34. `planDrag`:
- gives a `play` plan for a hand card a `play` names, in any stage, unless the card is a declared
  target of the play in flight;
- gives an `attack` plan for a unit an `attack` names, but not while playing;
- returns `null` otherwise.

`lifted` is never settled, so lifting a one-candidate spell sends nothing.

B35. `resolveDrop`:
- on a target spot in the drop set, returns what `onClickTarget(view, legal, lifted, target)`
  returns, or `IDLE` if that changes nothing;
- on a board spot with `freeDrop`, returns `pickInPlay(lifted, {})`;
- on anything else, returns `{ interaction: IDLE }` with no action.

B36. In jsdom with a stubbed hit test, a `pointerdown` on a legal hand card and a `pointermove`
of at least 8 px sets the lifted interaction, so its zones get `data-glow="ready"`. It also shows
`drag-layer` with `drag-ghost` and sets `<html data-dragging="play">`. Releasing over a glowing
zone sends the same `play` that click-click sends.

B37. Dragging an attacker shows `drag-arrow` with `data-from` set to its testid, and hovering the
glowing enemy hero shows `drag-reticle` with `data-target="hero-opponent"`. Releasing there sends
the same `attack` that click-click sends.

B38. During a drag, any of Escape, `contextmenu`, `pointercancel`, or a release over no drop
target does all of the following:
- returns the interaction to idle and sends nothing;
- removes the overlay and `data-dragging`;
- swallows the click that follows the release.

B39. A press that moves less than 8 px starts no drag and the click goes through, so click-click
plays and attacks work with `dragToPlay` both on and off. With it off, a long move starts no
drag. Escape or `contextmenu` also cancels a click-selected play or attack.

R196. A fusion of two hooked cards (through the real `fuse`, in hand and kept on the field) glows
when either ingredient's hook answers exactly `true` and not when neither does; each hook is asked
about the fused instance; one hooked ingredient's hook is the fusion's; a fusion with none never
glows. Crafting #53 Reno with #68 Twisted Sorcerer, the card glows at hero 5 (heals to 30, deals 8)
and at 20 (heals to 30, deals 4), and not at 30 (no heal, deals 4). The registry's hooked cards are
exactly R195's five.

B40. In a seeded hotseat game on Chrome/Electron:
- dragging a glowing hand card onto a glowing zone plays it;
- dragging a unit onto the enemy hero attacks;
- releasing outside the board cancels;
- after drag to play is turned off in the settings panel (still off after a reload),
  click-click plays a card.

Added in the fix stage, after review:

B41. With `reduceMotion` on, a new view with events shows at once and nothing carries
`data-animating` (the queue is built with the setting, as it is with the OS preference). Turning
it on mid-animation shows the newest view at once.

B42. A drop that sends a `play` leaves `drag-landing-card` where the card landed and marks its hand
slot `data-landing` (hidden), with `drag-layer` gone. Both go as soon as the board shows a newer
view, or after 4 s if it never does. A drop that sends nothing, and an attack, leave nothing
behind.

B43. On a phone, `log-toggle` (44×44 px) sets `data-log="open"`, which shows the log over the top
of the board; pressing it again hides it. At 1280×720 the log has its own place and the toggle is
not shown.

B44. At 390×844 with drag to play on, a tap on a playable card opens a play's zone pick as a bar at
most 72 px tall whose top is below the hand and below the lifted card, with no list; a tap on a
glowing zone then plays it. With drag to play off the same tap opens the full sheet. The modal
carries `data-prompt-source` `"play"` or `"engine"`.

B45. At 390×844 and 844×390: a tap on a card that cannot be played lifts it at least 1.5 times its
resting width, opaque, and inside the screen, the end cards included; a card being played whose
target is your hero leaves `hero-you` on top at every probed point; and (390×844) keyboard focus on
a covered card brings it above its neighbour.

B46. With the match route's chrome (BackLink and the match bar) and with the hotseat bar, at
390×844, 844×390, 768×1024, 1280×720, 1024×768 and 390×664: nothing scrolls either way, End turn
is on the screen, and the top of every hand card is on the screen. At 1024×768 the controls sit
in a sidebar right of the field. `board-layout.cy.tsx` runs at 1024×768 and 390×664 too, and
asserts no vertical scroll.

## Tests

| Behaviours | Project | New test file | Harness |
|---|---|---|---|
| B1–B4, B10 (the `R195 …` titles) | vitest `engine` | `packages/engine/test/conditionActive.test.ts` | `test/fixtures/harness.ts` (`newGame`, `inHand`, `put`, `slot`); a test-only `CardDef` and `CardScripts` with a `vi.fn` `conditionMet`, registered in-file on top of `registeredCatalog()` / `registeredScripts()` and restored in `afterAll` (the pattern `viewFor.test.ts` uses for its own defs) |
| B5–B9, B10 (the `R195 …` titles) | vitest `cards` | `packages/cards/test/condition-active.test.ts` | `test/_harness.ts` `scenario()`; `s.view("p1")`/`s.view("p2")` for the flag, and `s.play(...)` plus the scenario's assertions for the branch actually taken |
| B10 (index) | vitest `engine` | (existing `rulings.test.ts`, edited by slice 1) | `provenIn(195, "conditionActive.test.ts", "../../cards/test/condition-active.test.ts")`; plus `pnpm rulings:coverage` |
| B11–B15 | vitest `web` | `apps/web/src/test/ux/glow.test.ts` | pure; `apps/web/src/test/fixtures.ts` views (`baseView`, `fullBoardView`, `card`, `unit`, `pendingFor`) and hand-written `ActionBody[]` (hero targets are `"hero-p2"`) |
| B16–B17 | vitest `web` | `apps/web/src/test/ux/glow-render.test.tsx` | jsdom, `render(<Board …/>)` / `render(<Game …/>)` with fixtures; `card({ conditionActive: true })` |
| B19–B24 | vitest `web` | `apps/web/src/test/ux/settings.test.tsx` | jsdom; `localStorage.clear()` and `__resetSettingsForTests()` in `afterEach`; throwing storage via `vi.spyOn(Storage.prototype, "getItem")`; `StorageEvent` dispatched on `window`; CSS read as text with `readFileSync` (the Board.test pattern) |
| B25–B27, B33 | vitest `web` | `apps/web/src/test/ux/board-ux.test.tsx` | jsdom, `render(<Board …/>)` with a `Highlight` carrying `glow`; `writeSettings` to flip settings; CSS as text |
| B34–B35 | vitest `web` | `apps/web/src/test/ux/drag-model.test.ts` | pure; fixtures plus hand-written `legal` arrays |
| B36–B39 | vitest `web` | `apps/web/src/test/ux/drag-layer.test.tsx` | jsdom, `render(<Game view legal onAction/>)`; stub `document.elementsFromPoint = () => [el]` (delete it in `afterEach`); `fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX, clientY })`, then `pointerMove`/`pointerUp` fired on `window`; `keyDown(window, { key: "Escape" })` |
| B18, B29–B32 | Cypress component | `e2e/cypress/component/mobile-ux.cy.tsx` | mount `<div className="app-shell app-shell--wide"><Game …/></div>` exactly as `board-layout.cy.tsx` does; `cy.viewport(w, h)`; measure `getBoundingClientRect`, `getComputedStyle` |
| B28 | Cypress component | (existing `board-layout.cy.tsx`, `VIEWPORTS` extended by slice 5) | tester B runs it and adds no duplicate |
| B41 | vitest `web` | (existing `settings.test.tsx`) | `render(<Game/>)`, `rerender` with a `turnStarted` event, `writeSettings` |
| B42 | vitest `web` | (existing `drag-layer.test.tsx`) | as B36; `vi.useFakeTimers()` for the timeout |
| B43, B44 (attributes and CSS text) | vitest `web` | (existing `board-ux.test.tsx`) | `render(<Board/>)`, `render(<Game/>)`, CSS read as text |
| B18 (End turn, Radiant), B29 (switch), B43–B46 | Cypress component | (existing `mobile-ux.cy.tsx`; `board-layout.cy.tsx` for B46's two new sizes) | mounts `BackLink` and a `match-bar`, or a `hotseat-bar`, round `Game` for B46 |
| R196 | vitest `engine`, `cards` | (existing `conditionActive.test.ts`, `condition-active.test.ts`) | the real `fuse`; `subsystems.fuse(..., { toHand: "p1" })` in a `scenario()` |
| B40 | Cypress e2e | `e2e/cypress/e2e/16-drag-to-play.cy.ts` plus helper `e2e/support/ux.ts` | `cy.seedGame` with existing decks (`01-aggro-a`/`01-aggro-b` or `04-combat-*`); the helper `dragTo(sourceSelector, targetSelector \| "outside")` triggers `pointerdown` on the source, a few `pointermove`s on `body` with `clientX`/`clientY` and `pointerId: 1`, then `pointerup` on the target; `cy.settled()` afterwards. Testids for the new elements live in `e2e/support/ux.ts`, never raw in the spec |

Tester groups. Each group creates only the new files listed, and none of them belongs to a slice:

- **Tester A, `rules-and-state`.**
  - Behaviours: B1–B17 and B19–B24.
  - Files:
    - `packages/engine/test/conditionActive.test.ts`
    - `packages/cards/test/condition-active.test.ts`
    - `apps/web/src/test/ux/glow.test.ts`
    - `apps/web/src/test/ux/glow-render.test.tsx`
    - `apps/web/src/test/ux/settings.test.tsx`
  - Every R195 proof title starts `R195`.
- **Tester B, `interaction-and-layout`.**
  - Behaviours: B18 and B25–B40.
  - Files:
    - `apps/web/src/test/ux/board-ux.test.tsx`
    - `apps/web/src/test/ux/drag-model.test.ts`
    - `apps/web/src/test/ux/drag-layer.test.tsx`
    - `e2e/cypress/component/mobile-ux.cy.tsx`
    - `e2e/cypress/e2e/16-drag-to-play.cy.ts`
    - `e2e/support/ux.ts`
  - B28 is checked by running the extended `board-layout.cy.tsx`.

Commands (from the worktree):

```
pnpm vitest run --project engine packages/engine/test/conditionActive.test.ts
pnpm vitest run --project cards packages/cards/test/condition-active.test.ts
pnpm vitest run --project web apps/web/src/test/ux
pnpm vitest run --project web apps/web/src/game/Board.test.tsx -u   # slice 5, after reconcile
pnpm rulings:coverage
E2E_COMPONENT_PORT=5287 pnpm --dir e2e test:component
pnpm build:e2e && pnpm --dir apps/web exec vite preview --port 5177 --strictPort
E2E_BASE_URL=http://localhost:5177 pnpm --dir e2e exec cypress run --spec cypress/e2e/16-drag-to-play.cy.ts
```

The existing specs 01–12 must stay green, above all 01, 02, 04 and 12, which click hand cards,
zones and prompts at 1280×720.

## Out of scope

- Task 6's hover inspect and long-press inspect sheet. This task only provides the
  `hoverPreviews` key and the fan's own hover lift.
- Task 1's effects speed and intensity controls and task 2's audio controls. They are mounted at
  integration through `SETTINGS_SLOTS`. (`reduceMotion` itself now reaches the runner, B41; task
  1's speed setting joins it in `Game.tsx` at integration.)
- `Card.tsx` internals, including where the in-card switch button (⟳) sits. Its glyph stays below
  44 px; board.css only gives it a bigger hit area inside the card (S11). Moving it out of the card,
  where a full 44 px target fits, is task 6's.
- Yellow for conditions a player modifier grants to other cards (#38 Quickstriker, #64 Gifted
  Program, #78 /fullsend), scaling amounts (#70 Spiteful Stab), event-triggered traps (#18, #41,
  #60, #85, #96) and cost reductions (#100).
- A second drag for a play that needs two board choices (a zone and a Cry target). The first
  choice comes from the drop; the second is a click or a picker, as today.
- Dragging the hero power, backrow cards or prompt options.
- The deckbuilder's HTML5 drag (task 6).
- Haptics.
- Broadcasting the targeting arrow to the opponent.
- Any `GameEvent`, protocol or server change.
- Updating `e2e/README.md`'s spec list.

## Slices

**Slice 1, `engine-conditions`.**
- Owns:
  - `packages/engine/src/script.ts`
  - `packages/engine/src/condition.ts` (new)
  - `packages/engine/src/viewFor.ts`
  - `packages/shared/src/view.ts`
  - the five card scripts: `packages/cards/src/scripts/010-rapid-replenish.ts`, `053-reno.ts`,
    `068-twisted-sorcerer.ts`, `071-intern-stimmy.ts`, `093-combo-index.ts`
  - `packages/cards/README.md`
  - `SPEC.md`
  - `packages/engine/test/rulings.test.ts`
- Behaviours: B1–B10.
- Shared-file edits:
  - In `viewFor.ts`, only the three call sites in S2 plus one import. The file is shared with
    task 3 and task 4.
  - In `view.ts`, only the one field. Task 3 adds handicap fields.
  - In `SPEC.md` and `rulings.test.ts`, one row each, inserted in numeric position after R170
    (other tasks insert R171–R194 before it).
  - `packages/engine/src/index.ts` is **not** edited, because `script.ts` is already re-exported.

**Slice 2, `settings`.**
- Owns:
  - `apps/web/src/settings/store.ts`, `slots.ts`, `SettingsPanel.tsx`, `SettingsButton.tsx`,
    `settings.css`, `index.ts` (all new)
  - `apps/web/src/routes/nav.tsx`
- Behaviours: B19–B24.
- Shared-file edits: `nav.tsx` gets one import and one mount line (S10). Task 5 may also touch
  it.

**Slice 3, `drag`.**
- Owns:
  - `apps/web/src/game/drag/model.ts`, `targets.ts`, `DragLayer.tsx`, `drag.css` (all new)
  - `apps/web/src/game/Game.tsx`
- Behaviours: B34–B40.
- Shared-file edits: `Game.tsx` gets exactly one import and one mount line (S10). Tasks 1, 2 and
  3 also edit `Game.tsx`.

**Slice 4, `highlights`.**
- Owns:
  - `apps/web/src/game/glow.ts` (new)
  - `apps/web/src/game/highlights.css` (new)
  - `apps/web/src/game/actions.ts`
  - `apps/web/src/game/contract.ts`
  - `apps/web/src/game/Card.tsx` (root attributes only)
  - `apps/web/src/game/Hero.tsx`
- Behaviours: B11–B18.
- Shared-file edits:
  - `Card.tsx` belongs to task 6. Only the two root attributes in S10 and one import line are
    added.
  - `actions.ts` and `contract.ts` are unclaimed in the reference table. This task claims them
    for the additive `glow` field.

**Slice 5, `responsive-board`.**
- Owns:
  - `apps/web/src/game/Board.tsx`, `Zone.tsx`, `Hand.tsx`, `board.css`, `prompt.css`
  - `apps/web/src/game/Board.test.tsx` and `apps/web/src/game/__snapshots__/Board.test.tsx.snap`
  - `e2e/cypress/component/board-layout.cy.tsx`
  - `apps/web/README.md`
- Behaviours: B25–B33.
- Shared-file edits: none outside its own files.
- Existing-test updates:
  - In `Board.test.tsx`, delete the HTML5 test "reports a drag as the source click then the
    drop-target click". B37 is its pointer-events replacement.
  - Regenerate the snapshot after reconcile.
  - In `board-layout.cy.tsx`, extend `VIEWPORTS` to four entries, adjust its header comment, and
    keep every assertion.

Slice briefs (what a blind builder needs beyond Surface):

1. **engine-conditions.**
   - Implement S1–S4 and the SPEC text below.
   - In each card file, extract the predicate the resolution uses into one local function and
     call it from both `cry`/`trigger` and `conditionMet`. Don't read `state.active` or
     `state.players` from a card file; use `yourTurn`, `heroOf`, `zoneCount` and `subsystems.*`.
   - Add `conditionMet` to the `Script` shape list in `packages/cards/README.md` §1, with one
     sentence.
   - Add the R195 row to `rulings.test.ts` with a comment naming both proof files. The proof test
     titles start `R195`. Tester A writes them.
2. **settings.**
   - Implement S8 exactly: testids, labels, storage key, defaults.
   - No React context is needed; the store is module-level with `useSyncExternalStore`.
   - The panel is a centred dialog on desktop and a bottom sheet on phones, in `settings.css`.
     Its controls are at least 44 px tall.
   - Mount the nav gear (S10).
3. **drag.**
   - Implement S9 exactly. `model.ts` must import only from `../actions.ts` (`onClickTarget`,
     `pickInPlay`, `outstandingNeed`, `highlightFor`, `IDLE`, `attackTargetTestid`) and
     `../contract.ts`. It never inspects a card's rules.
   - Set the React state on every `pointermove`; no requestAnimationFrame is needed.
   - Guard `setPointerCapture` and `elementsFromPoint`. Neither exists in jsdom.
   - The ghost sits above a touch point (offset up by its height) and at the cursor for a mouse.
   - The arrow is a curved SVG path with an arrowhead: red-orange when invalid, `--glow-ready`
     when valid.
   - Mount it in `Game.tsx` (S10).
4. **highlights.**
   - Implement S5, `glow.ts` and the `Card.tsx` and `Hero.tsx` attributes from S6.
   - Remove `Hero.tsx`'s `onDragOver`/`onDrop` and the imports they leave unused.
   - Write `highlights.css` per S7.
   - `highlightFor` must add nothing to `glow` that isn't already in `legalIds`.
5. **responsive-board.**
   - Implement S6's `Board`/`Zone`/`Hand` rows and S11.
   - Board imports: `./board.css`, `./highlights.css`, `{ glowAttr, hasMovesLeft }` from
     `./glow.ts`, and `{ SettingsButton, useSetting }` from `../settings/index.ts`.
   - Stop passing `draggable` from `Zone.tsx`/`Hand.tsx`, and remove `onDragOver`/`onDrop` from
     `Zone.tsx` and `Board.tsx`.
   - `Hand.tsx` keeps local lift state, cleared by a `pointerdown` outside `hand-you` and when
     the card leaves the hand.
   - The confirm-end-turn arm state lives in `Board` and resets when `view` changes.
   - Keep every px `width`/`min-width` in `board.css` at or below 390 px.
   - Tune `--card-h` per query until B28–B32 hold.

## SPEC changes

**§10.8**: append after the existing paragraph:

> The viewer's own cards also carry Hearthstone's yellow glow as `conditionActive: true`:
> a card in the viewer's hand during the viewer's own main phase with no prompt open, and a unit
> or backrow card the viewer controls, whenever the card's script `conditionMet` holds (§10.9,
> R195). The key is absent otherwise, never `false`, and never set on the opponent's cards.

**§10.9**: in the `Script` listing, after `modes?`, add `conditionMet?`. After
"(`targets` and `modes` declare the card's play-time choices, R81)" insert:

> (`conditionMet` is R195's read-only predicate: no writes, no random draws. It answers whether
> the card's printed condition holds now for its controller, asked with `zone: 'hand'` as if the
> card were played now and with `zone: 'field'` as the card on the field reads it, and `viewFor`
> surfaces it as `conditionActive`, §10.8)

Then, after "plus a replay test that folds the recorded log and compares the final state hash",
add:

> ; a card with `conditionMet` also tests both answers of it against the branch its own
> resolution takes (R195)

**§11 R195** (a new row after R170, in numeric position):

> | R195 | When a card glows yellow (`conditionActive`) | Hearthstone lights a playable card
> yellow when its special condition is met; §10.8 did not say whether the view may carry that. It
> does, as `conditionActive: true` on the **viewer's own** cards only, computed by the engine and
> never by the client (CLAUDE.md rule 7). A card whose script declares `conditionMet` (§10.9) is
> asked with `zone: "hand"` for a card in the viewer's hand, and only during the viewer's own main
> phase with no prompt open and no result, the only time it could be played. It is asked with
> `zone: "field"` for a unit on top of its pile or a backrow card the viewer controls. The flag is
> absent otherwise (never `false`) and never set on the opponent's cards. A hook reads only what
> its controller may see (§9.1), so it reveals nothing. A hook is a pure read (no writes, no
> random draws) and must agree with the branch the card's own resolution would take if it
> resolved now. The Core cards with a printed condition implement it: #10 (Combo 3: three or more
> cards played earlier this turn, in hand), #53 (your hero below 30, radiant 60, in hand), #68
> (your hero below 10, in hand), #71 (your library larger than the opponent's, in hand and on the
> field) and #93 (on the field, during its controller's turn, when the cards played reach its
> grade and it is not at S). Scaling amounts (#70), conditions a player modifier grants to other
> cards (#38, #64, #78), trap triggers that wait for an event, and cost reductions (#100) are not
> conditions for this flag | §10.8, §10.9, #10, #53, #68, #71, #93 |

**§10.9** (fix stage): the `conditionMet` parenthetical ends "…surfaces it as `conditionActive`,
§10.8; a fusion's hook is its ingredients' hooks or-ed, R196)".

**§11 R196** (fix stage, after R195):

> | R196 | How a fused card glows yellow | R77 fuses two or three cards into one definition whose Cry,
> Death and trigger lists run every ingredient's in turn, so each ingredient's printed condition
> still picks its own branch when the fused card resolves; R195 did not say whether such a card
> glows. It does when **any** ingredient's condition holds … | §6.3, §10.9, R77, R102, R195 |

No other section changes. §10.10 belongs to task 1.

## Risks

- **`Card.tsx` merge with task 6.** Merge order is 6 → 7, so 6's rewrite lands first and this
  branch's two root attributes plus one import are re-applied by hand. Task 6's card CSS may also
  set `box-shadow`/`overflow` on `.card`, which would hide the glow. The integration check is
  B18's component spec.
- **CSS cascade.** `animations.css` (task 1) is imported after `highlights.css` and may override
  `box-shadow` mid-animation. That is acceptable while an element animates, but task 1 must not
  set a persistent `box-shadow` on `[data-legal]`/`.card`.
- **Long-press versus drag.** On touch, task 6's long-press inspect must cancel once the pointer
  moves `DRAG_THRESHOLD_PX`, or a drag will also open the inspect sheet. Checked at integration.
- **Clicks after a drag.** Pointer capture makes Chrome send the post-drag `click` to the source,
  which would toggle the selection back. The capture-phase click swallow (S9) prevents that, and
  B38 tests it.
- **Cypress actionability.**
  - An overlapping fan would make `cy.click()` on a hand card hit its neighbour. Specs run at
    1280×720, where B30 forbids overlap. A phone-width e2e click on a hand card is not supported.
  - A lifted hand card must not cover `hero-you` or `power` at desktop. It is kept inside the
    hand's padding.
- **Vertical budget.** Route chrome outside `Board` (`match-bar`, `hotseat-bar`, the turn banner
  and draw toast in `Game.tsx`) takes height the board once did not account for. The fix stage
  budgets the whole screen (S11) and B46 measures it with the match and hotseat chrome mounted.
  The per-layout "fixed parts" constants in board.css are measured on the crowded fixture board
  (seats with modifiers, a resolving card, armor); a seat that wraps further (a much narrower
  screen, a longer hero power) can still push the board a few pixels past the screen, and the
  page then scrolls rather than clipping. `:has()` and container units need Safari 16 / Chrome
  105 / Firefox 121.
- **Shared-file conflicts.**
  - `Game.tsx` (tasks 1, 2, 3), `nav.tsx` (task 5), `viewFor.ts`/`view.ts` (tasks 3, 4) and the
    SPEC/rulings index row positions (every task) can conflict line-for-line. Each edit here is
    one import plus one line, or one row, to keep resolution mechanical.
  - `actions.ts` and `contract.ts` are claimed by this task; the PR must say so.
  - The fix stage also touched `Log.tsx` (auto-scroll; task 4 edits it too),
    `packages/engine/src/subsystems/fuse.ts` (R196) and `Game.tsx` a second time (B41). The PR's
    merge notes list all three.
- **Settings defaults.** A `confirmEndTurn` default of `true`, or a drag that swallows plain
  clicks, would break every e2e spec. B19 pins the default and B39 pins click-through.
- **Hook discipline.** A `conditionMet` that throws would crash `viewFor` on the server. Hooks
  are one-line reads over engine query helpers, and B5–B9 run each hook in every scenario. The
  fuzz suite needs no change, since it never reaches these hooks with bad input shapes.
- **Hidden information.** A future hook could read a zone its controller can't see. R195 forbids
  that in words, but only review enforces it. The Core hooks read hero health, library counts,
  plays this turn and a grade, all of which the controller may see.

## Integration note: what the panel mounts

`SETTINGS_SLOTS` mounts task 1's effects speed and intensity and task 6's animated foil under
Visuals (`settings/controls.tsx`), and task 2's `AudioControls` under Audio, whose checkboxes the
panel draws as its switches. Each slot carries a `reset`, so "Reset to defaults" resets every store
the panel shows. Two settings stay one switch each: task 6's store has a `hoverPreviews` too, and its
enlarged preview now opens only while this panel's "Hover previews" is on as well; task 1's store
has a `motion`, and `reducedMotionNow` (and the effects layer, and practice's pacing) read this
panel's "Reduce motion" beside it. index.css keys animations.css's reduced-motion block on
`data-reduce-motion`, so the setting stops CSS motion on every screen, and `main.tsx` reads the store
at boot so the attribute is there from the first paint. Engine prompts no longer offer Cancel (it did
nothing); the mulligan opens with every card kept, shows each card's live cost, and stamps each
option Keep or Redraw; the waiting modal says "Your opponent is choosing." rather than a seat id;
and a list picker names a card's place ("Enemy unit, lane 2") rather than its instance id.
