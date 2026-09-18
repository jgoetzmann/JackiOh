// The M3 gate's third rulings file (BUILD.md): one `it("R<n> …")` per SPEC §11 row from R91 to
// R113 whose behaviour no other test names. R97 (event redaction) and R98 (a card that asks a
// question while it resolves) are already proved by `viewFor.test.ts` and `prompts.test.ts`, and
// R104 to R112 are server rulings, so neither kind is repeated here; `rulings.test.ts` is the index
// that points at whichever file proves each row.
//
// Every fixture is this file's own — defs prefixed `rc-`, indexes from 1901, registered on top of
// the shared fixture catalog by `game()` — so it cannot collide with another test file's (BUILD §0).
//
// Two rows have a clause that is easy to half-implement, so each gets a test of its own rather than
// riding along in a bigger one:
//   * R91's "no error" is a separate test from R91's "does nothing", because `switchPosition` has
//     to notice that the position asked for is the one the unit already holds *before* it reads the
//     unit's exertion — otherwise a unit that has already acted is refused where R91 says nothing
//     at all happens.
//   * R94 is one test per side of the exchange. Reading the attacker's attack once is the obvious
//     half; reading the *defender's* once is the half a lazy `strikeBack` gets wrong, and it is the
//     half R94 spells out ("a First Strike survivor is struck back with the attack the defender had
//     before the hit landed"). Both tests assert that the fixture aura really does move the number
//     between the two readings, so neither can pass by reading the same value twice.

import type { Action, ActionInput, CardDef, CardFace, GameEvent, PlayerId } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { defByIndex, defOf, registerCatalog, registeredCatalog } from "../src/catalog";
import {
  declareAttack,
  forceAttacksOn,
  hasExertion,
  switchPosition,
  type AttackTarget,
} from "../src/combat";
import { ANTI_ONESHOT_CAP, FATIGUE_DAMAGE, FUSE_COST_CAP, HERO_HEALTH } from "../src/config";
import { dealDamage, heroDamageCap, loseHealth } from "../src/damage";
import { addToHand as arriveInHand, drawOne } from "../src/draw";
import * as effects from "../src/effects";
import {
  damage,
  damageAll,
  discardHand,
  discardRandom,
  exile,
  exileHand,
  flipCoins,
  forcedAttacks,
  steal,
} from "../src/effects";
import { statsWithBuffs, unitHas, unitView } from "../src/layers";
import { scheduleDelayed } from "../src/modifiers";
import { printedCost } from "../src/mana";
import { PLAY_WORK_KIND } from "../src/playSteps";
import { DELAYED_HOOK } from "../src/effects/delay";
import {
  SHEEP_TOKEN_INDEX,
  declaredTargets,
  legalZonesFor,
  legalTributeSets,
  legalTributeUnits,
  mayTributeEnemyUnits,
  playActionsFor,
  tributeCostOf,
  tributeValueOf,
  whyChoicesRefused,
  type PlayAction,
} from "../src/playChoices";
import { RESUME_HOOK, answerPrompt, openPrompt, resumeSelf, runResume } from "../src/prompts";
import { beginGame, reduce } from "../src/reduce";
import {
  applyEffects,
  castCard,
  flagReturnToHandAtEndOfTurn,
  makeContext,
  type EngineSink,
} from "../src/resolve";
import type { CardScripts, Effect, Script } from "../src/script";
import { registerScripts, registeredScripts, scriptsFor } from "../src/scripts";
import { findInstance, newInstance, type CardInstance, type GameState, type Resume } from "../src/state";
import { gradeOf, gradeRises, playedCardsThisTurn } from "../src/subsystems/comboIndex";
import { fuse } from "../src/subsystems/fuse";
import {
  HERO_POWERS,
  HERO_POWER_NAMES,
  POWER_KEY,
  POWER_RESUME,
  POWER_USED_KEY,
  RUSH_TOKEN_INDEX,
  heroPower,
  powerCostOf,
  powerOf,
  rollPower,
  usePower,
  usedThisTurn,
  whyCannotActivate,
} from "../src/subsystems/heroPower";
import { fireTrapsFor, isTrapWindowEvent, runTrapWindow, trapsWatching } from "../src/traps";
import { playedIdsThisTurn } from "../src/query";
import { createRng } from "../src/rng";
import { settle } from "../src/triggers";
import { HIDDEN_ID, viewFor } from "../src/viewFor";
import { endTurn, startTurn } from "../src/turn";
import { triggerHoldersWithHook } from "../src/triggers";
import { beginWorkCascade, pushWork, runWorkItem, takeWork } from "../src/work";
import { activeUnitsOf, cardAt, firstFreeZone, placeOnField, removeFromAnyZone } from "../src/zones";
import { stacker } from "./fixtures/combat";
import { eventsOfType, inHand, newGame, put, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixture definitions.
// ---------------------------------------------------------------------------

let nextIndex = 1900;

function def(name: string, type: CardDef["type"], extra: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `rc-${name}`,
    index: String(nextIndex),
    name: `${name} (rulings-c)`,
    set: "Core",
    type,
    tags: [],
    rarity: "Common",
    token: false,
    cost: 1,
    base: { keywords: [], text: `${name} base` },
    radiant: { keywords: [], text: `${name} radiant` },
    ...extra,
  };
}

/**
 * A unit fixture. The two faces are `Partial<CardFace>` rather than `CardFace` on purpose: a fixture
 * below names only the keywords it is about, and the helper supplies the rest of the face — §8's
 * `text` included, which none of these rows exercise. `Partial<CardDef>` would type `base` as a
 * whole `CardFace` and demand a `text` at every call site.
 */
function unit(
  name: string,
  attack: number,
  health: number,
  extra: Omit<Partial<CardDef>, "base" | "radiant"> & {
    base?: Partial<CardFace>;
    radiant?: Partial<CardFace>;
  } = {},
): CardDef {
  const { base, radiant, ...rest } = extra;
  return def(name, "Unit", {
    base: { attack, health, keywords: [], text: name, ...base },
    radiant: { attack, health, keywords: [], text: name, ...radiant },
    ...rest,
  });
}

/** A body big enough to survive every exchange below, so no death confuses a hit count. */
const body = unit("body", 4, 20);
/** 2 attack and First Strike, so its step-1 strike is small enough to leave a survivor. */
const quick = unit("quick", 2, 20, {
  base: { keywords: [{ kind: "First Strike" }] },
  radiant: { keywords: [{ kind: "First Strike" }] },
});
/**
 * #20 Pointmaster's printed line: 7/2 with First Strike. It is the card R93 names, and the only
 * fixture here whose step-1 strike KILLS an ordinary attacker, which is the half of the ruling a
 * survivor can never show — a defender that lives through the exchange proves the order of the two
 * hits, not that the second one never happens.
 */
const pointmaster = unit("pointmaster", 7, 2, {
  base: { keywords: [{ kind: "First Strike" }] },
  radiant: { keywords: [{ kind: "First Strike" }] },
});
/** A plain 3/3: the ordinary attacker #20 Pointmaster kills before its blow lands. */
const doomed = unit("doomed", 3, 3);
/** Cleave on a body that survives, so R95 can count where the extra instances landed. */
const cleaver = unit("cleaver", 3, 20, {
  base: { keywords: [{ kind: "Cleave" }] },
  radiant: { keywords: [{ kind: "Cleave" }] },
});

/**
 * R94 needs a stat that changes *during* a combat. Layer 2 (`setStat`) is not wired into `unitView`
 * until M3-T4, so the fixture uses layer 5: a Field Spell whose aura reads `unit.damage`, which is
 * instance data an `applies` predicate may read (§10.4). A unit that has taken any damage loses 3
 * attack, so "the attack it had before the hit landed" and "the attack it has now" are different
 * numbers and the ruling is observable.
 */
const weakener = def("weakener", "Field Spell");
const WEAKEN_BY = 3;

/** #66 The Rock's shape: a Tribute cost on a body (§6.3). */
const tributeTwo = unit("tribute-two", 8, 8, { cost: 3 });
/** #55 Lava Golem's shape: a Tribute that may reach the opponent's units (R101). */
const tributeEnemies = unit("tribute-enemies", 10, 5, { cost: 3 });
/** §7's Sheep Token: the one unit worth 2 Tributes while on the field (§3.2). */
const sheep = unit("sheep", 1, 1, {
  index: SHEEP_TOKEN_INDEX,
  tags: ["Token"],
  rarity: "Token",
  token: true,
});

/** R99: a trap whose `when` admits only an event the opponent caused. */
const pickyTrap = def("picky-trap", "Trap");
/** R99 and R61: a trap whose condition is met and whose effect list is empty. */
const emptyTrap = def("empty-trap", "Trap");
/** R99: a trap that declares no predicate, so it answers the event whichever side caused it. */
const bareTrap = def("bare-trap", "Trap");
/** R100: a Field Trap on `turnEnded`, which stays after firing so a second offer is observable. */
const windowTrap = def("window-trap", "Field Trap");

/** R102: two ingredients whose printed costs sum past the cap. */
const fusePricey = unit("fuse-pricey", 1, 1, { cost: 4 });
const fuseDear = unit("fuse-dear", 1, 1, { cost: 3 });
/**
 * R102: an ingredient with a `cost` hook. Its printed cost is 3 but the hook answers 1, so the
 * fused def's cost is 1 + 1 = 2 while a surviving hook would still answer 1 — the two numbers
 * differ, which is what makes "any ingredient `cost` hook is dropped" observable.
 */
const fuseHooked = unit("fuse-hooked", 1, 1, { cost: 3 });
const fuseCheap = unit("fuse-cheap", 1, 1, { cost: 1 });
/** R102: two ingredients that each ask for a Tribute, so the max and the sum differ. */
const fuseTributeTwo = unit("fuse-tribute-two", 1, 1);
const fuseTributeThree = unit("fuse-tribute-three", 1, 1);
/** R102: two traps that use the *same* trigger id on the same event, with different predicates. */
const fuseTrapMine = def("fuse-trap-mine", "Trap");
const fuseTrapTheirs = def("fuse-trap-theirs", "Trap");
/** R102: an ingredient with a Death hook, so "no Death trigger" is observable. */
const fuseDying = unit("fuse-dying", 2, 2);
/**
 * R102: one ingredient fused onto two different targets in turn (radiant #85). Its 7/3 is unlike
 * either host, so which fusion picked up its stats is readable off the fused def.
 */
const fuseShared = unit("fuse-shared", 7, 3);
const fuseHostA = unit("fuse-host-a", 1, 1);
const fuseHostB = unit("fuse-host-b", 2, 2);

/** R103's stand-in for §8 #98: cost is the power's X, and a prompted power resumes into `heroPower`. */
const heroic = def("heroic", "Field Spell", { cost: "X", tags: ["Quickdraw"], rarity: "Mythic" });

/** R114: a small body, so one hit can leave it at exactly 0 health with a Trample hit still to come. */
const frail = unit("frail", 1, 3);
/**
 * R114: #32's shape with two more keywords bolted on, so one hit can be asked all three questions
 * at once — does the unit take damage, is it marked Poisonous, and does the source heal off it.
 */
const trampler = unit("trampler", 5, 5, {
  base: { keywords: [{ kind: "Trample" }, { kind: "Lifesteal" }, { kind: "Poisonous" }] },
  radiant: { keywords: [{ kind: "Trample" }, { kind: "Lifesteal" }, { kind: "Poisonous" }] },
});

/** R115: #92's shape — a unit that both projects an aura and sets its own stats from the board. */
const projector = unit("projector", 2, 2);
/** R115 and R116: a plain body for the aura to land on and the set-stat hook to measure. */
const measured = unit("measured", 3, 4);
/** R116: a set-stat hook that returns a delta big enough that a total would read differently. */
const setter = unit("setter", 2, 6);
/** R116: a second set-stat card, so "two on one board never read each other" is observable. */
const otherSetter = unit("other-setter", 4, 8);

/** R117 and R118: the note log, parked in p1's backrow lane 5 so it survives `reduce`'s clone. */
const logCard = def("log", "Field Spell");
/** R117 and R118: a Cry that notes it ran, so "exactly once" is countable. */
const crier = unit("crier", 2, 4, { cost: 0 });
/** R117 and R118: a Trap answering the summon with a prompt for its own controller (§10.3). */
const askTrap = def("ask-trap", "Trap");
/** R118: R17's carve-out — a Trap that takes the played card off the field before its Cry. */
const eatTrap = def("eat-trap", "Trap");

/** R122: a Spell whose Cry notes it ran, so "a Spell short of its graveyard" is observable. */
const spellCrier = def("spell-crier", "Spell", { cost: 0 });
/** R122: a Trap that prompts on `cardPlayed`, so a Spell's play pauses the same way a summon's does. */
const askOnPlay = def("ask-on-play", "Trap");
/** R123: #22 Carnivorous Cube's shape — a `tribute` declaration with both a pick and an `amount`. */
const cube = unit("cube", 4, 6, { cost: 0 });

/** R153: one card carrying the three hooks a hand and a graveyard must not answer. */
const zoneHooks = def("zone-hooks", "Field Spell");

/** R155: #23's shape — a Spell whose resolving face declares an end-of-turn return. */
const returnSpell = def("return-spell", "Spell", { cost: 0 });
/** R155: #13's shape — a Unit with an end-of-turn hook, which must never be flagged. */
const dyingUnit = unit("dying-unit", 1, 1, { cost: 0 });

/** R124 and R125: #90's shape — an Anti-oneshot Armor card, whose *cap* is a ceiling, not a reduction. */
const guard = def("guard", "Field Spell");

/** R126: a continuation under the `delayed` hook — the one shape `turn.runDelayed` re-enters today. */
const delayedHookCard = unit("delayed-hook", 1, 1);
/** R126: the same continuation as an entry in the card's `resume` step table (§10.6). */
const delayedStepCard = unit("delayed-step", 1, 1);
/** R127: a card that schedules a continuation and is gone before it comes due (#50's shape, R76). */
const ghostCard = def("ghost", "Spell", { cost: 0 });
/** R131 and R132: #92's shape — a Felinor-tagged set-stat card that must not count itself. */
const fiender = unit("fiender", 5, 7, { tags: ["Felinor"] });
/** R131 and R132: an ordinary Felinor for it to measure. */
const felinor = unit("felinor", 3, 10, { tags: ["Felinor"] });

const DEFS: CardDef[] = [
  body,
  quick,
  pointmaster,
  doomed,
  cleaver,
  weakener,
  tributeTwo,
  tributeEnemies,
  sheep,
  pickyTrap,
  emptyTrap,
  bareTrap,
  windowTrap,
  fusePricey,
  fuseDear,
  fuseHooked,
  fuseCheap,
  fuseTributeTwo,
  fuseTributeThree,
  fuseTrapMine,
  fuseTrapTheirs,
  fuseDying,
  fuseShared,
  fuseHostA,
  fuseHostB,
  heroic,
  frail,
  trampler,
  projector,
  measured,
  setter,
  otherSetter,
  logCard,
  crier,
  askTrap,
  eatTrap,
  spellCrier,
  askOnPlay,
  cube,
  guard,
  zoneHooks,
  returnSpell,
  dyingUnit,
  delayedHookCard,
  delayedStepCard,
  ghostCard,
  fiender,
  felinor,
];

// ---------------------------------------------------------------------------
// Fixture scripts.
// ---------------------------------------------------------------------------

function both(script: Script): CardScripts {
  return { base: script, radiant: script };
}

/** Deal `amount` to the enemy hero: the one visible thing a fixture script needs to do. */
const hit = (amount: number): Script["cry"] => () => [damage({ to: { of: "enemyHero" }, amount })];

/** R115: what `projector`'s set-stat hook adds, chosen so a total and a delta read differently. */
const PROJECTOR_SETS = 5;

/** R117 and R118: the note log lives in p1's backrow lane 5, so `reduce`'s state clone carries it. */
const NOTE_LANE = 5;

function logOf(state: GameState): CardInstance | null {
  return state.players.p1.backrow[NOTE_LANE - 1] ?? null;
}

function note(name: string): Effect {
  return {
    kind: "rc:note",
    apply(ctx): void {
      const log = logOf(ctx.state);
      if (log === null) return;
      const steps = Array.isArray(log.memory.steps) ? (log.memory.steps as string[]) : [];
      log.memory.steps = [...steps, name];
    },
  };
}

function notes(state: GameState): string[] {
  const log = logOf(state);
  return Array.isArray(log?.memory.steps) ? (log.memory.steps as string[]) : [];
}

/** §10.6: a prompt for the card's own controller, with one answer, so answering is trivial. */
function askController(): Effect {
  return {
    kind: "rc:ask",
    apply(ctx): void {
      openPrompt(ctx, {
        player: ctx.controller,
        kind: "target",
        prompt: "the trap asks its owner",
        options: [{ key: "none", label: "nothing", selection: { pick: "none" } }],
        resume: resumeSelf(ctx, "asked"),
      });
    },
  };
}

const heroicScript: Script = {
  cost: ({ instance }) => powerCostOf(instance),
  staticFlags: { quickdraw: true },
  startOfGame: () => [rollPower()],
  cry: () => [usePower()],
  activate: () => [usePower()],
  resume: { [POWER_RESUME]: heroPower },
};

const SCRIPTS: Record<string, CardScripts> = {
  [weakener.id]: both({
    aura: () => [{ applies: (unit) => unit.damage > 0, mod: { attack: -WEAKEN_BY } }],
  }),
  [tributeTwo.id]: both({ staticFlags: { tribute: 2 } }),
  [tributeEnemies.id]: both({ staticFlags: { tribute: 3, tributeEnemies: true } }),
  // R99: the predicate admits only an event the other player caused, and never spends the trap on
  // one of its controller's own.
  [pickyTrap.id]: both({
    triggers: [
      {
        id: "theirs-only",
        on: ["cardPlayed"],
        when: ({ controller, event }) => event.type === "cardPlayed" && event.player !== controller,
        run: () => [damage({ to: { of: "enemyHero" }, amount: 1 })],
      },
    ],
  }),
  // R61 and R99: the condition is met, the effect list is empty, and the trap is spent anyway.
  [emptyTrap.id]: both({
    triggers: [{ id: "always", on: ["cardPlayed"], when: () => true, run: () => [] }],
  }),
  [bareTrap.id]: both({
    triggers: [{ id: "no-predicate", on: ["cardPlayed"], run: () => [damage({ to: { of: "enemyHero" }, amount: 2 })] }],
  }),
  [windowTrap.id]: both({
    triggers: [{ id: "turn-end", on: ["turnEnded"], run: () => [damage({ to: { of: "enemyHero" }, amount: 1 })] }],
  }),
  // R102: the hook answers 1 where the printed cost is 3.
  [fuseHooked.id]: both({ cost: () => 1 }),
  [fuseTributeTwo.id]: both({ staticFlags: { tribute: 2 } }),
  [fuseTributeThree.id]: both({ staticFlags: { tribute: 3 } }),
  // R102: both traps call their trigger "fire", both watch `cardPlayed`, and their predicates are
  // opposites, so a fusion that lost the namespacing or merged the predicates reads differently.
  [fuseTrapMine.id]: both({
    triggers: [
      {
        id: "fire",
        on: ["cardPlayed"],
        when: ({ controller, event }) => event.type === "cardPlayed" && event.player === controller,
        run: () => [damage({ to: { of: "enemyHero" }, amount: 1 })],
      },
    ],
  }),
  [fuseTrapTheirs.id]: both({
    triggers: [
      {
        id: "fire",
        on: ["cardPlayed"],
        when: ({ controller, event }) => event.type === "cardPlayed" && event.player !== controller,
        run: () => [damage({ to: { of: "enemyHero" }, amount: 2 })],
      },
    ],
  }),
  [fuseDying.id]: both({ death: hit(7) }),
  [heroic.id]: { base: heroicScript, radiant: heroicScript },
  // R115: one card doing both of the things Vanilla has to silence — projecting an aura at layer 5
  // and setting its own stats at layer 2 — plus the printed face Vanilla must leave alone.
  [projector.id]: both({
    aura: ({ self }) => [
      { applies: (unit) => unit.controller === self.controller && unit.id !== self.id, mod: { attack: 2, maxHealth: 2 } },
    ],
    setStat: () => ({ attack: PROJECTOR_SETS, maxHealth: PROJECTOR_SETS }),
  }),
  // R116: a delta. It reads the other set-stat card on the board through `statsWithBuffs`, which is
  // layers 1 to 4 and therefore excludes layer 2 — so the two can never read each other.
  [setter.id]: both({
    setStat: ({ state, self }) => {
      const other = activeUnitsOf(state, self.controller).find(
        (unit) => unit.id !== self.id && unit.defId === otherSetter.id,
      );
      const seen = other === undefined ? 0 : statsWithBuffs(state, other).attack;
      return { attack: seen, maxHealth: seen };
    },
  }),
  [otherSetter.id]: both({
    setStat: ({ state, self }) => {
      const other = activeUnitsOf(state, self.controller).find(
        (unit) => unit.id !== self.id && unit.defId === setter.id,
      );
      const seen = other === undefined ? 0 : statsWithBuffs(state, other).attack;
      return { attack: seen, maxHealth: seen };
    },
  }),
  [crier.id]: both({ cry: () => [note("cry")] }),
  // R117 and R118: the trap's answer is a prompt for its own controller, which pauses the play that
  // emitted the `summoned` event partway through §10.5.
  [askTrap.id]: both({
    triggers: [{ id: "ask-summon", on: ["summoned"], run: () => [askController()] }],
    resume: { asked: () => [note("answered")] },
  }),
  // R118 and R17: the trap takes the played permanent off the field, so there is no card left to
  // resolve and the Cry is genuinely lost rather than merely delayed.
  [eatTrap.id]: both({
    triggers: [
      {
        id: "eat-summon",
        on: ["summoned"],
        run: ({ event }) => [
          note("eaten"),
          ...(event.type === "summoned"
            ? [exile({ target: { of: "instance", instanceId: event.instanceId } })]
            : []),
        ],
      },
    ],
  }),
  [spellCrier.id]: both({ cry: () => [note("spell")] }),
  [askOnPlay.id]: both({
    triggers: [{ id: "ask-play", on: ["cardPlayed"], run: () => [askController()] }],
    resume: { asked: () => [note("answered")] },
  }),
  // R123: one declaration carrying both halves — a pick the script reads out of `ctx.targets`, and
  // an `amount` that is §6.3's Tribute cost.
  [guard.id]: both({ staticFlags: { antiOneshot: true } }),
  [returnSpell.id]: both({ endOfTurn: () => [note("returned")] }),
  [dyingUnit.id]: both({ endOfTurn: () => [note("unit-end")] }),
  // R153: a card with all three of the hooks whose zones the ruling narrows.
  [zoneHooks.id]: both({
    startOfTurn: () => [note("startOfTurn")],
    endOfTurn: () => [note("endOfTurn")],
    onPlayHook: () => [note("onPlayHook")],
  }),
  // R126: the two shapes a delayed continuation may take. Both must be re-entered by one reader.
  [delayedHookCard.id]: both({ delayed: () => [note("delayed:hook")] }),
  [delayedStepCard.id]: both({ resume: { later: () => [note("delayed:step")] } }),
  // R127: the step reports whether it got a `self`, so "resolves with ctx.self === null" is visible.
  [ghostCard.id]: both({
    resume: {
      orphan: (ctx) => [
        note(`orphan:${ctx.self === null ? "no-self" : "self"}:${String(ctx.data.carried ?? "")}`),
      ],
    },
  }),
  // R131: "all your Felinors" means every OTHER Felinor you control, matched by instance and not by
  // tag — so this counts itself out by id even though its own def carries the Felinor tag. R132: the
  // sums accumulate first and each stat is floored once, on its combined total.
  [fiender.id]: both({
    setStat: ({ state, self }) => {
      let attack = 0;
      let maxHealth = 0;
      for (const other of activeUnitsOf(state, self.controller)) {
        if (other.id === self.id) continue;
        if (!defOf(state, other.defId).tags.includes("Felinor")) continue;
        const stats = statsWithBuffs(state, other);
        attack += stats.attack;
        maxHealth += stats.maxHealth;
      }
      return { attack: Math.max(0, attack), maxHealth: Math.max(0, maxHealth) };
    },
  }),
  [cube.id]: both({
    targets: [{ kind: "tribute", min: 1, max: 1, amount: 2 }],
    cry: (ctx) => {
      const pick = ctx.targets[0];
      return [note(pick !== undefined && pick.pick === "instance" ? `ate:${pick.instanceId}` : "ate:nothing")];
    },
  }),
};

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

/** p1's main phase on turn 4, so nothing placed with `put` is summoning sick (§4.1). */
function game(seed: string): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((entry) => [entry.id, entry])) });
  registerScripts({ ...registeredScripts(), ...SCRIPTS });
  state.turn = 4;
  state.active = "p1";
  state.phase = "main";
  state.players.p1.mana = { current: 4, max: 4, nextTurnMod: 0, permMod: 0 };
  return state;
}

let nonce = 0;

function actResult(state: GameState, body: ActionInput): ReturnType<typeof reduce> {
  nonce += 1;
  return reduce(state, { ...body, nonce: `rc${nonce}` } as Action);
}

function act(state: GameState, body: ActionInput): GameState {
  const result = actResult(state, body);
  if (result.error !== undefined) throw new Error(result.error);
  return result.state;
}

/**
 * Past the mulligans, in p1's main phase, with the note log in p1's backrow lane 5. R117 and R118
 * are about the play pipeline of §10.5, so they go through `reduce` rather than driving it.
 */
function playing(seed: string): GameState {
  let state = beginGame(game(seed)).state;
  state = act(state, { type: "mulligan", keep: state.players.p1.hand.map((card) => card.id), playerId: "p1" });
  state = act(state, { type: "mulligan", keep: state.players.p2.hand.map((card) => card.id), playerId: "p2" });
  put(state, logCard.id, slot("p1", "backrow", NOTE_LANE));
  return state;
}

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

function onUnit(instance: CardInstance): AttackTarget {
  return { kind: "unit", instance };
}

function onHero(player: PlayerId): AttackTarget {
  return { kind: "hero", player };
}

/** Every damage instance of a combat, as (source, target, amount) in the order they landed. */
function hits(events: readonly GameEvent[]): { from: string; to: string; amount: number }[] {
  return eventsOfType(events, "damage").map((event) => ({
    from: event.sourceId ?? "",
    to: event.targetId,
    amount: event.amount,
  }));
}

/** A `cardPlayed` event, the one every trap fixture below watches. */
function played(player: PlayerId): GameEvent {
  return { type: "cardPlayed", player, instanceId: "c9001", defId: body.id, costPaid: 1 };
}

// ---------------------------------------------------------------------------
// R91, R92: positions (§4.1).
// ---------------------------------------------------------------------------

describe("SPEC §11 R91–R96: positions and combat (M3 gate)", () => {
  it("R91 does nothing when a unit is switched to the position it already holds", () => {
    const state = game("r91-noop");
    const unit = put(state, body.id, slot("p1", "units", 1));
    expect(unit.position).toBe("ATK");

    // The player's action, naming the position the unit is already in: no event, no exertion.
    const attackEvents: GameEvent[] = [];
    expect(switchPosition(sinkFor(state, attackEvents), unit, { to: "ATK" }).error).toBeUndefined();
    expect(attackEvents).toEqual([]);
    expect(unit.position).toBe("ATK");
    expect(unit.exertion).toEqual({ attacked: false, switched: false });
    expect(hasExertion(unit, "switch")).toBe(true);

    // The same on the other face: a real flip spends the exertion and emits, a repeat does neither.
    const flipEvents: GameEvent[] = [];
    expect(switchPosition(sinkFor(state, flipEvents), unit, { to: "DEF" }).error).toBeUndefined();
    expect(eventsOfType(flipEvents, "positionSwitched")).toHaveLength(1);
    expect(unit.exertion.switched).toBe(true);

    unit.exertion = { attacked: false, switched: false };
    const repeatEvents: GameEvent[] = [];
    expect(switchPosition(sinkFor(state, repeatEvents), unit, { to: "DEF" }).error).toBeUndefined();
    expect(repeatEvents).toEqual([]);
    expect(unit.position).toBe("DEF");
    expect(unit.exertion.switched).toBe(false);

    // #48's "switch every unit" reaches units already in the position it would set (R20's effect
    // path spends no exertion either way, so the event list is what says nothing happened).
    const sweepEvents: GameEvent[] = [];
    const already = put(state, body.id, slot("p1", "units", 2));
    expect(
      switchPosition(sinkFor(state, sweepEvents), already, { to: "ATK", spendExertion: false }).error,
    ).toBeUndefined();
    expect(sweepEvents).toEqual([]);
    expect(already.position).toBe("ATK");
  });

  it("R91 is not an error even for a unit that has already acted this turn", () => {
    const state = game("r91-spent");
    const unit = put(state, body.id, slot("p1", "units", 1));
    unit.exertion.attacked = true; // it attacked this turn, so it has no switch left (§4.1, R6)

    // R91: "Does nothing: no error, no event and no exertion spent." Nothing about the unit's
    // exertion changes that, because nothing is being spent — there is no switch to refuse.
    const events: GameEvent[] = [];
    expect(switchPosition(sinkFor(state, events), unit, { to: "ATK" }).error).toBeUndefined();
    expect(events).toEqual([]);
    expect(unit.position).toBe("ATK");
    expect(unit.exertion).toEqual({ attacked: true, switched: false });
  });

  it("R92 gives a position only to a card on the field, so a dormant or absent card cannot be switched", () => {
    const state = game("r92-field-only");

    // In hand: no position at all, and the switch is refused rather than inventing one.
    const held = must(inHand(state, body.id, "p1")[0], "a unit in hand");
    expect(held.position).toBeUndefined();
    expect(switchPosition(sinkFor(state), held).error).toBe("that unit is not on the field");
    expect(held.position).toBeUndefined();

    // On the field it switches like any other unit.
    const under = put(state, body.id, slot("p1", "units", 1));
    expect(switchPosition(sinkFor(state), under).error).toBeUndefined();
    expect(under.position).toBe("DEF");

    // Dormant under a Stack: in the lane, but not on the field for anything (§3.2, R13). The same
    // refusal R13 gives an attack, and the position it had is left exactly where it was.
    under.exertion = { attacked: false, switched: false }; // a fresh turn's worth, so a spend shows
    const top = newInstance(state, stacker.id, "p1", { z: "hand", player: "p1" });
    expect(placeOnField(state, top, slot("p1", "units", 1), { stack: true })).toBe(true);
    const dormantEvents: GameEvent[] = [];
    expect(switchPosition(sinkFor(state, dormantEvents), under).error).toBe("that unit is not on the field");
    expect(dormantEvents).toEqual([]);
    expect(under.position).toBe("DEF");
    expect(under.exertion.switched).toBe(false);
    // Only the top of the pile has a position to switch.
    expect(switchPosition(sinkFor(state), top).error).toBeUndefined();

    // Off the field entirely: the same refusal, even though the instance still remembers a position.
    const left = put(state, body.id, slot("p1", "units", 3));
    removeFromAnyZone(state, left);
    left.zone = { z: "graveyard", player: "p1" };
    expect(switchPosition(sinkFor(state), left).error).toBe("that unit is not on the field");
  });

  // ---------------------------------------------------------------------------
  // R93, R94: how many times each unit strikes, and with what (§4.3).
  // ---------------------------------------------------------------------------

  it("R93 has a First Strike unit strike once, on whichever side it is: step 1 is when its strike happens, not an extra one", () => {
    // A First Strike attacker against a survivor: one hit each, not two for the attacker.
    const state = game("r93-attacker");
    const attacker = put(state, quick.id, slot("p1", "units", 1)); // 2/20 First Strike
    const defender = put(state, body.id, slot("p2", "units", 1)); // 4/20
    const events: GameEvent[] = [];
    expect(declareAttack(sinkFor(state, events), attacker, onUnit(defender)).error).toBeUndefined();
    expect(hits(events)).toEqual([
      { from: attacker.id, to: defender.id, amount: 2 },
      { from: defender.id, to: attacker.id, amount: 4 },
    ]);
    expect(defender.damage).toBe(2);
    expect(attacker.damage).toBe(4);

    // A First Strike defender: likewise one hit each, the defender's first.
    const other = game("r93-defender");
    const plainAttacker = put(other, body.id, slot("p1", "units", 1));
    const quickDefender = put(other, quick.id, slot("p2", "units", 1));
    const otherEvents: GameEvent[] = [];
    expect(declareAttack(sinkFor(other, otherEvents), plainAttacker, onUnit(quickDefender)).error).toBeUndefined();
    expect(hits(otherEvents)).toEqual([
      { from: quickDefender.id, to: plainAttacker.id, amount: 2 },
      { from: plainAttacker.id, to: quickDefender.id, amount: 4 },
    ]);

    // The half §4.3 used to leave unstated, and the reason R93 needed rewording: a First Strike
    // DEFENDER that kills its attacker in step 1 takes nothing back. #20 Pointmaster is a 7/2, so
    // a 3/3 attacking into it dies before its own blow lands and Pointmaster survives on 2 health
    // — which is exactly the case the old wording ("First Strike only moves the attacker's strike
    // earlier") got backwards while the engine had it right all along.
    const lethal = game("r93-defender-kills");
    const attacking = put(lethal, doomed.id, slot("p1", "units", 1));
    const point = put(lethal, pointmaster.id, slot("p2", "units", 1));
    const lethalEvents: GameEvent[] = [];
    expect(declareAttack(sinkFor(lethal, lethalEvents), attacking, onUnit(point)).error).toBeUndefined();
    expect(hits(lethalEvents)).toEqual([{ from: point.id, to: attacking.id, amount: 7 }]);
    expect(lethal.players.p1.graveyard.map((c) => c.id)).toEqual([attacking.id]);
    expect(point.damage).toBe(0);

    // Two First Strikers trade in step 1: two hits in all, not four, and neither waits for step 2.
    const trade = game("r93-trade");
    const left = put(trade, quick.id, slot("p1", "units", 1));
    const right = put(trade, quick.id, slot("p2", "units", 1));
    const tradeEvents: GameEvent[] = [];
    expect(declareAttack(sinkFor(trade, tradeEvents), left, onUnit(right)).error).toBeUndefined();
    expect(hits(tradeEvents)).toEqual([
      { from: left.id, to: right.id, amount: 2 },
      { from: right.id, to: left.id, amount: 2 },
    ]);
  });

  it("R94 reads the attacker's attack once per combat, before a First Strike defender's hit lands", () => {
    const state = game("r94-attacker");
    put(state, weakener.id, slot("p1", "backrow", 1)); // a damaged unit loses 3 attack
    const attacker = put(state, body.id, slot("p1", "units", 1)); // 4/20, undamaged
    const defender = put(state, quick.id, slot("p2", "units", 1)); // 2/20 First Strike
    expect(unitView(state, attacker).attack).toBe(4);

    const events: GameEvent[] = [];
    expect(declareAttack(sinkFor(state, events), attacker, onUnit(defender)).error).toBeUndefined();

    // The defender strikes in step 1, the attacker is damaged by it, and the aura drops its
    // *current* attack to 1 — so "read once, at the start" and "read now" are different numbers.
    expect(attacker.damage).toBe(2);
    expect(unitView(state, attacker).attack).toBe(4 - WEAKEN_BY);
    // R94: the attack was read at the start of the combat, so the attacker still struck for 4.
    expect(hits(events)).toEqual([
      { from: defender.id, to: attacker.id, amount: 2 },
      { from: attacker.id, to: defender.id, amount: 4 },
    ]);
  });

  it("R94 reads the defender's attack once per combat, so a First Strike survivor is struck back with the attack it had before the hit", () => {
    const state = game("r94-defender");
    put(state, weakener.id, slot("p1", "backrow", 1)); // a damaged unit loses 3 attack
    const attacker = put(state, quick.id, slot("p1", "units", 1)); // 2/20 First Strike
    const defender = put(state, body.id, slot("p2", "units", 1)); // 4/20, undamaged
    expect(unitView(state, defender).attack).toBe(4);

    const events: GameEvent[] = [];
    expect(declareAttack(sinkFor(state, events), attacker, onUnit(defender)).error).toBeUndefined();

    // The attacker's step-1 hit damages the defender, and the aura drops its *current* attack to 1,
    // so the two readings are different numbers rather than the same one twice.
    expect(defender.damage).toBe(2);
    expect(unitView(state, defender).attack).toBe(4 - WEAKEN_BY);
    // R94: "A First Strike survivor is struck back with the attack the defender had before the hit
    // landed" — 4, not the 1 the aura leaves it on.
    expect(hits(events)).toEqual([
      { from: attacker.id, to: defender.id, amount: 2 },
      { from: defender.id, to: attacker.id, amount: 4 },
    ]);
  });

  // ---------------------------------------------------------------------------
  // R95, R96: Cleave, and a forced attacker that is gone.
  // ---------------------------------------------------------------------------

  it("R95 lands Cleave on the attacker's own hit, never on the strike-back and never on a hero target", () => {
    const state = game("r95-cleave");
    const attacker = put(state, cleaver.id, slot("p1", "units", 3)); // 3/20 Cleave
    // The attacker's own neighbours, which adjacency never crosses sides to reach (§3.1).
    const mine = [put(state, body.id, slot("p1", "units", 2)), put(state, body.id, slot("p1", "units", 4))];
    const left = put(state, body.id, slot("p2", "units", 1));
    const defender = put(state, body.id, slot("p2", "units", 2));
    const right = put(state, body.id, slot("p2", "units", 3));

    const events: GameEvent[] = [];
    expect(declareAttack(sinkFor(state, events), attacker, onUnit(defender)).error).toBeUndefined();

    // The attacker's hit, then the two Cleave instances immediately after it, then the strike-back.
    expect(hits(events)).toEqual([
      { from: attacker.id, to: defender.id, amount: 3 },
      { from: attacker.id, to: left.id, amount: 3 },
      { from: attacker.id, to: right.id, amount: 3 },
      { from: defender.id, to: attacker.id, amount: 4 },
    ]);
    expect(mine.map((unit) => unit.damage)).toEqual([0, 0]);

    // A Cleave *defender* cleaves nothing: Cleave rides the attacker's hit, not the strike-back.
    const back = game("r95-strike-back");
    const plainAttacker = put(back, body.id, slot("p1", "units", 2));
    const myNeighbours = [put(back, body.id, slot("p1", "units", 1)), put(back, body.id, slot("p1", "units", 3))];
    const cleaveDefender = put(back, cleaver.id, slot("p2", "units", 2));
    const backEvents: GameEvent[] = [];
    expect(declareAttack(sinkFor(back, backEvents), plainAttacker, onUnit(cleaveDefender)).error).toBeUndefined();
    expect(hits(backEvents)).toEqual([
      { from: plainAttacker.id, to: cleaveDefender.id, amount: 4 },
      { from: cleaveDefender.id, to: plainAttacker.id, amount: 3 },
    ]);
    expect(myNeighbours.map((unit) => unit.damage)).toEqual([0, 0]);

    // A hero target cleaves nothing, since no unit is adjacent to a hero (§4.4 step 10, R63).
    const hero = game("r95-hero");
    const heroCleaver = put(hero, cleaver.id, slot("p1", "units", 1));
    const bystanders = [put(hero, body.id, slot("p2", "units", 1)), put(hero, body.id, slot("p2", "units", 2))];
    const heroEvents: GameEvent[] = [];
    expect(declareAttack(sinkFor(hero, heroEvents), heroCleaver, onHero("p2")).error).toBeUndefined();
    expect(hits(heroEvents)).toEqual([{ from: heroCleaver.id, to: "hero-p2", amount: 3 }]);
    expect(bystanders.map((unit) => unit.damage)).toEqual([0, 0]);
  });

  it("R96 skips a forced attacker that is already gone in silence, and stops once the game has a result", () => {
    const state = game("r96-gone");
    const gone = put(state, body.id, slot("p1", "units", 1));
    const present = put(state, body.id, slot("p1", "units", 2));
    const victim = put(state, body.id, slot("p2", "units", 1));

    // Whatever removed the first attacker — a trap, its own Death, a bounce — it is not there when
    // the sequence reaches it (R53 only says the sequence stops when the *target* is gone).
    removeFromAnyZone(state, gone);
    gone.zone = { z: "graveyard", player: "p1" };

    const events: GameEvent[] = [];
    forceAttacksOn(sinkFor(state, events), [gone, present], onUnit(victim));

    // No `attackDeclared` for the missing attacker, and nothing else names it either.
    expect(eventsOfType(events, "attackDeclared").map((event) => event.attackerId)).toEqual([present.id]);
    expect(events.some((event) => JSON.stringify(event).includes(gone.id))).toBe(false);
    expect(hits(events)).toEqual([
      { from: present.id, to: victim.id, amount: 4 },
      { from: victim.id, to: present.id, amount: 4 },
    ]);

    // And the sequence stops once the game has a result, before the first attacker declares.
    const over = game("r96-over");
    const first = put(over, body.id, slot("p1", "units", 1));
    const second = put(over, body.id, slot("p1", "units", 2));
    const target = put(over, body.id, slot("p2", "units", 1));
    over.result = { winner: "draw", reason: "turn-cap" };
    const overEvents: GameEvent[] = [];
    forceAttacksOn(sinkFor(over, overEvents), [first, second], onUnit(target));
    expect(overEvents).toEqual([]);
    expect([first.damage, second.damage, target.damage]).toEqual([0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// R99, R100: a trap's condition and the trap window's events (§5.1, §10.3, R62).
// ---------------------------------------------------------------------------

describe("SPEC §11 R99–R101: traps and Tribute (M3 gate)", () => {
  it("R99 fires a trap only when its `when` admits the event, spends it on an empty effect list, and answers either side without a predicate", () => {
    const state = game("r99-predicate");
    const trap = put(state, pickyTrap.id, slot("p1", "backrow", 1));

    // The trigger's `on` matches an event p1 caused, but the predicate refuses it: the trap is not
    // fired, not consumed and not turned face up, because R61 leaves `run` no way to say so.
    expect(trapsWatching(state, played("p1")).map((match) => match.trap.id)).toEqual([trap.id]);
    const mineSink = sinkFor(state);
    expect(fireTrapsFor(mineSink, played("p1")).fired).toEqual([]);
    expect(eventsOfType(mineSink.events, "trapFired")).toEqual([]);
    expect(cardAt(state, slot("p1", "backrow", 1))?.id).toBe(trap.id);
    expect(trap.faceUp).not.toBe(true);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH);

    // The same event from the other side satisfies the predicate, so the trap fires and is spent.
    const theirsSink = sinkFor(state);
    expect(fireTrapsFor(theirsSink, played("p2")).fired).toEqual([trap.id]);
    expect(eventsOfType(theirsSink.events, "trapFired").map((event) => event.instanceId)).toEqual([trap.id]);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 1);
    expect(cardAt(state, slot("p1", "backrow", 1))).toBeNull();
    expect(state.players.p1.graveyard.map((card) => card.id)).toEqual([trap.id]);

    // With the predicate satisfied, an empty effect list still spends the trap (R61).
    const empty = game("r99-empty");
    const spent = put(empty, emptyTrap.id, slot("p1", "backrow", 2));
    const emptySink = sinkFor(empty);
    expect(fireTrapsFor(emptySink, played("p2")).fired).toEqual([spent.id]);
    expect(eventsOfType(emptySink.events, "trapFired").map((event) => event.instanceId)).toEqual([spent.id]);
    expect(cardAt(empty, slot("p1", "backrow", 2))).toBeNull();
    expect(empty.players.p1.graveyard.map((card) => card.id)).toEqual([spent.id]);

    // A trap that declares no predicate answers every event it names, whichever side caused it.
    const bare = game("r99-bare");
    const unconditional = put(bare, bareTrap.id, slot("p1", "backrow", 3));
    expect(fireTrapsFor(sinkFor(bare), played("p1")).fired).toEqual([unconditional.id]);
    expect(bare.players.p2.hero.health).toBe(HERO_HEALTH - 2);
  });

  it("R100 gives the end-of-turn window its own events, so a `turnEnded` trap fires once per turn end", () => {
    const state = game("r100-window");
    const trap = put(state, windowTrap.id, slot("p1", "backrow", 1));
    const turnEnded: GameEvent = { type: "turnEnded", player: "p1", turn: state.turn, unspentMana: 0 };

    expect(isTrapWindowEvent(turnEnded)).toBe(true);
    // The trap is watching, so this is the withholding and not a failure to match.
    expect(trapsWatching(state, turnEnded).map((match) => match.trap.id)).toEqual([trap.id]);

    // The immediate check declines the event: it belongs to the scheduled window.
    const immediate = sinkFor(state);
    expect(fireTrapsFor(immediate, turnEnded)).toEqual({ fired: [], paused: false });
    expect(immediate.events).toEqual([]);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH);

    // The window delivers it, once.
    const window = sinkFor(state);
    expect(runTrapWindow(window, turnEnded).fired).toEqual([trap.id]);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 1);

    // It is a Field Trap, so it is still armed; offering the same event to the immediate check
    // again still fires nothing, which is what "once per turn end rather than twice" means.
    expect(cardAt(state, slot("p1", "backrow", 1))?.id).toBe(trap.id);
    expect(fireTrapsFor(sinkFor(state), turnEnded).fired).toEqual([]);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 1);

    // Every other event still goes to the immediate check, so this is not a blanket withholding.
    const other = game("r100-immediate");
    const bare = put(other, bareTrap.id, slot("p1", "backrow", 1));
    expect(isTrapWindowEvent(played("p2"))).toBe(false);
    expect(fireTrapsFor(sinkFor(other), played("p2")).fired).toEqual([bare.id]);
  });

  // ---------------------------------------------------------------------------
  // R101: paying a Tribute (§6.3, §3.2).
  // ---------------------------------------------------------------------------

  it("R101 pays a Tribute with a minimal set, counts a Sheep Token 2, and refuses the play when the board cannot pay", () => {
    const state = game("r101-tribute");
    const card = must(inHand(state, tributeTwo.id, "p1")[0], "a Tribute 2 card in hand");
    expect(tributeCostOf(card)).toBe(2);

    const play = (tributes: string[]): string | null =>
      whyChoicesRefused(state, "p1", card, {
        type: "play",
        instanceId: card.id,
        zone: { row: "units", lane: 3 },
        tributes,
      });

    // An unpayable Tribute makes the play illegal rather than fizzling on resolution (#66), and the
    // message names the card and the number: "<name> needs Tribute N".
    expect(play([])).toBe(`${defOf(state, card.defId).name} needs Tribute 2`);
    const one = put(state, body.id, slot("p1", "units", 1));
    expect(play([one.id])).toBe(`${defOf(state, card.defId).name} needs Tribute 2`);

    // Two ordinary bodies pay it exactly.
    const two = put(state, body.id, slot("p1", "units", 2));
    expect(play([one.id, two.id])).toBeNull();

    // Minimal: no unit could be dropped from the set and it still pay. A third body could be, so
    // the set of three is refused even though it pays.
    const three = put(state, body.id, slot("p1", "units", 4));
    expect(play([one.id, two.id, three.id])).toMatch(/tributes 2, no more/);

    // The Sheep Token counts 2, which is what makes overshooting unavoidable: it pays Tribute 2 on
    // its own, and is minimal doing it, while pairing it with a body is not.
    const woolly = put(state, sheep.id, slot("p1", "units", 5));
    expect(tributeValueOf(state, woolly)).toBe(2);
    expect(tributeValueOf(state, one)).toBe(1);
    expect(play([woolly.id])).toBeNull();
    expect(play([woolly.id, one.id])).toMatch(/tributes 2, no more/);

    // The enumeration says the same: the Sheep alone, or two bodies, and never three of anything.
    const sets = legalTributeSets(state, "p1", card);
    expect(sets).toContainEqual([woolly.id]);
    expect(sets).toContainEqual([one.id, two.id]);
    expect(sets.every((set) => set.length <= 2)).toBe(true);
    expect(sets).not.toContainEqual([one.id, two.id, three.id]);
  });

  it("R101 lets only a card that says so tribute the opponent's units", () => {
    const state = game("r101-enemies");
    // Two of p1's own, so its board can pay Tribute 2 on its own and the refusal below is about
    // *whose* units were named rather than about a board that cannot pay at all.
    const mine = [put(state, body.id, slot("p1", "units", 1)), put(state, body.id, slot("p1", "units", 2))];
    const theirs = [
      put(state, body.id, slot("p2", "units", 1)),
      put(state, body.id, slot("p2", "units", 2)),
      put(state, sheep.id, slot("p2", "units", 3)),
    ];

    // An ordinary Tribute reaches only its controller's units.
    const ordinary = must(inHand(state, tributeTwo.id, "p1")[0], "a Tribute 2 card");
    expect(mayTributeEnemyUnits(ordinary)).toBe(false);
    expect(legalTributeUnits(state, "p1", ordinary).map((unit) => unit.id)).toEqual(
      mine.map((unit) => unit.id),
    );
    expect(
      whyChoicesRefused(state, "p1", ordinary, {
        type: "play",
        instanceId: ordinary.id,
        zone: { row: "units", lane: 3 },
        tributes: [must(mine[0], "an own unit").id, must(theirs[0], "an enemy unit").id],
      }),
    ).toMatch(/cannot be tributed/);

    // #55 says so, so both sides are fodder — and an enemy Sheep is still worth 2 (§3.2 names no
    // side), which is how three of Tribute 3 can be paid by two enemy units.
    const golem = must(inHand(state, tributeEnemies.id, "p1")[0], "a Tribute 3 card that may take enemies");
    expect(mayTributeEnemyUnits(golem)).toBe(true);
    expect(tributeCostOf(golem)).toBe(3);
    expect(legalTributeUnits(state, "p1", golem).map((unit) => unit.id).sort()).toEqual(
      [...mine.map((unit) => unit.id), ...theirs.map((unit) => unit.id)].sort(),
    );
    const enemySheep = must(theirs[2], "the enemy Sheep");
    expect(tributeValueOf(state, enemySheep)).toBe(2);
    expect(
      whyChoicesRefused(state, "p1", golem, {
        type: "play",
        instanceId: golem.id,
        zone: { row: "units", lane: 3 },
        tributes: [enemySheep.id, must(theirs[0], "an enemy unit").id],
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R102: what a Fuse composes (§6.3, R77).
// ---------------------------------------------------------------------------

describe("SPEC §11 R102–R103: Fuse and the Heroic Power surface (M3 gate)", () => {
  it("R102 caps the fused cost and drops every ingredient's `cost` hook, so the cap wins over a cost-rewriting hook", () => {
    // The cap: two printed costs that sum past it.
    const capped = game("r102-cost-cap");
    const target = put(capped, fusePricey.id, slot("p1", "units", 1)); // cost 4
    const food = must(inHand(capped, fuseDear.id, "p1")[0], "a second ingredient"); // cost 3
    const result = must(fuse(sinkFor(capped), { ingredients: [target, food], target }), "a fusion");
    expect(defOf(capped, result.defId).cost).toBe(FUSE_COST_CAP);

    // The hook: its printed cost is 3 and its hook answers 1, so the fused sum is 1 + 1 = 2. The
    // hook is dropped, so the result reports 2; a surviving hook would still report 1.
    const hooked = game("r102-cost-hook");
    const hookTarget = put(hooked, fuseHooked.id, slot("p1", "units", 1));
    expect(printedCost(hooked, hookTarget)).toBe(1); // the hook, not the printed 3
    const cheap = must(inHand(hooked, fuseCheap.id, "p1")[0], "a 1-cost ingredient");
    const hookResult = must(fuse(sinkFor(hooked), { ingredients: [hookTarget, cheap], target: hookTarget }), "a fusion");

    expect(scriptsFor(hookResult.defId).base.cost).toBeUndefined();
    expect(scriptsFor(hookResult.defId).radiant.cost).toBeUndefined();
    expect(defOf(hooked, hookResult.defId).cost).toBe(2);
    expect(printedCost(hooked, hookResult)).toBe(2);
  });

  it("R102 takes the max of the ingredients' `staticFlags.tribute` rather than the sum", () => {
    const state = game("r102-tribute-max");
    const target = put(state, fuseTributeTwo.id, slot("p1", "units", 1)); // Tribute 2
    const food = must(inHand(state, fuseTributeThree.id, "p1")[0], "a Tribute 3 ingredient");
    expect(tributeCostOf(target)).toBe(2);
    expect(tributeCostOf(food)).toBe(3);

    const result = must(fuse(sinkFor(state), { ingredients: [target, food], target }), "a fusion");
    // The stricter of the two requirements, not a doubled one: 3, never 5.
    expect(scriptsFor(result.defId).base.staticFlags?.tribute).toBe(3);
    expect(tributeCostOf(result)).toBe(3);
  });

  it("R102 namespaces trigger ids by ingredient, so two ingredients that share an id stay two conditions", () => {
    const state = game("r102-trigger-ids");
    const target = put(state, fuseTrapMine.id, slot("p1", "backrow", 1));
    const food = must(inHand(state, fuseTrapTheirs.id, "p1")[0], "a second trap");
    // Both ingredients call their trigger "fire" and both watch `cardPlayed`.
    expect((scriptsFor(fuseTrapMine.id).base.triggers ?? []).map((trigger) => trigger.id)).toEqual(["fire"]);
    expect((scriptsFor(fuseTrapTheirs.id).base.triggers ?? []).map((trigger) => trigger.id)).toEqual(["fire"]);

    const sink = sinkFor(state);
    const result = must(fuse(sink, { ingredients: [target, food], target }), "a fused trap");
    const triggers = scriptsFor(result.defId).base.triggers ?? [];
    expect(triggers.map((trigger) => trigger.id)).toEqual([`${fuseTrapMine.id}:fire`, `${fuseTrapTheirs.id}:fire`]);
    expect(triggers.map((trigger) => trigger.on)).toEqual([["cardPlayed"], ["cardPlayed"]]);
    // Each kept its own R99 predicate, so only the one whose condition was met runs: p2's play
    // satisfies "theirs" (2) and not "mine" (1), so the hero takes 2 rather than 3.
    expect(triggers.every((trigger) => trigger.when !== undefined)).toBe(true);
    fireTrapsFor(sink, played("p2"));
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 2);
  });

  it("R102 resolves a multi-target Fuse's ingredients once and reuses them, since a consumed one cannot be re-found", () => {
    const state = game("r102-multi-target");
    const hostA = put(state, fuseHostA.id, slot("p1", "units", 1)); // 1/1
    const hostB = put(state, fuseHostB.id, slot("p1", "units", 2)); // 2/2
    const shared = put(state, fuseShared.id, slot("p1", "units", 3)); // 7/3, the played permanent
    const sink = sinkFor(state);

    // The first fusion consumes the shared ingredient: 1/1 plus 7/3 is 8/4.
    const first = must(fuse(sink, { ingredients: [hostA, shared], target: hostA }), "the first fusion");
    expect(first.id).toBe(hostA.id);
    expect(defOf(state, first.defId).base).toMatchObject({ attack: 8, health: 4 });

    // The premise of the ruling: it is held by no pile now, so nothing could look it up by id — a
    // second fusion that tried to re-find it would have nothing to fuse.
    expect(shared.zone).toEqual({ z: "gone", player: "p1" });
    expect(findInstance(state, shared.id)).toBeUndefined();
    expect(cardAt(state, slot("p1", "units", 3))).toBeNull();

    // R102: the ingredients were resolved once, so the same resolved instance fuses again — which is
    // what lets radiant #85 fuse one played permanent onto every matching target, one at a time.
    const second = must(fuse(sink, { ingredients: [hostB, shared], target: hostB }), "the second fusion");
    expect(second.id).toBe(hostB.id);
    // 2/2 plus the same 7/3 is 9/5: it contributed its definition a second time.
    expect(defOf(state, second.defId).base).toMatchObject({ attack: 9, health: 5 });
    expect(defOf(state, second.defId).name).toContain("fuse-shared");

    // Two fusions, two transient definitions, and the first host is untouched by the second.
    expect(second.defId).not.toBe(first.defId);
    expect(defOf(state, first.defId).base).toMatchObject({ attack: 8, health: 4 });
  });

  it("R102 makes every consumed ingredient cease to exist: no graveyard, no Death trigger, no destroyed counter", () => {
    const state = game("r102-consumed");
    const target = put(state, fuseTributeTwo.id, slot("p1", "units", 1));
    const eaten = put(state, fuseDying.id, slot("p1", "units", 2)); // a Death hook worth 7 to the hero
    const before = state.counters.destroyed;

    const sink = sinkFor(state);
    const result = must(fuse(sink, { ingredients: [target, eaten], target }), "a fusion");
    settle(sink);

    expect(result.id).toBe(target.id);
    // R86: gone, not moved — no pile holds it and the lane it stood in is empty.
    expect(eaten.zone).toEqual({ z: "gone", player: "p1" });
    expect(cardAt(state, slot("p1", "units", 2))).toBeNull();
    expect(state.players.p1.graveyard.map((card) => card.id)).not.toContain(eaten.id);
    expect(state.players.p1.exile.map((card) => card.id)).not.toContain(eaten.id);
    // No Death trigger, and it does not count as destroyed.
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH);
    expect(state.counters.destroyed).toBe(before);
    expect(eventsOfType(sink.events, "destroyed")).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // R103: the Heroic Power surface (§8 #98, R43).
  // ---------------------------------------------------------------------------

  it("R103 stores the seven power names and costs 0 for a power that has not rolled", () => {
    // §11 R103 writes the seven out, and they are state, so they stay stable across versions.
    expect([...HERO_POWER_NAMES]).toEqual(["recruit", "draw", "ping", "burn", "rush", "felinor", "discover"]);
    expect(HERO_POWERS.map((power) => power.name)).toEqual([...HERO_POWER_NAMES]);
    // A ping reaches any unit or hero on either side.
    const ping = must(HERO_POWERS.find((power) => power.name === "ping"), "the ping power");
    expect(ping.x).toBe(1);

    const state = game("r103-unrolled");
    const card = put(state, heroic.id, slot("p1", "backrow", 1));
    expect(card.memory[POWER_KEY]).toBeUndefined();

    // A Heroic Power that has not yet rolled costs 0, and the printed "X" is answered by the card's
    // own `cost` hook rather than by a special case in the cost rules (R65).
    expect(powerCostOf(card)).toBe(0);
    expect(defOf(state, card.defId).cost).toBe("X");
    expect(printedCost(state, card)).toBe(0);
    expect(whyCannotActivate(state, "p1", card.id)).toBe("that card has no power");

    // Once it has rolled, the same hook answers that power's X.
    card.memory[POWER_KEY] = "recruit";
    expect(powerCostOf(card)).toBe(3);
    expect(printedCost(state, card)).toBe(3);
  });

  it("R103 checks once-per-turn before mana, turn and phase", () => {
    const state = game("r103-order");
    const card = put(state, heroic.id, slot("p1", "backrow", 1));
    card.memory[POWER_KEY] = "recruit"; // X 3

    // Every one of the other three refusals is also true: no mana, not this player's turn, not the
    // main phase. R103 fixes which one the player hears.
    state.players.p1.mana.current = 0;
    state.active = "p2";
    state.phase = "end";
    card.memory[POWER_USED_KEY] = state.turn;
    expect(whyCannotActivate(state, "p1", card.id)).toBe("that power has already been used this turn");

    // With the use cleared the others surface, in the order the function checks them.
    delete card.memory[POWER_USED_KEY];
    expect(whyCannotActivate(state, "p1", card.id)).toBe("it is not your turn");
    state.active = "p1";
    expect(whyCannotActivate(state, "p1", card.id)).toBe("a power is activated in the main phase");
    state.phase = "main";
    expect(whyCannotActivate(state, "p1", card.id)).toBe("that power costs 3, more than your mana");
    state.players.p1.mana.current = 3;
    expect(whyCannotActivate(state, "p1", card.id)).toBeNull();
  });

  it("R103 marks the use before the effects run, and fizzles a token power in silence when the token is absent", () => {
    // A power that pauses on a prompt has already spent the turn's activation.
    const state = game("r103-marked");
    const sink = sinkFor(state);
    const card = put(state, heroic.id, slot("p1", "backrow", 1));
    card.memory[POWER_KEY] = "ping";
    const victim = put(state, body.id, slot("p2", "units", 1));

    const ctx = makeContext(sink, card, { controller: "p1" });
    applyEffects([usePower({ instanceId: card.id })], ctx);
    expect(must(state.pending, "a target prompt").kind).toBe("target");
    expect(usedThisTurn(state, card)).toBe(true);
    expect(whyCannotActivate(state, "p1", card.id)).toBe("that power has already been used this turn");
    expect(victim.damage).toBe(0);

    // A power that summons a token resolves it by catalog index and fizzles in silence when the
    // catalog has no such token (§5.3, §7).
    const missing = game("r103-missing-token");
    registerCatalog(
      Object.fromEntries(
        Object.entries(registeredCatalog()).filter(([, entry]) => entry.index !== RUSH_TOKEN_INDEX),
      ),
    );
    expect(defByIndex(RUSH_TOKEN_INDEX)).toBeUndefined();

    const tokenSink = sinkFor(missing);
    const rusher = put(missing, heroic.id, slot("p1", "backrow", 1));
    rusher.memory[POWER_KEY] = "rush";
    const tokenCtx = makeContext(tokenSink, rusher, { controller: "p1" });
    expect(() => applyEffects([usePower({ instanceId: rusher.id })], tokenCtx)).not.toThrow();

    expect(eventsOfType(tokenSink.events, "summoned")).toEqual([]);
    expect(missing.pending).toBeNull();
    // The use is still spent: it was marked before the effects that found nothing to do.
    expect(usedThisTurn(missing, rusher)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R113: the order paused sequences resume in (§9.3, §10.5, §10.6).
// ---------------------------------------------------------------------------

describe("SPEC §11 R113: the work cursor (M3 gate)", () => {
  function resumeOf(step: string): Resume {
    return { defId: body.id, hook: "rc:sequence", step, radiant: false, data: {} };
  }

  it("R113 parks one cascade's sequences innermost-first, and a pause during a resumption ahead of everything owed", () => {
    const state = game("r113-cursor");
    const sink = sinkFor(state);
    expect(state.work).toEqual([]);
    expect(state.workCursor).toBe(0);

    // One pause cascade, exactly R113's example: a Cry's effect list pauses inside play step 5, so
    // the Cry parks its own tail first and the pipeline then parks steps 6 to 8.
    beginWorkCascade(sink);
    const cryTail = pushWork(sink, resumeOf("cry-tail"));
    const playTail = pushWork(sink, resumeOf("play-steps-6-8"));

    // "The sequences parked by one pause land innermost-first": step 6 comes after step 5, not
    // inside it, so the Cry's tail is owed first. A stack would have buried it.
    expect(state.work.map((item) => item.resume.step)).toEqual(["cry-tail", "play-steps-6-8"]);
    expect(state.workCursor).toBe(2);
    expect(cryTail.seq).toBeLessThan(playTail.seq);

    // "Taking an item resets the cursor to 0, so a pause that happens during a resumption is
    // inserted ahead of everything still owed": the Cry's tail resumes and opens a second prompt.
    expect(takeWork(state)?.id).toBe(cryTail.id);
    expect(state.workCursor).toBe(0);
    const innerTail = pushWork(sink, resumeOf("cry-tail-after-second-prompt"));

    // Still inside step 5, so it precedes the play steps. A plain queue would run step 6 too early.
    expect(state.work.map((item) => item.resume.step)).toEqual([
      "cry-tail-after-second-prompt",
      "play-steps-6-8",
    ]);
    expect(takeWork(state)?.id).toBe(innerTail.id);
    expect(takeWork(state)?.id).toBe(playTail.id);
    expect(takeWork(state)).toBeUndefined();
  });

  it("R113 raises rather than drop a work item nothing knows how to resume", () => {
    const state = game("r113-raise");
    const sink = sinkFor(state);
    // No engine sequence registered this hook and `body`'s script has no step by that name, so
    // nothing can resume it: a lost sequence must never be dropped in silence.
    const orphan = pushWork(sink, { ...resumeOf("never-registered"), hook: "rc:no-such-sequence" });

    expect(() => runWorkItem(sink, orphan)).toThrow(/R113/);
    expect(() => runWorkItem(sink, orphan)).toThrow(/rc:no-such-sequence/);
    // It is still owed rather than quietly gone.
    expect(state.work.map((item) => item.id)).toEqual([orphan.id]);
  });
});

// ---------------------------------------------------------------------------
// R114: Trample into a unit with no health left (§4.4 steps 5 to 9, R63).
// ---------------------------------------------------------------------------

describe("SPEC §11 R114–R116: the damage pipeline and the stat layers (M3 gate)", () => {
  it("R114 deals nothing to a unit already at 0 health and sends the whole Trample amount to its hero", () => {
    const state = game("r114-zero-health");
    const source = put(state, trampler.id, slot("p1", "units", 1)); // 5/5 Trample, Lifesteal, Poisonous
    const victim = put(state, frail.id, slot("p2", "units", 1)); // 1/3

    // The fixture really does carry all three keywords, or the three negatives below are decoration.
    expect(unitHas(state, source, "Trample")).toBe(true);
    expect(unitHas(state, source, "Lifesteal")).toBe(true);
    expect(unitHas(state, source, "Poisonous")).toBe(true);

    // The control: the same source into a *healthy* unit deals, marks and heals. Without this the
    // negatives below could pass on an inert fixture.
    const control = game("r114-control");
    const controlSource = put(control, trampler.id, slot("p1", "units", 1));
    const controlVictim = put(control, frail.id, slot("p2", "units", 1));
    control.players.p1.hero.health -= 20; // room for the Lifesteal to show
    const controlEvents: GameEvent[] = [];
    const controlBefore = control.players.p1.hero.health;
    expect(
      dealDamage({ state: control, events: controlEvents }, { source: controlSource, target: { kind: "unit", instance: controlVictim }, amount: 5 }),
    ).toBe(3);
    expect(hits(controlEvents)).toEqual([
      { from: controlSource.id, to: controlVictim.id, amount: 3 },
      { from: controlSource.id, to: "hero-p2", amount: 2 },
    ]);
    expect(controlVictim.markedDestroyed).toBe(true);
    expect(controlVictim.lastDamagedBy).toBe(controlSource.id);
    // 3 off the unit plus 2 off the hero: the total healed is 5.
    expect(control.players.p1.hero.health - controlBefore).toBe(5);

    // Now the ruling. One earlier instance takes the victim to exactly 0 health and the state check
    // has not collected it yet (R59: no state check between the hits of one effect), so it is at 0
    // and still on the field — which is the whole premise of the row.
    dealDamage({ state, events: [] }, { source: null, target: { kind: "unit", instance: victim }, amount: 3 });
    expect(victim.damage).toBe(3);
    expect(unitView(state, victim).health).toBe(0);
    expect(cardAt(state, slot("p2", "units", 1))?.id).toBe(victim.id);
    expect(victim.markedDestroyed).not.toBe(true);
    expect(victim.lastDamagedBy).toBeUndefined();

    state.players.p1.hero.health -= 20; // room for the Lifesteal to show
    const before = state.players.p1.hero.health;
    const events: GameEvent[] = [];
    const dealt = dealDamage({ state, events }, { source, target: { kind: "unit", instance: victim }, amount: 5 });

    // Nothing to the unit: no damage dealt, no `damage` event naming it, no `lastDamagedBy` for an
    // on-damage trigger to read, and no Poisonous mark.
    expect(dealt).toBe(0);
    expect(victim.damage).toBe(3);
    expect(victim.lastDamagedBy).toBeUndefined();
    expect(victim.markedDestroyed).not.toBe(true);
    expect(events.filter((event) => JSON.stringify(event).includes(victim.id))).toEqual([]);

    // The whole amount becomes the step 9 instance on the victim's controller's hero.
    expect(hits(events)).toEqual([{ from: source.id, to: "hero-p2", amount: 5 }]);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 5);

    // Lifesteal heals it once, off the hero instance only, so the total healed is unchanged: 5 here
    // and 5 in the control above.
    expect(eventsOfType(events, "healed").map((event) => ({ to: event.targetId, amount: event.amount }))).toEqual([
      { to: "hero-p1", amount: 5 },
    ]);
    expect(state.players.p1.hero.health - before).toBe(5);
  });

  // ---------------------------------------------------------------------------
  // R115, R116: Vanilla's reach into the layers, and what a set-stat hook returns.
  // ---------------------------------------------------------------------------

  it("R115 stops a Vanilla'd permanent projecting its aura and setting its own stats, while it still receives other cards' auras", () => {
    const state = game("r115-vanilla");
    const source = put(state, projector.id, slot("p1", "units", 1)); // aura +2/+2 to allies, sets +5/+5
    const ally = put(state, measured.id, slot("p1", "units", 2)); // 3/4

    // Live: the aura reaches the ally and layer 2 sets the projector's own stats.
    expect(unitView(state, ally).attack).toBe(3 + 2);
    expect(unitView(state, ally).maxHealth).toBe(4 + 2);
    expect(unitView(state, source).attack).toBe(2 + PROJECTOR_SETS);
    expect(unitView(state, source).maxHealth).toBe(2 + PROJECTOR_SETS);

    // Vanilla clears its scripts, and an aura and a set-stat hook are both scripts (§6.3, §10.9).
    source.vanilla = true;

    // It stops projecting at layer 5.
    expect(unitView(state, ally).attack).toBe(3);
    expect(unitView(state, ally).maxHealth).toBe(4);
    // And stops setting at layer 2, keeping its printed face.
    expect(unitView(state, source).attack).toBe(2);
    expect(unitView(state, source).maxHealth).toBe(2);

    // But it still *receives*: another card's aura is that card's text, not this one's.
    const giver = put(state, projector.id, slot("p2", "units", 1));
    expect(unitView(state, giver).attack).toBe(2 + PROJECTOR_SETS); // the second card is not Vanilla'd
    source.controller = "p2"; // bring the Vanilla'd body inside the giver's "your units" clause
    expect(unitView(state, source).attack).toBe(2 + 2);
    expect(unitView(state, source).maxHealth).toBe(2 + 2);
    // Its own hook is still silent, so the +2 is the aura's and not a revived layer 2.
    expect(unitView(state, source).attack).not.toBe(2 + PROJECTOR_SETS);
  });

  it("R116 adds a set-stat hook's return to the printed face as a delta, floored at 0, and never lets two of them read each other", () => {
    const state = game("r116-delta");
    const one = put(state, setter.id, slot("p1", "units", 1)); // printed 2/6
    expect(unitView(state, one).attack).toBe(2); // nothing to measure yet
    expect(unitView(state, one).maxHealth).toBe(6);

    // A delta: the hook returns the other card's layer-4 attack, which is *added* to 2/6. A total
    // would have read 4/4, so the two readings are distinguishable.
    const two = put(state, otherSetter.id, slot("p1", "units", 2)); // printed 4/8
    expect(statsWithBuffs(state, two).attack).toBe(4);
    expect(unitView(state, one).attack).toBe(2 + 4);
    expect(unitView(state, one).maxHealth).toBe(6 + 4);

    // Neither reads the other's layer 2, because `statsWithBuffs` is layers 1 to 4: `two` sees
    // `one`'s printed 2, not the 6 that layer 2 gives it, so the pair cannot recurse or escalate.
    expect(unitView(state, two).attack).toBe(4 + 2);
    expect(unitView(state, two).maxHealth).toBe(8 + 2);

    // Layer 4's buffs land on top of the delta, and the hook sees them on the card it measures.
    two.buffs = { attack: 3, health: 0 };
    expect(statsWithBuffs(state, two).attack).toBe(7);
    expect(unitView(state, one).attack).toBe(2 + 7);

    // Each component is floored at 0 on its own, so a negative return never eats the printed face.
    const floored = game("r116-floor");
    const lone = put(floored, projector.id, slot("p1", "units", 1)); // sets +5/+5
    registerScripts({
      ...registeredScripts(),
      [projector.id]: both({ setStat: () => ({ attack: -99, maxHealth: -99 }) }),
    });
    expect(unitView(floored, lone).attack).toBe(2);
    expect(unitView(floored, lone).maxHealth).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// R117, R118: who owns a paused sequence's steps, and the Cry that survives a trap.
// ---------------------------------------------------------------------------

describe("SPEC §11 R117–R118: pausing the play pipeline (M3 gate)", () => {
  it("R117 owes a play's remaining steps only at the moment it pauses, never in advance", () => {
    // The control first: a play that never pauses owes nothing at all, and its Cry fires once. If
    // the pipeline parked itself in advance this queue would not be empty.
    const clean = playing("r117-no-pause");
    const straight = actResult(clean, {
      type: "play",
      instanceId: must(inHand(clean, crier.id, "p1")[0], "a Cry unit in hand").id,
      playerId: "p1",
      zone: { row: "units", lane: 1 },
    });
    expect(straight.error).toBeUndefined();
    expect(straight.state.work).toEqual([]);
    expect(notes(straight.state)).toEqual(["cry"]);

    // Now a trap prompts partway through the same play. Only now is the remainder owed, and only
    // once: one item for one play, belonging to the player whose pipeline it is.
    const state = playing("r117-pause");
    put(state, askTrap.id, slot("p2", "backrow", 1));
    const paused = actResult(state, {
      type: "play",
      instanceId: must(inHand(state, crier.id, "p1")[0], "a Cry unit in hand").id,
      playerId: "p1",
      zone: { row: "units", lane: 1 },
    });
    expect(paused.error).toBeUndefined();
    expect(paused.state.pending?.playerId).toBe("p2");

    const owed = paused.state.work.filter((item) => item.resume.hook === PLAY_WORK_KIND);
    expect(owed).toHaveLength(1);
    expect(owed.map((item) => item.owner)).toEqual(["p1"]);
    expect(paused.state.work).toHaveLength(1);

    // While the driver was on the stack the steps were the driver's alone: step 4's nested `settle`
    // drains `state.work` before it pops a trigger, and it neither took nor ran the steps it was
    // standing in — so the Cry has not fired yet.
    expect(notes(paused.state)).toEqual([]);

    // The answer runs the trap's continuation and then the owed remainder, once each.
    const answered = act(paused.state, {
      type: "answer",
      choiceId: paused.state.pending?.id ?? "",
      selection: [{ pick: "none" }],
      playerId: "p2",
    });
    expect(notes(answered)).toEqual(["answered", "cry"]);
    expect(notes(answered).filter((step) => step === "cry")).toHaveLength(1);
    expect(answered.work).toEqual([]);
    expect(answered.pending).toBeNull();
  });

  it("R118 lets a trap's prompt interrupt a play without eating its Cry, which still fires exactly once", () => {
    const state = playing("r118-cry-survives");
    put(state, askTrap.id, slot("p2", "backrow", 1));
    const card = must(inHand(state, crier.id, "p1")[0], "a Cry unit in hand");

    const paused = actResult(state, {
      type: "play",
      instanceId: card.id,
      playerId: "p1",
      zone: { row: "units", lane: 1 },
    });
    expect(paused.error).toBeUndefined();
    // The trap holds the play between step 4's `summoned` and step 5's Cry (§10.3, R17).
    expect(paused.state.pending?.playerId).toBe("p2");
    expect(notes(paused.state)).toEqual([]);

    const answered = act(paused.state, {
      type: "answer",
      choiceId: paused.state.pending?.id ?? "",
      selection: [{ pick: "none" }],
      playerId: "p2",
    });
    // The trap resolved to completion first, then the play resumed at the step after the one that
    // paused: the Cry fires, after the trap, exactly once (R1).
    expect(notes(answered)).toEqual(["answered", "cry"]);
    expect(answered.work).toEqual([]);
    // And the card is where the play put it, so nothing about the pause unwound the play.
    expect(cardAt(answered, slot("p1", "units", 1))?.defId).toBe(crier.id);
    expect(actResult(answered, { type: "endTurn", playerId: "p1" }).error).toBeUndefined();

    // R17's "the Cry is lost" is the other case, and only that case: a trap that takes the card off
    // the field leaves nothing to resolve, so the Cry never fires.
    const eaten = playing("r118-cry-lost");
    put(eaten, eatTrap.id, slot("p2", "backrow", 1));
    const doomed = must(inHand(eaten, crier.id, "p1")[0], "a Cry unit in hand");
    const after = actResult(eaten, {
      type: "play",
      instanceId: doomed.id,
      playerId: "p1",
      zone: { row: "units", lane: 1 },
    });
    expect(after.error).toBeUndefined();
    expect(after.state.pending).toBeNull();
    expect(notes(after.state)).toEqual(["eaten"]);
    expect(cardAt(after.state, slot("p1", "units", 1))).toBeNull();
    expect(after.state.work).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R122, R123: who finishes an interrupted sequence, and how a Tribute travels.
// ---------------------------------------------------------------------------

describe("SPEC §11 R122–R123: answering a prompt, and a declared Tribute (M3 gate)", () => {
  it("R122 has the answering action finish what the prompt interrupted, even driven without the reducer", () => {
    const state = playing("r122-answer-drains");
    put(state, askOnPlay.id, slot("p2", "backrow", 1));
    const spell = must(inHand(state, spellCrier.id, "p1")[0], "a Spell in hand");

    // p1 plays a Spell; p2's trap answers the `cardPlayed` and prompts, so the play stops between
    // step 4 and step 5 with its remainder owed (R117).
    const paused = actResult(state, { type: "play", instanceId: spell.id, playerId: "p1" });
    expect(paused.error).toBeUndefined();
    const held = paused.state;
    expect(held.pending?.playerId).toBe("p2");
    expect(notes(held)).toEqual([]);
    // The premise of the row: there is something owed, and the Spell is mid-resolution.
    expect(held.work.length).toBeGreaterThan(0);
    expect(held.players.p1.resolving.map((card) => card.id)).toEqual([spell.id]);
    expect(held.players.p1.graveyard.map((card) => card.id)).not.toContain(spell.id);

    // Answer it through `answerPrompt` directly rather than through `reduce`: R122 puts the drain in
    // the answering action itself, so a caller driving the engine does not lose the remainder.
    const sink = sinkFor(held);
    expect(
      answerPrompt(sink, {
        playerId: "p2",
        choiceId: held.pending?.id ?? "",
        selection: [{ pick: "none" }],
      }),
    ).toBeNull();

    // The trap's continuation ran, then the owed play steps, in R113's order — so the Cry fired and
    // the Spell reached its graveyard rather than stopping short of it.
    expect(notes(held)).toEqual(["answered", "spell"]);
    expect(held.pending).toBeNull();
    expect(held.work).toEqual([]);
    expect(held.players.p1.resolving).toEqual([]);
    expect(held.players.p1.graveyard.map((card) => card.id)).toContain(spell.id);
  });

  it("R123 carries a declared Tribute's picks in targets and its amount as the play's Tribute cost", () => {
    const state = game("r123-tribute-travels");
    const card = must(inHand(state, cube.id, "p1")[0], "a card with a tribute declaration");

    // The `amount` on the declaration is the Tribute cost, not a `staticFlags.tribute`.
    expect(scriptsFor(cube.id).base.staticFlags?.tribute).toBeUndefined();
    expect(declaredTargets(card).map((decl) => ({ kind: decl.kind, amount: decl.amount }))).toEqual([
      { kind: "tribute", amount: 2 },
    ]);
    expect(tributeCostOf(card)).toBe(2);

    // An unpayable board refuses the play outright rather than fizzling on resolution (R101).
    const play = (action: Partial<PlayAction>): string | null =>
      whyChoicesRefused(state, "p1", card, {
        type: "play",
        instanceId: card.id,
        zone: { row: "units", lane: 5 },
        ...action,
      } as PlayAction);
    expect(play({})).toBe(`${defOf(state, card.defId).name} needs Tribute 2`);

    const one = put(state, body.id, slot("p1", "units", 1));
    const two = put(state, body.id, slot("p1", "units", 2));

    // Both halves travel: the units in `tributes` as the cost, and the pick in `targets` as the
    // declared choice the script reads.
    expect(play({ tributes: [one.id, two.id], targets: [{ pick: "instance", instanceId: one.id }] })).toBeNull();
    // The cost half alone is not the declaration: the pick is still required (R90).
    expect(play({ tributes: [one.id, two.id] })).not.toBeNull();
    // And the pick alone does not pay the cost.
    expect(play({ targets: [{ pick: "instance", instanceId: one.id }] })).toBe(
      `${defOf(state, card.defId).name} needs Tribute 2`,
    );

    // `legalActions` enumerates them that way: every offered play carries both lists.
    const offered = playActionsFor(state, "p1", card);
    expect(offered.length).toBeGreaterThan(0);
    for (const action of offered) {
      expect(action.tributes ?? []).not.toEqual([]);
      expect(action.targets ?? []).not.toEqual([]);
    }
    // The declared pick is offered over the same permanents the cost may take (§6.3's "your units").
    expect(
      new Set(offered.flatMap((action) => (action.targets ?? []).map((pick) => JSON.stringify(pick)))),
    ).toEqual(
      new Set([one, two].map((unit) => JSON.stringify({ pick: "instance", instanceId: unit.id }))),
    );

    // A Sheep Token counts 2 (§3.2), so one Sheep pays the cost while the pick stays a single unit.
    const woolly = put(state, sheep.id, slot("p1", "units", 3));
    expect(tributeValueOf(state, woolly)).toBe(2);
    expect(legalTributeSets(state, "p1", card)).toContainEqual([woolly.id]);
    expect(play({ tributes: [woolly.id], targets: [{ pick: "instance", instanceId: woolly.id }] })).toBeNull();

    // And the script reads its permanent out of `ctx.targets[0]`, which is what #22 does.
    const running = game("r123-script-reads");
    put(running, logCard.id, slot("p1", "backrow", NOTE_LANE));
    const eater = put(running, cube.id, slot("p1", "units", 1));
    const eaten = put(running, body.id, slot("p1", "units", 2));
    const sink = sinkFor(running);
    const ctx = makeContext(sink, eater, {
      controller: "p1",
      targets: [{ pick: "instance", instanceId: eaten.id }],
    });
    applyEffects(scriptsFor(cube.id).base.cry?.(ctx) ?? [], ctx);
    expect(notes(running)).toEqual([`ate:${eaten.id}`]);
  });
});

// ---------------------------------------------------------------------------
// R124, R125: hero Armor from several sources, and Armor against fatigue.
// ---------------------------------------------------------------------------

describe("SPEC §11 R124–R125: hero Armor (M3 gate)", () => {
  /** One hit on p2's hero, and what it actually dealt. */
  function hitHero(state: GameState, amount: number): { dealt: number; events: GameEvent[] } {
    const events: GameEvent[] = [];
    const dealt = dealDamage({ state, events }, { source: null, target: { kind: "hero", player: "p2" }, amount });
    return { dealt, events };
  }

  it("R124 adds hero Armor up across its sources, where the Anti-oneshot cap instead takes the smallest", () => {
    const state = game("r124-armor-adds");
    const hero = state.players.p2.hero;

    // Bare: step 2 has nothing to subtract, so the whole hit lands.
    expect(hero.armor).toBe(0);
    expect(hitHero(state, 6).dealt).toBe(6);

    // One Going Long paid 2.
    hero.armor = 2;
    expect(hitHero(state, 6).dealt).toBe(4);

    // A second granting card contributes like any other layer: two Going Longs paid 2 give Armor 4,
    // not 2 — so the reduction is the sum and never the largest single source.
    hero.armor = 4;
    expect(hitHero(state, 6).dealt).toBe(2);
    // Plus any Armor written on the hero itself, on top of both.
    hero.armor = 4 + 1;
    expect(hitHero(state, 6).dealt).toBe(1);
    // And enough of it zeroes the hit, which R63 makes no damage instance at all.
    hero.armor = 6;
    const stopped = hitHero(state, 6);
    expect(stopped.dealt).toBe(0);
    expect(stopped.events).toEqual([]);

    // The opposite case, in the same pipeline: step 3's Anti-oneshot cap is a *ceiling*, so two of
    // those cards give the smallest cap either provides, never their sum.
    const capped = game("r124-cap-mins");
    capped.players.p2.hero.armor = 0;
    put(capped, guard.id, slot("p2", "backrow", 1)); // base: cap 5
    expect(heroDamageCap(capped, "p2")).toBe(ANTI_ONESHOT_CAP.base);
    put(capped, guard.id, slot("p2", "backrow", 2), { radiant: true }); // radiant: cap 3
    expect(heroDamageCap(capped, "p2")).toBe(ANTI_ONESHOT_CAP.radiant);
    expect(ANTI_ONESHOT_CAP.radiant).toBeLessThan(ANTI_ONESHOT_CAP.base);
    // Two cards, and a 10 is clamped to the smaller of the two — not to 8, and not to 5.
    expect(hitHero(capped, 10).dealt).toBe(ANTI_ONESHOT_CAP.radiant);
  });

  it("R125 sends fatigue through the whole damage pipeline, so Armor absorbs the early draws", () => {
    // The control first: with no Armor, the Nth empty draw takes the full N (§2.4, R3). Without this
    // the assertions below could pass on a fatigue that never fired.
    const bare = game("r125-no-armor");
    bare.players.p1.library = [];
    const bareSink = sinkFor(bare);
    for (const n of [1, 2, 3, 4]) {
      const before = bare.players.p1.hero.health;
      expect(drawOne(bareSink, "p1")).toBe("fatigue");
      expect(before - bare.players.p1.hero.health).toBe(n);
    }
    expect(bare.players.p1.fatigueCount).toBe(4);

    // Now behind Going Long's Armor 3. Fatigue is an ordinary damage instance on its own hero, so
    // step 2 applies: draws 1 to 3 are absorbed entirely and emit no damage event (R63's zero rule).
    const armoured = game("r125-armour");
    armoured.players.p1.library = [];
    armoured.players.p1.hero.armor = 3;
    const sink = sinkFor(armoured);
    const full = HERO_HEALTH;

    for (const n of [1, 2, 3]) {
      expect(drawOne(sink, "p1")).toBe("fatigue");
      expect(armoured.players.p1.fatigueCount).toBe(n);
      expect(armoured.players.p1.hero.health).toBe(full);
    }
    expect(eventsOfType(sink.events, "damage")).toEqual([]);

    // The escalating Nth-draw damage is what eventually beats the Armor: the 4th draw is 4, so 1
    // gets through, and the 5th lets 2 through.
    expect(drawOne(sink, "p1")).toBe("fatigue");
    expect(armoured.players.p1.hero.health).toBe(full - 1);
    expect(drawOne(sink, "p1")).toBe("fatigue");
    expect(armoured.players.p1.hero.health).toBe(full - 1 - 2);
    expect(hits(sink.events)).toEqual([
      { from: "", to: "hero-p1", amount: 1 },
      { from: "", to: "hero-p1", amount: 2 },
    ]);

    // Step 3's cap rides along too, since it is the same pipeline: a fatigue above the cap is
    // clamped to it.
    const capped = game("r125-capped");
    capped.players.p1.library = [];
    put(capped, guard.id, slot("p1", "backrow", 1), { radiant: true }); // cap 3
    const cappedSink = sinkFor(capped);
    capped.players.p1.fatigueCount = 8; // the next empty draw is the 9th
    const beforeCap = capped.players.p1.hero.health;
    expect(drawOne(cappedSink, "p1")).toBe("fatigue");
    expect(FATIGUE_DAMAGE(9)).toBe(9);
    expect(beforeCap - capped.players.p1.hero.health).toBe(ANTI_ONESHOT_CAP.radiant);

    // Only "lose health" escapes the pipeline (R18), which is what makes the contrast above a rule
    // about fatigue rather than about heroes.
    const losing = game("r125-lose-health");
    losing.players.p1.hero.armor = 3;
    const losingSink = sinkFor(losing);
    expect(loseHealth(losingSink, "p1", 2)).toBe(2);
    expect(losing.players.p1.hero.health).toBe(HERO_HEALTH - 2);
    expect(eventsOfType(losingSink.events, "damage")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R126, R127: how a delayed continuation is re-entered (§10.6, R113).
// ---------------------------------------------------------------------------

describe("SPEC §11 R126–R127: delayed continuations (M3 gate)", () => {
  /** A game with the note log in place and a delayed effect due at p1's next turn start. */
  function scheduled(seed: string, resume: Resume): { state: GameState; sink: EngineSink } {
    const state = game(seed);
    put(state, logCard.id, slot("p1", "backrow", NOTE_LANE));
    const sink = sinkFor(state);
    scheduleDelayed(sink, "p1", { phase: "start", player: "p1" }, resume);
    return { state, sink };
  }

  it("R126 re-enters a delayed continuation under the `delayed` hook", () => {
    const card = { defId: delayedHookCard.id, hook: DELAYED_HOOK, step: "", radiant: false, data: {} };
    const { state, sink } = scheduled("r126-hook", card);
    const holder = put(state, delayedHookCard.id, slot("p1", "units", 1));
    sink.state.delayed[0] = { ...must(sink.state.delayed[0], "the delay"), resume: { ...card, instanceId: holder.id } };

    startTurn(sink, "p1");
    expect(notes(state)).toEqual(["delayed:hook"]);
    expect(state.delayed).toEqual([]);
  });

  it("R126 re-enters a delayed continuation that lives in the card's `resume` step table", () => {
    // Same continuation, spelled the other way §10.6 allows: `resume.hook` names the step table and
    // `resume.step` picks the entry. One reader must resolve both shapes, so this must run too — and
    // a card must never have to register its continuation under two keys to be re-entered.
    const card = { defId: delayedStepCard.id, hook: RESUME_HOOK, step: "later", radiant: false, data: {} };
    const { state, sink } = scheduled("r126-step", card);
    const holder = put(state, delayedStepCard.id, slot("p1", "units", 1));
    sink.state.delayed[0] = { ...must(sink.state.delayed[0], "the delay"), resume: { ...card, instanceId: holder.id } };

    // The step table really is where the continuation lives, so this is not a missing fixture.
    expect(typeof scriptsFor(delayedStepCard.id).base.resume?.later).toBe("function");

    expect(() => startTurn(sink, "p1")).not.toThrow();
    expect(notes(state)).toEqual(["delayed:step"]);
  });

  it("R127 resolves a delayed continuation whose instance is gone, with ctx.self null and its data", () => {
    // #50 Kpop Fanatic's ordinary case (R76): the card that scheduled the delay has left play. The
    // continuation names its script by stored def id, so it still re-enters — dropping it would
    // silently lose a sequence, which R113 forbids.
    const resume: Resume = {
      defId: ghostCard.id,
      hook: RESUME_HOOK,
      step: "orphan",
      radiant: false,
      data: { carried: "payload" },
    };
    const { state, sink } = scheduled("r127-no-instance", resume);
    expect(state.delayed).toHaveLength(1);
    expect(state.delayed[0]?.resume.instanceId).toBeUndefined();

    expect(() => startTurn(sink, "p1")).not.toThrow();
    expect(notes(state)).toEqual(["orphan:no-self:payload"]);

    // The same continuation is resolved this way on the work path, which is the shape R127 asks the
    // delayed path to match (§9.3's resumable-work queue).
    const other = game("r127-work-path");
    put(other, logCard.id, slot("p1", "backrow", NOTE_LANE));
    const workSink = sinkFor(other);
    expect(runResume(workSink, resume, { controller: "p1" })).toBe(true);
    expect(notes(other)).toEqual(["orphan:no-self:payload"]);
  });

  it("R127 resolves a delayed continuation whose instance has since ceased to exist", () => {
    const state = game("r127-instance-gone");
    put(state, logCard.id, slot("p1", "backrow", NOTE_LANE));
    const sink = sinkFor(state);
    const scheduler = put(state, ghostCard.id, slot("p1", "backrow", 1));
    scheduleDelayed(sink, "p1", { phase: "start", player: "p1" }, {
      defId: ghostCard.id,
      hook: RESUME_HOOK,
      step: "orphan",
      radiant: false,
      instanceId: scheduler.id,
      data: { carried: "payload" },
    });

    // It ceases to exist before the delay comes due, which is the premise of the row.
    removeFromAnyZone(state, scheduler);
    scheduler.zone = { z: "gone", player: "p1" };
    expect(findInstance(state, scheduler.id)).toBeUndefined();

    expect(() => startTurn(sink, "p1")).not.toThrow();
    expect(notes(state)).toEqual(["orphan:no-self:payload"]);
    expect(state.delayed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R128, R129, R130: sweeps, fizzles and Lucky (§4.4, §10.7).
// ---------------------------------------------------------------------------

describe("SPEC §11 R128–R130: sweeps, fizzles and Lucky (M3 gate)", () => {
  it("R128 resolves a two-sided sweep as units in R68 order, then one instance per scoped hero in that order", () => {
    const state = game("r128-sweep");
    const mine = [put(state, body.id, slot("p1", "units", 1)), put(state, body.id, slot("p1", "units", 3))];
    const theirs = [put(state, body.id, slot("p2", "units", 2)), put(state, body.id, slot("p2", "units", 4))];

    const sink = sinkFor(state);
    const ctx = makeContext(sink, null, { controller: "p1" });
    applyEffects([damageAll({ amount: 2, heroes: true, side: "any" })], ctx);

    // p1 is active: its units in lane order, then p2's, then the two heroes in the same side order.
    expect(hits(sink.events).map((hit) => hit.to)).toEqual([
      ...mine.map((unit) => unit.id),
      ...theirs.map((unit) => unit.id),
      "hero-p1",
      "hero-p2",
    ]);

    // Not a hardcoded p1-first: with p2 active the whole order reverses (R68).
    const flipped = game("r128-sweep-flipped");
    flipped.active = "p2";
    const flippedMine = [put(flipped, body.id, slot("p1", "units", 1))];
    const flippedTheirs = [put(flipped, body.id, slot("p2", "units", 2))];
    const flippedSink = sinkFor(flipped);
    applyEffects(
      [damageAll({ amount: 2, heroes: true, side: "any" })],
      makeContext(flippedSink, null, { controller: "p1" }),
    );
    expect(hits(flippedSink.events).map((hit) => hit.to)).toEqual([
      ...flippedTheirs.map((unit) => unit.id),
      ...flippedMine.map((unit) => unit.id),
      "hero-p2",
      "hero-p1",
    ]);

    // The target list is fixed when the effect begins: a unit the sweep has already taken to 0 or
    // less health still gets its own instance, and the units after it are still reached, because the
    // state check waits for the whole effect (R59).
    const lethal = game("r128-sweep-lethal");
    const doomed = put(lethal, frail.id, slot("p1", "units", 1)); // 1/3
    const after = put(lethal, body.id, slot("p1", "units", 2));
    const lethalSink = sinkFor(lethal);
    applyEffects([damageAll({ amount: 5, side: "self" })], makeContext(lethalSink, null, { controller: "p1" }));
    expect(hits(lethalSink.events).map((hit) => hit.to)).toEqual([doomed.id, after.id]);
    expect(unitView(lethal, doomed).health).toBeLessThanOrEqual(0);
    expect(cardAt(lethal, slot("p1", "units", 1))?.id).toBe(doomed.id); // still there: no state check yet
  });

  it("R129 has a fizzling effect draw no randomness, which is why a whole-hand discard is its own verb", () => {
    // The hazard, made concrete: a random discard repeated by hand size moves the cursor once per
    // card, so `rngCursor` would depend on the board at that moment (§10.7).
    const random = game("r129-random-discard");
    inHand(random, body.id, "p1", 5);
    const randomSink = sinkFor(random);
    const startedAt = randomSink.rng.cursor;
    applyEffects([discardRandom({ count: 5 })], makeContext(randomSink, null, { controller: "p1" }));
    expect(random.players.p1.hand).toEqual([]);
    expect(randomSink.rng.cursor - startedAt).toBe(5);

    // R129: the whole-hand verb reaches the same end state and draws nothing at all.
    const whole = game("r129-discard-hand");
    inHand(whole, body.id, "p1", 5);
    const wholeSink = sinkFor(whole);
    const before = wholeSink.rng.cursor;
    applyEffects([discardHand()], makeContext(wholeSink, null, { controller: "p1" }));
    expect(whole.players.p1.hand).toEqual([]);
    expect(whole.players.p1.graveyard).toHaveLength(5);
    expect(wholeSink.rng.cursor - before).toBe(0);

    // And an effect that finds nothing to do takes no draw either, so the cursor does not depend on
    // whether the hand happened to be empty.
    const empty = game("r129-fizzle");
    const emptySink = sinkFor(empty);
    const emptyBefore = emptySink.rng.cursor;
    applyEffects([discardRandom({ count: 3 })], makeContext(emptySink, null, { controller: "p1" }));
    expect(emptySink.rng.cursor - emptyBefore).toBe(0);
  });

  it("R130 leaves a roll with no better outcome alone, so Lucky costs it no draw", () => {
    // The hazard, made concrete: applying Lucky where "better" cannot distinguish the outcomes still
    // burns the extra draws, which moves `rngCursor` and desynchronises a replay (R129).
    const one = createRng("r130");
    one.coin();
    const luckyRng = createRng("r130");
    luckyRng.lucky(1, () => luckyRng.coin(), (a) => a); // an identity comparator: no better outcome
    expect(luckyRng.cursor).toBe(one.cursor + 1);

    // R130 and R32: a coin-stat effect pays out on both faces, so it has no better outcome and Lucky
    // does nothing to it — the effect takes exactly one draw per coin, and the cursor lands where a
    // game with no Lucky anywhere would leave it.
    const state = game("r130-coins");
    const target = put(state, body.id, slot("p1", "units", 1));
    const sink = sinkFor(state);
    const before = sink.rng.cursor;
    applyEffects(
      [
        flipCoins({
          target: { of: "instance", instanceId: target.id },
          coins: 5,
          perHeads: { attack: 1 },
          perTails: { health: 1 },
        }),
      ],
      makeContext(sink, null, { controller: "p1" }),
    );
    expect(sink.rng.cursor - before).toBe(5);
    // The two gains total the coins, so every flip was counted once and none was re-rolled.
    expect(target.buffs.attack + target.buffs.health).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// R131 to R136: the set-stat layer, play pools, grades, Genn's Greed and the event window.
// ---------------------------------------------------------------------------

describe("SPEC §11 R131–R136: layer 2, pools, grades and event windows (M3 gate)", () => {
  it("R131 never counts Felinor Fiender itself, even when it carries the Felinor tag", () => {
    const state = game("r131-self");
    const self = put(state, fiender.id, slot("p1", "units", 1)); // 5/7, tagged Felinor

    // The premise: its own def really does carry the tag, so a tag-only match would count it.
    expect(defOf(state, self.defId).tags).toContain("Felinor");
    // Alone it is exactly its printed face: "all your Felinors" is every OTHER one (R39's floor).
    expect(unitView(state, self).attack).toBe(5);
    expect(unitView(state, self).maxHealth).toBe(7);

    // A second Fiender is a Felinor to the first, and contributes only its printed and buffed stats
    // — never its own layer-2 total, so the layer cannot recurse (R116).
    const second = put(state, fiender.id, slot("p1", "units", 2)); // 5/7, also tagged Felinor
    expect(statsWithBuffs(state, second).attack).toBe(5);
    expect(unitView(state, self).attack).toBe(5 + 5);
    expect(unitView(state, second).attack).toBe(5 + 5);
    // If either read the other's layer-2 total the pair would escalate past 10.
    expect(unitView(state, self).attack).not.toBe(5 + 10);

    // An enemy Felinor is nobody's: "your Felinors" is the controller's side.
    put(state, felinor.id, slot("p2", "units", 1));
    expect(unitView(state, self).attack).toBe(5 + 5);
  });

  it("R132 applies R39's floor to each stat's combined total, not per Felinor and not across the two stats", () => {
    const state = game("r132-floor");
    const self = put(state, fiender.id, slot("p1", "units", 1)); // 5/7
    const plus = put(state, felinor.id, slot("p1", "units", 2)); // 3/10
    const minus = put(state, felinor.id, slot("p1", "units", 3)); // 3/10
    plus.buffs = { attack: 4, health: 0 };
    minus.buffs = { attack: -5, health: 0 };

    // The control: the helper really does read permanent buffs, so a positive one lands in full.
    // Without this the negative case below could fail on buffs that were never applied.
    expect(statsWithBuffs(state, plus).attack).toBe(3 + 4);

    // R132 and R116: each Felinor is measured at layers 1 to 4 — printed plus permanent buffs — and
    // the floor belongs to the combined total, so a Felinor carrying a negative buff contributes a
    // negative attack and pulls the sum toward 0.
    expect(statsWithBuffs(state, minus).attack).toBe(3 - 5);

    // The sum is 7 + (-2) = 5, so the total is 5 + 5 = 10. A floor applied per Felinor instead would
    // read 7 + 0 = 7 and give 12.
    expect(unitView(state, self).attack).toBe(10);

    // Each stat is floored on its own: the health sum is untouched by whatever the attack sum did.
    expect(unitView(state, self).maxHealth).toBe(7 + 10 + 10);

    // And neither sum goes below 0: enough negative attack floors the attack contribution at 0
    // without dragging the health contribution down with it.
    minus.buffs = { attack: -99, health: 0 };
    expect(unitView(state, self).attack).toBe(5);
    expect(unitView(state, self).maxHealth).toBe(7 + 10 + 10);
  });

  it("R133 weights a card played twice in one turn once, because the pool is the set of cards played", () => {
    const state = game("r133-pool");
    const card = put(state, body.id, slot("p1", "units", 1));
    const other = put(state, frail.id, slot("p1", "units", 2));

    // The premise the row states: `playedIds` records one entry per play, so a card played, bounced
    // and replayed appears twice in the log.
    state.players.p1.turnLog.playedIds = [card.id, other.id, card.id];
    state.players.p1.turnLog.cardsPlayed = 3;
    expect(playedIdsThisTurn(state, "p1")).toEqual([card.id, other.id, card.id]);

    // R133: the pool a random pick draws from is the SET of cards played, so the replayed card is
    // one candidate and not two.
    const pool = playedCardsThisTurn(state, "p1");
    expect(pool.map((entry) => entry.id)).toEqual([card.id, other.id]);

    // R86's half of the same line still holds: an id whose card has ceased to exist drops out.
    removeFromAnyZone(state, other);
    other.zone = { z: "gone", player: "p1" };
    expect(playedCardsThisTurn(state, "p1").map((entry) => entry.id)).toEqual([card.id]);
  });

  it("R134 keeps a grade counter on the instance through a change of control, and reads the new controller's turn log", () => {
    const state = game("r134-grade");
    const index = put(state, logCard.id, slot("p1", "backrow", 1));
    index.counters.grade = 2; // grade D: it needs 2 plays to rise

    expect(gradeOf(index)).toBe(2);
    // p1 has played twice, p2 not at all, so it would rise for p1 and not for p2.
    state.players.p1.turnLog.cardsPlayed = 2;
    state.players.p2.turnLog.cardsPlayed = 0;
    expect(gradeRises(state, index)).toBe(true);

    // Control changes. The counter is the card's, so it travels with the instance.
    const sink = sinkFor(state);
    applyEffects([steal({ instanceId: index.id })], makeContext(sink, null, { controller: "p2" }));
    expect(index.controller).toBe("p2");
    expect(gradeOf(index)).toBe(2);

    // The threshold is the controller's: it now reads p2's turn log, which is short of the grade.
    expect(gradeRises(state, index)).toBe(false);
    state.players.p2.turnLog.cardsPlayed = 2;
    expect(gradeRises(state, index)).toBe(true);
    // And p1's log no longer decides it, which is what "the counter is the card's, the threshold is
    // the controller's" means.
    state.players.p1.turnLog.cardsPlayed = 0;
    expect(gradeRises(state, index)).toBe(true);
  });

  it("R135 exiles each card on its own, and needs a verb that walks library, then hand, then graveyard", () => {
    // The per-card half, on a verb that ships: R55's counter moves once per card and anything
    // watching sees one `exiled` event per card rather than a batch.
    const state = game("r135-per-card");
    const hand = inHand(state, body.id, "p1", 3);
    const sink = sinkFor(state);
    const before = state.counters.exiled;
    applyEffects([exileHand()], makeContext(sink, null, { controller: "p1" }));

    expect(state.players.p1.hand).toEqual([]);
    expect(state.counters.exiled - before).toBe(3);
    expect(eventsOfType(sink.events, "exiled").map((event) => event.instanceId)).toEqual(
      hand.map((card) => card.id),
    );

    // The ordering half needs a verb that can walk the three zones by cost in §8's order. #94's own
    // clauses are blocked on it, so the order has no home yet: library, then hand, then graveyard,
    // with the draw clause running first so a drawn card is never exiled by the same play.
    expect(Object.keys(effects)).toContain("exileMatching");
    expect(Object.keys(effects)).toContain("drawFromLibrary");
  });

  it("R136 gives a script its own event window, so an earlier event in the same action is not its own", () => {
    // The control: with no `summoned` event on the list at all, the filter compels nobody — so the
    // failure below is caused by the event, not by the filter being ignored.
    const quiet = game("r136-control");
    put(quiet, body.id, slot("p1", "units", 1));
    const quietVictim = put(quiet, body.id, slot("p2", "units", 1));
    const quietSink = sinkFor(quiet);
    applyEffects(
      [
        forcedAttacks({
          attackers: { side: "self", summonedThisScript: true },
          target: { instanceId: quietVictim.id },
        }),
      ],
      makeContext(quietSink, null, { controller: "p1" }),
    );
    expect(eventsOfType(quietSink.events, "attackDeclared")).toEqual([]);

    const state = game("r136-window");
    const earlier = put(state, body.id, slot("p1", "units", 1));
    const victim = put(state, body.id, slot("p2", "units", 1));
    const sink = sinkFor(state);

    // Something earlier in the same action summoned a unit, so its `summoned` event is already on
    // the sink's list — a second copy of a card, or a trap firing mid-action, does exactly this.
    sink.events.push({
      type: "summoned",
      player: "p1",
      instanceId: earlier.id,
      defId: earlier.defId,
      row: "units",
      lane: 1,
    });

    // This script summons nothing, so "the ones I just made" is empty and nobody is compelled.
    const ctx = makeContext(sink, null, { controller: "p1" });
    applyEffects(
      [forcedAttacks({ attackers: { side: "self", summonedThisScript: true }, target: { instanceId: victim.id } })],
      ctx,
    );

    expect(eventsOfType(sink.events, "attackDeclared")).toEqual([]);
    expect(victim.damage).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// R150, R154: where a floor lives in a summing read, and what `trapFired` carries.
// ---------------------------------------------------------------------------

describe("SPEC §11 R150 and R154: summing reads and the trapFired payload (M3 gate)", () => {
  it("R150 keeps a stat floor off each contributor of a summing read, leaving it on the combined total", () => {
    const state = game("r150-contributor-floor");
    const summer = put(state, fiender.id, slot("p1", "units", 1)); // 5/7, sums the others
    const donor = put(state, felinor.id, slot("p1", "units", 2)); // printed 3/10

    // The control: the layer-4 reading really does see permanent buffs, so the negative case below
    // is about the floor and not about a buff that never applied.
    donor.buffs = { attack: 4, health: 0 };
    expect(statsWithBuffs(state, donor).attack).toBe(3 + 4);
    expect(unitView(state, summer).attack).toBe(5 + 7);

    // R150: the layer-4 reading has no per-unit floor, so a contributor with a negative buff pulls
    // the total down rather than contributing nothing.
    donor.buffs = { attack: -5, health: 0 };
    expect(statsWithBuffs(state, donor).attack).toBe(3 - 5);

    // The floor belongs where the value is finally used — on the combined total (R132), per stat.
    expect(unitView(state, summer).attack).toBe(5);
    expect(unitView(state, summer).maxHealth).toBe(7 + 10);

    // And on a card's own stats, at the point of display.
    donor.buffs = { attack: -99, health: 0 };
    expect(unitView(state, donor).attack).toBe(0);
    expect(unitView(state, summer).attack).toBe(5);
  });

  it("R154 carries the trap's row and lane on trapFired, with its identity redacted for the other player", () => {
    const state = game("r154-trap-lane");
    const trap = put(state, bareTrap.id, slot("p1", "backrow", 3));
    const sink = sinkFor(state);
    expect(fireTrapsFor(sink, played("p2")).fired).toEqual([trap.id]);

    const fired = must(eventsOfType(sink.events, "trapFired")[0], "a trapFired event");
    expect(fired.controller).toBe("p1");

    // R154: the zone that flipped, so a client can animate the lane without being told which card
    // it was — which is the whole point, since a face-down trap is given no instance id (R97).
    expect(Object.keys(fired)).toContain("row");
    expect(Object.keys(fired)).toContain("lane");

    // `viewFor` reads its event stream off `state.applied`, which only a completed `reduce` writes
    // (`rememberNonce`). This fixture drives the sink directly, so the action has to be recorded
    // the way `reduce` would before any view can see it.
    state.applied = [{ nonce: "r154", events: sink.events }];

    // Its identity follows §10.8's redaction: the controller reads it, the other player reads the
    // sentinel — keyed to the controller and NOT to the card's current zone, because firing the
    // trap moves it to a public graveyard (R97's exception, stated in R154).
    const owner = viewFor(state, "p1");
    const other = viewFor(state, "p2");
    const seenBy = (view: ReturnType<typeof viewFor>): { instanceId: string; defId: string } => {
      const event = view.events.find((entry) => entry.type === "trapFired");
      if (event === undefined || event.type !== "trapFired") throw new Error("no trapFired in view");
      return { instanceId: event.instanceId, defId: event.defId };
    };
    expect(seenBy(owner)).toEqual({ instanceId: trap.id, defId: trap.defId });
    expect(seenBy(other)).toEqual({ instanceId: HIDDEN_ID, defId: HIDDEN_ID });
  });
});

// ---------------------------------------------------------------------------
// R138, R139, R140, R152: casts with no zone, lapsed limits, Stack placement, AI turns.
// ---------------------------------------------------------------------------

describe("SPEC §11 R138–R140 and R152: plays, limits and lockouts (M3 gate)", () => {
  it("R138 counts a cast permanent with no zone as played, resolves it, and sends it to the graveyard", () => {
    // The control first: with a free zone the same cast lands on the field, so the fixture really
    // does cast a permanent and the row below is about the full row rather than a broken cast.
    const roomy = game("r138-control");
    put(roomy, logCard.id, slot("p1", "backrow", NOTE_LANE));
    const roomySink = sinkFor(roomy);
    // Cast it straight out of the hand: `castCard` takes it out of whatever pile holds it.
    const lands = must(inHand(roomy, crier.id, "p1")[0], "a permanent to cast");
    castCard(roomySink, lands);
    expect(activeUnitsOf(roomy, "p1").map((unit) => unit.id)).toContain(lands.id);
    expect(notes(roomy)).toEqual(["cry"]);

    // Now the row: every unit zone taken, so there is nowhere for it to go.
    const state = game("r138-no-zone");
    put(state, logCard.id, slot("p1", "backrow", NOTE_LANE));
    for (const lane of [1, 2, 3, 4, 5]) put(state, body.id, slot("p1", "units", lane));
    expect(activeUnitsOf(state, "p1")).toHaveLength(5);

    const sink = sinkFor(state);
    const cast = must(inHand(state, crier.id, "p1")[0], "a permanent to cast");
    const playedBefore = state.players.p1.turnLog.cardsPlayed;
    castCard(sink, cast);

    // A cast cannot be refused the way a play can (R70): it still counts as played...
    expect(state.players.p1.turnLog.cardsPlayed).toBe(playedBefore + 1);
    expect(state.players.p1.turnLog.playedIds).toContain(cast.id);
    // ...and still resolves its script...
    expect(notes(state)).toEqual(["cry"]);
    // ...and is in no zone, so §10.5 step 7 sends it to its owner's graveyard.
    expect(activeUnitsOf(state, "p1").map((unit) => unit.id)).not.toContain(cast.id);
    expect(state.players.p1.graveyard.map((card) => card.id)).toContain(cast.id);
    expect(state.players.p1.resolving.map((card) => card.id)).not.toContain(cast.id);
  });

  it("R139 lapses a once-per-turn limit at the turn boundary, so a later turn is told whose turn it is", () => {
    const state = game("r139-lapse");
    const card = put(state, heroic.id, slot("p1", "backrow", 1));
    card.memory[POWER_KEY] = "burn"; // X 1
    state.players.p1.mana.current = 0; // unaffordable, so R103's priority is observable

    // Used this turn: R103 puts the per-turn limit ahead of mana, turn and phase.
    const usedOn = state.turn;
    card.memory[POWER_USED_KEY] = usedOn;
    expect(usedThisTurn(state, card)).toBe(true);
    expect(whyCannotActivate(state, "p1", card.id)).toBe("that power has already been used this turn");

    // R139: the limit is stored as the turn it was used on, so it is spent only while the game is
    // still on that turn. The stored value does not move — the turn does.
    state.turn += 1;
    state.active = "p2";
    expect(card.memory[POWER_USED_KEY]).toBe(usedOn);
    expect(usedThisTurn(state, card)).toBe(false);

    // So the player is told whose turn it is, not that the ability is spent: the per-turn limit has
    // already lapsed by the time the turn check could lose to it.
    expect(whyCannotActivate(state, "p1", card.id)).toBe("it is not your turn");
    // And on their own turn it is the mana, which is the next check R103 names.
    state.active = "p1";
    expect(whyCannotActivate(state, "p1", card.id)).toBe("that power costs 1, more than your mana");
  });

  it("R140 gives a zone-less Stack play the leftmost empty zone, and lifts occupancy only when named", () => {
    const state = game("r140-stack-zone");
    const card = must(inHand(state, stacker.id, "p1")[0], "a Stack card in hand");
    const play = (zone?: { row: "units"; lane: number }): string | null =>
      whyChoicesRefused(state, "p1", card, {
        type: "play",
        instanceId: card.id,
        ...(zone === undefined ? {} : { zone }),
      });

    // The control: on an empty row the convenience path is fine, and a named zone is too.
    expect(play()).toBeNull();
    expect(play({ row: "units", lane: 3 })).toBeNull();

    // Fill every unit zone. A named occupied zone is still legal — that is exactly the refusal
    // Stack lifts (§3.2, R64).
    const occupants = [1, 2, 3, 4, 5].map((lane) => put(state, body.id, slot("p1", "units", lane)));
    expect(occupants).toHaveLength(5);
    expect(play({ row: "units", lane: 2 })).toBeNull();
    expect(legalZonesFor(state, "p1", card).map((zone) => zone.lane)).toEqual([1, 2, 3, 4, 5]);

    // R140: the zone-less path still wants an EMPTY zone, so a full row refuses it even though
    // every lane would accept a named one. The asymmetry is confined to the convenience path.
    expect(play()).toMatch(/no free units zone/);

    // And with one lane freed it takes the leftmost empty one, not the first that would accept a
    // Stack — lane 4 here, with 1, 2, 3 and 5 still occupied.
    const freed = must(occupants[3], "the lane-4 occupant");
    removeFromAnyZone(state, freed);
    freed.zone = { z: "graveyard", player: "p1" };
    expect(play()).toBeNull();
    // "The leftmost empty, unlocked zone" is lane 4, not lane 1: lane 1 would accept a *named*
    // Stack play, and the convenience path deliberately does not take it.
    expect(firstFreeZone(state, "p1", "units")).toEqual({ player: "p1", row: "units", lane: 4 });
    expect(cardAt(state, slot("p1", "units", 1))?.defId).toBe(body.id);
  });

  it("R152 clears the AI lockout at the end of the turn it was set for", () => {
    // `aiPlaysOutTurn` sets the lockout and then plays the turn out, so the flag is only observable
    // mid-turn; R152 is about where it is *cleared*, which is what this sets up directly.
    const state = game("r152-ai-turn");
    const sink = sinkFor(state);
    expect(state.players.p1.aiTurn).toBe(false);
    state.players.p1.aiTurn = true; // the lockout `aiPlaysOutTurn` sets on the active player
    expect(state.active).toBe("p1");
    const lockedOn = state.turn;

    // §8's "until end of turn": the end of THIS turn clears it, not that player's next turn start —
    // otherwise a player stays locked out of a turn that is no longer the one the effect took.
    endTurn(sink);
    expect(state.players.p1.aiTurn).toBe(false);

    // And it was cleared by the end of the turn it was set for, not by p1 reaching another turn:
    // it is p2's turn now, and p1 has not started one since.
    expect(state.active).toBe("p2");
    expect(state.turn).toBeGreaterThan(lockedOn);
  });
});

// ---------------------------------------------------------------------------
// R151, R153: when a power rolls, and which hooks a zone answers.
// ---------------------------------------------------------------------------

describe("SPEC §11 R151 and R153: arrivals and zone-gated hooks (M3 gate)", () => {
  it("R151 rolls a Heroic Power's power as it arrives in a hand, not only at the start of the game", () => {
    const state = game("r151-arrival");
    const sink = sinkFor(state);

    // A copy that reached a hand some other way than the opening draw: returned from a graveyard.
    // The premise, and the bug R151 closes — it carries no power, so it would cost 0 for ever.
    const card = newInstance(state, heroic.id, "p1", { z: "graveyard", player: "p1" });
    state.players.p1.graveyard.push(card);
    expect(card.memory[POWER_KEY]).toBeUndefined();
    expect(powerOf(card)).toBeNull();
    expect(powerCostOf(card)).toBe(0);

    // It arrives somewhere a card can be looked at.
    expect(arriveInHand(sink, card)).toBe("hand");

    // R151: it rolls on arrival, so it has a power and its X again (R43, R78).
    const rolled = card.memory[POWER_KEY];
    expect(typeof rolled).toBe("string");
    expect(HERO_POWER_NAMES).toContain(rolled);
    expect(powerCostOf(card)).toBeGreaterThan(0);

    // And the roll is idempotent: a card that already has one keeps it when it arrives again.
    const kept = must(powerOf(card), "the rolled power");
    state.players.p1.hand = state.players.p1.hand.filter((entry) => entry.id !== card.id);
    expect(arriveInHand(sink, card)).toBe("hand");
    expect(powerOf(card)).toBe(kept);
  });

  it("R153 registers only the hooks a card's zone allows, so a hand or a graveyard answers no start- or end-of-turn hook", () => {
    const state = game("r153-zone-hooks");

    // The control: on the field the card IS a holder for all three hooks, so the enumerator is live
    // and the negatives below are about the zone rather than about a hook that never registered.
    const onField = put(state, zoneHooks.id, slot("p1", "backrow", 1));
    const holders = (hook: "startOfTurn" | "endOfTurn" | "onPlayHook"): string[] =>
      triggerHoldersWithHook(state, hook).map((holder) => holder.card.id);
    expect(holders("startOfTurn")).toEqual([onField.id]);
    expect(holders("endOfTurn")).toEqual([onField.id]);
    expect(holders("onPlayHook")).toEqual([onField.id]);

    // In a hand a card answers only its `handTriggers` (#89 Corpse Eater). A Field Spell held in
    // hand must not summon its token every turn, and a Gifted Program in hand must not make a play
    // Radiant — which is what an unfiltered enumeration lets both of them do.
    const held = must(inHand(state, zoneHooks.id, "p1")[0], "a copy in hand");
    expect(holders("startOfTurn")).not.toContain(held.id);
    expect(holders("endOfTurn")).not.toContain(held.id);
    expect(holders("onPlayHook")).not.toContain(held.id);

    // In a graveyard only the end-of-turn return of a spell that flagged itself when it was played
    // (#23, #24, #31) — so an unflagged card there answers nothing at all.
    const buried = newInstance(state, zoneHooks.id, "p1", { z: "graveyard", player: "p1" });
    state.players.p1.graveyard.push(buried);
    expect(buried.returnToHandAtEndOfTurn).not.toBe(true);
    expect(holders("startOfTurn")).not.toContain(buried.id);
    expect(holders("onPlayHook")).not.toContain(buried.id);
    expect(holders("endOfTurn")).not.toContain(buried.id);

    // The field copy is still the one holder for each, so nothing above was achieved by emptying
    // the enumeration.
    expect(holders("startOfTurn")).toEqual([onField.id]);
    expect(holders("onPlayHook")).toEqual([onField.id]);
  });
});

// ---------------------------------------------------------------------------
// R155: when the return-to-hand flag is set (§5.1, §10.5 step 7).
// ---------------------------------------------------------------------------

describe("SPEC §11 R155: the return-to-hand flag (M3 gate)", () => {
  it("R155 flags a Spell that asks to return as step 7 lands it in the graveyard, and clears it that turn", () => {
    const state = game("r155-flag");
    put(state, logCard.id, slot("p1", "backrow", NOTE_LANE));
    const sink = sinkFor(state);

    // The real call site: a cast goes through the same landing a play does (R70), so this is §10.5
    // step 7 doing the flagging rather than the setter being poked directly.
    const spell = must(inHand(state, returnSpell.id, "p1")[0], "a returning Spell");
    castCard(sink, spell);
    expect(state.players.p1.graveyard.map((card) => card.id)).toContain(spell.id);
    expect(spell.returnToHandAtEndOfTurn).toBe(true);

    // Each of step 7's three conditions, checked by a card that fails exactly one of them. None of
    // these may be flagged, or the flag would mean no more than "in the graveyard this turn".
    //
    // Not a Spell: #13's shape, a Unit with an end-of-turn hook that died the turn it was played.
    // It is in the play log AND in the graveyard, which is why the log cannot stand in for this.
    const unit = must(inHand(state, dyingUnit.id, "p1")[0], "a Unit with an end-of-turn hook");
    unit.zone = { z: "graveyard", player: "p1" };
    state.players.p1.hand = state.players.p1.hand.filter((card) => card.id !== unit.id);
    state.players.p1.graveyard.push(unit);
    state.players.p1.turnLog.playedIds.push(unit.id);
    expect(scriptsFor(unit.defId).base.endOfTurn).toBeDefined();
    flagReturnToHandAtEndOfTurn(state, unit.id);
    expect(unit.returnToHandAtEndOfTurn).not.toBe(true);

    // A Spell whose face declares no end-of-turn return.
    const plain = must(inHand(state, spellCrier.id, "p1")[0], "a Spell with no end-of-turn hook");
    plain.zone = { z: "graveyard", player: "p1" };
    state.players.p1.graveyard.push(plain);
    flagReturnToHandAtEndOfTurn(state, plain.id);
    expect(plain.returnToHandAtEndOfTurn).not.toBe(true);

    // And #39's shape: a Spell that exiled itself is not in the graveyard when step 7 runs.
    const exiled = must(inHand(state, returnSpell.id, "p1")[0], "a second returning Spell");
    exiled.zone = { z: "exile", player: "p1" };
    state.players.p1.exile.push(exiled);
    flagReturnToHandAtEndOfTurn(state, exiled.id);
    expect(exiled.returnToHandAtEndOfTurn).not.toBe(true);

    // The flag means "this turn": cleanup clears it at the end of the turn that set it.
    expect(state.active).toBe("p1");
    endTurn(sink);
    expect(spell.returnToHandAtEndOfTurn).not.toBe(true);
  });

  it("R155 makes the flag alone the graveyard's gate, so this turn's play log is not enough", () => {
    const state = game("r155-gate");

    // A flagged Spell in the graveyard answers its end-of-turn return (R153's one graveyard hook).
    const flagged = must(inHand(state, returnSpell.id, "p1")[0], "a returning Spell");
    flagged.zone = { z: "graveyard", player: "p1" };
    state.players.p1.hand = [];
    state.players.p1.graveyard.push(flagged);
    flagged.returnToHandAtEndOfTurn = true;
    expect(triggerHoldersWithHook(state, "endOfTurn").map((holder) => holder.card.id)).toEqual([flagged.id]);

    // An identical Spell in the same graveyard, played this very turn but never flagged — because
    // it never landed there through step 7 — answers nothing. Being in the log is not the gate.
    const unflagged = newInstance(state, returnSpell.id, "p1", { z: "graveyard", player: "p1" });
    state.players.p1.graveyard.push(unflagged);
    state.players.p1.turnLog.playedIds.push(unflagged.id);
    state.players.p1.turnLog.cardsPlayed += 1;
    expect(unflagged.returnToHandAtEndOfTurn).toBeUndefined();
    expect(triggerHoldersWithHook(state, "endOfTurn").map((holder) => holder.card.id)).toEqual([flagged.id]);

    // Flagging it is what admits it, so the gate is the flag and nothing else.
    unflagged.returnToHandAtEndOfTurn = true;
    expect(triggerHoldersWithHook(state, "endOfTurn").map((holder) => holder.card.id)).toEqual([
      flagged.id,
      unflagged.id,
    ]);
  });
});
