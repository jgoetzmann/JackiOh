// Turning clicks into actions — and nothing else (CLAUDE.md rule 7, BUILD M5-T2, SPEC §10.2).
//
// THE ONE RULE OF THIS FILE IS THAT IT HAS NO RULES. Every question of the form "may I?" is
// answered by searching the `ActionBody[]` that `legalActions(state, player)` handed us. There is
// no `cost <= mana`, no `keywords.includes("Taunt")`, no "a zone is open when it is null" and no
// summoning-sickness check anywhere below:
//
//   * a hand card is playable because a `play` naming it is in the array;
//   * a zone is legal because some candidate `play` names that row and lane;
//   * a unit may attack because an `attack` names it as `attackerId`, and it may hit a target
//     because a candidate names that `targetId`;
//   * a unit may switch because a `switchPosition` names it;
//   * `end-turn`, `offer-draw`, `power` and `concede` light up because the matching action type is
//     in the array.
//
// `min` and `max` on a picker come from `PendingView`, which the engine built. The engine decides;
// this module narrows a list it was given.
//
// R81: zone, X, embiggen, Tribute and a card's declared targets and modes are NOT prompts. They
// travel inside the `play` action, and `legalActions` enumerates them (today only zone and X; see
// CARRY_THROUGH below). Everything chosen during resolution — Discover, chained steps, Echo
// repeats, casts, triggers, the mulligan — arrives as a `PendingChoice` and is answered with an
// `answer` action (or, for the mulligan, its own `mulligan` action).
//
// CARRY_THROUGH: `legalActions` lists one `play` per zone choice and per X value and nothing else
// (see its own comment: "Other prompt kinds arrive with M3-T3"). Until it enumerates `tributes`,
// `targets` and `modes` as well, a candidate leaves those fields unset. A *board click* is never
// carried through — a click no candidate accounts for changes nothing, so the board can never be
// clicked into an illegal play. A choice made in a *picker* (`pickInPlay`) is carried into the
// emitted `play` verbatim and validated by the engine per R90: the client reports the player's
// pick, it does not rule on it. The day `legalActions` fixes those fields, the same narrowing
// code picks them up and the carry-through path goes quiet on its own.

import type {
  Action,
  ActionBody,
  PendingOption,
  PendingView,
  PlayerId,
  PlayerView,
  Row,
  Selection,
  ZoneChoice,
} from "@jackioh/shared";

import {
  LANES,
  NO_HIGHLIGHT,
  playerOf,
  sideOf,
  testid,
  type BoardControl,
  type ClickTarget,
  type Highlight,
} from "./contract.ts";

type PlayBody = Extract<ActionBody, { type: "play" }>;
type AttackBody = Extract<ActionBody, { type: "attack" }>;

/** The R81 play-time choices, as the client accumulates them. */
export type PlayBuild = {
  zone?: ZoneChoice;
  x?: number;
  embiggen?: boolean;
  tributes?: string[];
  targets?: Selection[];
  modes?: string[];
};

/** The client's in-progress selection. Not state the engine knows or cares about. */
export type Interaction =
  | { stage: "idle" }
  | { stage: "playing"; instanceId: string; candidates: ActionBody[]; picked: Partial<PlayBuild> }
  | { stage: "attacking"; attackerId: string; candidates: ActionBody[] };

export const IDLE: Interaction = { stage: "idle" };

/** What is still unchosen about the play in flight, derived only from the candidates. */
export type PlayNeed =
  | { kind: "zone"; min: number; max: number; zones: ZoneChoice[] }
  | { kind: "x"; min: number; max: number; values: number[] }
  | { kind: "embiggen"; min: number; max: number; values: boolean[] }
  | { kind: "tribute"; min: number; max: number; instanceIds: string[] }
  | { kind: "target"; min: number; max: number; selections: Selection[] }
  | { kind: "mode"; min: number; max: number; options: string[] };

export type ClickResult = { interaction: Interaction; action?: ActionBody };

// ---------------------------------------------------------------------------------------------
// Keys. Presentation-only identity for a choice, so a picker can round-trip it through the DOM.
// ---------------------------------------------------------------------------------------------

export function zoneKey(zone: ZoneChoice): string {
  return `${zone.row}:${zone.lane}`;
}

export function parseZoneKey(key: string): ZoneChoice | null {
  const [row, lane] = key.split(":");
  if (row !== "units" && row !== "backrow") return null;
  const n = Number(lane);
  if (lane === undefined || lane === "" || !Number.isInteger(n)) return null;
  return { row, lane: n };
}

export function selectionKey(selection: Selection): string {
  switch (selection.pick) {
    case "instance":
      return `instance:${selection.instanceId}`;
    case "hero":
      return `hero:${selection.player}`;
    case "zone":
      return `zone:${selection.player}:${selection.row}:${selection.lane}`;
    case "mode":
      return `mode:${selection.option}`;
    case "none":
      return "none";
  }
}

function listKey(values: readonly string[]): string {
  return JSON.stringify([...values].sort());
}

function targetsKey(selections: readonly Selection[]): string {
  return listKey(selections.map(selectionKey));
}

// ---------------------------------------------------------------------------------------------
// Searching the legal array. Nothing here knows a rule; it all reads `ActionBody`s.
// ---------------------------------------------------------------------------------------------

function isPlay(body: ActionBody): body is PlayBody {
  return body.type === "play";
}

function isAttack(body: ActionBody): body is AttackBody {
  return body.type === "attack";
}

function playsFor(legal: readonly ActionBody[], instanceId: string): PlayBody[] {
  return legal.filter(isPlay).filter((body) => body.instanceId === instanceId);
}

function attacksBy(legal: readonly ActionBody[], attackerId: string): AttackBody[] {
  return legal.filter(isAttack).filter((body) => body.attackerId === attackerId);
}

/**
 * How an `attack` names a hero: the literal string `hero-<playerId>`, e.g. `"hero-p2"`.
 * Learned from `packages/engine/test/combat-validation.test.ts` (`attackVia(other, free.id,
 * "hero-p1").error === "no target hero-p1"`), `combat-positions.test.ts` (every face attack sends
 * `targetId: "hero-p2"`) and `packages/engine/src/damage.ts`, whose `targetId()` builds the same
 * id for the `damage` and `healed` events. There is no exported helper in `@jackioh/shared` for
 * it — reported as an M5-T2 finding — so this is the client's copy of that one string.
 */
export function heroTargetId(player: PlayerId): string {
  return `hero-${player}`;
}

/** Decodes an `attack` target back to a player, tolerating a bare player id defensively. */
export function heroPlayerOfTargetId(view: PlayerView, targetId: string): PlayerId | null {
  for (const side of [view.you, view.opponent]) {
    if (targetId === heroTargetId(side.player) || targetId === side.player) return side.player;
  }
  return null;
}

/** The `data-testid` an `attack`'s `targetId` points at. */
export function attackTargetTestid(view: PlayerView, targetId: string): string {
  const player = heroPlayerOfTargetId(view, targetId);
  return player === null ? testid.card(targetId) : testid.hero(sideOf(view, player));
}

/** Where a `Selection` lives on the board. `mode` and `none` point at nothing. */
export function selectionTestid(view: PlayerView, selection: Selection): string | null {
  switch (selection.pick) {
    case "instance": {
      const hand = Array.isArray(view.you.hand) ? view.you.hand : [];
      return hand.some((card) => card.instanceId === selection.instanceId)
        ? testid.handCard(selection.instanceId)
        : testid.card(selection.instanceId);
    }
    case "hero":
      return testid.hero(sideOf(view, selection.player));
    case "zone":
      return testid.zone(sideOf(view, selection.player), selection.row, selection.lane);
    case "mode":
    case "none":
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Narrowing a play. `picked` is what the player has said; candidates are what the engine allows.
// ---------------------------------------------------------------------------------------------

function containsAll(fixed: readonly string[], wanted: readonly string[]): boolean {
  const have = new Set(fixed);
  return wanted.every((value) => have.has(value));
}

/**
 * A candidate still matches when every field it fixes equals what the player picked. A field the
 * candidate leaves unset is carried through (CARRY_THROUGH) rather than treated as a refusal.
 */
function matches(candidate: PlayBody, picked: Partial<PlayBuild>): boolean {
  if (picked.zone !== undefined && candidate.zone !== undefined) {
    if (zoneKey(candidate.zone) !== zoneKey(picked.zone)) return false;
  }
  if (picked.x !== undefined && candidate.x !== undefined && candidate.x !== picked.x) return false;
  if (picked.embiggen !== undefined && candidate.embiggen !== undefined && candidate.embiggen !== picked.embiggen) {
    return false;
  }
  if (picked.tributes !== undefined && candidate.tributes !== undefined) {
    if (!containsAll(candidate.tributes, picked.tributes)) return false;
  }
  if (picked.targets !== undefined && candidate.targets !== undefined) {
    if (!containsAll(candidate.targets.map(selectionKey), picked.targets.map(selectionKey))) return false;
  }
  if (picked.modes !== undefined && candidate.modes !== undefined) {
    if (!containsAll(candidate.modes, picked.modes)) return false;
  }
  return true;
}

/** The emitted body is the candidate the engine listed, plus only the fields it left unset. */
function mergePicked(candidate: PlayBody, picked: Partial<PlayBuild>): PlayBody {
  const body: PlayBody = { type: "play", instanceId: candidate.instanceId };
  const zone = candidate.zone ?? picked.zone;
  const x = candidate.x ?? picked.x;
  const embiggen = candidate.embiggen ?? picked.embiggen;
  const tributes = candidate.tributes ?? picked.tributes;
  const targets = candidate.targets ?? picked.targets;
  const modes = candidate.modes ?? picked.modes;
  if (zone !== undefined) body.zone = zone;
  if (x !== undefined) body.x = x;
  if (embiggen !== undefined) body.embiggen = embiggen;
  if (tributes !== undefined && tributes.length > 0) body.tributes = [...tributes];
  if (targets !== undefined && targets.length > 0) body.targets = [...targets];
  if (modes !== undefined && modes.length > 0) body.modes = [...modes];
  return body;
}

function remainingCandidates(interaction: Extract<Interaction, { stage: "playing" }>): PlayBody[] {
  return interaction.candidates.filter(isPlay).filter((candidate) => matches(candidate, interaction.picked));
}

function distinctBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const out = new Map<string, T>();
  for (const value of values) out.set(key(value), value);
  return [...out.values()];
}

/**
 * The next choice the play still needs, or null when the candidates agree on everything. Derived
 * purely from the candidate array: two candidates that differ only in `x` mean the player must
 * pick an X, and nothing else. Asked in cost order (X and embiggen change the cost), with the
 * board-driven zone last so a zone click finishes the play.
 */
export function outstandingNeed(interaction: Interaction): PlayNeed | null {
  if (interaction.stage !== "playing") return null;
  const remaining = remainingCandidates(interaction);
  if (remaining.length < 2) return null;

  if (interaction.picked.x === undefined) {
    const values = [...new Set(remaining.flatMap((c) => (c.x === undefined ? [] : [c.x])))].sort((a, b) => a - b);
    if (values.length > 1) return { kind: "x", min: 1, max: 1, values };
  }

  if (interaction.picked.embiggen === undefined) {
    const values = [...new Set(remaining.flatMap((c) => (c.embiggen === undefined ? [] : [c.embiggen])))].sort(
      (a, b) => Number(a) - Number(b),
    );
    if (values.length > 1) return { kind: "embiggen", min: 1, max: 1, values };
  }

  const tributeSets = distinctBy(
    remaining.flatMap((c) => (c.tributes === undefined ? [] : [c.tributes])),
    listKey,
  );
  if (tributeSets.length > 1) {
    const lengths = tributeSets.map((set) => set.length);
    return {
      kind: "tribute",
      min: Math.min(...lengths),
      max: Math.max(...lengths),
      instanceIds: [...new Set(tributeSets.flat())],
    };
  }

  const targetLists = distinctBy(
    remaining.flatMap((c) => (c.targets === undefined ? [] : [c.targets])),
    targetsKey,
  );
  if (targetLists.length > 1) {
    const lengths = targetLists.map((list) => list.length);
    return {
      kind: "target",
      min: Math.min(...lengths),
      max: Math.max(...lengths),
      selections: distinctBy(targetLists.flat(), selectionKey),
    };
  }

  const modeLists = distinctBy(
    remaining.flatMap((c) => (c.modes === undefined ? [] : [c.modes])),
    listKey,
  );
  if (modeLists.length > 1) {
    const lengths = modeLists.map((list) => list.length);
    return {
      kind: "mode",
      min: Math.min(...lengths),
      max: Math.max(...lengths),
      options: [...new Set(modeLists.flat())],
    };
  }

  const zones = distinctBy(
    remaining.flatMap((c) => (c.zone === undefined ? [] : [c.zone])),
    zoneKey,
  );
  if (zones.length > 1) return { kind: "zone", min: 1, max: 1, zones };

  return null;
}

/** One legal candidate left and nothing outstanding: the play is ready to send. */
function readyAction(interaction: Interaction): ActionBody | undefined {
  if (interaction.stage !== "playing") return undefined;
  if (outstandingNeed(interaction) !== null) return undefined;
  const first = remainingCandidates(interaction)[0];
  return first === undefined ? undefined : mergePicked(first, interaction.picked);
}

function settle(next: Interaction): ClickResult {
  const action = readyAction(next);
  return action === undefined ? { interaction: next } : { interaction: IDLE, action };
}

function narrowedBy(
  interaction: Extract<Interaction, { stage: "playing" }>,
  picked: Partial<PlayBuild>,
): Interaction | null {
  const next: Extract<Interaction, { stage: "playing" }> = {
    stage: "playing",
    instanceId: interaction.instanceId,
    candidates: interaction.candidates,
    picked: { ...interaction.picked, ...picked },
  };
  const remaining = remainingCandidates(next);
  if (remaining.length === 0) return null;
  return { ...next, candidates: remaining };
}

/** Does any candidate actually fix this zone? A board click is only accepted when one does. */
function someCandidateFixesZone(interaction: Extract<Interaction, { stage: "playing" }>, zone: ZoneChoice): boolean {
  return remainingCandidates(interaction).some((c) => c.zone !== undefined && zoneKey(c.zone) === zoneKey(zone));
}

/** Does any candidate name this selection as one of its declared targets (R81)? */
function someCandidateFixesTarget(
  interaction: Extract<Interaction, { stage: "playing" }>,
  selection: Selection,
): boolean {
  const key = selectionKey(selection);
  return remainingCandidates(interaction).some(
    (c) => c.targets !== undefined && c.targets.some((s) => selectionKey(s) === key),
  );
}

/** Does any candidate sacrifice this unit as one of its Tributes (§6.3, R81)? */
function someCandidateFixesTribute(
  interaction: Extract<Interaction, { stage: "playing" }>,
  instanceId: string,
): boolean {
  return remainingCandidates(interaction).some(
    (c) => c.tributes !== undefined && c.tributes.includes(instanceId),
  );
}

function appended<T>(existing: readonly T[] | undefined, value: T): T[] {
  return [...(existing ?? []), value];
}

/** Records one more declared target (R81: a declared `hand` or `zone` pick travels in `targets`). */
function narrowByTarget(
  interaction: Extract<Interaction, { stage: "playing" }>,
  selection: Selection,
): Interaction | null {
  if (!someCandidateFixesTarget(interaction, selection)) return null;
  return narrowedBy(interaction, { targets: appended(interaction.picked.targets, selection) });
}

function narrowByTribute(
  interaction: Extract<Interaction, { stage: "playing" }>,
  instanceId: string,
): Interaction | null {
  if (!someCandidateFixesTribute(interaction, instanceId)) return null;
  return narrowedBy(interaction, { tributes: appended(interaction.picked.tributes, instanceId) });
}

// ---------------------------------------------------------------------------------------------
// Highlighting: the set of testids the engine has already blessed.
// ---------------------------------------------------------------------------------------------

const CONTROL_FOR_TYPE: Partial<Record<ActionBody["type"], BoardControl>> = {
  endTurn: "end-turn",
  offerDraw: "offer-draw",
  activatePower: "power",
  concede: "concede",
};

const CONTROL_TESTID: Record<BoardControl, string> = {
  "end-turn": testid.endTurn,
  "offer-draw": testid.offerDraw,
  power: testid.power,
  concede: testid.concede,
};

/** Board cells an open prompt's own options point at, so a `target` prompt can be answered there. */
export function pendingHighlight(view: PlayerView, pending: PendingView | null): ReadonlySet<string> {
  const out = new Set<string>();
  if (pending === null || !pending.forYou) return out;
  for (const option of pending.options) {
    const where = selectionTestid(view, selectionForOption(option));
    if (where !== null) out.add(where);
  }
  return out;
}

/**
 * Every `data-testid` the board may light up, plus the selected set. Everything in `legal` got
 * there because an `ActionBody` (or an open prompt's own option list) named it.
 */
export function highlightFor(
  view: PlayerView,
  legal: readonly ActionBody[],
  interaction: Interaction,
): Highlight {
  // Nothing is legal, so nothing lights up — including a selection that was in flight when the
  // engine's answer changed under it. This reads the engine's answer rather than checking
  // `view.result` or whose turn it is: `legalActions` already returns [] for both.
  if (legal.length === 0 && interaction.stage !== "idle") return NO_HIGHLIGHT;

  const legalIds = new Set<string>();
  const selected = new Set<string>();

  // The controls the engine listed stay live through a selection: nothing the player is halfway
  // through building takes `end-turn` or `concede` away from them.
  for (const body of legal) {
    const control = CONTROL_FOR_TYPE[body.type];
    if (control !== undefined) legalIds.add(CONTROL_TESTID[control]);
  }

  if (interaction.stage === "playing") {
    selected.add(testid.handCard(interaction.instanceId));
    // Every playable card stays clickable: a second click on this one puts it back down, and a
    // click on another picks that one up instead.
    for (const body of legal) if (body.type === "play") legalIds.add(testid.handCard(body.instanceId));
    legalIds.add(testid.handCard(interaction.instanceId));
    const remaining = remainingCandidates(interaction);
    for (const candidate of remaining) {
      if (candidate.zone !== undefined) {
        legalIds.add(testid.zone("you", candidate.zone.row, candidate.zone.lane));
      }
      for (const id of candidate.tributes ?? []) legalIds.add(testid.card(id));
      for (const selection of candidate.targets ?? []) {
        const where = selectionTestid(view, selection);
        if (where !== null) legalIds.add(where);
      }
    }
    const picked = interaction.picked;
    if (picked.zone !== undefined) selected.add(testid.zone("you", picked.zone.row, picked.zone.lane));
    for (const id of picked.tributes ?? []) selected.add(testid.card(id));
    for (const selection of picked.targets ?? []) {
      const where = selectionTestid(view, selection);
      if (where !== null) selected.add(where);
    }
    return { legal: legalIds, selected };
  }

  if (interaction.stage === "attacking") {
    selected.add(testid.card(interaction.attackerId));
    // Any other unit the engine listed as an attacker stays clickable, so the player can switch.
    for (const body of legal) if (body.type === "attack") legalIds.add(testid.card(body.attackerId));
    legalIds.add(testid.card(interaction.attackerId));
    for (const candidate of interaction.candidates.filter(isAttack)) {
      if (candidate.attackerId !== interaction.attackerId) continue;
      legalIds.add(attackTargetTestid(view, candidate.targetId));
    }
    return { legal: legalIds, selected };
  }

  for (const body of legal) {
    switch (body.type) {
      case "play":
        legalIds.add(testid.handCard(body.instanceId));
        break;
      case "attack":
        legalIds.add(testid.card(body.attackerId));
        break;
      case "switchPosition":
        legalIds.add(testid.card(body.instanceId));
        legalIds.add(testid.switchPosition(body.instanceId));
        break;
      default:
        // Controls were added above, before the stage split.
        break;
    }
  }

  // With a prompt open `legalActions` offers only that prompt's answers (§10.7), so the board
  // would otherwise go entirely grey; the prompt's own options say which cells may be clicked.
  for (const where of pendingHighlight(view, view.pending)) legalIds.add(where);

  return { legal: legalIds, selected };
}

// ---------------------------------------------------------------------------------------------
// The click reducer.
// ---------------------------------------------------------------------------------------------

/**
 * One click. A click that no candidate can account for returns the interaction unchanged and no
 * action: an illegal click is simply not a move.
 */
export function onClickTarget(
  view: PlayerView,
  legal: readonly ActionBody[],
  interaction: Interaction,
  target: ClickTarget,
): ClickResult {
  switch (target.on) {
    case "hand": {
      if (interaction.stage === "playing") {
        if (interaction.instanceId === target.instanceId) return { interaction: IDLE };
        // R81: a declared hand pick (Glowy Jelly Bean) travels in `targets`, not as a prompt. It
        // wins over re-selecting only when a candidate actually names this card as a target.
        const asTarget = narrowByTarget(interaction, { pick: "instance", instanceId: target.instanceId });
        if (asTarget !== null) return settle(asTarget);
      }
      const candidates = playsFor(legal, target.instanceId);
      if (candidates.length === 0) return { interaction };
      return settle({ stage: "playing", instanceId: target.instanceId, candidates, picked: {} });
    }

    case "zone": {
      if (interaction.stage !== "playing") return { interaction };
      const zone: ZoneChoice = { row: target.row, lane: target.lane };
      if (target.side === "you" && someCandidateFixesZone(interaction, zone)) {
        const next = narrowedBy(interaction, { zone });
        return next === null ? { interaction } : settle(next);
      }
      // A declared zone pick (R81) travels in `targets` and may name either side of the board.
      const asTarget = narrowByTarget(interaction, {
        pick: "zone",
        player: playerOf(view, target.side),
        row: target.row,
        lane: target.lane,
      });
      return asTarget === null ? { interaction } : settle(asTarget);
    }

    case "unit":
    case "backrow": {
      if (interaction.stage === "attacking") {
        if (interaction.attackerId === target.instanceId) return { interaction: IDLE };
        const action = interaction.candidates
          .filter(isAttack)
          .find(
            (candidate) =>
              candidate.attackerId === interaction.attackerId &&
              attackTargetTestid(view, candidate.targetId) === testid.card(target.instanceId),
          );
        return action === undefined ? { interaction } : { interaction: IDLE, action };
      }
      if (interaction.stage === "playing") {
        const asTribute = target.on === "unit" ? narrowByTribute(interaction, target.instanceId) : null;
        if (asTribute !== null) return settle(asTribute);
        const asTarget = narrowByTarget(interaction, { pick: "instance", instanceId: target.instanceId });
        return asTarget === null ? { interaction } : settle(asTarget);
      }
      const candidates = attacksBy(legal, target.instanceId);
      if (candidates.length === 0) return { interaction };
      return { interaction: { stage: "attacking", attackerId: target.instanceId, candidates } };
    }

    case "hero": {
      const player = playerOf(view, target.side);
      if (interaction.stage === "attacking") {
        const action = interaction.candidates
          .filter(isAttack)
          .find(
            (candidate) =>
              candidate.attackerId === interaction.attackerId &&
              attackTargetTestid(view, candidate.targetId) === testid.hero(target.side),
          );
        return action === undefined ? { interaction } : { interaction: IDLE, action };
      }
      if (interaction.stage === "playing") {
        const asTarget = narrowByTarget(interaction, { pick: "hero", player });
        return asTarget === null ? { interaction } : settle(asTarget);
      }
      return { interaction };
    }

    case "switch": {
      const action = legal.find(
        (body) => body.type === "switchPosition" && body.instanceId === target.instanceId,
      );
      return action === undefined ? { interaction } : { interaction: IDLE, action };
    }
  }
}

/** A choice made in a picker rather than on the board: the X stepper, the embiggen toggle, … */
export function pickInPlay(interaction: Interaction, patch: Partial<PlayBuild>): ClickResult {
  if (interaction.stage !== "playing") return { interaction };
  const next = narrowedBy(interaction, patch);
  return next === null ? { interaction } : settle(next);
}

export function onControl(legal: readonly ActionBody[], control: BoardControl): ActionBody | undefined {
  return legal.find((body) => CONTROL_FOR_TYPE[body.type] === control);
}

// ---------------------------------------------------------------------------------------------
// Answering a prompt.
// ---------------------------------------------------------------------------------------------

/** The `<pick>:` prefixes the engine puts on an option key (`packages/engine/src/effects/choose.ts`). */
const KEY_PREFIXES = ["instance:", "hero:", "zone:", "mode:"] as const;

function withoutPickPrefix(key: string): string {
  for (const prefix of KEY_PREFIXES) if (key.startsWith(prefix)) return key.slice(prefix.length);
  return key;
}

/**
 * A `PendingOption` back to the `Selection` the engine stored for it.
 *
 * FINDING against SPEC §10.6 / §10.8: the engine's own `PromptOption` is `{ key, label,
 * selection }`, but the view's `PendingOption` flattens that to `{ key, label, instanceId?,
 * defId?, player?, row?, lane? }`. The `Selection` is gone, so the client has to rebuild it — and
 * a Discover option, whose stored selection is `{ pick: "mode", option: "<defId>" }`, is
 * indistinguishable from a card-in-hand option except by what fields happen to be set. Carrying
 * the `Selection` verbatim in `PendingOption` would delete this function.
 */
export function selectionForOption(option: PendingOption): Selection {
  if (option.row !== undefined && option.lane !== undefined && option.player !== undefined) {
    return { pick: "zone", player: option.player, row: option.row, lane: option.lane };
  }
  if (option.instanceId !== undefined) return { pick: "instance", instanceId: option.instanceId };
  if (option.player !== undefined) return { pick: "hero", player: option.player };
  if (option.key === "none" || option.key.startsWith("none:")) return { pick: "none" };
  // Everything else is a mode option: a Discover def id, a "Choose one" mode, a direction, or an
  // X / embiggen value, none of which `Selection` has a member for beyond `{ pick: "mode" }`.
  return { pick: "mode", option: option.defId ?? withoutPickPrefix(option.key) };
}

/**
 * The action that answers the open prompt with the options the player picked.
 *
 * The mulligan is not an `answer`: §10.2 gives it its own `mulligan {keep[]}` action, and
 * `legalActions` enumerates it as subsets of the prompt's option keys, so the picked keys *are*
 * the kept cards. They are re-ordered into hand order so the same picks always build the same
 * action (the engine reads `keep` as a set, `packages/engine/src/setup.ts`).
 */
export function answerAction(
  pending: Extract<PendingView, { forYou: true }>,
  keys: readonly string[],
  view: PlayerView,
  legal: readonly ActionBody[] = [],
): ActionBody {
  if (pending.kind === "mulligan") {
    const hand = Array.isArray(view.you.hand) ? view.you.hand.map((card) => card.instanceId) : [];
    const chosen = new Set(keys);
    const inHandOrder = hand.filter((id) => chosen.has(id));
    const rest = keys.filter((key) => !hand.includes(key));
    const keep = [...inHandOrder, ...rest];
    const listed = legal.find((body) => body.type === "mulligan" && listKey(body.keep) === listKey(keep));
    return listed ?? { type: "mulligan", keep };
  }

  const byKey = new Map(pending.options.map((option) => [option.key, option]));
  const selection = keys.map((key) => {
    const option = byKey.get(key);
    return option === undefined ? { pick: "mode" as const, option: withoutPickPrefix(key) } : selectionForOption(option);
  });

  // `promptAnswers` (engine `prompts.ts`) enumerates every answer the open prompt would accept, so
  // when the caller hands the array over, the action sent is the engine's own body rather than the
  // client's reconstruction of it — option order included. The reconstruction is the fallback for
  // a caller that has no array, and for a prompt whose answers ran past the engine's own cap.
  const wanted = targetsKey(selection);
  const listed = legal.find(
    (body) => body.type === "answer" && body.choiceId === pending.choiceId && targetsKey(body.selection) === wanted,
  );
  return listed ?? { type: "answer", choiceId: pending.choiceId, selection };
}

/** The nonce is handed in, never generated: this module is as pure as the engine (CLAUDE.md rule 4). */
export function withNonce(body: ActionBody, playerId: PlayerId, nonce: string): Action {
  return { ...body, playerId, nonce };
}

/** Zone choices in board order, for a picker that wants to draw a grid. */
export function zonesInBoardOrder(zones: readonly ZoneChoice[]): ZoneChoice[] {
  const rows: Row[] = ["units", "backrow"];
  return rows.flatMap((row) =>
    LANES.flatMap((lane) => zones.filter((zone) => zone.row === row && zone.lane === lane)),
  );
}
