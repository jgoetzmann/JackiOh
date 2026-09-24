// The face of a card, and the interaction vocabulary every other board component shares
// (BUILD M5-T1).
//
// A card renders `CardView` / `UnitView` and nothing else (CLAUDE.md rule 7, SPEC §10.8). When
// `card` is `null` it draws a back: `BackrowView { faceDown: true }` and the opponent's hand
// carry no identity at all, so there is nothing to leak and nothing to key a testid off.
//
// No rule lives here. `legal` is "is my testid in `props.highlight.legal`", which came from the
// engine's `legalActions`; the card never asks whether an attack is possible, whether a cost is
// affordable, or whether `canAct` / `usedThisTurn` permits anything. Those fields are drawn as
// state, never consulted as permission.
//
// What it draws is the card presentation module's (apps/web/src/cards, docs/polish/6-cards.md): a
// back, the board minion, or a tall Hearthstone-style face (full in the hand and the resolving
// strip, compact in the backrow). This file keeps the root element and everything the tests, the
// e2e specs and the animation table read off it; the face inside is `.cf`, which ignores the
// pointer, so the root and the badges drawn beside it take every click.
//
// The face is the card in play (faces.ts, SPEC §10.10): what the view says it is now — a hand
// Unit's grown stats (#89), a unit's numbers and keywords, the Vanilla mark, a Heroic Power's rolled
// power — and a match-made card (a Fuse's) reads its definition from the view (`MatchCardsContext`,
// R243) where the catalog has none.

import type { DragEvent, KeyboardEvent, MouseEvent, ReactElement } from "react";

import type { CardType, CardView, PlayerId, UnitView } from "@jackioh/shared";

import {
  CardBack,
  CardFace,
  MinionFace,
  faceModel,
  useCardSettings,
  useInspectTrigger,
  type FaceModel,
} from "../cards/index.ts";
import { useCardInfo, useFieldPower } from "./catalog.ts";
import { liveFace } from "./faces.ts";
import { NO_HIGHLIGHT, testid, type AnimatingMap, type ClickTarget, type Highlight } from "./contract.ts";
import { conditionAttr, glowAttr } from "./glow.ts";
import { useSetting } from "../settings/store.ts";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(" ");
}

export function isLegal(highlight: Highlight | undefined, testId: string | undefined): boolean {
  if (testId === undefined) return false;
  return (highlight ?? NO_HIGHLIGHT).legal.has(testId);
}

export function isSelected(highlight: Highlight | undefined, testId: string | undefined): boolean {
  if (testId === undefined) return false;
  return (highlight ?? NO_HIGHLIGHT).selected.has(testId);
}

/** `data-legal` is the only gate on firing `onClick`; see the drag note below. */
export function legalAttr(legal: boolean): "true" | "false" {
  return legal ? "true" : "false";
}

// ---------------------------------------------------------------------------------------------
// Drag-to-attack. A drop reports two clicks — the dragged source, then what it landed on — so
// click-click and drag reach `actions.ts` through one path (BUILD M5-T2).
//
// The source is gated on its own `data-legal` at `dragstart`. The drop target is not: no click
// has been dispatched yet when `drop` runs, so the target's `data-legal` still describes the
// board *before* the source was picked up and would refuse every drag-attack. The consumer sees
// the same two clicks it would see from click-click and resolves them against `legalActions`.
// ---------------------------------------------------------------------------------------------

export const DRAG_MIME = "application/x-jackioh-target";

export function encodeTarget(target: ClickTarget): string {
  return JSON.stringify(target);
}

export function decodeTarget(raw: string): ClickTarget | null {
  if (raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "on" in parsed) return parsed as ClickTarget;
    return null;
  } catch {
    return null;
  }
}

export function beginDrag(event: DragEvent<HTMLElement>, legal: boolean, target: ClickTarget | null | undefined): void {
  if (!legal || target === null || target === undefined) {
    event.preventDefault();
    return;
  }
  event.dataTransfer.setData(DRAG_MIME, encodeTarget(target));
  event.dataTransfer.effectAllowed = "move";
}

export function allowDrop(event: DragEvent<HTMLElement>): void {
  const types: readonly string[] = Array.from(event.dataTransfer.types);
  if (types.includes(DRAG_MIME)) event.preventDefault();
}

export function completeDrop(
  event: DragEvent<HTMLElement>,
  target: ClickTarget | null | undefined,
  onClick: ((target: ClickTarget) => void) | undefined,
): void {
  if (target === null || target === undefined) return;
  const source = decodeTarget(event.dataTransfer.getData(DRAG_MIME));
  if (source === null) return;
  event.preventDefault();
  event.stopPropagation();
  onClick?.(source);
  onClick?.(target);
}

// ---------------------------------------------------------------------------------------------
// Animation hooks (BUILD M5-T4). The runner owns timing; the board only owns the DOM it needs.
// The numbers come from the events in the view that match the element the runner marked as
// animating, so `.damage-pop` text equals the amount in the `damage` event.
// ---------------------------------------------------------------------------------------------

export type Pops = { damage?: number; heal?: number; loss?: number };

export function PopLayer({ pops }: { pops?: Pops }): ReactElement | null {
  if (pops === undefined) return null;
  const { damage, heal, loss } = pops;
  if (damage === undefined && heal === undefined && loss === undefined) return null;
  return (
    <span className="pop-layer" aria-hidden="true">
      {damage !== undefined && <span className="damage-pop">{damage}</span>}
      {heal !== undefined && <span className="heal-pop">{heal}</span>}
      {loss !== undefined && <span className="loss-pop">{loss}</span>}
    </span>
  );
}

export type CardProps = {
  /** Absent for a face-down back: the view gives it no instance id, so it has no testid. */
  testId?: string;
  /** `null` draws a back and renders no name, no def id and no stats (SPEC §10.8). */
  card: CardView | null;
  /** Present for a unit: stats, position, keywords, counters, Stack pile depth. */
  unit?: UnitView | null;
  /** A face-up backrow card's type, straight off `BackrowView`. */
  type?: CardType;
  /** R33: a public card names its owner and its controller; they differ after a steal or a swap. */
  owner?: PlayerId;
  controller?: PlayerId;
  counters?: { plague?: number; grade?: number };
  /** What a click reports. Absent means the element is not clickable and clicks bubble. */
  target?: ClickTarget | null;
  /** Units carry the switch-position button (BUILD M5-T2). */
  switchTarget?: boolean;
  draggable?: boolean;
  highlight?: Highlight;
  animating?: AnimatingMap;
  onClick?: (target: ClickTarget) => void;
  pops?: Pops;
  className?: string;
};

/** Which face a card draws, straight from its props (docs/polish/6-cards.md, "Card.tsx"). */
type Form = "back" | "minion" | "compact" | "full";

function formOf(card: CardView | null, unit: UnitView | null | undefined, type: CardType | undefined): Form {
  if (card === null) return "back";
  if (unit !== undefined && unit !== null) return "minion";
  if (type !== undefined) return "compact";
  return "full";
}

export default function Card(props: CardProps): ReactElement {
  const { card, unit, target, testId } = props;
  const info = useCardInfo(card?.defId ?? "", card?.radiant ?? false);
  const fieldPower = useFieldPower(card?.instanceId);
  const settings = useCardSettings();
  // The preview opens only while the panel's "Hover previews" is on too (useInspectTrigger.tsx).
  const panelHover = useSetting("hoverPreviews");
  const form = formOf(card, unit, props.type);

  // The card in play: the unit's view when it is one, else the card's own (a hand card's stats and
  // power, a face-up backrow card's power off the hero's list). A back has no face at all.
  const shown = unit ?? card;
  const model: FaceModel =
    shown === null
      ? faceModel({ defId: "", radiant: false })
      : liveFace(info, shown, {
          ...(props.type === undefined ? {} : { type: props.type }),
          ...(fieldPower === undefined ? {} : { fieldPower }),
        });
  // A face-up backrow card is drawn as the type its `BackrowView` names: the view is what the
  // client renders (CLAUDE.md rule 7), and the catalog only fills in what the view leaves out.
  const face: FaceModel = props.type === undefined ? model : { ...model, type: props.type };

  // Hooks run on every render, backs included; a back has no subject, so it opens nothing. A full
  // face sits in a row (the hand, the resolving strip), so its preview rises over it rather than
  // covering the neighbour the pointer is heading for.
  const inspect = useInspectTrigger(card === null ? null : { key: testId ?? card.instanceId, face }, {
    prefer: form === "full" ? "above" : "beside",
  });

  const legal = isLegal(props.highlight, testId);
  const selected = isSelected(props.highlight, testId);
  const clickable = target !== null && target !== undefined;
  const animatingEvent = testId === undefined ? undefined : props.animating?.get(testId);

  function fire(event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>): void {
    if (!clickable || !legal) return;
    event.stopPropagation();
    props.onClick?.(target);
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    fire(event);
  }

  const shared = {
    "data-testid": testId,
    "data-legal": clickable ? legalAttr(legal) : undefined,
    "data-selected": selected ? "true" : undefined,
    "data-animating": animatingEvent,
    "data-glow": glowAttr(props.highlight, testId),
    "aria-disabled": clickable && !legal ? ("true" as const) : undefined,
    onClick: clickable ? fire : undefined,
    onKeyDown: clickable ? onKeyDown : undefined,
    tabIndex: clickable && legal ? 0 : undefined,
    draggable: props.draggable === true && legal ? true : undefined,
    onDragStart: props.draggable === true ? (event: DragEvent<HTMLElement>) => beginDrag(event, legal, target) : undefined,
    onDragOver: clickable ? allowDrop : undefined,
    onDrop: clickable ? (event: DragEvent<HTMLElement>) => completeDrop(event, target, props.onClick) : undefined,
  };

  if (card === null) {
    // A back. No name, no def id, no instance id: the view does not have them.
    return (
      <div {...shared} className={cx("card", "card-back", props.className)} data-face-down="true" aria-label="Face-down card">
        <CardBack />
      </div>
    );
  }

  const position = unit?.position;
  const counters = props.counters ?? unit?.counters;
  const buried = unit?.buried ?? 0;
  const cardType = face.type;

  const root = (
    <div
      {...shared}
      {...inspect.handlers}
      className={cx(
        "card",
        unit ? "card-unit" : "card-spell",
        card.radiant && "radiant",
        "cf-host",
        `cf-host--${form}`,
        props.className,
      )}
      data-face={form}
      data-def-id={card.defId}
      data-radiant={card.radiant ? "true" : undefined}
      data-rarity={face.rarity ?? undefined}
      data-card-type={cardType}
      // animations.css keeps a fired Field Trap on the board with its own flip (trapFired).
      data-field-trap={cardType === "Field Trap" ? "true" : undefined}
      data-condition-active={conditionAttr(card)}
      data-owner={props.owner ?? unit?.owner}
      data-controller={props.controller ?? unit?.controller}
      data-vanilla={unit?.vanilla === true ? "true" : undefined}
      data-position={position}
      // `canAct` is drawn as state, never read as permission: legality is `props.highlight`.
      data-can-act={unit === undefined || unit === null ? undefined : unit.canAct ? "true" : "false"}
      // DEF is a sideways card: the rotation is inline so a test can read `rotate(90deg)` off the
      // style attribute (BUILD M5-T4 `positionSwitched`), and the scale keeps it inside its lane.
      // It is the root's only inline style; the faces put theirs on inner elements.
      style={position === "DEF" ? { transform: "rotate(90deg) scale(0.72)" } : undefined}
      // The hover preview replaces the native tooltip; with previews off, the name comes back.
      title={settings.hoverPreviews && panelHover ? undefined : face.name}
    >
      {unit !== undefined && unit !== null ? (
        <MinionFace face={face} unit={unit} />
      ) : (
        <CardFace face={face} layout={form === "compact" ? "compact" : "full"} />
      )}

      {/* Everything below is a sibling of `.cf`, not inside it, so it stays clickable while the
          face has `pointer-events: none`. */}
      {position !== undefined && <span className="position-tag">{position}</span>}

      {counters?.plague !== undefined && (
        <span className="counter counter-plague" data-counter="plague" title="Plague counters">
          {counters.plague}
        </span>
      )}
      {counters?.grade !== undefined && (
        <span className="counter counter-grade" data-counter="grade" title="Grade counters">
          {counters.grade}
        </span>
      )}

      {/* §3.2: the cards under a Stack pile are face-down and dormant. The view gives their
          number only, so the pile shows a depth badge and no second card. */}
      {buried > 0 && (
        <span className="buried-badge" data-buried={buried} title="Cards buried under this pile">
          {buried}
        </span>
      )}

      {props.switchTarget === true && unit !== undefined && unit !== null && (
        <SwitchButton instanceId={unit.instanceId} highlight={props.highlight} animating={props.animating} onClick={props.onClick} />
      )}

      <PopLayer pops={props.pops} />
    </div>
  );

  // The overlay is a sibling of the root, never its child, so the root's own click and drag
  // handlers never see an event from inside a preview or a sheet.
  return (
    <>
      {root}
      {inspect.overlay}
    </>
  );
}

function SwitchButton({
  instanceId,
  highlight,
  animating,
  onClick,
}: {
  instanceId: string;
  highlight?: Highlight;
  animating?: AnimatingMap;
  onClick?: (target: ClickTarget) => void;
}): ReactElement {
  const testId = testid.switchPosition(instanceId);
  const legal = isLegal(highlight, testId);
  return (
    <button
      type="button"
      className="switch-button"
      data-testid={testId}
      data-legal={legalAttr(legal)}
      data-selected={isSelected(highlight, testId) ? "true" : undefined}
      data-animating={animating?.get(testId)}
      aria-disabled={legal ? undefined : "true"}
      disabled={!legal}
      title="Switch position"
      onClick={(event) => {
        event.stopPropagation();
        if (!legal) return;
        onClick?.({ on: "switch", instanceId });
      }}
    >
      ⟳
    </button>
  );
}
