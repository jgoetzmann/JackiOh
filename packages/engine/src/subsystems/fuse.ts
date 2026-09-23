// Fuse and Craft a Card (SPEC §6.3 Fuse, R77): the transient definition two or three cards make,
// and the instance the result lives on. Used by #85 Unlicensed Experimentation and #99 Craft a Card.
//
// Three things make Fuse unlike every other verb.
//
// First, the result is a *definition*, not an instance: two cards' base forms make the fused base
// form and their radiant forms make the fused radiant one, so the fused card still has both faces
// and Make Radiant keeps working on it (§5.2). Definitions are shared by every copy of a card and
// are never edited, so the fusion writes a fresh one into `state.transientDefs`, where `defOf`
// finds it ahead of the catalog. It is match state and survives a JSON round-trip (§10.1).
//
// Second, the scripts are code, which no JSON state can hold. The concatenated pair therefore joins
// the script registry under the new def id, exactly as `packages/cards` and the test fixtures
// register theirs (`scripts.ts`), and the def records the ingredient ids it was built from
// (`fusedFrom`), so the pair can always be rebuilt from the state alone. A `t-<n>` id is only unique
// within one match, and the registry is the process's: every match on a server, and every world
// the practice AI simulates beside the real game in its worker, would otherwise overwrite one
// another's `t-1`. `syncFusedScripts` therefore re-registers a state's own pairs whenever the
// registry holds someone else's, and the engine calls it wherever it is entered (`reduce`,
// `legalActions`, `viewFor`), so a replay of the same action list runs the same scripts (§9.3).
//
// Third, R77 keeps an ingredient's *instance* when one of them is a target already on the field:
// the fused card is that card, with its zone, damage, exertion, counters and memory intact, and the
// other ingredients cease to exist without dying. So the only instance-level work here is the def
// id, the summed buffs and the united granted keywords; everything else is deliberately untouched.

import type { CardDef, CardFace, CardType, Keyword, PlayerId, Rarity, Tag } from "@jackioh/shared";
import { keywordKey } from "@jackioh/shared";
import { defOf, findDef } from "../catalog";
import { FUSE_COST_CAP } from "../config";
import { addToHand } from "../draw";
import { unitHas } from "../layers";
import { printedCost } from "../mana";
import type { EngineSink } from "../resolve";
import type { CardScripts, Script } from "../script";
import { registerScripts, registeredScripts, scriptsFor } from "../scripts";
import { newInstance, type CardInstance, type GameState } from "../state";
import { removeFromAnyZone } from "../zones";

/** R77: Craft a Card fuses "two or three cards", and #85 fuses two. Fewer is not a fusion. */
export const FUSE_MIN_INGREDIENTS = 2;

/** §8 #99: "the result costs 0 and goes to your hand", as a `costOverride` per R65. */
export const CRAFTED_CARD_COST = 0;

/**
 * The two `Script` members that are functions but return no list, so the generic concatenation
 * below cannot combine them and each is handled on its own: `cost` is dropped, because R77 fixes
 * the fused cost at min(sum, 4), and `setStat` is summed like every other stat R77 sums. A new
 * member of `Script` that returns something other than a list belongs in this pair.
 */
const COST_KEY = "cost";
const SET_STAT_KEY = "setStat";

/** The script keys whose entries carry an `id` that has to stay unique across the ingredients. */
const TRIGGER_KEYS = ["triggers", "handTriggers"] as const;

/** §8's rarity ladder, lowest first, so a fusion can report the rarest ingredient's rarity. */
const RARITY_ORDER: readonly Rarity[] = ["Token", "Common", "Rare", "Epic", "Legendary", "Mythic"];

export type FuseArgs = {
  /** Every card going into the fusion, in the order the fusing card names them. */
  ingredients: readonly CardInstance[];
  /**
   * R77: an ingredient already on the field that the result keeps as its instance. #85 fuses the
   * permanent the opponent just played onto one of yours, and that one is the target.
   */
  target?: CardInstance;
  /** Craft a Card: no target on the field, so the result is a fresh card in this player's hand. */
  toHand?: PlayerId;
};

// ---------------------------------------------------------------------------
// The fused definition (R77).
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** R77's unions: one keyword per distinct keyword, so Armor 1 and Armor 2 both survive (§10.4). */
function unionKeywords(keywords: readonly Keyword[]): Keyword[] {
  const seen = new Set<string>();
  const out: Keyword[] = [];
  for (const keyword of keywords) {
    const key = keywordKey(keyword);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(keyword);
  }
  return out;
}

function unionTags(defs: readonly CardDef[]): Tag[] {
  const seen = new Set<Tag>();
  for (const def of defs) for (const tag of def.tags) seen.add(tag);
  return [...seen];
}

/**
 * A stat the fused face has only if some ingredient had it: two fused Spells or Traps keep a face
 * with no attack and no health rather than gaining a printed 0/0 (§5, `CardFace`).
 */
function sumDefined(values: readonly (number | undefined)[]): number | null {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length === 0 ? null : defined.reduce((sum, value) => sum + value, 0);
}

/** R77: one face of the fusion — summed stats, united keywords, both texts. */
function fusedFace(defs: readonly CardDef[], radiant: boolean): CardFace {
  const faces = defs.map((def) => (radiant ? def.radiant : def.base));
  const attack = sumDefined(faces.map((face) => face.attack));
  const health = sumDefined(faces.map((face) => face.health));
  return {
    ...(attack === null ? {} : { attack }),
    ...(health === null ? {} : { health }),
    keywords: unionKeywords(faces.flatMap((face) => face.keywords)),
    text: faces.map((face) => face.text).join("\n"),
  };
}

/**
 * R77: "Its type is the target's, or the ingredients' shared type when there is no target on the
 * field (Field Trap if any ingredient is one)". The parenthetical settles a trap fusion, because a
 * Field Trap is not consumed when it fires and a plain Trap is, so the Field Trap half wins; it
 * cannot turn a unit fusion into a trap, and #85 only ever fuses two cards of the same type.
 *
 * Ingredients of different types with no target is a shape no Core card makes (#99 Discovers Units);
 * the first ingredient's type is the fallback rather than a fizzle.
 */
function fusedType(defs: readonly CardDef[], targetDef: CardDef | null): CardType {
  const types = defs.map((def) => def.type);
  const first = types[0] ?? "Unit";
  const shared = types.every((type) => type === first) ? first : undefined;
  const base = targetDef?.type ?? shared ?? first;
  if ((base === "Trap" || base === "Field Trap") && types.includes("Field Trap")) return "Field Trap";
  return base;
}

/**
 * R77: "min(sum of the printed costs per R65, 4)". `printedCost` is R65's reading of one card —
 * Ceaseless Void's computed cost, the X chosen on the instance, the embiggen price it was played
 * for — so the sum needs no second cost rule here.
 */
function fusedCost(state: GameState, ingredients: readonly CardInstance[]): number {
  const sum = ingredients.reduce((total, card) => total + printedCost(state, card), 0);
  return Math.min(sum, FUSE_COST_CAP);
}

function rarestOf(defs: readonly CardDef[]): Rarity {
  let best: Rarity = "Common";
  let bestRank = -1;
  for (const def of defs) {
    const rank = RARITY_ORDER.indexOf(def.rarity);
    if (rank > bestRank) {
      bestRank = rank;
      best = def.rarity;
    }
  }
  return best;
}

/**
 * A `t-<n>` id, the spelling §10.1 gives a transient def. It depends only on how many transient
 * defs the state already holds, so the same action list always produces the same id (§9.3).
 */
function nextTransientId(state: GameState): string {
  let n = Object.keys(state.transientDefs).length + 1;
  while (state.transientDefs[`t-${n}`] !== undefined) n += 1;
  return `t-${n}`;
}

/** A transient def plus the ingredient ids its scripts are rebuilt from (JSON, so it replays). */
type FusedDef = CardDef & { fusedFrom: readonly string[] };

function buildDef(
  state: GameState,
  ingredients: readonly CardInstance[],
  defs: readonly CardDef[],
  targetDef: CardDef | null,
): FusedDef {
  const id = nextTransientId(state);
  return {
    id,
    // Transient defs are not catalog cards, so no random pool or Discover can reach one (§5.1);
    // the index is the id itself, which keeps `defByIndex` unambiguous.
    index: id,
    name: defs.map((def) => def.name).join(" + "),
    set: targetDef?.set ?? defs[0]?.set ?? "Core",
    type: fusedType(defs, targetDef),
    tags: unionTags(defs),
    rarity: rarestOf(defs),
    // A fusion is a real card unless every ingredient was a token, so fusing a token onto a unit
    // gives a result that no longer ceases to exist off the field (R11).
    token: defs.every((def) => def.token),
    cost: fusedCost(state, ingredients),
    base: fusedFace(defs, false),
    radiant: fusedFace(defs, true),
    fusedFrom: defs.map((def) => def.id),
  };
}

// ---------------------------------------------------------------------------
// The concatenated scripts (R77).
// ---------------------------------------------------------------------------

/** Every hook in `script.ts` is "context in, list out", which is what makes concatenation total. */
type ListFn = (...args: unknown[]) => unknown[];

/**
 * Combine one key of several scripts. The rule is the same for every kind of value a script holds,
 * which is what keeps this working as `Script` grows new hooks:
 *   - a hook (Cry, Death, a start/end-of-turn hook, an aura) becomes one hook that runs each of
 *     them and concatenates what they return, so "both Cry and Death lists run" (R77);
 *   - a list (triggers, declared targets and modes) becomes the lists in ingredient order, so a
 *     fused trap carries every ingredient's trigger condition;
 *   - a nested object (static flags, the resume table) is combined key by key by the same rules,
 *     so two ingredients that resume the same step name run both steps;
 *   - a flag is true when any ingredient set it, and a number takes the larger, which is the one
 *     stricter requirement rather than a doubled one (`staticFlags.tribute`).
 */
function combineValues(values: readonly unknown[]): unknown {
  const defined = values.filter((value) => value !== undefined);
  if (defined.length <= 1) return defined[0];
  if (defined.every((value) => Array.isArray(value))) return (defined as unknown[][]).flat();
  if (defined.every((value) => typeof value === "function")) {
    const fns = defined as ListFn[];
    return (...args: unknown[]): unknown[] => fns.flatMap((fn) => fn(...args));
  }
  if (defined.every((value) => typeof value === "boolean")) return defined.some((value) => value === true);
  if (defined.every((value) => typeof value === "number")) return Math.max(...(defined as number[]));
  if (defined.every((value) => isPlainObject(value))) return combineObjects(defined as Record<string, unknown>[]);
  // Nothing in `Script` mixes kinds under one key; the last ingredient wins if one ever does.
  return defined[defined.length - 1];
}

function combineObjects(objects: readonly Record<string, unknown>[]): Record<string, unknown> {
  const keys = [...new Set(objects.flatMap((object) => Object.keys(object)))];
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = combineValues(objects.map((object) => object[key]));
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * One ingredient's script, ready to be combined: without its `cost` hook, because R77 fixes the
 * fused cost at min(sum, 4) and a surviving Ceaseless Void hook would overrule it (R65); and with
 * its trigger ids namespaced, so two ingredients that both call a trigger "turn-end" stay two
 * distinct conditions on the fused card.
 */
function scriptRecord(script: Script, defId: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...script };
  delete out[COST_KEY];
  delete out[SET_STAT_KEY];
  for (const key of TRIGGER_KEYS) {
    const list = out[key];
    if (!Array.isArray(list)) continue;
    out[key] = list.map((trigger) =>
      isPlainObject(trigger) && typeof trigger.id === "string"
        ? { ...trigger, id: `${defId}:${trigger.id}` }
        : trigger,
    );
  }
  return out;
}

/**
 * §10.4 layer 2 (#92 Felinor Fiender): a card that sets its own stats from the board. R77 sums
 * printed stats, so a fusion of two set-stat cards sums what they set, and a stat only one of them
 * sets is that one's.
 */
function fusedSetStat(scripts: readonly Script[]): Script["setStat"] | undefined {
  const fns = scripts.flatMap((script) => (script.setStat === undefined ? [] : [script.setStat]));
  if (fns.length === 0) return undefined;
  if (fns.length === 1) return fns[0];
  return (args) => {
    let attack: number | undefined;
    let maxHealth: number | undefined;
    for (const fn of fns) {
      const set = fn(args);
      if (set.attack !== undefined) attack = (attack ?? 0) + set.attack;
      if (set.maxHealth !== undefined) maxHealth = (maxHealth ?? 0) + set.maxHealth;
    }
    return {
      ...(attack === undefined ? {} : { attack }),
      ...(maxHealth === undefined ? {} : { maxHealth }),
    };
  };
}

function fusedScript(defs: readonly CardDef[], radiant: boolean): Script {
  const faces = defs.map((def) => {
    const pair = scriptsFor(def.id);
    return { defId: def.id, script: radiant ? pair.radiant : pair.base };
  });
  const combined = combineObjects(
    faces.map((face) => scriptRecord(face.script, face.defId)),
  ) as Script;
  const setStat = fusedSetStat(faces.map((face) => face.script));
  return setStat === undefined ? combined : { ...combined, setStat };
}

// ---------------------------------------------------------------------------
// Keeping the process's registry in step with the state being run.
// ---------------------------------------------------------------------------

/** The ingredient ids a transient def was fused from, or null for a def this file did not build. */
function fusedFromOf(def: CardDef | undefined): readonly string[] | null {
  const from = (def as Partial<FusedDef> | undefined)?.fusedFrom;
  return Array.isArray(from) ? from : null;
}

/**
 * What a transient id means in this state, all the way down: `(core-011+core-020)`, or
 * `((core-011+core-020)+core-008)` for a fusion of a fusion. Two states whose `t-1` is built from
 * different cards give different identities, which is what tells a stale registry entry apart.
 */
function fusedIdentity(state: GameState, defId: string): string {
  const from = fusedFromOf(state.transientDefs[defId]);
  if (from === null) return defId;
  return `(${from.map((id) => fusedIdentity(state, id)).join("+")})`;
}

/** What the registry holds for each transient id, as last written here, and which fusion it was. */
const registeredFusions = new Map<string, { identity: string; scripts: CardScripts }>();

function registerFused(state: GameState, defId: string, defs: readonly CardDef[]): void {
  const scripts: CardScripts = { base: fusedScript(defs, false), radiant: fusedScript(defs, true) };
  registerScripts({ ...registeredScripts(), [defId]: scripts });
  registeredFusions.set(defId, { identity: fusedIdentity(state, defId), scripts });
}

/** `t-<n>`'s n, so ingredients (always older, so lower) are brought up to date first. */
function transientOrder(defId: string): number {
  const n = Number(defId.slice(defId.lastIndexOf("-") + 1));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Re-register this state's fused scripts wherever the registry holds another state's (§9.3, R77).
 * Cheap when nothing changed: a state with no transient defs does nothing, and an entry that is
 * still this state's own is left alone.
 */
export function syncFusedScripts(state: GameState): void {
  const ids = Object.keys(state.transientDefs);
  if (ids.length === 0) return;
  ids.sort((a, b) => transientOrder(a) - transientOrder(b));
  for (const defId of ids) {
    const from = fusedFromOf(state.transientDefs[defId]);
    if (from === null) continue;
    const known = registeredFusions.get(defId);
    if (
      known !== undefined &&
      known.identity === fusedIdentity(state, defId) &&
      registeredScripts()[defId] === known.scripts
    ) {
      continue;
    }
    // A state that lost an ingredient's def has nothing to rebuild from; leave the registry be,
    // so syncing never makes a state fail that the rest of the engine would still run.
    const defs = from.map((id) => findDef(state, id));
    if (defs.some((def) => def === undefined)) continue;
    registerFused(state, defId, defs as CardDef[]);
  }
}

// ---------------------------------------------------------------------------
// The result.
// ---------------------------------------------------------------------------

/**
 * R77 and R86: an ingredient that is not kept ceases to exist — no graveyard, no exile pile, no
 * Death trigger and nothing destroyed — which is the `{ z: "gone" }` zone, not a pile.
 */
function ceaseToExist(state: GameState, card: CardInstance): void {
  removeFromAnyZone(state, card);
  card.zone = { z: "gone", player: card.owner };
}

/**
 * R77's keep-the-instance path. The fused card *is* the target: only its def id, its buffs (the sum
 * of every ingredient's) and its granted keywords (their union) change, and the rest of the
 * instance — zone, position, damage, exertion, summonedTurn, counters, memory, the radiant flag,
 * `statsOverride` and the Vanilla flag — is left exactly as it was.
 */
function keepInstance(
  state: GameState,
  def: CardDef,
  ingredients: readonly CardInstance[],
  kept: CardInstance,
): CardInstance {
  const attack = ingredients.reduce((sum, card) => sum + card.buffs.attack, 0);
  const health = ingredients.reduce((sum, card) => sum + card.buffs.health, 0);
  const granted = unionKeywords(ingredients.flatMap((card) => card.grantedKeywords));

  kept.defId = def.id;
  kept.buffs = { attack, health };
  kept.grantedKeywords = granted;

  for (const card of ingredients) {
    if (card.id === kept.id) continue;
    ceaseToExist(state, card);
  }
  return kept;
}

/**
 * R77's Craft a Card path: "a fresh, non-Radiant hand card with `costOverride` 0". The ingredients
 * went into it, so they cease to exist here too — #99's are Discovered definitions that were never
 * cards on a board, and for anything else a consumed ingredient is what a fusion means.
 * A full hand burns the result like any other card reaching it (§2.4, R4).
 */
function craftInHand(sink: EngineSink, def: CardDef, player: PlayerId, ingredients: readonly CardInstance[]): CardInstance {
  const card = newInstance(sink.state, def.id, player, { z: "hand", player });
  card.costOverride = CRAFTED_CARD_COST;
  for (const ingredient of ingredients) ceaseToExist(sink.state, ingredient);
  addToHand(sink, card);
  return card;
}

/**
 * §6.3 Fuse per R77. Returns the fused card — the kept target instance, or the crafted hand card —
 * or null when the fusion cannot happen, in which case nothing has changed.
 *
 * It does not happen when there are fewer than two ingredients, when a named target is not on the
 * field, when the target is Immutable (R23: an Immutable permanent is never chosen as a Fuse
 * target, and R61 has the trap fire and do nothing), or when the call names neither a target nor a
 * hand to craft into. A target the caller did not also list as an ingredient is one anyway, so #85
 * may name the played card and its victim separately.
 *
 * An ingredient only ever contributes its definition, so an ingredient that already ceased to exist
 * in an earlier fusion still fuses: that is what lets radiant #85 fuse the played permanent "onto
 * each matching permanent separately, one fusion at a time" (R77), each fusion its own transient
 * definition, without the card having to rebuild the permanent it consumed.
 */
export function fuse(sink: EngineSink, args: FuseArgs): CardInstance | null {
  const state = sink.state;
  const target = args.target ?? null;
  const toHand = args.toHand;

  const ingredients: CardInstance[] = [];
  for (const card of [...args.ingredients, ...(target === null ? [] : [target])]) {
    if (!ingredients.some((seen) => seen.id === card.id)) ingredients.push(card);
  }
  if (ingredients.length < FUSE_MIN_INGREDIENTS) return null;

  if (target !== null) {
    if (target.zone.z !== "field") return null;
    if (unitHas(state, target, "Immutable")) return null;
  } else if (toHand === undefined) {
    return null;
  }

  const defs = ingredients.map((card) => defOf(state, card.defId));
  const targetDef = target === null ? null : defOf(state, target.defId);
  const def = buildDef(state, ingredients, defs, targetDef);

  // The def is match state; the scripts are rebuilt from it into the process's registry.
  state.transientDefs[def.id] = def;
  registerFused(state, def.id, defs);

  let result: CardInstance;
  if (target !== null) {
    result = keepInstance(state, def, ingredients, target);
  } else if (toHand !== undefined) {
    result = craftInHand(sink, def, toHand, ingredients);
  } else {
    return null;
  }

  sink.events.push({
    type: "fused",
    instanceIds: ingredients.map((card) => card.id),
    resultInstanceId: result.id,
    defId: def.id,
  });
  return result;
}
