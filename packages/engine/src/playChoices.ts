// The choices a play carries, built and validated (SPEC §10.5 step 1, §10.6, R81, R90).
//
// R81: "Zone, X, embiggen, Tribute and the targets and modes a card's script declares travel in the
// `play` action, which `legalActions` enumerates". This module is the one place those five kinds of
// answer are turned into options and checked against what the card declared and what the board
// allows, so `reduce`'s play path and `legalActions` read the same rules:
//
//   * `legalZonesFor`, `legalXValues`, `legalEmbiggenChoices`, `legalTributeSets` — the play's own
//     cost-and-placement choices;
//   * `declaredTargets` / `declaredModes` — what the card's script asked for;
//   * `legalSelectionsFor` — every selection one `TargetDecl` filter admits, in a deterministic
//     order (the chooser's side first, lane order within a side);
//   * `playChoiceCombinations` / `playActionsFor` — R90's enumeration, bounded;
//   * `whyChoicesRefused` — the single refusal, returning `null` when every choice is legal.
//
// R90 is the governing ruling for the validation: several declarations read the flat `targets` list
// in order, each taking its own minimum and the last one the remainder; one declaration may not
// name the same card twice while two declarations may both name the same card; a declaration the
// board cannot satisfy does not refuse the play, it fizzles on resolution. §9.1 is why a `hand` pick
// only ever offers the chooser's own hand, and R13 is why a unit pick only offers the top of a
// Stack pile.
//
// §6.2's Stack row is why the zone question has two answers rather than one: "may be played onto an
// occupied zone", so a Stack card's legal zones are the unit zones that are merely unlocked and
// unreserved (R64), not the empty ones. `legalZonesFor` and `refuseZone` read that off the same two
// predicates on purpose — the client's greyed-out button and `reduce`'s refusal are the same rule
// asked from opposite directions, and a Stack play that only one of them knew about would be a
// board the client cannot reach or a refusal it cannot explain.

import type {
  ActionBody,
  CardType,
  ModeDecl,
  PlayerId,
  Row,
  Selection,
  Tag,
  TargetDecl,
  TargetFilter,
  ZoneChoice,
} from "@jackioh/shared";
import { hasKeyword, opponentOf } from "@jackioh/shared";
import { defOf } from "./catalog";
import { MAX_CHOICE_COMBINATIONS } from "./config";
import { faceOf } from "./layers";
import { effectiveCost, isXCost } from "./mana";
import type { StaticFlags } from "./script";
import { flagsOf, scriptOf } from "./scripts";
import type { CardInstance, GameState } from "./state";
import {
  activeUnitsOf,
  cardAt,
  firstFreeZone,
  isLocked,
  isOpen,
  isReserved,
  openZones,
  rowSize,
  slotsOf,
  type ZoneSlot,
} from "./zones";

/** The `play` member of the action union, without the `playerId` and `nonce` the caller adds. */
export type PlayAction = Extract<ActionBody, { type: "play" }>;

/** One answer to everything a card's script declared (R81): the `targets` and `modes` of a play. */
export type PlayChoices = {
  targets?: Selection[];
  modes?: string[];
};

// R90's enumeration bound is `MAX_CHOICE_COMBINATIONS` in `config.ts` (BUILD §2): "Choose 2 or 3"
// on a full board is 165 combinations, and the client only needs enough of them to offer every
// picker, so every enumeration below stops at the cap rather than growing with the board.

/** §7: the Sheep Token, which is "worth 2 Tributes while on the field" (§3.2, §6.3). */
export const SHEEP_TOKEN_INDEX = "T-sheep";

const ROWS: readonly Row[] = ["units", "backrow"];

/** The pick kinds a `TargetFilter.of` may name, in the order selections are offered in. */
type PickKind = NonNullable<TargetFilter["of"]>[number];
const PICK_KIND_ORDER: readonly PickKind[] = ["unit", "backrow", "hand", "zone", "hero"];

// ---------------------------------------------------------------------------
// What the card asked for
// ---------------------------------------------------------------------------

/** The `targets` a card's running face declares (§10.9, R81); the empty list when it declares none. */
export function declaredTargets(card: CardInstance): TargetDecl[] {
  return scriptOf(card).targets ?? [];
}

/** The `modes` a card's running face declares: "Choose one" and Silly Silas's direction (R81). */
export function declaredModes(card: CardInstance): ModeDecl[] {
  return scriptOf(card).modes ?? [];
}

/**
 * The target declarations a play with these modes answers (R90, §8 Conventions). A declaration that
 * belongs to some modes only (`forModes`, #24's damage and heal target) asks for nothing when none
 * of them was chosen, so it takes no slot of the flat `targets` list — and one that does belong to
 * the chosen mode asks for its minimum like any other, which is what stops a damage mode from
 * naming nobody while a target exists.
 */
export function activeTargetDecls(decls: readonly TargetDecl[], modes: readonly string[]): TargetDecl[] {
  return decls.filter((decl) => decl.forModes === undefined || decl.forModes.some((mode) => modes.includes(mode)));
}

/** Whether any declaration depends on the modes, so the modes are chosen before the targets. */
export function targetsFollowModes(decls: readonly TargetDecl[]): boolean {
  return decls.some((decl) => decl.forModes !== undefined);
}

// ---------------------------------------------------------------------------
// The face a play resolves with (§10.5 step 3, R213, R214)
// ---------------------------------------------------------------------------

/** Every permanent that acts for this player: the tops of their unit piles and their backrow (§3.2). */
function permanentsOf(state: GameState, player: PlayerId): CardInstance[] {
  return ROWS.flatMap((row) =>
    slotsOf(player, row).flatMap((ref) => {
      const held = cardAt(state, ref);
      return held === null ? [] : [held];
    }),
  );
}

/**
 * §8 #64 Gifted Program, §10.5 step 3: whether a play this player makes now, paying `costPaid`
 * (R56's cost actually paid, 0 for a cast, R70), is made Radiant as it is played.
 *
 * R213: "the first card costing 1 or less YOU play each turn" is counted over the player's plays,
 * which the turn log keeps (`costsPaid`), and not over the Field Spell's own history. So the count
 * stays with the player whatever happens to the card: a Gifted Program that fired for its owner and
 * was then stolen has not used up its thief's first cheap card, one that was bounced and played
 * again has not given its player a second, and a card costing 1 or less played before a Gifted
 * Program arrived was already the first — Hearthstone's Pint-Sized Summoner counts the same way.
 * Each Gifted Program asks with its own face's threshold (2 or less on the radiant one), and the
 * card's text is its controller's (§8 Conventions), so only the permanents on this player's side
 * count. A Vanilla one has no text (`flagsOf`). It never catches its own play: step 3 runs before
 * step 4 puts it on the field (R119).
 */
export function giftedMakesRadiant(state: GameState, player: PlayerId, costPaid: number): boolean {
  const earlier = state.players[player].turnLog.costsPaid ?? [];
  return permanentsOf(state, player).some((held) => {
    const threshold = flagsOf(held).giftedProgram;
    if (threshold === undefined || costPaid > threshold) return false;
    return !earlier.some((paid) => paid <= threshold);
  });
}

/**
 * R214: the card whose declarations a play's targets and modes answer — the card as it will
 * resolve. §10.5 step 3 can make it Radiant as it is played (#64), after step 1 has read the choices
 * and before step 5 resolves them, and a Radiant face can declare other choices than the face in
 * hand: #87's "you may skip adding it", #48's "all enemy units, or all units", a crafted card whose
 * radiant Bigot names no target. So step 1 checks, and `legalActions` offers, the choices of the
 * face step 5 will run, which is known at step 1: the cost it pays is.
 */
export function resolvingFace(state: GameState, player: PlayerId, card: CardInstance, costPaid: number): CardInstance {
  if (card.radiant || !giftedMakesRadiant(state, player, costPaid)) return card;
  return { ...card, radiant: true };
}

/** What a play of this card with these prices would pay, read the way §10.5 step 1 reads it (R65). */
function costWith(state: GameState, card: CardInstance, x: number | undefined, embiggen: boolean | undefined): number {
  const probe: CardInstance = {
    ...card,
    x: choosesX(state, card) ? (x ?? 0) : card.x,
    embiggened: hasEmbiggenPrice(state, card) ? embiggen === true : card.embiggened,
  };
  return effectiveCost(state, probe);
}

// ---------------------------------------------------------------------------
// Zone, X and embiggen
// ---------------------------------------------------------------------------

/** §5.1: a Unit goes in the unit row, every other permanent in the backrow. */
export function rowForCard(state: GameState, card: CardInstance): Row {
  return defOf(state, card.defId).type === "Unit" ? "units" : "backrow";
}

/** §10.5 step 4: permanents take a zone, a Spell resolves without one. */
export function needsZone(state: GameState, card: CardInstance): boolean {
  return defOf(state, card.defId).type !== "Spell";
}

/**
 * §6.2 Stack: "may be played onto an occupied zone" (§3.2). Read off the card's printed face,
 * because at play time the card is still in hand: `unitView` is the *field* reading — it adds
 * `grantedKeywords` and layer-5 auras, and no effect reaches a card in a hand with either — while
 * `faceOf` is the radiant-aware printed text, which is what a card in hand has (§5.2, §10.4 layer
 * 1). Only the unit row holds a pile (§3.2's zone table), so a backrow card never stacks.
 */
export function playsOnStack(state: GameState, card: CardInstance): boolean {
  if (!needsZone(state, card) || rowForCard(state, card) !== "units") return false;
  return hasKeyword(faceOf(state, card).keywords, "Stack");
}

/**
 * §3.2: the zone a Stack card may enter. Occupancy is exactly the refusal Stack lifts, so what is
 * left is the two that occupancy never covered: a Locked zone "accepts no summons until the game
 * ends" and a zone reserved for a dying Reborn unit "counts as occupied for every other card that
 * would enter it" (R64). Neither takes a Stack card either.
 */
function acceptsStack(state: GameState, ref: ZoneSlot): boolean {
  return ref.row === "units" && !isLocked(state, ref) && !isReserved(state, ref);
}

/**
 * §3.2: "the player picks the zone" — every empty, unlocked, unreserved zone of the right row, plus
 * the occupied unit zones for a Stack card (§6.2). `refuseZone` below reads the same two rules off
 * the same pair of predicates, so the client's greyed-out button and `reduce`'s refusal agree.
 */
export function legalZonesFor(state: GameState, player: PlayerId, card: CardInstance): ZoneChoice[] {
  if (!needsZone(state, card)) return [];
  const row = rowForCard(state, card);
  const refs = playsOnStack(state, card)
    ? slotsOf(player, row).filter((ref) => acceptsStack(state, ref))
    : openZones(state, player, row);
  return refs.map((ref) => ({ row: ref.row, lane: ref.lane }));
}

/**
 * §2.3: whether the player chooses X when playing this card — an X-cost card whose X is not fixed
 * by a `cost` hook. #98 Heroic Power prints X but "its X is fixed by its power" (§2.3, R43, R65):
 * its cost hook answers the X, so there is nothing to choose and no X travels in its play.
 */
export function choosesX(state: GameState, instance: CardInstance): boolean {
  return isXCost(state, instance) && scriptOf(instance).cost === undefined;
}

/** §2.3: "X is chosen at play time, 0 ≤ X ≤ current mana". Not an X-cost card, no X values. */
export function legalXValues(state: GameState, player: PlayerId, card: CardInstance): number[] {
  if (!choosesX(state, card)) return [];
  const mana = state.players[player].mana.current;
  return Array.from({ length: Math.max(0, mana) + 1 }, (_, i) => i);
}

/** §2.3: an "A embiggen B" card offers two prices; every other card offers none. */
export function hasEmbiggenPrice(state: GameState, card: CardInstance): boolean {
  const cost = defOf(state, card.defId).cost;
  return typeof cost === "object" && cost !== null && !Array.isArray(cost);
}

export function legalEmbiggenChoices(state: GameState, card: CardInstance): boolean[] {
  return hasEmbiggenPrice(state, card) ? [false, true] : [];
}

// ---------------------------------------------------------------------------
// Tribute (§6.3, §3.2)
// ---------------------------------------------------------------------------

/**
 * #55 Lava Golem "may tribute enemy units", which no other Tribute card may (R101). `script.ts`'s
 * `StaticFlags` now declares `tributeEnemies?: boolean` beside `tribute`, so this alias is only a
 * local narrowing for readability; the flag defaults to false, which is every other card.
 */
type TributeFlags = StaticFlags & { tributeEnemies?: boolean };

/** §6.3 "Tribute X": the number of units playing this card sacrifices, 0 when it asks for none. */
export function tributeCostOf(card: CardInstance): number {
  const declared = declaredTargets(card).find((decl) => decl.kind === "tribute")?.amount;
  const flagged: TributeFlags = flagsOf(card);
  return Math.max(0, declared ?? flagged.tribute ?? 0);
}

export function mayTributeEnemyUnits(card: CardInstance): boolean {
  const flags: TributeFlags = flagsOf(card);
  return flags.tributeEnemies === true;
}

/** §7: a Radiant Sheep Token is "2/2, worth 3 Tributes" — the base one is worth 2. */
export const RADIANT_SHEEP_TRIBUTE_VALUE = 3;
export const SHEEP_TRIBUTE_VALUE = 2;

/**
 * §3.2: "Sheep Tokens are worth 2 Tributes while on the field"; every other unit is worth 1.
 *
 * §7 gives the Sheep a Radiant face worth 3, so the value is read off the instance's face rather
 * than its definition — the same card is worth a different amount depending on which face is up,
 * which is exactly what a Radiant form is.
 */
export function tributeValueOf(state: GameState, unit: CardInstance): number {
  if (defOf(state, unit.defId).index !== SHEEP_TOKEN_INDEX) return 1;
  return unit.radiant ? RADIANT_SHEEP_TRIBUTE_VALUE : SHEEP_TRIBUTE_VALUE;
}

/** §6.3: your own units, plus the enemy's for a card that says so (#55). Dormant cards never. */
export function legalTributeUnits(state: GameState, player: PlayerId, card: CardInstance): CardInstance[] {
  const sides: PlayerId[] = mayTributeEnemyUnits(card) ? [player, opponentOf(player)] : [player];
  return sides.flatMap((side) => activeUnitsOf(state, side).filter((unit) => unit.id !== card.id));
}

function tributeTotal(state: GameState, units: readonly CardInstance[]): number {
  return units.reduce((sum, unit) => sum + tributeValueOf(state, unit), 0);
}

/**
 * Every set of units that pays the Tribute exactly: enough to meet the cost, and minimal, so no unit
 * in the set could be dropped and still pay it. The Sheep Token's 2 is why a set may overshoot.
 */
export function legalTributeSets(state: GameState, player: PlayerId, card: CardInstance): string[][] {
  const need = tributeCostOf(card);
  if (need === 0) return [[]];

  const units = legalTributeUnits(state, player, card);
  const out: string[][] = [];
  const chosen: CardInstance[] = [];

  const walk = (from: number): void => {
    if (out.length >= MAX_CHOICE_COMBINATIONS) return;
    const paid = tributeTotal(state, chosen);
    if (paid >= need) {
      if (isMinimalTribute(state, chosen, need)) out.push(chosen.map((unit) => unit.id));
      return;
    }
    for (let at = from; at < units.length; at += 1) {
      const unit = units[at];
      if (unit === undefined) continue;
      chosen.push(unit);
      walk(at + 1);
      chosen.pop();
      if (out.length >= MAX_CHOICE_COMBINATIONS) return;
    }
  };

  walk(0);
  return out;
}

function isMinimalTribute(state: GameState, units: readonly CardInstance[], need: number): boolean {
  const paid = tributeTotal(state, units);
  return units.every((unit) => paid - tributeValueOf(state, unit) < need);
}

// ---------------------------------------------------------------------------
// Declared targets: the options one declaration admits
// ---------------------------------------------------------------------------

function selectionKey(selection: Selection): string {
  switch (selection.pick) {
    case "instance":
      return `instance:${selection.instanceId}`;
    case "hero":
      return `hero:${selection.player}`;
    case "zone":
      return `zone:${selection.player}:${selection.row}:${selection.lane}`;
    case "mode":
      return `mode:${selection.option}`;
    default:
      return "none";
  }
}

/**
 * The sides a declaration reaches, the chooser's own first so the offered order is stable.
 *
 * A Tribute defaults to the chooser's side — §6.3 reads "sacrifice X of *your* units" — and every
 * other kind defaults to both, which is what §10.6's bare `target` means. A `hand` declaration is
 * forced to the chooser whatever it says (§9.1: the opponent's hand is hidden), which `handSides`
 * enforces rather than this.
 */
function sidesFor(player: PlayerId, decl: TargetDecl): PlayerId[] {
  const side = decl.filter?.side ?? (decl.kind === "tribute" ? "ally" : "any");
  if (side === "ally") return [player];
  if (side === "enemy") return [opponentOf(player)];
  return [player, opponentOf(player)];
}

/** §10.6: what a declaration picks. `of` names it; otherwise the declaration's own kind does. */
function pickKindsFor(decl: TargetDecl): PickKind[] {
  const named = decl.filter?.of;
  if (named !== undefined && named.length > 0) return PICK_KIND_ORDER.filter((kind) => named.includes(kind));
  if (decl.kind === "hand") return ["hand"];
  if (decl.kind === "zone") return ["zone"];
  // R90: "a card that declared nothing takes nothing"; a bare `target` or `tribute` means a unit.
  return ["unit"];
}

function typeAllows(filter: TargetFilter | undefined, type: CardType): boolean {
  const named = filter?.type;
  if (named === undefined) return true;
  return Array.isArray(named) ? named.includes(type) : named === type;
}

/** §10.6: `tags` wants every tag it names, `notTags` none of them — the same reading as §5.1's query. */
function tagsAllow(filter: TargetFilter | undefined, tags: readonly Tag[]): boolean {
  if (filter?.tags !== undefined && !filter.tags.every((tag) => tags.includes(tag))) return false;
  if (filter?.notTags !== undefined && filter.notTags.some((tag) => tags.includes(tag))) return false;
  return true;
}

function cardAllowed(
  state: GameState,
  filter: TargetFilter | undefined,
  held: CardInstance,
  self: CardInstance,
): boolean {
  if (filter?.excludeSelf === true && held.id === self.id) return false;
  const def = defOf(state, held.defId);
  return typeAllows(filter, def.type) && tagsAllow(filter, def.tags);
}

/** A hero has no card type and no tags, so a filter that names either cannot reach one. */
function heroAllowed(filter: TargetFilter | undefined): boolean {
  return filter?.type === undefined && filter?.tags === undefined;
}

/**
 * Every selection this declaration admits right now, in offer order: the chooser's side first, and
 * within a side units by lane, then the backrow by lane, then the hand, then zones, then the hero.
 *
 * R90: a unit pick offers the top of a Stack pile and never a dormant card (R13), a hand pick offers
 * only the chooser's own hand (§9.1), and the card being played is never offered out of the hand it
 * is leaving. An empty result is not an error — the play stays legal and the effect fizzles.
 */
export function legalSelectionsFor(
  state: GameState,
  player: PlayerId,
  card: CardInstance,
  decl: TargetDecl,
): Selection[] {
  const filter = decl.filter;
  const kinds = pickKindsFor(decl);
  const out: Selection[] = [];
  const seen = new Set<string>();

  const offer = (selection: Selection): void => {
    const key = selectionKey(selection);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(selection);
  };

  for (const side of sidesFor(player, decl)) {
    for (const kind of kinds) {
      switch (kind) {
        case "unit":
          for (const unit of activeUnitsOf(state, side)) {
            if (cardAllowed(state, filter, unit, card)) offer({ pick: "instance", instanceId: unit.id });
          }
          break;
        case "backrow":
          for (const ref of slotsOf(side, "backrow")) {
            const held = cardAt(state, ref);
            if (held === null) continue;
            if (cardAllowed(state, filter, held, card)) offer({ pick: "instance", instanceId: held.id });
          }
          break;
        case "hand":
          // §9.1: only ever the chooser's own hand, whatever side the filter names.
          if (side !== player) break;
          for (const held of state.players[player].hand) {
            if (held.id === card.id) continue;
            if (cardAllowed(state, filter, held, card)) offer({ pick: "instance", instanceId: held.id });
          }
          break;
        case "zone":
          for (const row of ROWS) {
            for (const ref of slotsOf(side, row)) {
              if (isOpen(state, ref)) offer({ pick: "zone", player: ref.player, row: ref.row, lane: ref.lane });
            }
          }
          break;
        case "hero":
          if (heroAllowed(filter)) offer({ pick: "hero", player: side });
          break;
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// R90: reading the flat list, and enumerating it
// ---------------------------------------------------------------------------

/**
 * R90: how many selections a declaration takes off the flat list. Every declaration but the last
 * takes a fixed number — its own minimum, or everything the board can offer when that is less, so a
 * declaration the board cannot satisfy takes none and the next one still reads its own slot. The
 * last declaration takes the remainder.
 */
function takeFor(decl: TargetDecl, offered: number): number {
  return Math.min(decl.min, offered);
}

/**
 * R90's reading of a flat `targets` list: one slice per declaration, in declaration order, measured
 * against what the board offers each declaration now. A fused card reads its ingredients' slices
 * this way (R102), each ingredient's script getting only the declarations it made.
 */
export function selectionsPerDeclaration(
  state: GameState,
  player: PlayerId,
  card: CardInstance,
  decls: readonly TargetDecl[],
  selections: readonly Selection[],
): Selection[][] {
  const offered = decls.map((decl) => legalSelectionsFor(state, player, card, decl));
  return splitSelections(decls, offered, selections);
}

function splitSelections(
  decls: readonly TargetDecl[],
  offered: readonly Selection[][],
  selections: readonly Selection[],
): Selection[][] {
  const out: Selection[][] = [];
  let at = 0;
  decls.forEach((decl, index) => {
    if (index === decls.length - 1) {
      out.push(selections.slice(at));
      at = selections.length;
      return;
    }
    const take = Math.min(takeFor(decl, offered[index]?.length ?? 0), Math.max(0, selections.length - at));
    out.push(selections.slice(at, at + take));
    at += take;
  });
  return out;
}

/** Every subset of `options` a declaration may answer with, size-ascending then index order. */
function subsetsFor(options: readonly Selection[], decl: TargetDecl, isLast: boolean): Selection[][] {
  const low = takeFor(decl, options.length);
  const high = isLast ? Math.min(decl.max, options.length) : low;
  const out: Selection[][] = [];

  for (let size = low; size <= high; size += 1) {
    const picked: Selection[] = [];
    const walk = (from: number): void => {
      if (out.length >= MAX_CHOICE_COMBINATIONS) return;
      if (picked.length === size) {
        out.push([...picked]);
        return;
      }
      for (let at = from; at < options.length; at += 1) {
        const option = options[at];
        if (option === undefined) continue;
        picked.push(option);
        walk(at + 1);
        picked.pop();
        if (out.length >= MAX_CHOICE_COMBINATIONS) return;
      }
    };
    walk(0);
    if (out.length >= MAX_CHOICE_COMBINATIONS) break;
  }

  return out;
}

function crossProduct<T>(lists: readonly T[][], cap: number): T[][] {
  let out: T[][] = [[]];
  for (const list of lists) {
    const next: T[][] = [];
    for (const prefix of out) {
      for (const item of list) {
        next.push([...prefix, item]);
        if (next.length >= cap) break;
      }
      if (next.length >= cap) break;
    }
    out = next;
  }
  return out;
}

/**
 * R90: "`legalActions` enumerates every legal combination, bounded by `MAX_CHOICE_COMBINATIONS`".
 * Declarations are read in order, the first varying slowest, and the target and mode lists that come
 * back are exactly what a `play` action carries. A card that declares nothing yields one empty
 * answer, so it is still offered once.
 */
export function playChoiceCombinations(
  state: GameState,
  player: PlayerId,
  card: CardInstance,
): PlayChoices[] {
  const targetDecls = declaredTargets(card);
  const modeDecls = declaredModes(card);
  if (targetDecls.length === 0 && modeDecls.length === 0) return [{}];

  const targetCombosFor = (decls: readonly TargetDecl[]): Selection[][] => {
    const perDecl = decls.map((decl, index) =>
      subsetsFor(legalSelectionsFor(state, player, card, decl), decl, index === decls.length - 1),
    );
    return crossProduct(perDecl, MAX_CHOICE_COMBINATIONS).map((slices) => slices.flat());
  };
  const modeCombos = crossProduct(
    modeDecls.map((decl) => decl.options),
    MAX_CHOICE_COMBINATIONS,
  );

  const out: PlayChoices[] = [];
  if (targetsFollowModes(targetDecls)) {
    // The target declarations a play answers depend on its modes (`forModes`), so each mode choice
    // is enumerated with the targets it asks for.
    for (const modes of modeDecls.length === 0 ? [[]] : modeCombos) {
      const active = activeTargetDecls(targetDecls, modes);
      for (const targets of active.length === 0 ? [undefined] : targetCombosFor(active)) {
        out.push({ ...(targets === undefined ? {} : { targets }), ...(modeDecls.length === 0 ? {} : { modes }) });
        if (out.length >= MAX_CHOICE_COMBINATIONS) return out;
      }
    }
    return out;
  }

  const targetCombos = targetCombosFor(targetDecls);
  const targetAnswers: (Selection[] | undefined)[] = targetDecls.length === 0 ? [undefined] : targetCombos;
  const modeAnswers: (string[] | undefined)[] = modeDecls.length === 0 ? [undefined] : modeCombos;

  for (const targets of targetAnswers) {
    for (const modes of modeAnswers) {
      out.push({ ...(targets === undefined ? {} : { targets }), ...(modes === undefined ? {} : { modes }) });
      if (out.length >= MAX_CHOICE_COMBINATIONS) return out;
    }
  }
  return out;
}

/**
 * Every `play` action this card could legally produce: R81's five choice kinds crossed, skipping the
 * prices the player cannot pay. This is what `legalActions` lists for a card in hand.
 */
export function playActionsFor(state: GameState, player: PlayerId, card: CardInstance): PlayAction[] {
  const out: PlayAction[] = [];
  const xValues: (number | undefined)[] = choosesX(state, card) ? legalXValues(state, player, card) : [undefined];
  const embiggens: (boolean | undefined)[] = hasEmbiggenPrice(state, card)
    ? legalEmbiggenChoices(state, card)
    : [undefined];
  const zones: (ZoneChoice | undefined)[] = needsZone(state, card) ? legalZonesFor(state, player, card) : [undefined];
  const tributeSets = legalTributeSets(state, player, card);

  for (const x of xValues) {
    for (const embiggen of embiggens) {
      const probe: CardInstance = { ...card, x: x ?? card.x, embiggened: embiggen ?? card.embiggened };
      const cost = effectiveCost(state, probe);
      if (cost > state.players[player].mana.current) continue;
      // R214: the choices of the face step 5 will resolve, which this price decides (#64).
      const face = resolvingFace(state, player, card, cost);
      for (const tributes of tributeSets) {
        for (const zone of zones) {
          for (const choices of playChoiceCombinations(state, player, face)) {
            out.push({
              type: "play",
              instanceId: card.id,
              ...(zone === undefined ? {} : { zone }),
              ...(x === undefined ? {} : { x }),
              ...(embiggen === undefined ? {} : { embiggen }),
              ...(tributes.length === 0 ? {} : { tributes }),
              ...choices,
            });
          }
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// §10.5 step 1: the refusal
// ---------------------------------------------------------------------------

function plural(count: number, one: string): string {
  return count === 1 ? `${count} ${one}` : `${count} ${one}s`;
}

function refuseZone(state: GameState, player: PlayerId, card: CardInstance, zone?: ZoneChoice): string | null {
  const name = defOf(state, card.defId).name;
  const needs = needsZone(state, card);

  if (zone === undefined) {
    if (!needs) return null;
    const row = rowForCard(state, card);
    // §3.2: playing a permanent from hand requires an open zone in the right row.
    return firstFreeZone(state, player, row) === null ? `no free ${row} zone` : null;
  }
  if (!needs) return `${name} takes no zone`;

  const row = rowForCard(state, card);
  if (zone.row !== row) return `${name} goes in the ${row} row`;
  if (zone.lane < 1 || zone.lane > rowSize(row)) return `there is no ${row} zone ${zone.lane}`;

  // §6.2 Stack: an occupied unit zone is a legal zone for a Stack card, and only occupancy is
  // waived — `acceptsStack` still refuses a Locked or Reborn-reserved zone (R64).
  const ref: ZoneSlot = { player, row: zone.row, lane: zone.lane };
  const takesIt = playsOnStack(state, card) ? acceptsStack(state, ref) : isOpen(state, ref);
  if (!takesIt) return `that ${row} zone is not open`;
  return null;
}

function refuseX(state: GameState, player: PlayerId, card: CardInstance, x?: number): string | null {
  const name = defOf(state, card.defId).name;
  if (!isXCost(state, card)) return x === undefined ? null : `${name} does not cost X`;
  // R43: an X the card's own cost hook fixes (#98) is not the player's to choose, so whatever the
  // action names is ignored — never recorded on the card, never read by the cost (`playSteps`).
  if (!choosesX(state, card)) return null;
  const value = x ?? 0;
  if (!Number.isInteger(value)) return "X must be a whole number";
  if (value < 0) return "X cannot be negative";
  if (value > state.players[player].mana.current) return "X is above your current mana";
  return null;
}

function refuseEmbiggen(state: GameState, card: CardInstance, embiggen?: boolean): string | null {
  if (hasEmbiggenPrice(state, card)) return null;
  return embiggen === true ? `${defOf(state, card.defId).name} has no embiggen price` : null;
}

function refuseTributes(
  state: GameState,
  player: PlayerId,
  card: CardInstance,
  tributes?: readonly string[],
): string | null {
  const name = defOf(state, card.defId).name;
  const need = tributeCostOf(card);
  const picked = tributes ?? [];
  if (need === 0) return picked.length === 0 ? null : `${name} needs no Tribute`;

  const legal = new Map(legalTributeUnits(state, player, card).map((unit) => [unit.id, unit]));
  // §6.3: the Tribute is an additional *cost*, so a board that cannot pay it refuses the play (#66).
  if (tributeTotal(state, [...legal.values()]) < need) return `${name} needs Tribute ${need}`;

  const chosen: CardInstance[] = [];
  const seen = new Set<string>();
  for (const id of picked) {
    const unit = legal.get(id);
    if (unit === undefined) return `${id} cannot be tributed to play ${name}`;
    if (seen.has(id)) return `${name} cannot tribute the same unit twice`;
    seen.add(id);
    chosen.push(unit);
  }

  if (tributeTotal(state, chosen) < need) return `${name} needs Tribute ${need}`;
  if (!isMinimalTribute(state, chosen, need)) return `${name} tributes ${need}, no more`;
  return null;
}

function refuseTargets(
  state: GameState,
  player: PlayerId,
  card: CardInstance,
  selections: readonly Selection[],
  modes: readonly string[],
): string | null {
  const name = defOf(state, card.defId).name;
  const declared = declaredTargets(card);
  // R90: a declaration that belongs to modes the play did not choose asks for nothing.
  const decls = activeTargetDecls(declared, modes);
  if (decls.length === 0 && declared.length > 0) {
    return selections.length === 0 ? null : `${name} takes no targets for that choice`;
  }
  // R90: "a card that declared nothing takes nothing".
  if (decls.length === 0) return selections.length === 0 ? null : `${name} takes no targets`;

  const offered = decls.map((decl) => legalSelectionsFor(state, player, card, decl));
  const slices = splitSelections(decls, offered, selections);

  for (let index = 0; index < decls.length; index += 1) {
    const decl = decls[index];
    const got = slices[index] ?? [];
    const options = offered[index] ?? [];
    if (decl === undefined) continue;

    // R90: a declaration the board cannot satisfy asks for what the board has, not for its minimum.
    const required = takeFor(decl, options.length);
    if (got.length < required) return `${name} needs ${plural(required, "target")} for that choice`;
    if (got.length > decl.max) return `${name} takes at most ${plural(decl.max, "target")} for that choice`;

    const keys = new Set(options.map(selectionKey));
    const used = new Set<string>();
    for (const selection of got) {
      const key = selectionKey(selection);
      if (!keys.has(key)) return `that is not a legal target for ${name}`;
      // R90: one declaration may not pick the same card twice; two declarations may.
      if (used.has(key)) return `${name} cannot name the same target twice in one choice`;
      used.add(key);
    }
  }
  return null;
}

function refuseModes(state: GameState, card: CardInstance, modes: readonly string[]): string | null {
  const name = defOf(state, card.defId).name;
  const decls = declaredModes(card);
  if (decls.length === 0) return modes.length === 0 ? null : `${name} takes no mode choices`;
  if (modes.length > decls.length) {
    return `${name} takes ${plural(decls.length, "mode choice")}, not ${modes.length}`;
  }

  for (let index = 0; index < decls.length; index += 1) {
    const decl = decls[index];
    if (decl === undefined) continue;
    const option = modes[index];
    if (option === undefined) {
      return `${name} needs a mode choice for each of its ${plural(decls.length, "mode declaration")}`;
    }
    if (!decl.options.includes(option)) return `"${option}" is not a mode of ${name}`;
  }
  return null;
}

/**
 * §10.5 step 1, R90: every choice the play carried, checked against what the card declared and what
 * the board allows. Returns `null` when the play's choices are legal, and the refusal otherwise —
 * `reduce` returns that string and leaves the state untouched (§9.3).
 *
 * Mana affordability is not a choice and stays with `reduce`'s pay step (§10.5 step 2).
 */
export function whyChoicesRefused(
  state: GameState,
  player: PlayerId,
  card: CardInstance,
  action: PlayAction,
): string | null {
  const price =
    refuseZone(state, player, card, action.zone) ??
    refuseX(state, player, card, action.x) ??
    refuseEmbiggen(state, card, action.embiggen) ??
    refuseTributes(state, player, card, action.tributes);
  if (price !== null) return price;
  // R214: the targets and modes are the resolving face's, so they are read against it. The Tribute
  // above is paid at step 2, before step 3 can change the face, so it is the face in hand's.
  const face = resolvingFace(state, player, card, costWith(state, card, action.x, action.embiggen));
  return (
    refuseTargets(state, player, face, action.targets ?? [], action.modes ?? []) ??
    refuseModes(state, face, action.modes ?? [])
  );
}
