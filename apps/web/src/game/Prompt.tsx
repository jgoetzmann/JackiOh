// The choice pickers (BUILD M5-T2, SPEC §10.6). One modal, ten pickers, no rules.
//
// Two things open this modal, and telling them apart is R81:
//
//  1. `view.pending` — a `PendingChoice` the engine opened during resolution (Discover, a chained
//     step, an Echo repeat, a cast, a trigger, the mulligan). Resolution is paused until it is
//     answered, and the answer is an `answer` action (or, for the mulligan, §10.2's own `mulligan`
//     action). The opponent sees only that a prompt is open, never its options (§10.6, §10.8).
//
//  2. `props.interaction` — a play the player is still building. R81: "Zone, X, embiggen, Tribute
//     and the targets and modes a card's script declares travel in the `play` action, which
//     `legalActions` enumerates; the client builds them with the prompt pickers." Those five
//     pickers therefore have to work with NO `view.pending` at all: nothing is paused, nothing is
//     waiting on an answer, and what they submit is a `play`, never an `answer`. §10.6 keeps the
//     `x`, `embiggen`, `zone`, `tribute` and `direction` prompt kinds for later sets, so both
//     routes render the same picker with the same `data-prompt-kind`.
//
// `data-prompt-source` says which route opened the modal ("engine" or "play"), for layout only:
// prompt.css turns a play's board picks into a slim bar on a phone while drag to play is on
// (polish task 7), because their answers already glow on the board.
//
// No rule is applied here either. `min` and `max` gate the confirm button, and both came from the
// engine — from `PendingView` on route 1 and from the candidate `play`s on route 2. The options
// likewise: a prompt's options are the engine's, and a play's choices are read off the
// `legalActions` array by `actions.ts`.

import { Fragment, useState, type ReactNode } from "react";

import type { ActionBody, PendingView, PlayerId, PlayerView, PromptKind, Selection } from "@jackioh/shared";

import {
  IDLE,
  highlightFor,
  outstandingNeed,
  pickInPlay,
  answerAction,
  selectionKey,
  zoneKey,
  zonesInBoardOrder,
  parseZoneKey,
  type Interaction,
  type PlayBuild,
  type PlayNeed,
} from "./actions.ts";
import { CardFace, faceModel, useInspectTrigger } from "../cards/index.ts";
import { useCardInfo } from "./catalog.ts";
import { sideOf } from "./contract.ts";
import { modeText } from "./modeText.ts";
import "./prompt.css";

export type PromptProps = {
  view: PlayerView;
  /** The in-flight play, for the inline R81 pickers (x, embiggen, zone, tribute, direction). */
  interaction?: Interaction;
  legal?: readonly ActionBody[];
  onAction: (body: ActionBody) => void;
  onInteraction?: (next: Interaction) => void;
  onCancel?: () => void;
};

/**
 * The seat that is only watching gets NO `data-prompt-kind` at all: §10.8 gives that view the
 * fact that a choice is open and nothing else, and `data-prompt-kind` is the attribute M5-T4
 * animates the open picker on. It is marked with its own flag instead, so "a prompt is open for
 * me" and "somebody is choosing" never read the same in the DOM.
 */
const WAITING_FLAG = "waiting";

/** R14 / §3.1: the only two directions a rotation can take (`RotationDirection` in the engine). */
const DIRECTIONS = ["left", "right"] as const;
const ARROWS: Record<string, string> = { left: "←", right: "→" };

type PickerItem = {
  key: string;
  label: string;
  /** Set when the option names a card, so the picker can show its real name (`catalog.ts`). */
  defId?: string;
  radiant?: boolean;
  /** The card's cost as the view carries it (`CardView.cost`), for its face's gem. */
  cost?: number;
  /** Where the card sits ("Enemy unit, lane 2"), which tells two copies of one card apart. */
  where?: string;
  /** The row a zone option sits in, so the zone grid can group by it without parsing keys. */
  group?: string;
  /** Which arrow a direction option draws. Never read off the key, which is the engine's. */
  arrow?: "left" | "right";
  /** A "Choose one" option's line of detail under its label (modeText.ts). */
  detail?: string;
};

type Submitted = { action?: ActionBody; interaction?: Interaction };

type Picker = {
  /** Which picker to draw, and the `data-prompt-kind` value M5-T4 animates on. */
  chrome: PromptKind;
  title: string;
  /** The card asking, when the picker knows it: its name heads the title ("Pocket Chaos: choose one"). */
  sourceDefId?: string;
  items: PickerItem[];
  min: number;
  max: number;
  /** A one-of-N picker sends as soon as an option is clicked. */
  immediate: boolean;
  /** What is chosen before the player touches anything: every card, for a mulligan. */
  initial?: readonly string[];
  submit: (keys: readonly string[]) => Submitted;
};

// ---------------------------------------------------------------------------------------------
// Labels. Read out of the view, never computed.
// ---------------------------------------------------------------------------------------------

type CardRef = { defId: string; radiant: boolean; cost: number };

/** Where an instance id sits in the viewer's own view, for a picker label. */
function cardRefFor(view: PlayerView, instanceId: string): CardRef | null {
  for (const side of [view.you, view.opponent]) {
    for (const pile of side.units) {
      if (pile !== null && pile.instanceId === instanceId) return { defId: pile.defId, radiant: pile.radiant, cost: pile.cost };
    }
    for (const slot of side.backrow) {
      if (slot !== null && slot.faceDown === false && slot.instanceId === instanceId) {
        return { defId: slot.defId, radiant: slot.radiant, cost: slot.cost };
      }
    }
    const piles = [Array.isArray(side.hand) ? side.hand : [], side.graveyard, side.exile];
    for (const pile of piles) {
      for (const card of pile) {
        if (card.instanceId === instanceId) return { defId: card.defId, radiant: card.radiant, cost: card.cost };
      }
    }
  }
  return null;
}

/**
 * Where an instance sits, as a player would say it, for a list picker's label: a target or a
 * Tribute is told apart from another copy of the same card by its place, never by its instance id.
 */
function whereOf(view: PlayerView, instanceId: string): string | null {
  for (const side of [view.you, view.opponent]) {
    const whose = side === view.you ? "Your" : "Enemy";
    const unitAt = side.units.findIndex((pile) => pile !== null && pile.instanceId === instanceId);
    if (unitAt >= 0) return `${whose} unit, lane ${String(unitAt + 1)}`;
    const backrowAt = side.backrow.findIndex(
      (slot) => slot !== null && slot.faceDown === false && slot.instanceId === instanceId,
    );
    if (backrowAt >= 0) return `${whose} backrow, lane ${String(backrowAt + 1)}`;
    const hand = Array.isArray(side.hand) ? side.hand : [];
    if (hand.some((card) => card.instanceId === instanceId)) return `${whose} hand`;
    if (side.graveyard.some((card) => card.instanceId === instanceId)) return `${whose} graveyard`;
    if (side.exile.some((card) => card.instanceId === instanceId)) return `${whose} exile`;
  }
  return null;
}

function itemForInstance(view: PlayerView, instanceId: string, fallback: string): PickerItem {
  const ref = cardRefFor(view, instanceId);
  const where = whereOf(view, instanceId);
  const item: PickerItem = ref === null
    ? { key: instanceId, label: fallback }
    : { key: instanceId, label: fallback, defId: ref.defId, radiant: ref.radiant, cost: ref.cost };
  if (where !== null) item.where = where;
  return item;
}

/** Lanes are 1-based, as `contract.ts` and the engine's `zones.ts` have them. */
function zoneLabel(row: string, lane: number): string {
  return `${row === "units" ? "Unit" : "Backrow"} lane ${lane}`;
}

function selectionLabel(view: PlayerView, selection: Selection): string {
  switch (selection.pick) {
    case "instance":
      return cardRefFor(view, selection.instanceId)?.defId ?? selection.instanceId;
    case "hero":
      return `${sideOf(view, selection.player) === "you" ? "Your" : "Enemy"} hero`;
    case "zone":
      return `${sideOf(view, selection.player) === "you" ? "Your" : "Enemy"} ${zoneLabel(selection.row, selection.lane)}`;
    case "mode":
      return selection.option;
    case "none":
      return "Nothing";
  }
}

// ---------------------------------------------------------------------------------------------
// Route 1: an open `PendingChoice`.
// ---------------------------------------------------------------------------------------------

function pickerForPending(
  pending: Extract<PendingView, { forYou: true }>,
  view: PlayerView,
  legal: readonly ActionBody[],
): Picker {
  const items = pending.options.map((option): PickerItem => {
    const base: PickerItem = { key: option.key, label: option.label };
    if (option.defId !== undefined) base.defId = option.defId;
    if (option.row !== undefined) base.group = option.row;
    if (option.instanceId !== undefined) {
      const ref = cardRefFor(view, option.instanceId);
      if (ref !== null) {
        base.defId = ref.defId;
        base.radiant = ref.radiant;
        base.cost = ref.cost;
      }
      const where = whereOf(view, option.instanceId);
      if (where !== null) base.where = where;
    }
    // The engine prefixes a direction key (`mode:left`), so the arrow comes off the label or the
    // key's tail, never off the whole key: `data-testid="direction-left"` is the M5-T2 contract.
    const arrow = DIRECTIONS.find((d) => option.label === d || option.key === d || option.key.endsWith(`:${d}`));
    if (arrow !== undefined) base.arrow = arrow;
    return base;
  });

  return {
    chrome: pending.kind,
    title: pending.prompt,
    items,
    min: pending.min,
    max: pending.max,
    // The mulligan is per-card toggles plus a confirm, whatever its max.
    immediate: pending.kind !== "mulligan" && pending.max <= 1,
    // R9's answer names the cards KEPT, and Hearthstone keeps the whole hand until a card is
    // marked to go back, so a mulligan opens with every card kept: Confirm alone keeps the hand,
    // and a tap marks a card for a redraw.
    ...(pending.kind === "mulligan" ? { initial: items.slice(0, pending.max).map((item) => item.key) } : {}),
    submit: (keys) => ({ action: answerAction(pending, keys, view, legal) }),
  };
}

// ---------------------------------------------------------------------------------------------
// Route 2: an R81 play choice. Submits a `play`, never an `answer`.
// ---------------------------------------------------------------------------------------------

function isDirection(options: readonly string[]): boolean {
  return options.length > 0 && options.every((option) => DIRECTIONS.some((d) => d === option));
}

/**
 * R81 puts a declared `hand` pick (#26 Glowy Jelly Bean) in the play action's `targets`, so it
 * arrives here as a `target` need — but §10.6 still names `hand` as its own prompt kind and
 * BUILD M5-T2 draws it as its own picker. The only thing that tells the two apart is where the
 * offered instances live, which `PlayerView` already says: every candidate being a card in the
 * viewer's own hand is a hand pick, anything else (a unit, a hero, a zone) is a target pick.
 * Presentation only — the action built is the same `play` either way.
 */
function isHandPick(need: PlayNeed, view: PlayerView): boolean {
  if (need.kind !== "target") return false;
  const hand = Array.isArray(view.you.hand) ? view.you.hand : [];
  if (hand.length === 0 || need.selections.length === 0) return false;
  return need.selections.every(
    (selection) =>
      selection.pick === "instance" &&
      hand.some((card) => card.instanceId === selection.instanceId),
  );
}

function pickerForNeed(need: PlayNeed, interaction: Interaction, view: PlayerView): Picker {
  const play = (patch: Partial<PlayBuild>): Submitted => {
    const result = pickInPlay(interaction, patch);
    return result.action === undefined
      ? { interaction: result.interaction }
      : { interaction: result.interaction, action: result.action };
  };
  const common = { min: need.min, max: need.max, immediate: need.max <= 1 };

  switch (need.kind) {
    case "zone":
      return {
        ...common,
        chrome: "zone",
        title: "Choose a zone",
        items: zonesInBoardOrder(need.zones).map((zone) => ({
          key: zoneKey(zone),
          label: zoneLabel(zone.row, zone.lane),
          group: zone.row,
        })),
        submit: (keys) => {
          const zone = keys[0] === undefined ? null : parseZoneKey(keys[0]);
          return zone === null ? {} : play({ zone });
        },
      };
    case "x":
      return {
        ...common,
        chrome: "x",
        title: "Choose X",
        items: need.values.map((value) => ({ key: String(value), label: String(value) })),
        submit: (keys) => (keys[0] === undefined ? {} : play({ x: Number(keys[0]) })),
      };
    case "embiggen":
      return {
        ...common,
        chrome: "embiggen",
        title: "Pay the embiggen price?",
        items: need.values.map((value) => ({ key: String(value), label: value ? "Embiggened" : "Normal" })),
        submit: (keys) => (keys[0] === undefined ? {} : play({ embiggen: keys[0] === "true" })),
      };
    case "tribute":
      return {
        ...common,
        chrome: "tribute",
        title: "Choose Tributes",
        items: need.instanceIds.map((id) => itemForInstance(view, id, id)),
        submit: (keys) => play({ tributes: [...keys] }),
      };
    case "target": {
      const byKey = new Map(need.selections.map((selection) => [selectionKey(selection), selection]));
      // R81: a declared `target` pick whose selections are all hand cards is rendered with the hand
      // chrome, so the player sees the pick where the cards are. (This was left short-circuited to
      // `false` by an abandoned experiment, which made the branch below dead and the hand picker
      // unreachable — e2e spec 02 asserts it for the hand kind.)
      const inHand = isHandPick(need, view);
      return {
        ...common,
        chrome: inHand ? "hand" : "target",
        title: inHand ? "Choose a card in your hand" : "Choose a target",
        items: need.selections.map((selection) => {
          const key = selectionKey(selection);
          const label = selectionLabel(view, selection);
          if (selection.pick !== "instance") return { key, label };
          const ref = cardRefFor(view, selection.instanceId);
          const where = whereOf(view, selection.instanceId);
          const item: PickerItem =
            ref === null ? { key, label } : { key, label, defId: ref.defId, radiant: ref.radiant, cost: ref.cost };
          if (where !== null) item.where = where;
          return item;
        }),
        submit: (keys) => {
          const targets = keys.flatMap((key) => {
            const selection = byKey.get(key);
            return selection === undefined ? [] : [selection];
          });
          return play({ targets });
        },
      };
    }
    case "mode": {
      // The card being played is the one asking; its options read as that card's words, on the face
      // it is played with (#24's radiant "Uses X+1").
      const played = interaction.stage === "playing" ? cardRefFor(view, interaction.instanceId) : null;
      const source = played?.defId ?? undefined;
      const radiant = played?.radiant === true;
      const picker: Picker = {
        ...common,
        chrome: isDirection(need.options) ? "direction" : "mode",
        title: isDirection(need.options) ? "Choose a direction" : "Choose one",
        items: need.options.map((option): PickerItem => {
          const arrow = DIRECTIONS.find((d) => d === option);
          if (arrow !== undefined) return { key: option, label: option, arrow };
          const text = modeText(source, option, radiant);
          return text.detail === undefined
            ? { key: option, label: text.label }
            : { key: option, label: text.label, detail: text.detail };
        }),
        submit: (keys) => play({ modes: [...keys] }),
      };
      if (source !== undefined) picker.sourceDefId = source;
      return picker;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The modal.
// ---------------------------------------------------------------------------------------------

// Polish 6 (a minimal edit to task 7's file, flagged in the PR): a card option draws the card's face,
// the one the hand and the deck builder draw, with the same hover preview and long-press sheet, in
// whatever box prompt.css gives it. An option that names no card keeps its name and text.
function CardOption(props: {
  item: PickerItem;
  pressed: boolean;
  /** A mulligan's options say what Confirm will do to each card. */
  verdicts?: boolean;
  onPick: () => void;
}) {
  const info = useCardInfo(props.item.defId ?? "", props.item.radiant === true);
  const name = props.item.defId === undefined ? props.item.label : info.name;
  const radiant = props.item.radiant === true;
  const cost = props.item.cost;
  const face =
    props.item.defId === undefined
      ? null
      : faceModel({
          defId: props.item.defId,
          def: info.def,
          name: info.name,
          radiant,
          ...(cost === undefined ? {} : { liveCost: cost }),
        });
  const testId = `prompt-option-${props.item.key}`;
  const inspect = useInspectTrigger(face === null ? null : { key: testId, face }, { prefer: "above" });
  const verdict = props.verdicts === true ? (props.pressed ? "keep" : "redraw") : undefined;
  // The name, then the cost the gem shows, so a screen reader hears what a sighted player reads.
  const label = face === null ? undefined : `${name}, costs ${face.cost.text}`;
  return (
    <>
      <button
        type="button"
        className="prompt-card"
        data-testid={testId}
        data-verdict={verdict}
        aria-pressed={props.pressed}
        aria-label={label}
        onClick={props.onPick}
        {...inspect.handlers}
      >
        {face === null ? (
          <>
            <span className="prompt-card-name">{name}</span>
            {info.text === "" ? null : <span className="prompt-card-text">{info.text}</span>}
          </>
        ) : (
          <span className="cf-option">
            <CardFace face={face} layout="full" />
          </span>
        )}
        {verdict === undefined ? null : (
          <span className="prompt-card-verdict" aria-hidden="true">
            {verdict === "keep" ? "Keep" : "Redraw"}
          </span>
        )}
      </button>
      {inspect.overlay}
    </>
  );
}

function ListOption(props: { item: PickerItem; pressed: boolean; onPick: () => void }) {
  const info = useCardInfo(props.item.defId ?? "", props.item.radiant === true);
  const name =
    props.item.defId === undefined ? props.item.label : `${info.name} — ${props.item.where ?? props.item.label}`;
  return (
    <li>
      <button
        type="button"
        data-testid={`prompt-option-${props.item.key}`}
        aria-pressed={props.pressed}
        onClick={props.onPick}
      >
        {name}
      </button>
    </li>
  );
}

function PlainOption(props: { item: PickerItem; pressed: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      className={props.item.detail === undefined ? undefined : "prompt-mode"}
      data-testid={`prompt-option-${props.item.key}`}
      aria-pressed={props.pressed}
      onClick={props.onPick}
    >
      {props.item.detail === undefined ? (
        props.item.label
      ) : (
        <>
          <span className="prompt-mode-label">{props.item.label}</span>
          <span className="prompt-mode-detail">{props.item.detail}</span>
        </>
      )}
    </button>
  );
}

/** The picker's heading: the asking card's name before it, when the picker knows the card. */
function PickerTitle(props: { title: string; sourceDefId: string | undefined }) {
  const info = useCardInfo(props.sourceDefId ?? "", false);
  if (props.sourceDefId === undefined) return <p className="prompt-title">{props.title}</p>;
  return (
    <p className="prompt-title">
      <span className="prompt-title-source">{info.name}</span>
      <span className="prompt-title-ask">{props.title}</span>
    </p>
  );
}

function PromptModal(props: {
  picker: Picker;
  /** Which route opened it: an engine prompt (`view.pending`) or a play still being built (R81). */
  source: "engine" | "play";
  boardTestids: readonly string[];
  onAction: (body: ActionBody) => void;
  onInteraction?: (next: Interaction) => void;
  onCancel?: () => void;
}) {
  const { picker } = props;
  const [selected, setSelected] = useState<readonly string[]>(() => picker.initial ?? []);
  /**
   * What is typed in the X field, which is not the same thing as what has been chosen: a field
   * being cleared, or holding a number the engine did not offer, stages nothing. `null` means
   * "nothing typed since the last stepper press", so the field follows the stepper.
   */
  const [typedX, setTypedX] = useState<string | null>(null);
  const inRange = selected.length >= picker.min && selected.length <= picker.max;

  function send(keys: readonly string[]): void {
    const out = picker.submit(keys);
    if (out.interaction !== undefined) props.onInteraction?.(out.interaction);
    if (out.action !== undefined) props.onAction(out.action);
  }

  /** Stages a value without sending it: the X stepper's − and +. */
  function stage(key: string): void {
    setSelected([key]);
  }

  function pick(key: string): void {
    if (picker.immediate) {
      send([key]);
      return;
    }
    setSelected((prev) => {
      if (prev.includes(key)) return prev.filter((k) => k !== key);
      if (prev.length >= picker.max) return prev;
      return [...prev, key];
    });
  }

  const pressed = (key: string): boolean => selected.includes(key);

  function body(): ReactNode {
    const items = picker.items;

    if (picker.chrome === "direction") {
      return (
        <div className="prompt-direction">
          {items.map((item) => (
            <div
              key={item.key}
              className="prompt-arrow"
              data-testid={item.arrow === undefined ? `direction-${item.key}` : `direction-${item.arrow}`}
              role="button"
              tabIndex={0}
              aria-pressed={pressed(item.key)}
              onClick={() => pick(item.key)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") pick(item.key);
              }}
            >
              <span aria-hidden="true">{item.arrow === undefined ? "•" : ARROWS[item.arrow]}</span>
              <span data-testid={`prompt-option-${item.key}`}>{item.label}</span>
            </div>
          ))}
        </div>
      );
    }

    if (picker.chrome === "x") {
      // The stepper walks the option list the engine offered; it never invents a value.
      const chosen = selected[0];
      const at = chosen === undefined ? 0 : Math.max(items.findIndex((item) => item.key === chosen), 0);
      const step = (delta: number): void => {
        const next = items[Math.min(Math.max(at + delta, 0), items.length - 1)];
        if (next === undefined) return;
        setTypedX(null);
        stage(next.key);
      };
      // Typing stages the value only when the engine offered it; anything else stages nothing, so
      // an X the play cannot take can never be confirmed.
      const typeX = (raw: string): void => {
        setTypedX(raw);
        const match = items.find((item) => item.key === raw);
        setSelected(match === undefined ? [] : [match.key]);
      };
      return (
        <>
          <div className="prompt-stepper" data-testid="x-stepper" role="group" aria-label="Choose X">
            <button type="button" data-testid="x-minus" aria-label="Lower X" onClick={() => step(-1)}>
              −
            </button>
            {/* The number is both typeable and readable: `prompt-x` is the input the value is
                typed into, `x-value` the label the stepper moves. */}
            <input
              className="prompt-x-input"
              data-testid="prompt-x"
              type="number"
              inputMode="numeric"
              aria-label="X"
              min={items[0]?.key}
              max={items[items.length - 1]?.key}
              value={typedX ?? chosen ?? ""}
              onChange={(event) => typeX(event.target.value)}
            />
            <span className="prompt-stepper-value" data-testid="x-value">
              {items[at]?.label ?? ""}
            </span>
            <button type="button" data-testid="x-plus" aria-label="Raise X" onClick={() => step(1)}>
              +
            </button>
          </div>
          <div className="prompt-chips">
            {items.map((item) => (
              <PlainOption key={item.key} item={item} pressed={pressed(item.key)} onPick={() => pick(item.key)} />
            ))}
          </div>
        </>
      );
    }

    if (picker.chrome === "embiggen") {
      return (
        <div className="prompt-toggle" data-testid="embiggen-toggle" role="group" aria-label="Embiggen">
          {items.map((item) => (
            <PlainOption key={item.key} item={item} pressed={pressed(item.key)} onPick={() => pick(item.key)} />
          ))}
        </div>
      );
    }

    if (picker.chrome === "zone") {
      const groups = [...new Set(items.map((item) => item.group ?? ""))];
      return (
        <div className="prompt-zones">
          {groups.map((group) => {
            const inGroup = items.filter((item) => (item.group ?? "") === group);
            return (
              <Fragment key={group}>
                {group === "" ? null : <span className="prompt-zone-row">{group}</span>}
                {inGroup.map((item) => (
                  <PlainOption key={item.key} item={item} pressed={pressed(item.key)} onPick={() => pick(item.key)} />
                ))}
              </Fragment>
            );
          })}
        </div>
      );
    }

    if (picker.chrome === "discover" || picker.chrome === "hand" || picker.chrome === "mulligan") {
      return (
        <div className="prompt-cards">
          {items.map((item) => (
            <CardOption
              key={item.key}
              item={item}
              pressed={pressed(item.key)}
              verdicts={picker.chrome === "mulligan"}
              onPick={() => pick(item.key)}
            />
          ))}
        </div>
      );
    }

    if (picker.chrome === "target" || picker.chrome === "tribute") {
      return (
        <ul className="prompt-list">
          {items.map((item) => (
            <ListOption key={item.key} item={item} pressed={pressed(item.key)} onPick={() => pick(item.key)} />
          ))}
        </ul>
      );
    }

    return (
      <div className="prompt-modes">
        {items.map((item) => (
          <PlainOption key={item.key} item={item} pressed={pressed(item.key)} onPick={() => pick(item.key)} />
        ))}
      </div>
    );
  }

  const range = picker.min === picker.max ? `${picker.min}` : `${picker.min}–${picker.max}`;

  return (
    <div className="prompt-scrim" data-testid="prompt-scrim">
      <div
        className={`prompt prompt-${picker.chrome}`}
        data-testid="prompt-modal"
        data-prompt-kind={picker.chrome}
        data-prompt-source={props.source}
        /* The board cells this prompt has blessed, so a `target` pick can be made on the board
           too (BUILD M5-T2). Derived by `highlightFor`, which reads only `legalActions` and the
           prompt's own options. */
        data-board-testids={props.boardTestids.join(" ")}
        role="dialog"
        aria-modal="true"
        aria-label={picker.title}
      >
        <PickerTitle title={picker.title} sourceDefId={picker.sourceDefId} />
        <p className="prompt-count">
          Choose {range} — {selected.length} chosen
        </p>
        {body()}
        {picker.chrome === "target" && props.boardTestids.length > 0 ? (
          <p className="prompt-board-note">Highlighted on the board as well.</p>
        ) : null}
        <div className="prompt-actions">
          <button
            type="button"
            data-testid="prompt-submit"
            aria-disabled={!inRange}
            onClick={() => {
              if (inRange) send(selected);
            }}
          >
            Confirm
          </button>
          {props.onCancel === undefined ? null : (
            <button type="button" data-testid="prompt-cancel" onClick={props.onCancel}>
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * §10.6, §10.8: the other seat learns that a choice is open and nothing else about it. The chooser
 * is always the viewer's opponent (a prompt for the viewer is `forYou`), so the line names the
 * opponent rather than a seat id: in practice that is the AI, which the HUD already shows thinking.
 */
function Waiting(props: { pendingFor: PlayerId }) {
  return (
    <div className="prompt-scrim" data-testid="prompt-scrim">
      <div
        className="prompt prompt-waiting"
        data-testid="prompt-modal"
        data-prompt-waiting={WAITING_FLAG}
        data-pending-for={props.pendingFor}
        role="dialog"
        aria-modal="true"
        aria-label="Waiting for choice"
      >
        <p className="prompt-title">Waiting for choice</p>
        <p className="prompt-sub">Your opponent is choosing.</p>
      </div>
    </div>
  );
}

function needKey(need: PlayNeed): string {
  return `${need.kind}:${need.min}:${need.max}`;
}

export default function Prompt(props: PromptProps) {
  const interaction = props.interaction ?? IDLE;
  const boardTestids = [...highlightFor(props.view, props.legal ?? [], interaction).legal].sort();
  const pending = props.view.pending;

  if (pending !== null && !pending.forYou) return <Waiting pendingFor={pending.pendingFor} />;

  if (pending !== null) {
    return (
      <PromptModal
        key={pending.choiceId}
        source="engine"
        picker={pickerForPending(pending, props.view, props.legal ?? [])}
        boardTestids={boardTestids}
        onAction={props.onAction}
        {...(props.onInteraction === undefined ? {} : { onInteraction: props.onInteraction })}
        {...(props.onCancel === undefined ? {} : { onCancel: props.onCancel })}
      />
    );
  }

  // R81: no prompt is open and nothing is paused, but the play in flight still needs a choice.
  const need = outstandingNeed(interaction);
  if (need === null) return null;

  return (
    <PromptModal
      key={needKey(need)}
      source="play"
      picker={pickerForNeed(need, interaction, props.view)}
      boardTestids={boardTestids}
      onAction={props.onAction}
      {...(props.onInteraction === undefined ? {} : { onInteraction: props.onInteraction })}
      {...(props.onCancel === undefined ? {} : { onCancel: props.onCancel })}
    />
  );
}
