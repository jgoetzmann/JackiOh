// The board (BUILD M5-T1): five lanes as columns, two seats, two hands, the control bar and the
// log — all of it drawn from one `PlayerView` (CLAUDE.md rule 7, SPEC §10.8).
//
// `viewFor` has already oriented the view, so the DOM speaks in "you" and "opponent" and the
// board never has to know which seat is which. Nothing here decides anything: every clickable
// element takes `data-legal` from `props.highlight.legal` (built by `actions.ts` from the
// engine's `legalActions`) and fires `props.onClick` only when that says true. With the default
// `NO_HIGHLIGHT` the whole board is greyed out, which is the honest default for "the client has
// not been told what is legal".
//
// Polish task 7 (docs/polish/7-mobile-ux.md S6, S11): the green glow is `data-glow`, written from
// `highlight.glow` (a subset of `legal`); `data-legal` stays the only click gate. The board reads
// two settings: `dragToPlay` becomes `data-drag` on the root (drag.css keys touch-action off it),
// and `confirmEndTurn` makes End turn ask twice while something is still playable (Hand.tsx reads
// the third, `hoverPreviews`). The layout itself is board.css's grid, which keeps the children
// below in this order. A phone has no room for the log beside the field, so board.css hides it
// there and shows `log-toggle` instead, which opens it over the top of the board
// (`data-log="open"`) until it is pressed again.

import { useContext, useState, type KeyboardEvent, type MouseEvent, type ReactElement, type ReactNode } from "react";

import type { CardView, GameEvent, GameEventType, PlayerId, PlayerView, Row } from "@jackioh/shared";

import { animTestid } from "./animations.ts";
import Card, { cx, isLegal, isSelected, legalAttr, type Pops } from "./Card.tsx";
import { CatalogContext, MatchCardsProvider } from "./catalog.ts";
import {
  LANES,
  NO_HIGHLIGHT,
  playerOf,
  sideOf,
  sideView,
  testid,
  type AnimatingMap,
  type AnimationFrames,
  type BoardControl,
  type BoardProps,
  type Highlight,
  type Side,
} from "./contract.ts";
import Hand from "./Hand.tsx";
import Hero from "./Hero.tsx";
import Log from "./Log.tsx";
import { BurnNotice, PileNotice, noticesFrom, type OverflowNotices } from "./OverflowNotices.tsx";
import Zone from "./Zone.tsx";
import { listedFace } from "./faces.ts";
import { glowAttr, hasMovesLeft } from "./glow.ts";
import { CardListPreview, CardListSheet, useInspectTrigger, type CardListEntry, type InspectOverlayState } from "../cards/index.ts";
import { SettingsButton, useSetting } from "../settings/index.ts";
import AudioToggle from "../audio/AudioToggle.tsx";

// Order matters: highlights.css paints the glow over board.css's borders (S7).
import "./board.css";
import "./highlights.css";
import "./inspectable.css";

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

function amountFor(
  view: PlayerView,
  events: readonly GameEvent[],
  testId: string,
  type: GameEventType,
): number | undefined {
  const player = heroTargetId(view, testId);
  const instanceId = testId.startsWith("card-") ? testId.slice("card-".length) : null;
  // The last matching event wins: the runner animates them in order.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
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

/**
 * The numbers to pop, one entry of the current burst at a time.
 *
 * `animated` is what the runner has played since the board last caught up; each entry knows both
 * the elements it marks and the events it is playing, and the amount comes from the latter. It
 * cannot come from `view`: that is the view the runner is still HOLDING BACK (BUILD M5-T4), so by
 * definition it does not yet carry the event being animated. Keeping the whole burst rather than
 * only the entry in flight is what lets both halves of a trade stand on screen together.
 *
 * A caller with no burst to hand falls back to "whatever is animating, against the shown view",
 * which is what a board rendered straight out of a fixture wants.
 */
export function popsFrom(
  view: PlayerView,
  animating: AnimatingMap | undefined,
  animated?: readonly AnimationFrames[],
): ReadonlyMap<string, Pops> {
  const pops = new Map<string, Pops>();
  const sources: readonly AnimationFrames[] =
    animated ?? (animating === undefined ? [] : [{ frames: animating, events: view.events }]);
  for (const source of sources) {
    for (const [testId, type] of source.frames) {
      if (!POP_EVENTS.includes(type)) continue;
      const amount = amountFor(view, source.events, testId, type);
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
 *
 * A graveyard or an exile pile is public on both seats (§10.8: `SideView.graveyard` and `.exile` are
 * full `CardView` lists), so either one can be looked through (`browse`): a resting mouse opens a
 * preview of its newest cards, and a click, a tap, a long-press or Enter opens every card in a
 * sheet, newest first. The library is a count and nothing else, so it has no `browse`.
 */
type PileBrowse = { title: string; cards: readonly CardView[]; view: PlayerView };

function Pile({
  label,
  regionId,
  testId,
  count,
  fatigue,
  animating,
  browse,
  children,
}: {
  label: string;
  regionId: string;
  testId: string;
  count: number;
  fatigue?: number;
  animating?: AnimatingMap;
  browse?: PileBrowse;
  /** R318: the pile's overflow notice (OverflowNotices.tsx), drawn inside it. */
  children?: ReactNode;
}): ReactElement {
  const lookup = useContext(CatalogContext);
  const hoverPreviews = useSetting("hoverPreviews");
  // Newest first: a pile grows at its end (the engine appends each card that lands in it).
  const entries: CardListEntry[] = [];
  if (browse !== undefined) {
    for (let at = browse.cards.length - 1; at >= 0; at -= 1) {
      const card = browse.cards[at];
      const face = card === undefined ? null : listedFace(lookup, browse.view, card);
      if (card !== undefined && face !== null) entries.push({ key: card.instanceId, face });
    }
  }
  const title = browse?.title ?? label;
  const browsable = entries.length > 0;
  const inspect = useInspectTrigger(
    browsable
      ? {
          key: `pile-${regionId}`,
          render: ({ mode, anchor, close }: InspectOverlayState) =>
            mode === "hover" ? (
              <CardListPreview title={title} entries={entries} anchor={anchor} />
            ) : (
              <CardListSheet title={title} entries={entries} onClose={close} />
            ),
        }
      : null,
  );

  const open = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>): void => {
    inspect.openSheet(event.currentTarget);
  };

  return (
    <>
      <span
        {...(browsable ? inspect.handlers : {})}
        className={cx("pile", browsable && "pile--browsable")}
        // The preview replaces the native tooltip; with previews off, the label comes back.
        title={browsable && hoverPreviews ? undefined : label}
        data-testid={regionId}
        data-fatigue={fatigue}
        data-animating={animating?.get(regionId)}
        data-browsable={browsable ? "true" : undefined}
        role={browsable ? "button" : undefined}
        tabIndex={browsable ? 0 : undefined}
        aria-haspopup={browsable ? "dialog" : undefined}
        aria-label={browsable ? `${title}: ${String(count)} ${count === 1 ? "card" : "cards"}. Show them` : undefined}
        onClick={browsable ? open : undefined}
        onKeyDown={
          browsable
            ? (event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                open(event);
              }
            : undefined
        }
      >
        <span className="pile-label">{label}</span>
        <span className="pile-n" data-testid={testId}>
          {count}
        </span>
        {children}
      </span>
      {inspect.overlay}
    </>
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
  notices,
}: {
  view: PlayerView;
  side: Side;
  highlight: Highlight;
  animating?: AnimatingMap;
  onClick?: BoardProps["onClick"];
  onControl?: BoardProps["onControl"];
  pops: ReadonlyMap<string, Pops>;
  notices: OverflowNotices;
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
        >
          <PileNotice notice={notices.pile.get(side)} side={side} view={view} />
        </Pile>
        <Pile
          label="Graveyard"
          regionId={animTestid.graveyard(side)}
          testId={countId("graveyard", side)}
          count={seat.graveyard.length}
          animating={animating}
          browse={{ title: side === "you" ? "Your graveyard" : "Opponent's graveyard", cards: seat.graveyard, view }}
        />
        <Pile
          label="Exile"
          regionId={animTestid.exile(side)}
          testId={countId("exile", side)}
          count={seat.exile.length}
          animating={animating}
          browse={{ title: side === "you" ? "Your exile" : "Opponent's exile", cards: seat.exile, view }}
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
  confirm,
  onPress,
}: {
  control: BoardControl;
  testId: string;
  label: string;
  highlight: Highlight;
  animating?: AnimatingMap;
  /** `"armed"` while End turn is waiting for its confirming second click (B25). */
  confirm?: "armed";
  onPress: () => void;
}): ReactElement {
  const legal = isLegal(highlight, testId);
  return (
    <button
      type="button"
      className={cx("control", `control-${control}`)}
      data-testid={testId}
      data-legal={legalAttr(legal)}
      data-glow={glowAttr(highlight, testId)}
      data-confirm={confirm}
      data-selected={isSelected(highlight, testId) ? "true" : undefined}
      data-animating={animating?.get(testId)}
      aria-disabled={legal ? undefined : "true"}
      // BUILD M5-T4 `turnEnded` asserts the end-turn button is disabled, so the real attribute
      // goes on alongside `aria-disabled`. Either way an illegal control fires nothing.
      disabled={!legal}
      onClick={() => {
        if (!legal) return;
        onPress();
      }}
    >
      {label}
    </button>
  );
}

export default function Board({
  view,
  highlight = NO_HIGHLIGHT,
  animating,
  animated,
  onClick,
  onControl,
}: BoardProps): ReactElement {
  const pops = popsFrom(view, animating, animated);
  // R318: fatigue and a full library on a library pile, a full hand over a hand, as the pops are.
  const notices = noticesFrom(view, animating, animated);
  const burnNotice = (side: Side): ReactElement => <BurnNotice notice={notices.burn.get(side)} side={side} view={view} />;
  const yourHand: CardView[] | { count: number } = view.you.hand;
  const dragToPlay = useSetting("dragToPlay");
  const confirmEndTurn = useSetting("confirmEndTurn");

  // B25: the confirm is armed FOR a view. Any new view (the engine moved, the turn changed, an
  // animation caught up) is a different object, so it disarms without an effect.
  const [armedFor, setArmedFor] = useState<PlayerView | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const needsConfirm = confirmEndTurn && hasMovesLeft(highlight);
  const armed = needsConfirm && armedFor === view;

  function pressEndTurn(): void {
    if (needsConfirm && !armed) {
      setArmedFor(view);
      return;
    }
    setArmedFor(null);
    onControl?.("end-turn");
  }

  // R243: the match-made definitions and field powers this view names, for every card drawn below.
  return (
    <MatchCardsProvider view={view}>
      <div
        className="board"
        data-testid={testid.board}
        data-phase={view.phase}
        data-turn={view.turn}
        data-active={sideOf(view, view.active)}
        data-viewer={view.viewer}
        data-drag={dragToPlay ? "on" : "off"}
        data-log={logOpen ? "open" : undefined}
      >
        <Seat
          view={view}
          side="opponent"
          highlight={highlight}
          animating={animating}
          onClick={onClick}
          onControl={onControl}
          pops={pops}
          notices={notices}
        />
        <Hand side="opponent" hand={view.opponent.hand} highlight={highlight} animating={animating} onClick={onClick} notice={burnNotice("opponent")} />

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

        <Seat view={view} side="you" highlight={highlight} animating={animating} onClick={onClick} onControl={onControl} pops={pops} notices={notices} />
        <Hand side="you" hand={yourHand} highlight={highlight} animating={animating} onClick={onClick} notice={burnNotice("you")} />

        <div className="control-bar" aria-label="Controls">
          {/* Whose turn, above End turn wherever the controls have a column of their own (board.css
              hides it on a phone held upright, where the shell's banner says it). The banner is the
              live region, so this copy stays out of the accessibility tree. */}
          <div
            className="turn-plate"
            data-side={view.result !== null ? "over" : sideOf(view, view.active)}
            aria-hidden="true"
          >
            <span className="turn-plate-number">Turn {view.turn}</span>
            <span className="turn-plate-whose">
              {view.result !== null
                ? "Game over"
                : view.phase === "mulligan"
                  ? "Mulligan"
                  : view.active === view.viewer
                    ? "Your turn"
                    : "Opponent's turn"}
            </span>
          </div>
          <ControlButton
            control="end-turn"
            testId={testid.endTurn}
            label={armed ? "Confirm end turn" : "End turn"}
            highlight={highlight}
            animating={animating}
            confirm={armed ? "armed" : undefined}
            onPress={pressEndTurn}
          />
          <ControlButton
            control="offer-draw"
            testId={testid.offerDraw}
            label="Offer draw"
            highlight={highlight}
            animating={animating}
            onPress={() => onControl?.("offer-draw")}
          />
          <ControlButton
            control="concede"
            testId={testid.concede}
            label="Concede"
            highlight={highlight}
            animating={animating}
            onPress={() => onControl?.("concede")}
          />
          {view.clockMs !== null && <span className="clock">{Math.ceil(view.clockMs / 1000)}s</span>}
          {/* Phones only (board.css): the log's own place on the board is hidden there. */}
          <button
            type="button"
            className="log-toggle"
            data-testid="log-toggle"
            aria-expanded={logOpen}
            aria-label={logOpen ? "Hide the game log" : "Show the game log"}
            title="Game log"
            onClick={() => setLogOpen((open) => !open)}
          >
            <span className="log-toggle-icon" aria-hidden="true" />
          </button>
          {/* Task 2's mute, beside the gear that holds the rest of its controls: a fixed corner button
              sat on the practice HUD's Menu and the match bar's clock (integration). */}
          <AudioToggle className="audio-toggle--bar" />
          <SettingsButton placement="game" />
        </div>

        <Log view={view} revealed={logOpen} />
      </div>
    </MatchCardsProvider>
  );
}
