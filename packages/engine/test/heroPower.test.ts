// Heroic Power (SPEC §8 #98, R43; BUILD M3-T7's `heroPower.ts` row: "the 7 powers with X,
// once-per-turn flag, `activatePower` action, radiant variants").
//
// R43, verbatim: "The power is stored on the instance (`memory.power`, `memory.usedTurn`). At start
// of game every Heroic Power in either player's hand or library rolls its power, including one the
// mulligan returned; one created later rolls when it is created, and one that ends up in a hand or
// library with no `memory.power` (a bounced or reset instance, R78) rolls as it arrives. Its cost is
// always the power's X, never chosen by the player. Playing it pays X and activates the power once,
// which is that turn's use; afterwards `activatePower` uses it once per turn for X. 'Recruit a card'
// recruits a permanent."
//
// The X table and the seven clauses come from §8 #98: "Start of game: gain one of 7 random powers,
// each 'Once per turn, spend X': (3) Recruit a permanent; (1) lose 2 health, draw 1; (1) deal 1
// damage to a target; (1) deal 2 damage to each opposing hero; (2) summon a Rush Token; (1) summon a
// Felinor Token; (2) Discover a Unit" with the radiant column "Recruit and make it Radiant; lose 2,
// draw 2; deal 2; 4 to each opposing hero; two Rush Tokens; two Felinor Tokens; Discover a Radiant
// Unit".
//
// Two fixtures are in play. `./fixtures/scripts.ts`'s `heroicPower` is the M1–M3 stand-in used by
// `setup.test.ts` and `mana.test.ts`: a Quickdraw Field Spell whose `startOfGame` rolls a name out
// of its own `HERO_POWERS` list. `hp-heroic` below is this file's own stand-in for the real #98,
// wired to the subsystem the way M4's card will be — `cost` reading `powerCostOf`, `startOfGame`
// rolling with `rollPower`, `activate` and `cry` running `usePower`, and `resume` pointing
// `POWER_RESUME` at `heroPower` so a prompted power finishes on the answer.
//
// NOTE: the fixture's seven names ("drain", "bolt", "rush-token", "felinor-token") are not the
// subsystem's seven names ("draw", "burn", "rush", "felinor"), so a card that rolls through the
// fixture script lands on a name `powerByName` does not know. The tests below read the X table off
// the subsystem, which is where R43's "the power's X" lives, and use the fixture only for the
// start-of-game clause it already serves. The mismatch is reported, not asserted: SPEC §8 #98 names
// the powers by their text, never by a string id, so neither list contradicts it.

import type { Action, ActionInput, CardDef, GameEvent, Selection } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { defByIndex, registerCatalog, registeredCatalog } from "../src/catalog";
import { DECK_SIZE, HERO_HEALTH } from "../src/config";
import { unitView } from "../src/layers";
import { effectiveCost } from "../src/mana";
import { answerPrompt } from "../src/prompts";
import { beginGame, legalActions, reduce } from "../src/reduce";
import { applyEffects, makeContext, type EngineSink } from "../src/resolve";
import type { CardScripts, Script } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import { finishSetup } from "../src/setup";
import { createGame, type CardInstance, type GameState } from "../src/state";
import {
  HERO_POWERS,
  HERO_POWER_NAMES,
  POWER_HEALTH_COST,
  POWER_KEY,
  POWER_RESUME,
  POWER_USED_KEY,
  activatePower,
  ensurePower,
  heroPower,
  powerByName,
  powerCostOf,
  powerOf,
  rollPower,
  usePower,
  usedThisTurn,
  whyCannotActivate,
} from "../src/subsystems/heroPower";
import { settle } from "../src/triggers";
import { activeUnitsOf } from "../src/zones";
import { bounce } from "../src/effects";
import { vanillaDeck } from "./fixtures/catalog";
import { plain } from "./fixtures/combat";
import { HERO_POWERS as FIXTURE_POWER_NAMES, heroicPower, stockpile } from "./fixtures/scripts";
import { eventsOfType, inHand, newGame, put, setLibrary, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixtures: this file's stand-in for #98, a Felinor token, and a Spell to skip past.
// ---------------------------------------------------------------------------

let nextIndex = 1600;

function def(name: string, type: CardDef["type"], extra: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `hp-${name}`,
    index: String(nextIndex),
    name: `${name} (heroPower)`,
    set: "Core",
    type,
    tags: [],
    rarity: "Common",
    token: false,
    cost: 1,
    base: { keywords: [], text: name },
    radiant: { keywords: [], text: name },
    ...extra,
  };
}

/** §8 #98's shape: a Quickdraw Field Spell whose cost is its power's X (R43, R65). */
const heroic = def("heroic", "Field Spell", { cost: "X", tags: ["Quickdraw"], rarity: "Mythic" });

/** §7's Felinor Token, which the felinor power summons by index (T-felinor). */
const felinorToken: CardDef = {
  id: "hp-token-felinor",
  index: "T-felinor",
  name: "Felinor Token (heroPower)",
  set: "Core",
  type: "Unit",
  tags: ["Felinor", "Token"],
  rarity: "Token",
  token: true,
  cost: 1,
  base: { attack: 1, health: 1, keywords: [], text: "1/1" },
  radiant: { attack: 1, health: 1, keywords: [], text: "1/1" },
};

const DEFS: CardDef[] = [heroic, felinorToken];

const heroicScript: Script = {
  // R43: the cost the validator, `legalActions` and the client all read is the power's X.
  cost: ({ instance }) => powerCostOf(instance),
  staticFlags: { quickdraw: true },
  startOfGame: () => [rollPower()],
  // "Playing it pays X and activates the power once, which is that turn's use."
  cry: () => [usePower()],
  activate: () => [usePower()],
  // R43 and R78: an instance that arrives in a hand with no power rolls as it arrives.
  handTriggers: [{ id: "roll-on-arrival", on: ["addedToHand", "drawn"], run: () => [rollPower()] }],
  resume: { [POWER_RESUME]: heroPower },
};

const SCRIPTS: Record<string, CardScripts> = {
  [heroic.id]: { base: heroicScript, radiant: heroicScript },
};

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

/** A Heroic Power on the field with a chosen power, which is the state every activation needs. */
function powered(state: GameState, name: string, options: { radiant?: boolean } = {}): CardInstance {
  const card = put(state, heroic.id, slot("p1", "backrow", 1), options);
  card.memory[POWER_KEY] = name;
  return card;
}

/** Run the effects of one activation, as the `activatePower` action does (R81's targets included). */
function activate(
  sink: EngineSink,
  card: CardInstance,
  targets: Selection[] = [],
): void {
  const ctx = makeContext(sink, card, { controller: card.controller, targets });
  applyEffects([usePower({ instanceId: card.id })], ctx);
  settle(sink);
}

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

let nonce = 0;
/**
 * `ActionInput`, not `Omit<Action, "nonce">`: `Action` is a discriminated union and a plain `Omit`
 * does not distribute over one, so it collapses to the members every variant shares and every
 * variant's own field (`instanceId`, `keep`) disappears. `@jackioh/shared` exports `ActionInput`
 * (and `DistributiveOmit`) for exactly this.
 */
function act(state: GameState, body: ActionInput): ReturnType<typeof reduce> {
  nonce += 1;
  return reduce(state, { ...body, nonce: `hp${nonce}` } as Action);
}

// ---------------------------------------------------------------------------
// The seven powers and their X.
// ---------------------------------------------------------------------------

describe("Heroic Power: the seven powers and their X (R43, §8 #98)", () => {
  it("R43 knows the seven powers of §8 #98, each with the X it spends", () => {
    expect(HERO_POWERS).toHaveLength(7);
    expect(HERO_POWER_NAMES).toHaveLength(7);
    expect(new Set(HERO_POWER_NAMES).size).toBe(7);

    // §8 #98 lists the seven with their X in this order.
    expect(HERO_POWERS.map((power) => power.x)).toEqual([3, 1, 1, 1, 2, 1, 2]);
    for (const power of HERO_POWERS) {
      expect(powerByName(power.name)).toBe(power);
      expect(power.label.length).toBeGreaterThan(0);
      expect(power.radiantLabel.length).toBeGreaterThan(0);
    }

    // The fixture's roll list is the same length, so a stand-in card rolls one of seven too.
    expect(FIXTURE_POWER_NAMES).toHaveLength(7);
  });

  it("R43 stores the power in memory.power and its cost is that power's X, never a chosen X", () => {
    const state = game("r43-cost");
    const card = powered(state, "recruit");

    for (const power of HERO_POWERS) {
      card.memory[POWER_KEY] = power.name;
      expect(powerOf(card)?.name).toBe(power.name);
      expect(powerCostOf(card)).toBe(power.x);
      // The cost pipeline reports the same number, which is what the play validator reads (R65).
      expect(effectiveCost(state, card)).toBe(power.x);
    }

    // "never chosen by the player": an X the player put on the instance changes nothing (R65).
    card.memory[POWER_KEY] = "recruit";
    card.x = 0;
    expect(effectiveCost(state, card)).toBe(3);
    card.x = 4;
    expect(effectiveCost(state, card)).toBe(3);

    // A card that has not rolled yet has no power to report.
    delete card.memory[POWER_KEY];
    expect(powerOf(card)).toBeNull();
    expect(powerCostOf(card)).toBe(0);
  });

  it("R43 'Recruit a card' recruits a permanent, and the radiant power makes it Radiant", () => {
    const state = game("r43-recruit");
    const card = powered(state, "recruit");
    setLibrary(state, "p1", [stockpile.id, plain.id]); // a Spell on top, then a Unit

    activate(sinkFor(state), card);

    // The Spell is skipped and stays where it was; the permanent is on the field (§6.3 Recruit).
    expect(activeUnitsOf(state, "p1").map((unit) => unit.defId)).toEqual([plain.id]);
    expect(state.players.p1.library.map((entry) => entry.defId)).toEqual([stockpile.id]);
    expect(activeUnitsOf(state, "p1")[0]?.radiant).toBe(false);

    const radiant = game("r43-recruit-radiant");
    const radiantCard = powered(radiant, "recruit", { radiant: true });
    setLibrary(radiant, "p1", [stockpile.id, plain.id]);
    activate(sinkFor(radiant), radiantCard);
    expect(activeUnitsOf(radiant, "p1").map((unit) => unit.defId)).toEqual([plain.id]);
    expect(activeUnitsOf(radiant, "p1")[0]?.radiant).toBe(true);
  });

  it("R43 the draw power loses 2 health and draws 1, or 2 when Radiant (R18)", () => {
    const state = game("r43-draw");
    const events: GameEvent[] = [];
    const card = powered(state, "draw");
    setLibrary(state, "p1", [plain.id, plain.id, plain.id]);
    const handBefore = state.players.p1.hand.length;

    activate(sinkFor(state, events), card);

    expect(state.players.p1.hero.health).toBe(HERO_HEALTH - POWER_HEALTH_COST);
    expect(state.players.p1.hand).toHaveLength(handBefore + 1);
    // R18: losing health is not damage, so the pipeline never runs.
    expect(eventsOfType(events, "healthLost")).toHaveLength(1);
    expect(eventsOfType(events, "damage")).toEqual([]);

    const radiant = game("r43-draw-radiant");
    const radiantCard = powered(radiant, "draw", { radiant: true });
    setLibrary(radiant, "p1", [plain.id, plain.id, plain.id]);
    const before = radiant.players.p1.hand.length;
    activate(sinkFor(radiant), radiantCard);
    expect(radiant.players.p1.hero.health).toBe(HERO_HEALTH - POWER_HEALTH_COST);
    expect(radiant.players.p1.hand).toHaveLength(before + 2);
  });

  it("R43 the ping power deals 1 to a target the action named, 2 when Radiant (R81)", () => {
    const state = game("r43-ping");
    const card = powered(state, "ping");
    const victim = put(state, plain.id, slot("p2", "units", 1)); // 3/3

    activate(sinkFor(state), card, [{ pick: "instance", instanceId: victim.id }]);
    expect(victim.damage).toBe(1);

    // The hero is a legal target of the same power (§8 #98: "a target").
    const other = game("r43-ping-hero");
    const heroPinger = powered(other, "ping", { radiant: true });
    activate(sinkFor(other), heroPinger, [{ pick: "hero", player: "p2" }]);
    expect(other.players.p2.hero.health).toBe(HERO_HEALTH - 2);
  });

  it("R43 the ping power with no target named opens a prompt and finishes on the answer (§10.6)", () => {
    const state = game("r43-ping-prompt");
    const sink = sinkFor(state);
    const card = powered(state, "ping");
    const victim = put(state, plain.id, slot("p2", "units", 1));

    activate(sink, card);
    const pending = must(state.pending, "a target prompt");
    expect(pending.kind).toBe("target");
    expect(pending.playerId).toBe("p1");
    expect(pending.options.map((option) => option.selection)).toContainEqual({
      pick: "instance",
      instanceId: victim.id,
    });

    // R43: the use was spent when the activation started, so the answer cannot buy a second one.
    expect(usedThisTurn(state, card)).toBe(true);

    expect(
      answerPrompt(sink, {
        playerId: "p1",
        choiceId: pending.id,
        selection: [{ pick: "instance", instanceId: victim.id }],
      }),
    ).toBeNull();
    expect(victim.damage).toBe(1);
    expect(state.pending).toBeNull();
  });

  it("R43 the burn power deals 2 to each opposing hero, 4 when Radiant", () => {
    const state = game("r43-burn");
    const card = powered(state, "burn");
    activate(sinkFor(state), card);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 2);
    expect(state.players.p1.hero.health).toBe(HERO_HEALTH);

    const radiant = game("r43-burn-radiant");
    const radiantCard = powered(radiant, "burn", { radiant: true });
    activate(sinkFor(radiant), radiantCard);
    expect(radiant.players.p2.hero.health).toBe(HERO_HEALTH - 4);
  });

  it("R43 the token powers summon one Rush or Felinor Token, and two when Radiant (§7)", () => {
    const rushDef = must(defByIndex("T-rush"), "a Rush Token definition");

    const state = game("r43-tokens");
    const card = powered(state, "rush");
    activate(sinkFor(state), card);
    expect(activeUnitsOf(state, "p1").map((unit) => unit.defId)).toEqual([rushDef.id]);
    // §6.1: the token carries Rush, so it may attack the turn it arrives.
    expect(unitView(state, must(activeUnitsOf(state, "p1")[0], "the token")).keywords.map((k) => k.kind)).toContain(
      "Rush",
    );

    const two = game("r43-tokens-radiant");
    const radiantRush = powered(two, "rush", { radiant: true });
    activate(sinkFor(two), radiantRush);
    expect(activeUnitsOf(two, "p1").map((unit) => unit.defId)).toEqual([rushDef.id, rushDef.id]);

    const felinor = game("r43-felinor");
    const felinorCard = powered(felinor, "felinor");
    activate(sinkFor(felinor), felinorCard);
    expect(activeUnitsOf(felinor, "p1").map((unit) => unit.defId)).toEqual([felinorToken.id]);

    const twoFelinors = game("r43-felinor-radiant");
    const radiantFelinor = powered(twoFelinors, "felinor", { radiant: true });
    activate(sinkFor(twoFelinors), radiantFelinor);
    expect(activeUnitsOf(twoFelinors, "p1").map((unit) => unit.defId)).toEqual([
      felinorToken.id,
      felinorToken.id,
    ]);
  });

  it("R43 the discover power offers three Units and puts the pick in hand, Radiant when it is", () => {
    const state = game("r43-discover");
    const sink = sinkFor(state);
    const card = powered(state, "discover");
    const handBefore = state.players.p1.hand.length;

    activate(sink, card);
    const pending = must(state.pending, "a discover prompt");
    expect(pending.kind).toBe("discover");
    expect(pending.playerId).toBe("p1");
    expect(pending.options).toHaveLength(3);

    const pick = must(pending.options[0], "an offered option");
    expect(answerPrompt(sink, { playerId: "p1", choiceId: pending.id, selection: [pick.selection] })).toBeNull();
    expect(state.players.p1.hand).toHaveLength(handBefore + 1);
    const added = must(state.players.p1.hand[state.players.p1.hand.length - 1], "the discovered card");
    expect(added.radiant).toBe(false);

    // The radiant power Discovers a Radiant Unit.
    const radiant = game("r43-discover-radiant");
    const radiantSink = sinkFor(radiant);
    const radiantCard = powered(radiant, "discover", { radiant: true });
    const before = radiant.players.p1.hand.length;
    activate(radiantSink, radiantCard);
    const radiantPending = must(radiant.pending, "a discover prompt");
    const radiantPick = must(radiantPending.options[0], "an offered option");
    expect(
      answerPrompt(radiantSink, {
        playerId: "p1",
        choiceId: radiantPending.id,
        selection: [radiantPick.selection],
      }),
    ).toBeNull();
    expect(radiant.players.p1.hand).toHaveLength(before + 1);
    expect(must(radiant.players.p1.hand[radiant.players.p1.hand.length - 1], "the card").radiant).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The once-per-turn flag, playing the card, and the action.
// ---------------------------------------------------------------------------

describe("Heroic Power: once per turn and activatePower (R43, M3-T7)", () => {
  it("R43 records the use in memory.usedTurn and refuses a second activation that turn", () => {
    const state = game("r43-once");
    const sink = sinkFor(state);
    const card = powered(state, "burn");

    expect(card.memory[POWER_USED_KEY]).toBeUndefined();
    expect(whyCannotActivate(state, "p1", card.id)).toBeNull();

    activate(sink, card);
    expect(card.memory[POWER_USED_KEY]).toBe(state.turn);
    expect(usedThisTurn(state, card)).toBe(true);
    expect(whyCannotActivate(state, "p1", card.id)).toBe("that power has already been used this turn");

    // The next turn is a new use (§6.2 "Once per Turn": the instance stores the turn it was used).
    state.turn += 1;
    expect(usedThisTurn(state, card)).toBe(false);
    expect(whyCannotActivate(state, "p1", card.id)).toBeNull();
    activate(sink, card);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 4); // 2 twice
  });

  it("R43 refuses an activation that is not the controller's, not on the field, or unaffordable", () => {
    const state = game("r43-refusals");
    const card = powered(state, "recruit"); // X 3

    expect(whyCannotActivate(state, "p2", card.id)).toBe("that card is not yours");
    expect(whyCannotActivate(state, "p1", "c9999")).toBe("no card c9999");

    state.players.p1.mana.current = 2;
    expect(whyCannotActivate(state, "p1", card.id)).toBe("that power costs 3, more than your mana");
    state.players.p1.mana.current = 3;
    expect(whyCannotActivate(state, "p1", card.id)).toBeNull();

    // A card with no rolled power has no power to activate (R43).
    delete card.memory[POWER_KEY];
    expect(whyCannotActivate(state, "p1", card.id)).toBe("that card has no power");

    const inHandCard = must(inHand(state, heroic.id, "p1")[0], "a Heroic Power in hand");
    inHandCard.memory[POWER_KEY] = "burn";
    expect(whyCannotActivate(state, "p1", inHandCard.id)).toBe("that card is not on the field");
  });

  it("R43 activatePower spends the power's X and uses it once, for X, per turn", () => {
    const state = game("r43-activate");
    const sink = sinkFor(state);
    const card = powered(state, "recruit"); // X 3
    setLibrary(state, "p1", [plain.id]);
    state.players.p1.mana.current = 4;

    expect(activatePower(sink, "p1", { instanceId: card.id })).toBeNull();
    expect(state.players.p1.mana.current).toBe(1); // 4 − 3
    expect(activeUnitsOf(state, "p1").map((unit) => unit.defId)).toEqual([plain.id]);
    expect(card.memory[POWER_USED_KEY]).toBe(state.turn);

    // Once per turn, and the refusal is the reason `whyCannotActivate` gives.
    expect(activatePower(sink, "p1", { instanceId: card.id })).toBe(
      "that power has already been used this turn",
    );
    expect(state.players.p1.mana.current).toBe(1); // nothing was spent on the refusal
  });

  it("R43 activatePower carries the target of a power that needs one (R81)", () => {
    const state = game("r43-activate-target");
    const sink = sinkFor(state);
    const card = powered(state, "ping");
    const victim = put(state, plain.id, slot("p2", "units", 1));
    state.players.p1.mana.current = 2;

    expect(
      activatePower(sink, "p1", {
        instanceId: card.id,
        targets: [{ pick: "instance", instanceId: victim.id }],
      }),
    ).toBeNull();
    expect(victim.damage).toBe(1);
    expect(state.players.p1.mana.current).toBe(1); // X 1
    expect(state.pending).toBeNull(); // the target was named, so nothing was asked
  });

  it("R43 playing it pays X and activates the power once, which is that turn's use", () => {
    const state = game("r43-play");
    const card = must(inHand(state, heroic.id, "p1")[0], "a Heroic Power in hand");
    card.memory[POWER_KEY] = "burn"; // X 1, deal 2 to the enemy hero
    // A second playable card, so §2.5's auto-end does not end the turn under the assertions.
    inHand(state, plain.id, "p1");
    state.players.p1.mana.current = 4;
    const turn = state.turn;

    const played = act(state, { type: "play", instanceId: card.id, playerId: "p1" });
    expect(played.error).toBeUndefined();
    const after = played.state;
    expect(after.turn).toBe(turn);

    // Paid X, not a chosen X (R43, R65).
    expect(after.players.p1.mana.current).toBe(3);
    expect(eventsOfType(played.events, "cardPlayed")[0]?.costPaid).toBe(1);

    // The power went off once, and that was the turn's use.
    expect(after.players.p2.hero.health).toBe(HERO_HEALTH - 2);
    const onField = must(
      after.players.p1.backrow.find((entry) => entry?.defId === heroic.id),
      "the Heroic Power on the field",
    );
    expect(onField.memory[POWER_USED_KEY]).toBe(after.turn);
    expect(whyCannotActivate(after, "p1", onField.id)).toBe("that power has already been used this turn");
  });

  it("R43 the activatePower action goes through reduce and legalActions offers it (§10.2)", () => {
    // `reduce.ts` dispatches `activatePower` to the subsystem and `legalActions` enumerates the
    // powers of every permanent the player controls, so what is asserted here is that both
    // directions come from `activatePower` and `whyCannotActivate` (proved above), per §10.2's
    // action list and BUILD M3-T7.
    const state = game("r43-action");
    const card = powered(state, "burn"); // X 1
    // A second playable card, so §2.5's auto-end does not end the turn between the two actions:
    // the refusal under test is the power's own once-per-turn (R43, R103), not "it is not your
    // turn". `plain` costs 1, which is what is left after the power's X.
    inHand(state, plain.id, "p1");
    state.players.p1.mana.current = 2;

    expect(legalActions(state, "p1")).toContainEqual({ type: "activatePower", instanceId: card.id });

    const result = act(state, { type: "activatePower", instanceId: card.id, playerId: "p1" });
    expect(result.error).toBeUndefined();
    expect(result.state.players.p2.hero.health).toBe(HERO_HEALTH - 2);
    expect(result.state.players.p1.mana.current).toBe(1);

    // Used up: the action is neither offered nor accepted again this turn.
    expect(
      legalActions(result.state, "p1").some((action) => action.type === "activatePower"),
    ).toBe(false);
    expect(act(result.state, { type: "activatePower", instanceId: card.id, playerId: "p1" }).error).toBe(
      "that power has already been used this turn",
    );
  });
});

// ---------------------------------------------------------------------------
// The roll (R43, R78).
// ---------------------------------------------------------------------------

describe("Heroic Power: rolling the power (R43, R78)", () => {
  it("R43 rolls a power at start of game for every copy in either player's hand or library", () => {
    const state = game("r43-roll-setup");
    const p1Hand = must(inHand(state, heroic.id, "p1")[0], "p1's hand copy");
    const p2Hand = must(inHand(state, heroic.id, "p2")[0], "p2's hand copy");
    setLibrary(state, "p1", [heroic.id, plain.id]);
    setLibrary(state, "p2", [plain.id, heroic.id]);
    const p1Library = must(state.players.p1.library.find((c) => c.defId === heroic.id), "p1's library copy");
    const p2Library = must(state.players.p2.library.find((c) => c.defId === heroic.id), "p2's library copy");

    for (const card of [p1Hand, p2Hand, p1Library, p2Library]) {
      expect(card.memory[POWER_KEY]).toBeUndefined();
    }

    // §2.1 step 4: start-of-game effects resolve for every card in a hand or library.
    finishSetup(sinkFor(state));

    for (const card of [p1Hand, p2Hand, p1Library, p2Library]) {
      expect(HERO_POWER_NAMES).toContain(card.memory[POWER_KEY]);
      expect(powerOf(card)).not.toBeNull();
      expect(powerCostOf(card)).toBe(must(powerOf(card), "a power").x);
    }
  });

  it("R43 the roll comes from the match rng, so the same seed rolls the same power", () => {
    const rolled = (seed: string): unknown => {
      const state = game(seed);
      const card = must(inHand(state, heroic.id, "p1")[0], "a Heroic Power in hand");
      finishSetup(sinkFor(state));
      return card.memory[POWER_KEY];
    };

    const first = rolled("r43-seeded");
    expect(HERO_POWER_NAMES).toContain(first);
    expect(rolled("r43-seeded")).toBe(first);

    // Two copies in one game roll independently, so a game can hold two different powers.
    const state = game("r43-two-copies");
    const cards = inHand(state, heroic.id, "p1", 6);
    finishSetup(sinkFor(state));
    const names = new Set(cards.map((card) => card.memory[POWER_KEY]));
    expect(names.size).toBeGreaterThan(1);
  });

  it("R43 the M1-M3 fixture Heroic Power also rolls at start of game (setup §2.1)", () => {
    // `./fixtures/scripts.ts`'s stand-in, as `setup.test.ts` uses it: a Quickdraw card that rolls
    // one of its own seven names. It proves the start-of-game clause without this file's wiring.
    const state = newGame("r43-fixture-roll");
    const card = must(inHand(state, heroicPower.id, "p2")[0], "the fixture Heroic Power");
    expect(card.memory.power).toBeUndefined();

    finishSetup(sinkFor(state));
    expect(FIXTURE_POWER_NAMES).toContain(card.memory.power);
  });

  it("R43 ensurePower rolls for an instance with no power and keeps the one it has", () => {
    const state = game("r43-ensure");
    const sink = sinkFor(state);
    const card = must(inHand(state, heroic.id, "p1")[0], "a Heroic Power in hand");

    const rolled = must(ensurePower(sink, card), "a rolled power");
    expect(card.memory[POWER_KEY]).toBe(rolled.name);
    // Idempotent: a card that already rolled keeps its power however often it is asked.
    expect(ensurePower(sink, card)?.name).toBe(rolled.name);
    expect(ensurePower(sink, card)?.name).toBe(rolled.name);

    card.memory[POWER_KEY] = "recruit";
    expect(ensurePower(sink, card)?.name).toBe("recruit");
  });

  it("R43 a bounced Heroic Power arrives in hand with a power again, so its cost is still X (R78)", () => {
    const state = game("r43-bounced");
    const sink = sinkFor(state);
    const card = powered(state, "recruit");
    card.memory[POWER_USED_KEY] = state.turn;
    expect(effectiveCost(state, card)).toBe(3);

    // R78 resets the instance as it leaves the field, memory included, so the power is gone.
    applyEffects([bounce({ target: { of: "chosen" } })], makeContext(sink, card, {
      controller: "p1",
      targets: [{ pick: "instance", instanceId: card.id }],
    }));
    expect(card.zone).toEqual({ z: "hand", player: "p1" });
    expect(card.memory[POWER_USED_KEY]).toBeUndefined();

    // R43: "one that ends up in a hand or library with no `memory.power` … rolls as it arrives".
    settle(sink);
    expect(HERO_POWER_NAMES).toContain(card.memory[POWER_KEY]);
    expect(effectiveCost(state, card)).toBe(must(powerOf(card), "a power").x);
  });

  it("R43 a Heroic Power created mid-game rolls when it is created", () => {
    const state = game("r43-created");
    const sink = sinkFor(state);
    const card = must(inHand(state, heroic.id, "p1")[0], "a freshly created Heroic Power");

    // The creating effect rolls it: `rollPower` is the effect #98's own hooks return, and
    // `usePower` rolls too, so a power that reaches play always has one.
    applyEffects([rollPower({ instanceId: card.id })], makeContext(sink, card, { controller: "p1" }));
    expect(HERO_POWER_NAMES).toContain(card.memory[POWER_KEY]);

    const fresh = must(inHand(state, heroic.id, "p1", 1)[0], "another copy");
    expect(fresh.memory[POWER_KEY]).toBeUndefined();
    const onField = put(state, heroic.id, slot("p1", "backrow", 2));
    activate(sink, onField);
    expect(HERO_POWER_NAMES).toContain(onField.memory[POWER_KEY]);
  });

  it("R43 a game begun with a Heroic Power in the deck has one with a power in play (§2.1)", () => {
    // `game()` registers this file's defs; the decks are then built against that catalog, so the
    // game is created after the registration rather than by `newGame`, which resets it.
    game("r43-begin");
    const deck = [heroic.id, ...vanillaDeck(DECK_SIZE - 1, 1)];
    const begun = beginGame(
      createGame({ seed: "r43-begin", decks: [deck, vanillaDeck(DECK_SIZE, 21)] }),
    ).state;

    let playing = act(begun, {
      type: "mulligan",
      keep: begun.players.p1.hand.map((card) => card.id),
      playerId: "p1",
    }).state;
    playing = act(playing, {
      type: "mulligan",
      keep: playing.players.p2.hand.map((card) => card.id),
      playerId: "p2",
    }).state;

    // Quickdraw put it in the opening hand (§6.2), and start of game rolled its power (R43).
    const card = must(
      [...playing.players.p1.hand, ...playing.players.p1.library].find((entry) => entry.defId === heroic.id),
      "the Heroic Power",
    );
    expect(HERO_POWER_NAMES).toContain(card.memory[POWER_KEY]);
    expect(effectiveCost(playing, card)).toBe(must(powerOf(card), "a power").x);
  });
});
