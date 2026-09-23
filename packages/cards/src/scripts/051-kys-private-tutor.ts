// #51 KY's Private Tutor (SPEC §8.3, §6.3 Discover, §10.5 steps 5-6, §10.6, §10.8, §5.1; R4, R11,
// R50, R60, R65, R81, R90). Spell, cost 1, tag KY, Epic.
//   Base:    "Choose a type (Spell, Unit, Field Spell, Trap), then a cost bracket (0-1, 2, 3, 4+),
//            offering only options with a match in your library; reveal 3 random matching library
//            cards; choose one to hand. No match at all → add a KY's Empty Notebook"
//   Radiant: "Echo (resolves a second time)" — §8 Conventions: the cell restates nothing of the
//            base clause, so the whole four-step sequence is kept and simply happens twice.
//   Engine:  "Three chained pending choices; Field Trap counts as Trap; brackets read costs per R65
//            (X cards as 0, embiggen cards at their base price)".
//
// A FOUR-STEP MACHINE, THREE OF THEM PROMPTS. §9.3 forbids callbacks in state, so a chain is a
// named step plus captured data (§10.6): `prompts.ts`'s `resumeSelf(ctx, step, data)` records
// `{ defId, hook: "resume", step, radiant, instanceId, data }` on the `PendingChoice`, and
// `answerPrompt` re-enters `script.resume[step]` with the answer in `ctx.targets`. So the steps are
// entries of the `resume` table below and nothing else:
//
//   cry            → "start"   read the library, offer the types that have a match       (prompt 1)
//   resume.bracket → the type  offer the cost brackets that have a match for that type   (prompt 2)
//   resume.reveal  → +bracket  reveal 3 random matching library cards                    (prompt 3)
//   resume.take    → the card  move that library card to hand
//
// Each step carries forward what the earlier ones learned in `data` (the chosen type), because
// §10.6's continuation is data, not a closure, and because a step may resume with `ctx.self ===
// null` — this is a Spell, and by resolution time the card is in `resolving` on its way to the
// graveyard. `ctx.data` is `Record<string, unknown>`, so it is narrowed with `typeof`, never cast.
//
// "OFFERING ONLY OPTIONS WITH A MATCH IN YOUR LIBRARY" is why the two mode prompts are computed
// from the library rather than fixed: a type with no match is never offered, and neither is a
// bracket with no match for the type already chosen. Reading the library is reading state, which a
// hook may do (CLAUDE.md rule 5 bans mutation, not reads); the cards are not revealed by it —
// §10.8 rules that "a card revealed out of a library … is revealed only as an option of the prompt
// that reveals it", so only prompt 3 ever exposes a card, only to the chooser, and the rest of the
// library stays hidden from both players. The type and bracket prompts leak nothing but the
// existence of a match, which is what the §8 row asks them to say.
//
// "FIELD TRAP COUNTS AS TRAP" (Engine cell) is the same reading as `query.ts`'s `TRAP_TYPES`, R61
// (#85) and R35 (#83): a `type` filter matches the field exactly, so "Trap" has to name both
// "Trap" and "Field Trap" or #18 Bread and Butter and #71 Intern Stimmy would silently vanish.
//
// BRACKETS READ COSTS PER R65 (Engine cell): `effectiveCost(state, card)` is R65's one calculation
// for an instance, the same one #30 Archivist and #94 Genn's Greed read their library cards with
// (R24, R66). A library card was never played, so an X-cost card has no X and reads 0 (#74 Adaptive
// UI and #96 My Pawn sit in the "0-1" bracket) and an embiggen card its base price (#59 Unbiased
// Immigration, "2 embiggen 4", reads 2); and R65 names library filters as its own ground, so the
// card's `costMod` (kept in every zone, R78 — #95's "costs 2 less"), its `costOverride`, Ceaseless
// Void's computed cost and a rolled Heroic Power's X all count, as do the player's live discounts.
// The definition's printed cost (`queryCost`) would see none of them.
//
// "NO MATCH AT ALL → ADD A KY'S EMPTY NOTEBOOK": no type has a match exactly when the library is
// empty, since every card in it has one of the five types and all five map onto the four options.
// The token is created fresh in hand by `addToHand` (R4's cap applies; a spell token is an ordinary
// hand card, R11) and it is never reachable from a random pool (§5.1), only from here.
//
// TWO MISSING VERBS (reported, not worked around, and not faked with a different verb):
//
//   1. discoverFromLibrary({ step: string, count?: number, player?: "self" | "enemy",
//                            filter?: { type?: CardType | CardType[];
//                                       costRange?: { min?: number; max?: number } },
//                            prompt?: string, data?: Record<string, unknown> }): Effect
//      §6.3's Discover row already describes this card as the primitive: "'Reveal N matching cards,
//      then choose one' (KY's Private Tutor) is this same primitive with the library as the pool:
//      the revealed cards are that prompt's options, so only the chooser ever sees them (§10.8)".
//      `discoverFromCatalog` queries the CATALOG, which would offer cards that are not in the
//      library at all, and `discoverFromGraveyard` is the same shape over the wrong pile — so the
//      third one is needed: options are the actual library INSTANCES (`{ pick: "instance",
//      instanceId }`, as `discoverFromGraveyard` builds them), drawn without replacement from the
//      matching subset with `ctx.rng.shuffle` so the three are always different (R60, §6.3), and
//      fewer than `count` matches offer what exists (§6.3: no options at all fizzles).
//
//   2. addToHand({ instance: { of: "chosen", index?: number } }) — an added overload of the
//      existing verb, for §6.3's "Add to hand: CREATES OR MOVES the card". Today `addToHand` only
//      creates a fresh instance from a `defId`, which would leave the revealed card in the library
//      and put a copy in hand. The chosen library instance must MOVE zones (library → hand) with
//      its identity, its radiant flag and its `costOverride` intact (R78: those persist in every
//      zone), through the same `draw.ts` pipeline, so the hand cap burns it when the hand is full
//      (R4). `bounce` is not that verb — it returns a card from the FIELD to its owner's hand and
//      resets the instance (§6.3, R78) — so it is deliberately not used here.
//
// THE RADIANT ECHO. §6.2's "Echo X" is "recast this card X more times … The repeats outstanding
// live in `state.echoQueue` and resolve one at a time in the resolution loop, so a prompt inside
// one repeat pauses the rest until it is answered (§10.5 step 6)". That is `StaticFlags.echo`
// (R30): the count of EXTRA resolutions, 1 here, which `playSteps.ts`'s `echoStep` reads when it
// queues an `EchoRepeat`, summed with the `echoNextSpell` player modifier (#79 Twinspell). Each
// repeat re-enters `cry` and opens its OWN fresh prompts, which is what makes the radiant face run
// the whole four-step sequence twice.
//
// Why not grant this card the existing `echoNextSpell` modifier instead: that modifier has expiry
// `{ until: "used" }` and applies to the NEXT spell played, so it would have to be granted
// mid-resolution of this one (§10.5 step 5, after step 2 already consumed it); no effect verb
// grants a `PlayerModifier` at all; and a card that re-entered its own chain by hand would double
// up with Twinspell — 2 engine repeats × 2 card repeats = 4 resolutions where §6.2 wants 3.

import type { CardDef, CardType } from "@jackioh/shared";
import type { EffectContext, Hook, Script, StaticFlags } from "@jackioh/engine";
import { defOf, effectiveCost, isUnitToken, zoneCards, type CardInstance } from "@jackioh/engine";
import {
  addToHand,
  chooseMode,
  chosenOptions,
  discoverFromLibrary,
} from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-051");

/** #51.1, the token the empty-library path adds (§8.3, §7). */
const NOTEBOOK = "core-051-1";

/** §6.3 Discover: 1 of 3, so three library cards are revealed. */
const REVEAL_COUNT = 3;

/** The four type options, in the §8 row's printed order. */
const TYPE_OPTIONS = ["Spell", "Unit", "Field Spell", "Trap"] as const;
type TypeOption = (typeof TYPE_OPTIONS)[number];

/** The four cost brackets, in the §8 row's printed order. */
const BRACKET_OPTIONS = ["0-1", "2", "3", "4+"] as const;
type BracketOption = (typeof BRACKET_OPTIONS)[number];

/** The key the chosen type travels under, from the bracket step to the reveal step (§10.6). */
const TYPE_KEY = "type";

/**
 * Which card types one option covers. Engine cell: "Field Trap counts as Trap"; every other option
 * is its own type, so "Spell" never reaches a Field Spell and "Field Spell" never a Spell.
 */
function typesFor(option: TypeOption): CardType[] {
  return option === "Trap" ? ["Trap", "Field Trap"] : [option];
}

/** R65's out-of-play cost range a bracket means; "4+" has no upper bound. */
function rangeFor(bracket: BracketOption): { min?: number; max?: number } {
  switch (bracket) {
    case "0-1":
      return { min: 0, max: 1 };
    case "2":
      return { min: 2, max: 2 };
    case "3":
      return { min: 3, max: 3 };
    default:
      return { min: 4 };
  }
}

function matchesType(ctx: EffectContext, card: CardInstance, option: TypeOption): boolean {
  const type: CardDef["type"] = defOf(ctx.state, card.defId).type;
  return typesFor(option).includes(type);
}

/** R65: the library card's own cost (`effectiveCost`), as #30 and #94 read theirs (R24, R66). */
function matchesBracket(ctx: EffectContext, card: CardInstance, bracket: BracketOption): boolean {
  const cost = effectiveCost(ctx.state, card);
  const range = rangeFor(bracket);
  if (range.min !== undefined && cost < range.min) return false;
  return range.max === undefined || cost <= range.max;
}

/**
 * "Your library" (§8 Conventions: "your" means the controller), top card first. Reading state,
 * never touching it: `zoneCards` is the engine's read-only pile reader (engine/src/query.ts) and
 * hands back a copy (BUILD M3-T1).
 *
 * R218: a unit-token card in the library (#33's copy of a played Rush Token card, R34) leaves it only
 * by being drawn or played (R11), and "choose one to hand" is neither, so the Tutor passes over it —
 * as the reveal does (`discoverFromLibrary`) — and never offers a type or a bracket only it matches.
 */
function libraryCards(ctx: EffectContext): readonly CardInstance[] {
  return zoneCards(ctx.state, ctx.controller, "library").filter((card) => !isUnitToken(ctx.state, card));
}

/** A `chosenOptions` answer narrowed back to the option it must be, or null (never a cast). */
function typeOptionOf(picked: string | undefined): TypeOption | null {
  return TYPE_OPTIONS.find((option) => option === picked) ?? null;
}

function bracketOptionOf(picked: string | undefined): BracketOption | null {
  return BRACKET_OPTIONS.find((option) => option === picked) ?? null;
}

/** §10.6's captured data is JSON, so what comes back out is narrowed, not asserted. */
function capturedType(ctx: EffectContext): TypeOption | null {
  const stored = ctx.data[TYPE_KEY];
  return typeOptionOf(typeof stored === "string" ? stored : undefined);
}

/**
 * Step 1 (the spell's own resolution, §10.5 step 5): offer the types that have a match in the
 * library. No type does — an empty library — so the Notebook is added instead.
 */
const startStep: Hook = (ctx) => {
  const library = libraryCards(ctx);
  const options = TYPE_OPTIONS.filter((option) => library.some((card) => matchesType(ctx, card, option)));
  if (options.length === 0) return [addToHand({ defId: NOTEBOOK })];

  return [
    chooseMode({
      options: [...options],
      step: "bracket",
      prompt: "Choose a card type",
    }),
  ];
};

/**
 * Step 2: the type is answered, so offer the cost brackets that have a match FOR THAT TYPE, and
 * carry the type forward — the reveal step needs it and `ctx.targets` will by then hold the
 * bracket answer instead.
 */
const bracketStep: Hook = (ctx) => {
  const type = typeOptionOf(chosenOptions(ctx)[0]);
  if (type === null) return [];

  const matching = libraryCards(ctx).filter((card) => matchesType(ctx, card, type));
  const options = BRACKET_OPTIONS.filter((bracket) =>
    matching.some((card) => matchesBracket(ctx, card, bracket)),
  );
  if (options.length === 0) return [];

  return [
    chooseMode({
      options: [...options],
      step: "reveal",
      data: { [TYPE_KEY]: type },
      prompt: `Choose a cost bracket for ${type}`,
    }),
  ];
};

/**
 * Step 3: both halves of the filter are known, so reveal three random matching library cards. The
 * options are the library's own instances, which is what keeps §10.8's "revealed only as an option
 * of the prompt that reveals it" true.
 */
const revealStep: Hook = (ctx) => {
  const type = capturedType(ctx);
  const bracket = bracketOptionOf(chosenOptions(ctx)[0]);
  if (type === null || bracket === null) return [];

  return [
    discoverFromLibrary({
      step: "take",
      count: REVEAL_COUNT,
      player: "self",
      filter: { type: typesFor(type), costRange: rangeFor(bracket) },
      prompt: "Reveal 3 cards from your library; choose one to add to your hand",
    }),
  ];
};

/** Step 4: "choose one to hand" — the revealed instance moves library → hand (§6.3, R4). */
const takeStep: Hook = () => [addToHand({ instance: { of: "chosen" } })];

/** The three named continuations a prompt answer re-enters (`RESUME_HOOK`, §10.6). */
const steps: Record<string, Hook> = {
  bracket: bracketStep,
  reveal: revealStep,
  take: takeStep,
};

export const base: Script = {
  cry: startStep,
  resume: steps,
};

/** "Echo (resolves a second time)": one EXTRA resolution, driven by §10.5 step 6. */
const RADIANT_FLAGS: StaticFlags = { echo: 1 };

/**
 * The radiant face is the same four steps — each repeat re-enters `cry` and opens its own fresh
 * prompts (§6.2 Echo X, §10.5 step 6) — plus the count of repeats it owes.
 */
export const radiant: Script = {
  cry: startStep,
  resume: steps,
  staticFlags: RADIANT_FLAGS,
};
