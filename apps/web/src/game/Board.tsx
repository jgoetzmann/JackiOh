// The board (BUILD M5-T1): five lanes as columns, two seats, two hands, the control bar and the
// log — all of it drawn from one `PlayerView` (CLAUDE.md rule 7, SPEC §10.8).
//
// `viewFor` has already oriented the view, so the DOM speaks in "you" and "opponent" and the
// board never has to know which seat is which. Nothing here decides anything: every clickable
// element takes `data-legal` from `props.highlight.legal` (built by `actions.ts` from the
// engine's `legalActions`) and fires `props.onClick` only when that says true. With the default
// `NO_HIGHLIGHT` the whole board is greyed out, which is the honest default for "the client has
// not been told what is legal".

import type { ReactElement } from "react";

import type { CardView, GameEventType, PlayerId, PlayerView, Row } from "@jackioh/shared";

import { animTestid } from "./animations.ts";
import Card, { allowDrop, cx, isLegal, isSelected, legalAttr, type Pops } from "./Card.tsx";
import {
  LANES,
  NO_HIGHLIGHT,
  playerOf,
  sideOf,
  sideView,
  testid,
  type AnimatingMap,
  type BoardControl,
  type BoardProps,
  type Highlight,
  type Side,
} from "./contract.ts";
import Hand from "./Hand.tsx";
import Hero from "./Hero.tsx";
import Log from "./Log.tsx";
import Zone from "./Zone.tsx";

import "./board.css";

/** Top to bottom in every lane column (BUILD M5-T1). */
const FIELD_ROWS: readonly { side: Side; row: Row }[] = [
  { side: "opponent", row: "backrow" },
  { side: "opponent", row: "units" },
  { side: "you", row: "units" },
  { side: "you", row: "backrow" },
];

/**
 * ASSUMPTION, recorded because `contract.ts` has no entry for them: the per-side pile, hand and
 * mana counters use the ids `e2e/support/testids.ts` already assumes —
 * `library-count-<side>`, `graveyard-count-<side>`, `exile-count-<side>`, `hand-count-<side>`,
 * `mana-<side>` — so the specs and the board agree. Adding them to `testid` would be tidier.
 */
function countId(pile: "library" | "graveyard" | "exile", side: Side): string {
  return `${pile}-count-${side}`;
}

// ---------------------------------------------------------------------------------------------
// Animation hooks: `.damage-pop`, `.heal-pop` and `.loss-pop` take their text from the event the
// runner is currently animating on that element (BUILD M5-T4). The board does not time anything;
// it pairs `props.animating` (testid → event type) with the matching event in `view.events` so
// the pop can show the amount, and shows nothing when the element is not animating.
// ---------------------------------------------------------------------------------------------

const POP_EVENTS: readonly GameEventType[] = ["damage", "healed", "healthLost"];

function heroTargetId(view: PlayerView, testId: string): PlayerId | null {
  if (testId === testid.hero("you")) return playerOf(view, "you");
  if (testId === testid.hero("opponent")) return playerOf(view, "opponent");
  return null;
}

function amountFor(view: PlayerView, testId: string, type: GameEventType): number | undefined {
  const player = heroTargetId(view, testId);
  const instanceId = testId.startsWith("card-") ? testId.slice("card-".length) : null;
  // The last matching event wins: the runner animates them in order.
  for (let index = view.events.length - 1; index >= 0; index -= 1) {
    const event = view.events[index];
    if (event === undefined || event.type !== type) continue;
    if (event.type === "healthLost") {
      if (player !== null && event.player === player) return event.amount;
      continue;
    }
    if (event.type === "damage" || event.type === "healed") {
      if (instanceId !== null && event.targetId === instanceId) return event.amount;
      if (player !== null && event.targetId === `hero-${player}`) return event.amount;
    }
  }
  return undefined;
}

export function popsFrom(view: PlayerView, animating: AnimatingMap | undefined): ReadonlyMap<string, Pops> {
  const pops = new Map<string, Pops>();
  if (animating === undefined) return pops;
  for (const [testId, type] of animating) {
    if (!POP_EVENTS.includes(type)) continue;
    const amount = amountFor(view, testId, type);
    if (amount === undefined) continue;
    const current = pops.get(testId) ?? {};
    pops.set(
      testId,
      type === "damage"
        ? { ...current, damage: amount }
        : type === "healed"
          ? { ...current, heal: amount }
          : { ...current, loss: amount },
    );
  }
  return pops;
}

function ManaTray({ side, mana, animating }: { side: Side; mana: { current: number; max: number }; animating?: AnimatingMap }): ReactElement {
  const testId = `mana-${side}`;
  const crystals = Math.max(mana.max, mana.current);
  return (
    <span
      className="mana"
      data-testid={testId}
      data-current={mana.current}
      data-max={mana.max}
      data-animating={animating?.get(testId)}
      title={`Mana ${mana.current}/${mana.max}`}
    >
      <span className="crystals">
        {Array.from({ length: crystals }, (_unused, index) => (
          // `.mana-crystal` is the class the M5-T4 acceptance row and e2e read; `.crystal` is the
          // shorter alias the animation table's prose uses. Both sit on every crystal.
          <span key={index} className="mana-crystal crystal" data-filled={index < mana.current ? "true" : "false"} />
        ))}
      </span>
      <span className="mana-text">
        {mana.current}/{mana.max}
      </span>
    </span>
  );
}

/**
 * A library / graveyard / exile pile. Two testids, two consumers: `regionId` is the element the
 * M5-T4 animation table moves (`animTestid.library` and friends), `testId` is the number the e2e
 * specs read (`library-count-<side>` in `e2e/support/testids.ts`). They are different elements
 * because the count must not be the thing that pulses.
 */
function Pile({
  label,
  regionId,
  testId,
  count,
  fatigue,
  animating,
}: {
  label: string;
  regionId: string;
  testId: string;
  count: number;
  fatigue?: number;
  animating?: AnimatingMap;
}): ReactElement {
  return (
    <span
      className="pile"
      title={label}
      data-testid={regionId}
      data-fatigue={fatigue}
      data-animating={animating?.get(regionId)}
    >
      <span className="pile-label">{label}</span>
      <span className="pile-n" data-testid={testId}>
        {count}
      </span>
    </span>
  );
}

function Seat({
  view,
  side,
  highlight,
  animating,
  onClick,
  onControl,
  pops,
}: {
  view: PlayerView;
  side: Side;
  highlight: Highlight;
  animating?: AnimatingMap;
  onClick?: BoardProps["onClick"];
  onControl?: BoardProps["onControl"];
  pops: ReadonlyMap<string, Pops>;
}): ReactElement {
  const seat = sideView(view, side);
  return (
    <div className={cx("seat", `seat-${side}`)} data-side={side} data-player={seat.player}>
      <Hero
        view={view}
        side={side}
        highlight={highlight}
        animating={animating}
        onClick={onClick}
        onControl={onControl}
        pops={pops.get(testid.hero(side))}
      />
      <ManaTray side={side} mana={seat.mana} animating={animating} />
      <span className="piles">
        <Pile
          label="Library"
          regionId={animTestid.library(side)}
          testId={countId("library", side)}
          count={seat.libraryCount}
          fatigue={seat.fatigueCount}
          animating={animating}
        />
        <Pile
          label="Graveyard"
          regionId={animTestid.graveyard(side)}
          testId={countId("graveyard", side)}
          count={seat.graveyard.length}
          animating={animating}
        />
        <Pile
          label="Exile"
          regionId={animTestid.exile(side)}
          testId={countId("exile", side)}
          count={seat.exile.length}
          animating={animating}
        />
      </span>
      {/* R98: a card mid-resolution is public and still itself, so it is shown rather than
          vanishing between its play and its graveyard. It is not a click target — `ClickTarget`
          has no member for the resolving zone, and nothing in `legalActions` points at one. */}
      {(seat.resolving ?? []).length > 0 && (
        <span className="resolving" data-testid={`resolving-${side}`}>
          {(seat.resolving ?? []).map((card) => (
            <Card
              key={card.instanceId}
              testId={testid.card(card.instanceId)}
              card={card}
              className="card-resolving"
              highlight={highlight}
              animating={animating}
            />
          ))}
        </span>
      )}
    </div>
  );
}

function ControlButton({
  control,
  testId,
  label,
  highlight,
  animating,
  onControl,
}: {
  control: BoardControl;
  testId: string;
  label: string;
  highlight: Highlight;
  animating?: AnimatingMap;
  onControl?: (control: BoardControl) => void;
}): ReactElement {
  const legal = isLegal(highlight, testId);
  return (
    <button
      type="button"
      className={cx("control", `control-${control}`)}
      data-testid={testId}
      data-legal={legalAttr(legal)}
      data-selected={isSelected(highlight, testId) ? "true" : undefined}
      data-animating={animating?.get(testId)}
      aria-disabled={legal ? undefined : "true"}
      // BUILD M5-T4 `turnEnded` asserts the end-turn button is disabled, so the real attribute
      // goes on alongside `aria-disabled`. Either way an illegal control fires nothing.
      disabled={!legal}
      onClick={() => {
        if (!legal) return;
        onControl?.(control);
      }}
    >
      {label}
    </button>
  );
}

export default function Board({ view, highlight = NO_HIGHLIGHT, animating, onClick, onControl }: BoardProps): ReactElement {
  const pops = popsFrom(view, animating);
  const yourHand: CardView[] | { count: number } = view.you.hand;

  return (
    <div
      className="board"
      data-testid={testid.board}
      data-phase={view.phase}
      data-turn={view.turn}
      data-active={sideOf(view, view.active)}
      data-viewer={view.viewer}
      onDragOver={allowDrop}
    >
      <Seat
        view={view}
        side="opponent"
        highlight={highlight}
        animating={animating}
        onClick={onClick}
        onControl={onControl}
        pops={pops}
      />
      <Hand side="opponent" hand={view.opponent.hand} highlight={highlight} animating={animating} onClick={onClick} />

      <div className="field" aria-label="Field">
        {LANES.map((lane) => (
          <div className="lane" key={lane} data-lane={lane}>
            {FIELD_ROWS.map((slot) => (
              <Zone
                key={`${slot.side}-${slot.row}`}
                view={view}
                side={slot.side}
                row={slot.row}
                lane={lane}
                highlight={highlight}
                animating={animating}
                onClick={onClick}
                pops={pops}
              />
            ))}
          </div>
        ))}
      </div>

      <Seat view={view} side="you" highlight={highlight} animating={animating} onClick={onClick} onControl={onControl} pops={pops} />
      <Hand side="you" hand={yourHand} highlight={highlight} animating={animating} onClick={onClick} />

      <div className="control-bar" aria-label="Controls">
        <ControlButton control="end-turn" testId={testid.endTurn} label="End turn" highlight={highlight} animating={animating} onControl={onControl} />
        <ControlButton control="offer-draw" testId={testid.offerDraw} label="Offer draw" highlight={highlight} animating={animating} onControl={onControl} />
        <ControlButton control="concede" testId={testid.concede} label="Concede" highlight={highlight} animating={animating} onControl={onControl} />
        {view.clockMs !== null && <span className="clock">{Math.ceil(view.clockMs / 1000)}s</span>}
      </div>

      <Log view={view} />
    </div>
  );
}
