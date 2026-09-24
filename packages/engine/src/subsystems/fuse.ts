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
// register theirs (`scripts.ts`): static data keyed by a deterministic id, so a replay of the same
// action list rebuilds the same id and registers the same scripts (§9.3).
//
// Third, R77 keeps an ingredient's *instance* when one of them is a target already on the field:
// the fused card is that card, with its zone, damage, exertion, counters and memory intact, and the
// other ingredients cease to exist without dying. So the only instance-level work here is the def
// id, the summed buffs and the united granted keywords; everything else is deliberately untouched.

import type { CardDef, CardFace, CardType, Keyword, PlayerId, Rarity, Selection, Tag } from "@jackioh/shared";
import { keywordKey } from "@jackioh/shared";
import { defOf } from "../catalog";
import { FUSE_COST_CAP } from "../config";
import { addToHand } from "../draw";
import { unitHas } from "../layers";
import { printedCost } from "../mana";
import type { EngineSink } from "../resolve";
import { activeTargetDecls, selectionsPerDeclaration, storedDeclarationSlices } from "../playChoices";
import { lazyPart, runHook } from "../resolve";
import type { AuraHook, Effect, EffectContext, Hook, Script, TriggerDef } from "../script";
import {
  INGREDIENTS_KEY,
  asIngredient,
  ingredientPaid,
  ingredientRecord,
  registerScripts,
  registeredScripts,
  scriptsFor,
} from "../scripts";
import { newInstance, type CardInstance, type GameState } from "../state";
import { PART_DEPTH_KEY, PART_KEY, partPathOf, rerootRemembered } from "../work";
import { ceaseToExist } from "../zones";

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
/** The `Script` key of the step table a continuation re-enters (`prompts.RESUME_HOOK`). */
const RESUME_KEY = "resume";
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

/**
 * R77's unions: one keyword per distinct keyword — except Armor, which every ingredient keeps. Armor
 * is the keyword whose number stacks from every source (§6.1, §10.4 sums it), so it adds up on the
 * fused face the way the stats beside it do: Armor 7 and Armor 3 print 10, and so do Armor 7 and
 * Armor 7 print 14 rather than collapsing into one because the numbers happen to match (R102).
 */
function unionKeywords(keywords: readonly Keyword[]): Keyword[] {
  const seen = new Set<string>();
  const out: Keyword[] = [];
  for (const keyword of keywords) {
    if (keyword.kind === "Armor") {
      out.push(keyword);
      continue;
    }
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

/**
 * One ingredient's face as its instance wears it. §7 and R175: a token summoned X/X carries its X as
 * `statsOverride`, and the Bread Token its "Armor X" as `armorOverride`, because neither number can
 * be printed — they ARE its printed face, §10.4's layer 1. So a Fuse sums that X/X, not the printed
 * 0/0 it stands in for, and the X replaces only that token's own Armor, never an Armor another
 * ingredient prints (#85 fusing a 7/7 onto #18's Bread Token keeps the 7/7's Armor 7).
 */
function wornFace(def: CardDef, card: CardInstance | undefined, radiant: boolean): CardFace {
  const face = radiant ? def.radiant : def.base;
  const stats = card?.statsOverride;
  const armor = card?.armorOverride;
  return {
    ...face,
    ...(stats === undefined ? {} : { attack: stats.attack, health: stats.health }),
    keywords:
      armor === undefined
        ? face.keywords
        : face.keywords.map((keyword) => (keyword.kind === "Armor" ? { kind: "Armor" as const, n: armor } : keyword)),
  };
}

/** R77: one face of the fusion — summed stats, united keywords, both texts. */
function fusedFace(ingredients: readonly CardInstance[], defs: readonly CardDef[], radiant: boolean): CardFace {
  const faces = defs.map((def, at) => wornFace(def, ingredients[at], radiant));
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
 * The id a transient def gets (R102, R179): `t-<n>`, where n depends only on how many transient defs
 * the state already holds, so the same action list always produces the same id (§9.3) — followed by
 * the ids of the ingredients it was fused from, `t-<n>:<a>+<b>`.
 *
 * The suffix is what keeps the script registry right. A def is match state, but its scripts are code
 * and live in the process-wide registry under the def's id (see this file's header), and one server
 * process runs every match (§9.2) and folds a match's log to rebuild it (§9.3). With a bare `t-<n>`,
 * two matches that fused different pairs into the same slot shared one registry entry, and the
 * later fusion replaced the scripts of the earlier match's card. The fused scripts are a function of
 * the ingredients' ids and nothing else (`fusedScript`), so an id that carries them names the same
 * scripts in every match that can mint it.
 */
function nextTransientId(state: GameState, defs: readonly CardDef[]): string {
  const taken = (n: number): boolean =>
    Object.keys(state.transientDefs).some((id) => id === `t-${n}` || id.startsWith(`t-${n}:`));
  let n = Object.keys(state.transientDefs).length + 1;
  while (taken(n)) n += 1;
  return `t-${n}:${defs.map((def) => def.id).join("+")}`;
}

function buildDef(
  state: GameState,
  ingredients: readonly CardInstance[],
  defs: readonly CardDef[],
  targetDef: CardDef | null,
): CardDef {
  const id = nextTransientId(state, defs);
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
    base: fusedFace(ingredients, defs, false),
    radiant: fusedFace(ingredients, defs, true),
  };
}

// ---------------------------------------------------------------------------
// The concatenated scripts (R77).
// ---------------------------------------------------------------------------

/** Every hook in `script.ts` is "context in, list out", which is what makes concatenation total. */
type ListFn = (...args: unknown[]) => unknown[];

/**
 * The script keys whose functions return something other than effects, so they combine by building
 * every ingredient's list at once: an aura's entries are read off the field on every stat read
 * (§10.4), and there is no "when the list reaches it" for them.
 */
const EAGER_KEYS: readonly string[] = ["aura"];

/**
 * §10.4 layer 5: each ingredient's aura, reading "this" as the fused card at the price that
 * ingredient was played for (R102, `scripts.asIngredient`): #46 Suppressive Aura played for 4 and
 * fused onto a Mana Well is still "paid 4: −5/−5", though the kept instance's own price is the Mana
 * Well's.
 */
function fusedAura(faces: readonly Face[]): AuraHook | undefined {
  const hooks = faces.map((face) => face.script.aura);
  if (hooks.every((hook) => hook === undefined)) return undefined;
  return (ctx) =>
    hooks.flatMap((hook, index) => (hook === undefined ? [] : hook({ ...ctx, self: asIngredient(ctx.self, index) })));
}

/**
 * The static flags that are an amount of what the text does, not a quality the card has: #79's
 * "the next Spell you play gains Echo +1", #38's granted Combo and #84's hero Armor. R102: a card
 * fused from two such texts carries both, so its amount is theirs added — a Twinspell fused onto a
 * Twinspell grants Echo +2, and a Going Long onto a Going Long gives Armor twice, as two standing
 * apart do (R124) — where a quality (`castOnDraw`, `immutable`) is had once and a requirement
 * (`tribute`) takes the stricter. A `true` is one.
 */
const SUMMED_FLAGS: readonly string[] = ["echoGrant", "quickstriker", "heroArmor"];

/**
 * The context ingredient `index`'s text builds and applies with (R102): its place in the fusion
 * appended to the path the combined hooks above it have used (`work.PART_KEY`).
 */
function partData(data: Record<string, unknown>, index: number): Record<string, unknown> {
  const depth = typeof data[PART_DEPTH_KEY] === "number" ? (data[PART_DEPTH_KEY] as number) : 0;
  const path = (partPathOf(data) ?? []).slice(0, depth);
  return { [PART_KEY]: [...path, index], [PART_DEPTH_KEY]: depth + 1 };
}

/**
 * The context an ingredient's text runs in: its place in the fusion (`partData`'s patch), and the
 * price its card was played for as `embiggened` (R102, `scripts.ingredientPaid`), found by that
 * place's path — #59's trigger reads it.
 */
function inPlace(ctx: EffectContext, patch: Record<string, unknown>): EffectContext {
  const path = partPathOf(patch) ?? [];
  const embiggened = ctx.self === null ? ctx.embiggened : ingredientPaid(ctx.self, path);
  return { ...ctx, embiggened, data: { ...ctx.data, ...patch } };
}

/** An effect that applies, and builds any part of its own, with its ingredient's place (R102). */
function inIngredient(effect: Effect, patch: Record<string, unknown>): Effect {
  const expand = effect.expand;
  return {
    ...effect,
    apply: (ctx) => effect.apply(inPlace(ctx, patch)),
    ...(expand === undefined
      ? {}
      : {
          expand: (ctx, memo) => {
            const built = expand(inPlace(ctx, patch), memo);
            return { ...built, effects: built.effects.map((inner) => inIngredient(inner, patch)) };
          },
        }),
  };
}

/**
 * One ingredient's list as a part of the combined list (`resolve.lazyPart`, R102): built when the
 * list reaches it, with the ingredient's place in its context, and every effect of it applied there.
 */
function ingredientPart(index: number, build: (ctx: EffectContext) => readonly Effect[]): Effect {
  return lazyPart(`fused:part${index}`, (at) => {
    const patch = partData(at.data, index);
    const effects = build(inPlace(at, patch));
    return { effects: effects.map((effect) => inIngredient(effect, patch)) };
  });
}

/**
 * A combined hook: each ingredient's list in turn, as parts (R102, R113). A continuation one
 * ingredient's text left — the step its prompt re-enters, the delayed effect it scheduled — names
 * that ingredient (`work.PART_KEY`, which `prompts.resumeSelf` carries in the card's data), and comes
 * back to its list alone: the answer to one Masochism Mask's "choose one" is that Mask's pick, not a
 * pick for every ingredient that names its step the same.
 */
function combinedHook(fns: readonly (ListFn | undefined)[], step = false): (ctx: EffectContext) => Effect[] {
  return (ctx) => {
    const depth = typeof ctx.data[PART_DEPTH_KEY] === "number" ? (ctx.data[PART_DEPTH_KEY] as number) : 0;
    // A step of the `resume` table is one continuation of one text, so one that names no part — the
    // engine left it for the card as a whole, not one of its texts: the prompt of the power R43
    // activates once (`heroPower.activatePower`) — comes back to the first ingredient that has the
    // step, once, rather than to every ingredient that names its step the same (R43, R102).
    const routed = partPathOf(ctx.data)?.[depth] ?? (step ? fns.findIndex((fn) => fn !== undefined) : undefined);
    const indices = fns.flatMap((fn, index) =>
      fn === undefined || (routed !== undefined && routed !== index) ? [] : [index],
    );
    return indices.map((index) =>
      ingredientPart(index, (built) => (fns[index] as ListFn)(built) as Effect[]),
    );
  };
}

/**
 * Combine one key of several scripts, `values` aligned with the ingredients (undefined where one has
 * none). The rule is the same for every kind of value a script holds, which is what keeps this
 * working as `Script` grows new hooks:
 *   - a hook (Cry, Death, a start/end-of-turn hook, a resume step, a delayed hook) becomes one hook
 *     that runs each of them in turn, so "both Cry and Death lists run" (R77) — each ingredient's
 *     list built only when the one before it has resolved (`lazyPart`, R102), so a later ingredient
 *     reads the board the earlier ones left: #68's "8 if your hero is below 10" after Reno has set
 *     the hero to 30, #22's meal after #100 has exiled it — and a continuation one of them left comes
 *     back to that one alone (`combinedHook`). An aura, which returns no effects, runs each at once;
 *   - a list (triggers, declared targets and modes) becomes the lists in ingredient order, so a
 *     fused trap carries every ingredient's trigger condition;
 *   - a nested object (static flags, the resume table) is combined key by key by the same rules;
 *   - a flag is true when any ingredient set it, and a number takes the larger, which is the one
 *     stricter requirement rather than a doubled one (`staticFlags.tribute`) — except an amount of
 *     what the text does, which adds up (`SUMMED_FLAGS`).
 */
function combineValues(values: readonly unknown[], key = "", parent = ""): unknown {
  const defined = values.filter((value) => value !== undefined);
  if (defined.length === 0) return undefined;
  if (defined.every((value) => typeof value === "function")) {
    const fns = values.map((value) => (typeof value === "function" ? (value as ListFn) : undefined));
    if (EAGER_KEYS.includes(key)) {
      if (defined.length === 1) return defined[0];
      return (...args: unknown[]): unknown[] => fns.flatMap((fn) => (fn === undefined ? [] : fn(...args)));
    }
    return combinedHook(fns, parent === RESUME_KEY);
  }
  if (SUMMED_FLAGS.includes(key) && defined.every((value) => typeof value === "number" || typeof value === "boolean")) {
    return defined.reduce<number>((sum, value) => sum + (value === true ? 1 : typeof value === "number" ? value : 0), 0);
  }
  if (defined.length === 1) return defined[0];
  if (defined.every((value) => Array.isArray(value))) return (defined as unknown[][]).flat();
  if (defined.every((value) => typeof value === "boolean")) return defined.some((value) => value === true);
  if (defined.every((value) => typeof value === "number")) return Math.max(...(defined as number[]));
  if (defined.every((value) => isPlainObject(value))) {
    return combineObjects(
      values.map((value) => (isPlainObject(value) ? value : undefined)),
      key,
    );
  }
  // Nothing in `Script` mixes kinds under one key; the last ingredient wins if one ever does.
  return defined[defined.length - 1];
}

function combineObjects(objects: readonly (Record<string, unknown> | undefined)[], parent = ""): Record<string, unknown> {
  const keys = [...new Set(objects.flatMap((object) => (object === undefined ? [] : Object.keys(object))))];
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = combineValues(
      objects.map((object) => object?.[key]),
      key,
      parent,
    );
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * One ingredient's script, ready to be combined: without its `cost` hook, because R77 fixes the
 * fused cost at min(sum, 4) and a surviving Ceaseless Void hook would overrule it (R65); and with
 * its trigger ids namespaced, so two ingredients that both call a trigger "turn-end" stay two
 * distinct conditions on the fused card — each running in its ingredient's place (R102), so a
 * question it asks comes back to its own step.
 */
function scriptRecord(script: Script, defId: string, index: number): Record<string, unknown> {
  const out: Record<string, unknown> = { ...script };
  delete out[COST_KEY];
  delete out[SET_STAT_KEY];
  for (const key of TRIGGER_KEYS) {
    const list = out[key];
    if (!Array.isArray(list)) continue;
    out[key] = list.map((trigger) =>
      isPlainObject(trigger) && typeof trigger.id === "string"
        ? { ...trigger, id: `${defId}:${trigger.id}`, run: inTriggerIngredient(trigger as unknown as TriggerDef, index) }
        : trigger,
    );
  }
  return out;
}

/** A trigger's list, built and applied in its ingredient's place (R102). */
function inTriggerIngredient(trigger: TriggerDef, index: number): TriggerDef["run"] {
  return (ctx) => {
    const patch = partData(ctx.data, index);
    return trigger.run({ ...inPlace(ctx, patch), event: ctx.event }).map((effect) => inIngredient(effect, patch));
  };
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

type Face = { defId: string; script: Script };

/** An effect that resolves with one ingredient's own play choices, whatever context applies it. */
function withChoices(effect: Effect, targets: readonly Selection[], modes: readonly string[]): Effect {
  return { ...effect, apply: (ctx) => effect.apply({ ...ctx, targets: [...targets], modes: [...modes] }) };
}

/**
 * R102 concatenates the ingredients' declared targets and modes in ingredient order, and R90 reads
 * that flat list declaration by declaration — so each ingredient's Cry must resolve with its OWN
 * slice of the play's choices, not the whole list. Handed the whole list, every ingredient read its
 * first slot: a crafted Bigot + Twisted Sorcerer aimed the Sorcerer's 4 damage at the unit Bigot
 * destroyed, and an Archivist + Silly Silas rotated by Archivist's "highest". Modes split by each
 * ingredient's count of mode declarations; targets split by R90's rule over the declarations that
 * the ingredient's own modes make active (`forModes`) — with the lengths §10.5 step 1 read the play
 * with, which the pipeline hands over in `data` (`DECLARATION_SLICES_KEY`), because the board at
 * resolution is not the one the play was checked against: by step 5 a crafted Postdoc + Sorcerer
 * stands on the field and is itself a Human the Postdoc's declaration could take. Only a Cry run
 * with no play behind it measures against the board as it stands.
 *
 * Every effect an ingredient's Cry returns is bound to that slice, because an effect reads
 * `ctx.targets` when it applies, and the context applying it is the fused card's. And each
 * ingredient's Cry is its own part of the list (`resolve.lazyPart`), built when the list reaches it,
 * so it reads the board the ingredients before it left (R102), and a pause inside it resumes into
 * the rest of that part and then every part after it (`prompts.applyResumable`, R113).
 */
function fusedCry(faces: readonly Face[]): Hook | undefined {
  if (!faces.some((face) => face.script.cry !== undefined)) return undefined;
  return (ctx) => {
    const modesOf: string[][] = [];
    let modeAt = 0;
    for (const face of faces) {
      const count = face.script.modes?.length ?? 0;
      modesOf.push(ctx.modes.slice(modeAt, modeAt + count));
      modeAt += count;
    }
    const declsOf = faces.map((face, index) => activeTargetDecls(face.script.targets ?? [], modesOf[index] ?? []));
    const decls = declsOf.flat();
    const stored = storedDeclarationSlices(ctx.data);
    const slices =
      stored !== null && stored.length === decls.length
        ? cutSlices(ctx.targets, stored)
        : ctx.self === null
          ? decls.map(() => [])
          : selectionsPerDeclaration(ctx.state, ctx.controller, ctx.self, decls, ctx.targets);

    // Each ingredient's Cry is built as the list reaches it (`lazyPart`), so it reads the board the
    // ingredients before it left (R102); its slice of the play's choices is fixed now, as step 1
    // checked them.
    let declAt = 0;
    return faces.map((face, index) => {
      const count = declsOf[index]?.length ?? 0;
      const targets = slices.slice(declAt, declAt + count).flat();
      declAt += count;
      const cry = face.script.cry;
      const modes = modesOf[index] ?? [];
      return ingredientPart(index, (at) =>
        cry === undefined ? [] : cry({ ...at, targets, modes }).map((effect) => withChoices(effect, targets, modes)),
      );
    });
  };
}

/** The flat list cut into consecutive slices of these lengths; the last takes the remainder (R90). */
function cutSlices(selections: readonly Selection[], lengths: readonly number[]): Selection[][] {
  let at = 0;
  return lengths.map((length, index) => {
    const slice = index === lengths.length - 1 ? selections.slice(at) : selections.slice(at, at + length);
    at += slice.length;
    return slice;
  });
}

function fusedScript(defs: readonly CardDef[], radiant: boolean): Script {
  const faces: Face[] = defs.map((def) => {
    const pair = scriptsFor(def.id);
    return { defId: def.id, script: radiant ? pair.radiant : pair.base };
  });
  const combined = combineObjects(
    faces.map((face, index) => scriptRecord(face.script, face.defId, index)),
  ) as Script;
  const setStat = fusedSetStat(faces.map((face) => face.script));
  const cry = fusedCry(faces);
  const aura = fusedAura(faces);
  return {
    ...combined,
    ...(setStat === undefined ? {} : { setStat }),
    ...(aura === undefined ? {} : { aura }),
    ...(cry === undefined ? {} : { cry }),
  };
}

// ---------------------------------------------------------------------------
// The result.
// ---------------------------------------------------------------------------

/**
 * R77's keep-the-instance path. The fused card *is* the target: only its def id, its buffs (the sum
 * of every ingredient's) and its granted keywords (their union) change, and the rest of the
 * instance — zone, position, damage, exertion, summonedTurn, counters, memory, the radiant flag and
 * the Vanilla flag — is left exactly as it was. A token's `statsOverride` and `armorOverride` are one
 * exception: they were its printed face (§7, R175), which `wornFace` has already summed into the
 * fused definition, so they leave the instance with it — kept, §10.4's layer 1 would read them in
 * place of the fused face and a 3/3 Bread Token fused with a 7/7 would still be a 3/3. The other is
 * R77's own: the memory gains the ingredients' prices (`scripts.INGREDIENTS_KEY`) when they were not
 * all the kept card's, so each ingredient's text reads its own (R102).
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
  const before = defOf(state, kept.defId);

  // R102: the price each ingredient's text reads as its own, recorded before any of them ceases to
  // exist and only when they are not all the kept card's (`scripts.INGREDIENTS_KEY`).
  const record = ingredientRecord(kept, ingredients);
  // R77, R102: the kept card's texts become ingredient `index` of the fusion, and what they
  // remembered moves with them to the path they now run at (`work.rerootRemembered`).
  rerootRemembered(kept.memory, ingredients.findIndex((card) => card.id === kept.id));
  gainPrintedKeywords(kept, before, def);
  kept.defId = def.id;
  kept.buffs = { attack, health };
  kept.grantedKeywords = granted;
  if (record === null) delete kept.memory[INGREDIENTS_KEY];
  else kept.memory[INGREDIENTS_KEY] = record;
  delete kept.statsOverride;
  delete kept.armorOverride;

  // R77 and R86: an ingredient that is not kept ceases to exist — no graveyard, no exile pile, no
  // Death trigger and nothing destroyed — and one that stood on the field has left it (R174).
  for (const card of ingredients) {
    if (card.id === kept.id) continue;
    ceaseToExist(state, card);
  }
  return kept;
}

/**
 * §5.2: "newly gained keywords apply at once". The fused face can print a keyword the kept card's
 * own face did not — Jilliax's Divine Shield fused onto a Kpop Fanatic, a Radiant Saintess's Reborn
 * onto a unit that came back through a granted one — and the card gains it with the new text, so a
 * shield or a Reborn the card had spent is up again, as radiant #50's printed shield is after a
 * granted one was spent (`effects/radiant.ts`). A keyword the kept face already printed is not newly
 * gained, and stays spent. A Vanilla unit prints nothing on either face (§6.3).
 */
function gainPrintedKeywords(kept: CardInstance, before: CardDef, after: CardDef): void {
  if (kept.vanilla) return;
  const prints = (def: CardDef, kind: string): boolean =>
    (kept.radiant ? def.radiant : def.base).keywords.some((keyword) => keyword.kind === kind);
  if (prints(after, "Divine Shield") && !prints(before, "Divine Shield")) delete kept.divineShieldSpent;
  if (prints(after, "Reborn") && !prints(before, "Reborn")) delete kept.rebornSpent;
}

/**
 * R77's Craft a Card path: "a fresh, non-Radiant hand card with `costOverride` 0". The ingredients
 * went into it, so they cease to exist here too — #99's are Discovered definitions that were never
 * cards on a board, and for anything else a consumed ingredient is what a fusion means.
 * A full hand burns the result like any other card reaching it (§2.4, R4), and the 0 goes with the
 * hand: §8 #99's "the result costs 0 and goes to your hand" is a price for the card in that hand,
 * the reading `addToHand`'s cost riders have (R4), so a burned result is an ordinary graveyard card
 * that R78 would otherwise carry the price for into every later zone (a Reminisce, a Gravedigger).
 */
function craftInHand(sink: EngineSink, def: CardDef, player: PlayerId, ingredients: readonly CardInstance[]): CardInstance {
  const card = newInstance(sink.state, def.id, player, { z: "hand", player });
  for (const ingredient of ingredients) ceaseToExist(sink.state, ingredient);
  if (addToHand(sink, card) === "hand") card.costOverride = CRAFTED_CARD_COST;
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

  // The def is match state; the scripts are static data the registry holds, like the catalog.
  state.transientDefs[def.id] = def;
  registerScripts({
    ...registeredScripts(),
    [def.id]: { base: fusedScript(defs, false), radiant: fusedScript(defs, true) },
  });

  let result: CardInstance;
  if (target !== null) {
    result = keepInstance(state, def, ingredients, target);
    // R43, R151: the kept card now carries every ingredient's text, a #98 Heroic Power's included —
    // and "one created later rolls when it is created". The ingredient's rolled power ceased to exist
    // with it, and the kept instance's memory is the target's (R77), so without the roll the card
    // would carry "Once per turn, spend X" and no power for as long as it stood. A card that already
    // has its power keeps it (`heroPower.ensurePower`). A crafted card rolls as it reaches the hand.
    runHook(sink, result, "startOfGame", { controller: result.controller });
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
