// The Zephyrs scorer (SPEC §10.7's scorer bullet, R29, §8 #97): rank every non-token Core
// definition except Zephyrs itself for the current state, so the Discover can offer the top 3.
//
// §10.7's priorities, in order: lethal available → max; can clear the enemy board → high; hero
// below 10 and the card heals → high; otherwise stats per mana plus draw value.
//
// Each priority is read two ways. The printed data — type, cost, stats and keywords (§5) — stands in
// for it where a card's face says so (a Charge body, a Poisonous one, Lifesteal), named at its own
// function. And §10.7's dry run plays the candidate on a copy of the state (`dryRun`), which is the
// only way to see what a card's *text* does: #44's 4 damage, #17's bounce of every unit, #53's heal
// to 30. A card whose claim to a priority lives in neither scores on stats per mana like any other.
//
// The scorer is a pure function of (state, viewer): the dry run draws from a seed of its own and
// never the match's, and no clock is read, so the same state always produces the same order, which
// is what R29's Discover and §9.3's replay need.

import type { CardDef, CardFace, PlayerId } from "@jackioh/shared";
import { hasKeyword, opponentOf } from "@jackioh/shared";
import { query, queryCost } from "../catalog";
import { canAttack } from "../combat";
import { heroArmorOf, heroDamageCap } from "../damage";
import { unitView } from "../layers";
import { playActionsFor } from "../playChoices";
import { runPlaySteps, type PlayAction } from "../playSteps";
import { createRng } from "../rng";
import { scriptsFor } from "../scripts";
import { cloneState, newInstance, type CardInstance, type GameState } from "../state";
import { settle, type SettleSink } from "../triggers";
import { activeUnitsOf, firstFreeZone, isLocked, isReserved, slotsOf } from "../zones";

/**
 * The weights, in one place so they can be tuned without touching the scoring functions (§10.7:
 * "the weights are engine constants, tested against fixed states"). The tests pin the ranking a
 * fixed state produces, never these numbers, so a tuning pass does not rewrite the test file.
 *
 * The gaps are deliberate: the four priorities of §10.7 are a strict order, so no amount of stats
 * per mana can outrank a heal at low health, no heal can outrank a board clear, and nothing
 * outranks lethal.
 */
export const SCORER_WEIGHTS = {
  /** "lethal available → max". */
  lethal: 100_000,
  /** "can clear the enemy board → high". */
  clearsBoard: 10_000,
  /** Partial credit: an answer to some of the enemy board is worth less than all of it. */
  perKill: 1_000,
  /** "hero below 10 and card heals → high". */
  heal: 5_000,
  /** The fallback: printed stats per mana. */
  statsPerMana: 10,
  /** The fallback's second half: what the card leaves behind beyond this turn. */
  drawValue: 25,
} as const;

/** §10.7: the hero health below which a heal becomes a priority. */
export const SCORER_LOW_HEALTH = 10;

/** R29: the scorer ranks every non-token Core card except #97 itself. */
export const ZEPHYRS_INDEX = "97";

export type ScorerOptions = {
  /** #97 radiant: the picks are radiant, so the radiant face is the one scored (§5.2). */
  radiant?: boolean;
};

/** Which §10.7 priority decided this score; the highest one that applied. */
export type ScorePriority = "lethal" | "clear" | "heal" | "value";

export type Scored = {
  def: CardDef;
  score: number;
  priority: ScorePriority;
  /** Each priority's contribution, for tuning and for the client's tooltip. */
  parts: { lethal: number; clear: number; kills: number; heal: number; stats: number; draw: number };
};

/** R29, §5.1: the candidate pool. `query` already drops tokens and the excluded index. */
export function candidateDefs(): CardDef[] {
  return query({ set: "Core", excludeIndex: ZEPHYRS_INDEX });
}

function faceFor(def: CardDef, radiant: boolean): CardFace {
  return radiant ? def.radiant : def.base;
}

/**
 * §4.4 steps 2 and 3: what one hit of `amount` actually takes off that hero (R44). Step 2's Armor
 * is `heroArmorOf`, the pipeline's own reader — the stored Armor plus every backrow grant (#84),
 * summed per R124 — so the score and the hit never disagree.
 */
function heroHit(state: GameState, player: PlayerId, amount: number): number {
  const after = Math.max(0, amount - heroArmorOf(state, player));
  const cap = heroDamageCap(state, player);
  return cap === null ? after : Math.min(after, cap);
}

/**
 * Damage the viewer's board can already send at the enemy hero this turn: every unit that may
 * legally attack the hero right now, after Armor and the cap (R44). Taunt, exertion, position and
 * summoning sickness are all in `canAttack`, so a board that cannot reach the hero projects 0.
 */
export function projectedBoardDamage(state: GameState, viewer: PlayerId): number {
  const enemy = opponentOf(viewer);
  return activeUnitsOf(state, viewer)
    .filter((unit) => canAttack(state, unit, { kind: "hero", player: enemy }))
    .reduce((sum, unit) => sum + heroHit(state, enemy, unitView(state, unit).attack), 0);
}

/**
 * §10.7 priority 1. The printed signal for "this card enables lethal" is a Unit with Charge: it is
 * the only printed data that says a card can hit the hero on the turn it arrives (§6.1, and Rush
 * explicitly may not). A card must also be affordable, have a zone to be played into and a clear
 * path to the hero (no enemy Taunt), or the lethal is not available this turn, and it must
 * contribute damage of its own, so "enables" means the card is part of the kill.
 *
 * Out of reach from printed data: a damage spell, a Taunt-remover or a buff that would also make
 * the swing lethal. All three live in card text.
 */
function lethalContribution(state: GameState, viewer: PlayerId, def: CardDef, face: CardFace): number {
  if (def.type !== "Unit") return 0;
  if (!hasKeyword(face.keywords, "Charge")) return 0;
  if (queryCost(def) > state.players[viewer].mana.current) return 0;
  // It must reach the field this turn: §3.2 plays a Unit into an empty, unlocked zone, or a Stack
  // card onto an occupied one (#92), so a full row keeps anything else off the board.
  if (!hasRoomToPlay(state, viewer, face)) return 0;
  // And it must reach the hero: §4.2 step 3 makes any enemy Taunt unit the only legal target, which
  // is the same check `projectedBoardDamage` makes through `canAttack` for the units already there.
  const enemy = opponentOf(viewer);
  if (activeUnitsOf(state, enemy).some((unit) => hasKeyword(unitView(state, unit).keywords, "Taunt"))) return 0;
  return heroHit(state, enemy, face.attack ?? 0);
}

/** §3.2: whether a Unit with this face could be played into the viewer's unit row now. */
function hasRoomToPlay(state: GameState, viewer: PlayerId, face: CardFace): boolean {
  if (firstFreeZone(state, viewer, "units") !== null) return true;
  if (!hasKeyword(face.keywords, "Stack")) return false;
  return slotsOf(viewer, "units").some((ref) => !isLocked(state, ref) && !isReserved(state, ref));
}

/**
 * §10.7 priority 2. The printed signal for "answers an enemy unit" is an attack big enough to
 * destroy it through its Armor, or Poisonous, which destroys any unit it damages (§6.1). Divine
 * Shield and Indestructible put a unit out of reach of both. Cleave hits the target's two
 * neighbours, so one attack can answer up to three units (§3.1).
 *
 * Out of reach from printed data: every board wipe and every targeted destroy, which are text.
 */
function killableUnits(state: GameState, enemyUnits: readonly CardInstance[], face: CardFace): number {
  const attack = face.attack ?? 0;
  const poisonous = hasKeyword(face.keywords, "Poisonous");
  const answered = enemyUnits.filter((unit) => {
    const view = unitView(state, unit);
    if (hasKeyword(view.keywords, "Indestructible")) return false;
    if (hasKeyword(view.keywords, "Divine Shield") && unit.divineShieldSpent !== true) return false;
    if (poisonous) return attack > view.armor;
    return attack - view.armor >= view.health;
  }).length;

  const reach = hasKeyword(face.keywords, "Cleave") ? 3 : 1;
  return Math.min(answered, reach);
}

/**
 * §10.7 priority 3. The one heal printed on a card face is Lifesteal, which heals its controller's
 * hero for the damage it deals (§6.1, §4.4 step 8).
 *
 * Out of reach from printed data: every "Restore N Health" and every healing Cry, which are text.
 */
function healsFromPrintedData(face: CardFace): boolean {
  return hasKeyword(face.keywords, "Lifesteal");
}

/** §10.7's fallback, first half: printed stats per mana. A spell prints no stats, so it scores 0. */
function statsPerMana(def: CardDef, face: CardFace): number {
  const stats = (face.attack ?? 0) + (face.health ?? 0);
  return stats / Math.max(1, queryCost(def));
}

/**
 * §10.7's fallback, second half: "draw value". "Draw a card" is text, so this is the printed-data
 * stand-in — what the card leaves behind beyond the turn it is played. Reborn is a second body
 * from one card, Divine Shield buys a second life, and a backrow permanent keeps working after it
 * lands while a spell is spent on resolution (§3.2).
 */
function drawValue(def: CardDef, face: CardFace): number {
  let value = 0;
  if (hasKeyword(face.keywords, "Reborn")) value += 1;
  if (hasKeyword(face.keywords, "Divine Shield")) value += 0.5;
  if (def.type === "Field Spell" || def.type === "Trap" || def.type === "Field Trap") value += 0.5;
  return value;
}

// ---------------------------------------------------------------------------
// The dry run (§10.7: "for each candidate, simulate a dry-run score")
// ---------------------------------------------------------------------------

/**
 * How many of one candidate's plays the dry run tries. A play is tried at its strongest price (the
 * largest X, embiggened when that is affordable) in the first zone it could take, so what varies is
 * its targets and modes, taken heroes first (`targetRank`): the enemy hero is lethal's target, the
 * viewer's own a heal's, and the board's units come after them.
 */
export const SCORER_DRY_RUN_PLAYS = 8;

/** What playing a candidate now did, read off a copy of the state it was played in. */
export type DryRun = { lethal: boolean; clears: boolean; heals: boolean };

const NOTHING: DryRun = { lethal: false, clears: false, heals: false };

/** The seed a dry run draws from: its own, so the match's rng is never touched (§9.3). */
const DRY_RUN_SEED = "zephyrs-dry-run";

/**
 * Set while a dry run is playing a candidate, so a candidate whose play would ask the scorer again
 * scores on printed data rather than running a dry run inside a dry run. A dry run is synchronous
 * and resets it before returning, so no state outlives one call.
 */
let dryRunning = false;

/**
 * The plays a dry run tries: `playChoices.playActionsFor`'s, narrowed to one price per card — the
 * largest X and the embiggened price when either is affordable, the strongest thing the card can do
 * now — one zone and one Tribute set, since where a card lands and what it sacrificed are not what
 * §10.7's three questions ask.
 */
function dryRunPlays(state: GameState, viewer: PlayerId, card: CardInstance): PlayAction[] {
  const all = playActionsFor(state, viewer, card);
  if (all.length === 0) return [];
  const x = Math.max(...all.map((action) => action.x ?? 0));
  const embiggen = all.some((action) => action.embiggen === true);
  const first = all.find((action) => (action.x ?? 0) === x && (action.embiggen === true) === embiggen);
  const zone = JSON.stringify(first?.zone ?? null);
  const tributes = JSON.stringify(first?.tributes ?? []);
  const priced = all.filter(
    (action) =>
      (action.x ?? 0) === x &&
      (action.embiggen === true) === embiggen &&
      JSON.stringify(action.zone ?? null) === zone &&
      JSON.stringify(action.tributes ?? []) === tributes,
  );
  // A stable sort, so plays that aim alike keep the order `playActionsFor` gave them.
  return priced
    .map((action, at) => ({ action, at, rank: targetRank(viewer, action) }))
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .slice(0, SCORER_DRY_RUN_PLAYS)
    .map((entry) => entry.action);
}

/** Which of a play's targets the dry run tries first: a hero, then anything else (§10.7). */
function targetRank(viewer: PlayerId, action: PlayAction): number {
  const aim = action.targets?.[0];
  if (aim === undefined) return 0;
  if (aim.pick === "hero") return aim.player === viewer ? 1 : 0;
  return 2;
}

/**
 * Whether playing a card can do anything this turn that §10.7's three questions ask about: a Cry
 * (a Spell's script is its Cry, §10.9), an aura or a stat hook it brings to the field, a trigger, or
 * an on-play hook. Anything else — a Trap, which only answers the opponent later (§5.1); a body
 * whose text is a Death, a turn hook or a flag later plays read — does nothing now that its printed
 * data does not already say, so it is not played at all.
 */
function mayActNow(def: CardDef, radiant: boolean): boolean {
  if (def.type === "Trap" || def.type === "Field Trap") return false;
  const scripts = scriptsFor(def.id);
  const script = radiant ? scripts.radiant : scripts.base;
  return (
    script.cry !== undefined ||
    script.aura !== undefined ||
    script.setStat !== undefined ||
    script.onPlayHook !== undefined ||
    (script.triggers ?? []).length > 0
  );
}

/**
 * §10.7's dry run: the card is put in the viewer's hand on a copy of the state and played now, with
 * the viewer's own mana, once per play `dryRunPlays` names, and the copy after the play says what it
 * did. Lethal is available when the enemy hero is dead, or when what the viewer's board can then
 * send at it this turn finishes it (a Charge unit, a buff, a Taunt removed); it clears the enemy
 * board when the enemy had units and has none; and it heals when the viewer's hero ends above where
 * it began. A card whose play asks something is read as it stands at the question.
 *
 * The play is made on a copy of `base` (`dryRunBase`), which the candidate joins for its turn and
 * leaves again, and the copy draws from a seed of its own, so the match's state and rng are untouched
 * and the ranking stays a pure function of the state (R29, §9.3).
 */
export function dryRun(
  state: GameState,
  viewer: PlayerId,
  def: CardDef,
  radiant: boolean,
  base: GameState | null = dryRunBase(state, viewer),
): DryRun {
  if (base === null || dryRunning || !mayActNow(def, radiant)) return NOTHING;
  const enemy = opponentOf(viewer);
  const hand = base.players[viewer].hand;
  const card = newInstance(base, def.id, viewer, { z: "hand", player: viewer });
  card.radiant = radiant;
  hand.push(card);
  dryRunning = true;
  try {
    const enemyUnitsBefore = activeUnitsOf(base, enemy).length;
    const healthBefore = base.players[viewer].hero.health;
    // A play aimed at the viewer's own hero can only answer the heal question, which asks nothing
    // of a hero at SCORER_LOW_HEALTH or more, so it is not played then.
    const healMatters = healthBefore < SCORER_LOW_HEALTH;
    const outcome: DryRun = { ...NOTHING };
    for (const action of dryRunPlays(base, viewer, card)) {
      if (!healMatters && targetRank(viewer, action) === 1) continue;
      const trial = cloneState(base);
      const sink: SettleSink = { state: trial, events: [], rng: createRng(DRY_RUN_SEED, 0) };
      if (runPlaySteps(sink, viewer, action) !== null) continue;
      settle(sink);

      const enemyHealth = trial.players[enemy].hero.health;
      if (trial.result?.winner === viewer || (trial.result === null && enemyHealth <= projectedBoardDamage(trial, viewer))) {
        outcome.lethal = true;
      }
      if (enemyUnitsBefore > 0 && activeUnitsOf(trial, enemy).length === 0) outcome.clears = true;
      if (trial.players[viewer].hero.health > healthBefore) outcome.heals = true;
      if (outcome.lethal && outcome.clears && outcome.heals) break;
    }
    return outcome;
  } finally {
    dryRunning = false;
    hand.splice(hand.indexOf(card), 1);
  }
}

/**
 * The copy of the state every dry run of one ranking plays on, or null when the viewer cannot play
 * now: only the active player in the main phase with nothing open can (a rank a test asks of the
 * other seat has no dry run, and the printed signals alone score it). The copy leaves the history
 * of actions behind (§9.3's nonce dedupe, §10.8's event window), which nothing a play reads is in.
 */
export function dryRunBase(state: GameState, viewer: PlayerId): GameState | null {
  if (state.result !== null || state.pending !== null || state.active !== viewer || state.phase !== "main") {
    return null;
  }
  const base = cloneState({ ...state, applied: [] });
  return base;
}

/** One candidate's score for this state. Pure: the same arguments always give the same number. */
export function scoreDef(
  state: GameState,
  viewer: PlayerId,
  def: CardDef,
  options: ScorerOptions = {},
  base: GameState | null = dryRunBase(state, viewer),
): Scored {
  const radiant = options.radiant === true;
  const face = faceFor(def, radiant);
  const enemy = opponentOf(viewer);
  const enemyUnits = activeUnitsOf(state, enemy);
  // What the card's text does, which its printed data cannot say (§10.7's dry run).
  const played = dryRun(state, viewer, def, radiant, base);

  const contribution = lethalContribution(state, viewer, def, face);
  const lethal =
    played.lethal ||
    (contribution > 0 && projectedBoardDamage(state, viewer) + contribution >= state.players[enemy].hero.health);

  const kills = killableUnits(state, enemyUnits, face);
  const clears = played.clears || (enemyUnits.length > 0 && kills >= enemyUnits.length);

  const heals =
    state.players[viewer].hero.health < SCORER_LOW_HEALTH && (played.heals || healsFromPrintedData(face));

  const parts = {
    lethal: lethal ? SCORER_WEIGHTS.lethal : 0,
    clear: clears ? SCORER_WEIGHTS.clearsBoard : 0,
    kills: kills * SCORER_WEIGHTS.perKill,
    heal: heals ? SCORER_WEIGHTS.heal : 0,
    stats: statsPerMana(def, face) * SCORER_WEIGHTS.statsPerMana,
    draw: drawValue(def, face) * SCORER_WEIGHTS.drawValue,
  };

  const priority: ScorePriority = lethal ? "lethal" : clears ? "clear" : heals ? "heal" : "value";
  const score = parts.lethal + parts.clear + parts.kills + parts.heal + parts.stats + parts.draw;
  return { def, score, priority, parts };
}

/** §5's index as a number, so "2" sorts before "10" and a token suffix still has a place. */
function indexRank(index: string): number {
  const parsed = Number.parseFloat(index);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

/**
 * The order two candidates sit in: higher score first, then the §5 index, then the catalog id.
 * Ids are unique, so this is a strict total order whatever the weights are — `rank` never leaves
 * two candidates tied and never depends on the order the catalog handed them over.
 */
export function compareScored(a: Scored, b: Scored): number {
  if (a.score !== b.score) return b.score - a.score;
  const byIndex = indexRank(a.def.index) - indexRank(b.def.index);
  if (byIndex !== 0) return byIndex;
  if (a.def.index !== b.def.index) return a.def.index < b.def.index ? -1 : 1;
  return a.def.id < b.def.id ? -1 : 1;
}

/** R29: every non-token Core definition except #97, best first, as a total order. */
export function rank(state: GameState, viewer: PlayerId, options: ScorerOptions = {}): Scored[] {
  // One copy for every candidate's dry run: each plays on a copy of it and puts it back as it was.
  const base = dryRunBase(state, viewer);
  return candidateDefs()
    .map((def) => scoreDef(state, viewer, def, options, base))
    .sort(compareScored);
}

/** R29, §8 #97: the Discover offers the top 3. */
export function topThree(state: GameState, viewer: PlayerId, options: ScorerOptions = {}): Scored[] {
  return rank(state, viewer, options).slice(0, 3);
}
