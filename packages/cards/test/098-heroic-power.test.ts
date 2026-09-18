// #98 Heroic Power — SPEC §8.5, §6.2 ("Start of Game", "Once per Turn", Quickdraw), §10.2, §10.6,
// §10.8, R18, R43, R45, R46, R65, R81, R103.
//
// BUILD M4-T4 row 98: "In opening hand; power chosen at start of game from the seed; playing costs
// the power's X and activates once; a copy created mid-game, mulliganed back into the library, or
// bounced to hand still has a power (R43); once per turn afterwards; Indestructible; each radiant
// power variant".
//
// HOW A POWER IS PINNED. R103 makes the seven power names state (`recruit`, `draw`, `ping`, `burn`,
// `rush`, `felinor`, `discover`), so a test that wants a named one writes that name into
// `memory.power` — which is exactly and only what `subsystems.ensurePower` writes, so the state is
// one the engine produces. `HERO_POWERS` supplies the X and the pair of §8.5 clauses, and every
// assertion below is then about what the card DID, never about the table it read.
//
// What the harness cannot reach: `scenario()` skips §2.1, so `startOfGame` never runs and the
// start-of-game roll of R43 has no card-level path. The roll itself is still covered here through
// `usePower`, which rolls for a card that has none — same seed, same power; different seeds, more
// than one power — and `packages/engine/test/heroPower.test.ts` covers the §2.1 placement by
// calling `finishSetup` directly.

import { describe, expect, it } from "vitest";
import type { GameEvent, PlayerId, Selection } from "@jackioh/shared";
import { effectiveCost, subsystems } from "@jackioh/engine";
import type { CardInstance } from "@jackioh/engine";
import { cardDef } from "../src/catalog-data";
import { query } from "../src/query";
import { base as hpBase, radiant as hpRadiant } from "../src/scripts/098-heroic-power";
import { scenario, type Scenario, type SideSetup } from "./_harness";

const HEROIC = "core-098"; // Field Spell, cost X, Mythic, tag Quickdraw, Indestructible
const RUSH_TOKEN = "core-t-rush";
const FELINOR_TOKEN = "core-t-felinor";

/** #53 Reno, a 3-cost Unit: the spare card that keeps §2.5's auto-end away from the assertions. */
const SPARE = "core-053";
/** #36 Magic Jammed, a 1-cost Spell that destroys a chosen backrow card (R46's test). */
const JAMMED = "core-036";
/** #19 Midrange Menace, a 3-cost 9/9 Unit — the permanent the recruit power finds in a library. */
const MENACE = "core-019";
/** #72 Reminisce, a 1-cost Spell that Discovers a card out of your graveyard into your hand. */
const REMINISCE = "core-072";
/**
 * #93.1 Combo-Fodder, a 0-cost spell token: the spare card for a side with no mana at all, so
 * §2.5's auto-end (which would refresh the mana the assertion is about) never fires.
 */
const FREE = "core-093-1";

type PowerName = (typeof subsystems.HERO_POWERS)[number]["name"];

function powerX(name: PowerName): number {
  const power = subsystems.HERO_POWERS.find((entry) => entry.name === name);
  if (power === undefined) throw new Error(`no hero power named "${name}"`);
  return power.x;
}

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

function eventsOf<T extends GameEvent["type"]>(s: Scenario, type: T): Extract<GameEvent, { type: T }>[] {
  return s.events.filter((event): event is Extract<GameEvent, { type: T }> => event.type === type);
}

function unitsOf(s: Scenario, player: PlayerId): CardInstance[] {
  return [1, 2, 3, 4, 5].flatMap((lane) => {
    const found = s.unit(player, lane);
    return found === null ? [] : [found];
  });
}

/**
 * R43: the power is stored on the instance. Writing `memory.power` is what `ensurePower` does and
 * the only thing it does, so a fixture that names a power is a state the engine reaches.
 */
function setPower(card: CardInstance, name: PowerName): CardInstance {
  card.memory[subsystems.POWER_KEY] = name;
  return card;
}

/** A #98 on p1's backrow with a named power, mana to spend and a spare card in hand. */
function onField(
  name: PowerName,
  opts: { radiantFace?: boolean; p1?: SideSetup; p2?: SideSetup } = {},
): { s: Scenario; power: CardInstance } {
  const s = scenario({
    seed: `hp-${name}`,
    p1: {
      hand: [SPARE],
      mana: 8,
      ...(opts.p1 ?? {}),
      backrow: [{ def: HEROIC, radiant: opts.radiantFace === true }, ...(opts.p1?.backrow ?? [])],
    },
    ...(opts.p2 === undefined ? {} : { p2: opts.p2 }),
  });
  return { s, power: setPower(must(s.backrow("p1", 1), "the Heroic Power"), name) };
}

/** A #98 in p1's hand with a named power (or none at all, for R103's unrolled card). */
function inHand(
  name: PowerName | null,
  opts: { radiantFace?: boolean; p1?: SideSetup; p2?: SideSetup } = {},
): { s: Scenario; power: CardInstance } {
  const s = scenario({
    seed: `hp-hand-${String(name)}`,
    p1: {
      mana: 8,
      ...(opts.p1 ?? {}),
      hand: [{ def: HEROIC, radiant: opts.radiantFace === true }, SPARE, ...(opts.p1?.hand ?? [])],
    },
    ...(opts.p2 === undefined ? {} : { p2: opts.p2 }),
  });
  const card = must(s.hand("p1")[0], "the Heroic Power in hand");
  return { s, power: name === null ? card : setPower(card, name) };
}

function unitPick(card: CardInstance): Selection[] {
  return [{ pick: "instance", instanceId: card.id }];
}

// ---------------------------------------------------------------------------
// The card: its data, its wiring and its keyword.
// ---------------------------------------------------------------------------

describe("#98 Heroic Power — the card", () => {
  it("§8.5 is a Mythic X-cost Field Spell tagged Quickdraw, Indestructible on both faces", () => {
    const def = cardDef(HEROIC);
    expect(def.type).toBe("Field Spell");
    expect(def.cost).toBe("X");
    expect(def.rarity).toBe("Mythic");
    expect(def.tags).toContain("Quickdraw");
    for (const face of [def.base, def.radiant]) {
      expect(face.keywords.map((keyword) => keyword.kind)).toContain("Indestructible");
    }
  });

  it("§6.2 Quickdraw: both faces carry the flag `setup.ts` reads for the opening hand", () => {
    // Step 2 of §2.1 swaps one opening draw for a Quickdraw card; that placement is the engine's
    // own setup test. What this card owes is the flag, on both faces.
    expect(hpBase.staticFlags?.quickdraw).toBe(true);
    expect(hpRadiant.staticFlags?.quickdraw).toBe(true);
  });

  it("§10.9 both faces wire the same six members to the subsystem, and nothing more", () => {
    // R43 makes this card a subsystem: Quickdraw, the cost, the roll, the play's activation, the
    // §10.2 action and the prompted powers' continuation. A rule written here would be a second
    // source of truth for something `subsystems/heroPower.ts` already owns.
    const members = ["staticFlags", "cost", "startOfGame", "cry", "activate", "resume"];
    expect(Object.keys(hpBase).sort()).toEqual([...members].sort());
    expect(Object.keys(hpRadiant).sort()).toEqual([...members].sort());
    expect(Object.keys(hpBase.resume ?? {})).toEqual([subsystems.POWER_RESUME]);
  });

  it("R46 Indestructible: a Field Spell that is destroyed simply stays", () => {
    const { s, power } = onField("burn", { p1: { hand: [JAMMED], mana: 8 } });
    expect(s.stats(power).keywords.map((keyword) => keyword.kind)).toContain("Indestructible");

    // #36 Magic Jammed locks the zone and destroys the backrow card in it (§8.2).
    s.play(JAMMED, { targets: unitPick(power) });
    // §4.5 step 1 drops the destroy mark: the card keeps its zone, and it is not a unit, so there
    // is no position or Taunt clause to apply.
    s.expectInZone(power, "field");
    expect(s.backrow("p1", 1)?.id).toBe(power.id);
    expect(s.state.players.p1.locks.backrow[0]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The cost (R43, R65, R103).
// ---------------------------------------------------------------------------

describe("#98 Heroic Power — the cost is the power's X (R43, R65, R103)", () => {
  it("R43 the cost the validator reads is the power's X, for every one of the seven", () => {
    // R103: "The seven stored power names are `recruit`, `draw`, `ping`, `burn`, `rush`, `felinor`
    // and `discover`", in §8.5's order, each with the X that row prints in brackets.
    expect(subsystems.HERO_POWER_NAMES).toEqual([
      "recruit",
      "draw",
      "ping",
      "burn",
      "rush",
      "felinor",
      "discover",
    ]);
    expect(subsystems.HERO_POWERS.map((entry) => entry.x)).toEqual([3, 1, 1, 1, 2, 1, 2]);

    const { s, power } = inHand("burn");
    for (const entry of subsystems.HERO_POWERS) {
      setPower(power, entry.name);
      expect(subsystems.powerCostOf(power)).toBe(entry.x);
      // R65 starts from the `cost` hook, so `effectiveCost` is the number the play pays.
      expect(effectiveCost(s.state, power)).toBe(entry.x);
    }
  });

  it("R103 a Heroic Power that has not rolled yet costs 0, and is playable with no mana", () => {
    const { s, power } = inHand(null, { p1: { mana: 0, hand: [FREE] } });
    expect(power.memory[subsystems.POWER_KEY]).toBeUndefined();
    expect(effectiveCost(s.state, power)).toBe(0);

    s.play(power);
    s.expectMana("p1", 0);
    expect(eventsOf(s, "cardPlayed")[0]?.costPaid).toBe(0);
    // Using it rolls one, so a power that reaches play always has one (R43's idempotent roll).
    expect(subsystems.HERO_POWER_NAMES).toContain(s.card(power).memory[subsystems.POWER_KEY]);
  });

  it("R43 the X is never the player's: an x named in the play action changes nothing", () => {
    for (const x of [0, 4]) {
      const { s, power } = inHand("recruit", { p1: { library: [MENACE], mana: 8 } });
      s.play(power, { x });
      // "recruit" is X 3, whatever the action asked for.
      s.expectMana("p1", 5);
      expect(eventsOf(s, "cardPlayed")[0]?.costPaid).toBe(powerX("recruit"));
    }
  });

  it("R65 cost modifiers never apply to an X-cost card, so a discount leaves the X alone", () => {
    // `costMod` is what `setCostMod` writes and R78 keeps it in every zone; R65 then rules that an
    // X-cost card "costs exactly X: `costMod` and discounts don't change it".
    const { s, power } = inHand("recruit");
    power.costMod = -2;
    expect(effectiveCost(s.state, power)).toBe(powerX("recruit"));
  });

  it("§10.8 the view names the power, its X and whether it is spent (R43)", () => {
    const { s, power } = onField("discover");
    const powers = s.view("p1").you.hero.powers;
    expect(powers).toHaveLength(1);
    expect(powers[0]).toMatchObject({
      instanceId: power.id,
      defId: HEROIC,
      name: "discover",
      x: powerX("discover"),
      usedThisTurn: false,
    });
    // The opponent sees it as theirs to fear, not theirs to use.
    expect(s.view("p2").you.hero.powers).toEqual([]);
    expect(s.view("p2").opponent.hero.powers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Playing it, and the once-per-turn limit (R43, R103).
// ---------------------------------------------------------------------------

describe("#98 Heroic Power — playing it and once per turn (R43, R103)", () => {
  it("R43 playing it pays X, activates the power once, and that is the turn's use", () => {
    const { s, power } = inHand("burn", { p2: { health: 30 } });
    s.play(power);

    s.expectMana("p1", 7); // 8 − 1
    s.expectHealth("p2", 28); // the power went off exactly once
    s.expectInZone(power, "field");
    expect(s.card(power).memory[subsystems.POWER_USED_KEY]).toBe(s.state.turn);
    expect(subsystems.whyCannotActivate(s.state, "p1", power.id)).toBe(
      "that power has already been used this turn",
    );
    expect(() => s.activate(power)).toThrow(/already been used this turn/);
    s.expectHealth("p2", 28); // the refusal spent nothing
    s.expectMana("p1", 7);
  });

  it("§10.2 legalActions offers activatePower until it is used, and not after", () => {
    const { s, power } = onField("burn");
    expect(subsystems.whyCannotActivate(s.state, "p1", power.id)).toBeNull();

    s.activate(power);
    s.expectMana("p1", 7);
    s.expectHealth("p2", 28);
    expect(s.view("p1").you.hero.powers[0]?.usedThisTurn).toBe(true);
    expect(() => s.activate(power)).toThrow(/already been used this turn/);
  });

  it("§6.2 Once per Turn: the next turn is a fresh use", () => {
    const { s, power } = onField("burn", { p1: { library: [SPARE, SPARE], hand: [SPARE] } });
    s.activate(power);
    s.expectHealth("p2", 28);

    // `startTurn()` runs the engine's own start of turn for p1: the turn counter goes up, so the
    // stored `usedTurn` no longer matches (§6.2's "the instance stores the turn it was last used").
    s.startTurn();
    expect(subsystems.usedThisTurn(s.state, s.card(power))).toBe(false);
    s.activate(power);
    s.expectHealth("p2", 26);
  });

  it("R103 once per turn is checked BEFORE the mana, so a spent power says so", () => {
    const { s, power } = onField("recruit", { p1: { library: [MENACE], hand: [SPARE], mana: 8 } });
    s.activate(power);
    // 8 − 3 = 5, still affordable, so drop below the X to make the two refusals compete.
    s.state.players.p1.mana.current = 0;
    expect(subsystems.whyCannotActivate(s.state, "p1", power.id)).toBe(
      "that power has already been used this turn",
    );

    // …and an unspent power on no mana reports the mana, which is the other half of the priority.
    const fresh = onField("recruit", { p1: { hand: [SPARE], mana: 0 } });
    expect(subsystems.whyCannotActivate(fresh.s.state, "p1", fresh.power.id)).toBe(
      `that power costs ${powerX("recruit")}, more than your mana`,
    );
  });

  it("R103 once per turn is checked BEFORE the open prompt, so a spent power still says so", () => {
    // The other half of R103's message priority. The Discover power leaves a prompt open, and the
    // player who tries the power again is told the power is spent, not to answer the prompt.
    const { s, power } = onField("discover", {
      p1: { hand: [SPARE], mana: 8, backrow: [HEROIC] },
    });
    s.activate(power);
    expect(s.state.pending).not.toBeNull();
    expect(subsystems.whyCannotActivate(s.state, "p1", power.id)).toBe(
      "that power has already been used this turn",
    );
    // …while an UNSPENT power in the same state is told about the prompt, which is what makes the
    // first message a priority rather than the only message.
    const other = setPower(must(s.backrow("p1", 2), "a second Heroic Power"), "burn");
    expect(subsystems.whyCannotActivate(s.state, "p1", other.id)).toBe("answer the open prompt first");
  });

  it("§6.2 once the turn has passed the power is no longer spent, so the refusal is the turn", () => {
    const { s, power } = onField("burn", { p1: { hand: [SPARE] }, p2: { hand: [SPARE] } });
    s.activate(power);
    expect(subsystems.usedThisTurn(s.state, s.card(power))).toBe(true);

    s.endTurn();
    expect(s.state.active).toBe("p2");
    // "The instance stores the turn it was last used" (§6.2), so a new turn number clears it and
    // what stands between p1 and the power is whose turn it is.
    expect(subsystems.usedThisTurn(s.state, s.card(power))).toBe(false);
    expect(subsystems.whyCannotActivate(s.state, "p1", power.id)).toBe("it is not your turn");
  });

  it("R103 the use is marked BEFORE the effects run, so a prompted power cannot be spent twice", () => {
    // The Discover power pauses on a prompt (§10.6). If the use were marked after the effects, the
    // answer would arrive with the turn's use still unspent and buy a second activation.
    const { s, power } = onField("discover", { p1: { hand: [SPARE], mana: 8 } });
    s.activate(power);

    expect(s.state.pending?.kind).toBe("discover");
    expect(subsystems.usedThisTurn(s.state, s.card(power))).toBe(true);
    expect(subsystems.whyCannotActivate(s.state, "p1", power.id)).toBe(
      "that power has already been used this turn",
    );

    s.answer(must(s.state.pending?.options[0], "an offered Unit").key);
    expect(s.state.pending).toBeNull();
    expect(() => s.activate(power)).toThrow(/already been used this turn/);
    // Exactly one Unit reached the hand, so the power really only went off once.
    expect(eventsOf(s, "addedToHand")).toHaveLength(1);
  });

  it("R103 two Heroic Powers are two independent uses in one turn", () => {
    // Reachable through #36 radiant or #49: a player can control their own plus a stolen one, and
    // §10.8's `powers` is a list for exactly that reason.
    const s = scenario({
      seed: "hp-two",
      p1: { backrow: [HEROIC, HEROIC], hand: [SPARE], mana: 8 },
      p2: { health: 30 },
    });
    const first = setPower(must(s.backrow("p1", 1), "the first power"), "burn");
    const second = setPower(must(s.backrow("p1", 2), "the second power"), "felinor");

    expect(s.view("p1").you.hero.powers.map((entry) => entry.name)).toEqual(["burn", "felinor"]);

    s.activate(first);
    s.expectHealth("p2", 28);
    // The second one is untouched: the flag is on the instance, never in a module (R43, §10.1).
    expect(subsystems.usedThisTurn(s.state, s.card(second))).toBe(false);
    s.activate(second);
    expect(unitsOf(s, "p1").map((unit) => unit.defId)).toEqual([FELINOR_TOKEN]);
    s.expectMana("p1", 6); // 8 − 1 − 1
    expect(s.view("p1").you.hero.powers.every((entry) => entry.usedThisTurn)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The seven powers, base clause and radiant clause (§8.5, R43).
// ---------------------------------------------------------------------------

describe("#98 Heroic Power — the seven powers, base", () => {
  it("R43 (3) Recruit a permanent: the library's first permanent, top down, not Radiant", () => {
    const { s, power } = onField("recruit", {
      p1: { library: [JAMMED, MENACE], hand: [SPARE], mana: 8 },
    });
    s.activate(power);

    // §6.3 Recruit scans top down for a Unit, Field Spell, Trap or Field Trap: the Spell is skipped.
    expect(unitsOf(s, "p1").map((unit) => unit.defId)).toEqual([MENACE]);
    expect(unitsOf(s, "p1")[0]?.radiant).toBe(false);
    expect(s.pile("p1", "library").map((card) => card.defId)).toEqual([JAMMED]);
    s.expectMana("p1", 5); // 8 − 3
  });

  it("R43 (1) lose 2 health, draw 1 — a loss, not damage (R18)", () => {
    const { s, power } = onField("draw", {
      p1: { library: [MENACE, SPARE], hand: [SPARE], armor: 5, mana: 8 },
    });
    s.activate(power);

    s.expectHealth("p1", 30 - subsystems.POWER_HEALTH_COST);
    expect(s.hand("p1").map((card) => card.defId)).toEqual([SPARE, MENACE]);
    // R18: losing health is not damage, so Armor never applies and no damage pipeline runs.
    expect(eventsOf(s, "healthLost")).toHaveLength(1);
    expect(eventsOf(s, "damage")).toHaveLength(0);
    s.expectMana("p1", 7);
  });

  it("R43 (1) deal 1 damage to a target the action named (R81), any unit or hero either side", () => {
    const { s, power } = onField("ping", { p2: { field: [MENACE] } });
    const victim = must(s.unit("p2", 1), "the enemy #19");

    s.activate(power, { targets: unitPick(victim) });
    s.expectStats(victim, { health: 8 }); // 9 − 1
    expect(s.state.pending).toBeNull(); // the target was named, so nothing was asked
    s.expectMana("p1", 7);
  });

  it("R103 the ping reaches any unit or hero on either side, prompting when no target is given", () => {
    const { s, power } = onField("ping", {
      p1: { field: [MENACE], hand: [SPARE], mana: 8 },
      p2: { field: [SPARE] },
    });
    s.activate(power);

    const pending = must(s.state.pending, "a target prompt");
    expect(pending.kind).toBe("target");
    expect(pending.playerId).toBe("p1");
    const offered = pending.options.map((option) => option.selection);
    expect(offered).toContainEqual({ pick: "instance", instanceId: must(s.unit("p1", 1), "ally").id });
    expect(offered).toContainEqual({ pick: "instance", instanceId: must(s.unit("p2", 1), "enemy").id });
    expect(offered).toContainEqual({ pick: "hero", player: "p1" });
    expect(offered).toContainEqual({ pick: "hero", player: "p2" });

    s.answer([{ pick: "hero", player: "p2" }]);
    s.expectHealth("p2", 29);
  });

  it("R43 (1) deal 2 damage to each opposing hero: the enemy hero only (R45)", () => {
    const { s, power } = onField("burn", { p1: { hand: [SPARE], health: 30 }, p2: { health: 30 } });
    s.activate(power);
    s.expectHealth("p2", 28);
    s.expectHealth("p1", 30);
    // "each opposing hero" future-proofs multiplayer: with two players it is the one enemy hero.
    expect(eventsOf(s, "damage")).toHaveLength(1);
  });

  it("R43 (2) summon a Rush Token: §7's 3/3 with Rush, placed per R64", () => {
    const { s, power } = onField("rush");
    s.activate(power);
    const tokens = unitsOf(s, "p1");
    expect(tokens.map((unit) => unit.defId)).toEqual([RUSH_TOKEN]);
    s.expectStats(must(tokens[0], "the token"), { attack: 3, health: 3 });
    expect(s.stats(must(tokens[0], "the token")).keywords.map((k) => k.kind)).toContain("Rush");
    s.expectMana("p1", 6); // 8 − 2
  });

  it("R43 (1) summon a Felinor Token: §7's 1/1 Felinor", () => {
    const { s, power } = onField("felinor");
    s.activate(power);
    const tokens = unitsOf(s, "p1");
    expect(tokens.map((unit) => unit.defId)).toEqual([FELINOR_TOKEN]);
    s.expectStats(must(tokens[0], "the token"), { attack: 1, health: 1 });
    expect(cardDef(FELINOR_TOKEN).tags).toContain("Felinor");
    s.expectMana("p1", 7);
  });

  it("R43 (2) Discover a Unit: three Units offered, the pick goes to hand and is not Radiant", () => {
    const { s, power } = onField("discover");
    s.activate(power);

    const pending = must(s.state.pending, "a discover prompt");
    expect(pending.kind).toBe("discover");
    expect(pending.playerId).toBe("p1");
    expect(pending.options).toHaveLength(3);

    const offered = pending.options.flatMap((option) =>
      option.selection.pick === "mode" ? [option.selection.option] : [],
    );
    const units = query({ type: "Unit" }).map((def) => def.id);
    for (const id of offered) {
      expect(units).toContain(id);
      expect(cardDef(id).type).toBe("Unit");
      expect(cardDef(id).token).toBe(false);
    }
    expect(new Set(offered).size).toBe(3); // drawn without replacement (§6.3 Discover)

    const picked = must(offered[0], "an offered Unit");
    s.answer(picked);
    const added = s.hand("p1").filter((card) => card.defId === picked);
    expect(added).toHaveLength(1);
    expect(added[0]?.radiant).toBe(false);
    s.expectMana("p1", 6); // 8 − 2
  });
});

describe("#98 Heroic Power — the seven powers, radiant (§8.5's radiant cell)", () => {
  it("§8.5 Recruit and make it Radiant", () => {
    const { s, power } = onField("recruit", {
      radiantFace: true,
      p1: { library: [MENACE], hand: [SPARE], mana: 8 },
    });
    s.activate(power);
    const recruited = must(unitsOf(s, "p1")[0], "the recruited #19");
    expect(recruited.defId).toBe(MENACE);
    expect(recruited.radiant).toBe(true);
    // §5.2: the radiant face is what a Radiant #19 uses, so its printed stats are the radiant ones.
    s.expectStats(recruited, { attack: 18, health: 18 });
  });

  it("§8.5 lose 2, draw 2", () => {
    const { s, power } = onField("draw", {
      radiantFace: true,
      p1: { library: [MENACE, SPARE, JAMMED], hand: [SPARE], mana: 8 },
    });
    s.activate(power);
    s.expectHealth("p1", 30 - subsystems.POWER_HEALTH_COST); // still 2, not 4
    expect(s.hand("p1").map((card) => card.defId)).toEqual([SPARE, MENACE, SPARE]);
  });

  it("§8.5 deal 2 (the ping), to a named target and through the prompt alike", () => {
    const named = onField("ping", { radiantFace: true, p2: { field: [MENACE] } });
    const victim = must(named.s.unit("p2", 1), "the enemy #19");
    named.s.activate(named.power, { targets: unitPick(victim) });
    named.s.expectStats(victim, { health: 7 }); // 9 − 2

    const prompted = onField("ping", { radiantFace: true, p1: { hand: [SPARE], mana: 8 } });
    prompted.s.activate(prompted.power);
    expect(prompted.s.state.pending?.prompt).toBe("Deal 2 damage to a target");
    prompted.s.answer([{ pick: "hero", player: "p2" }]);
    prompted.s.expectHealth("p2", 28);
  });

  it("§8.5 4 to each opposing hero", () => {
    const { s, power } = onField("burn", { radiantFace: true });
    s.activate(power);
    s.expectHealth("p2", 26);
    s.expectHealth("p1", 30);
  });

  it("§8.5 two Rush Tokens", () => {
    const { s, power } = onField("rush", { radiantFace: true });
    s.activate(power);
    expect(unitsOf(s, "p1").map((unit) => unit.defId)).toEqual([RUSH_TOKEN, RUSH_TOKEN]);
  });

  it("§8.5 two Felinor Tokens", () => {
    const { s, power } = onField("felinor", { radiantFace: true });
    s.activate(power);
    expect(unitsOf(s, "p1").map((unit) => unit.defId)).toEqual([FELINOR_TOKEN, FELINOR_TOKEN]);
  });

  it("§8.5 Discover a Radiant Unit: the pick arrives with the flag set (R103)", () => {
    const { s, power } = onField("discover", { radiantFace: true });
    s.activate(power);
    const pending = must(s.state.pending, "a discover prompt");
    expect(pending.prompt).toBe("Discover a Radiant Unit");

    const picked = must(
      pending.options.flatMap((option) =>
        option.selection.pick === "mode" ? [option.selection.option] : [],
      )[0],
      "an offered Unit",
    );
    s.answer(picked);
    const added = must(s.hand("p1").find((card) => card.defId === picked), "the discovered Unit");
    expect(added.radiant).toBe(true);
  });

  it("§8 Conventions the radiant cell restates only the powers: X, once per turn and the play's own activation are kept", () => {
    const { s, power } = inHand("burn", { radiantFace: true });
    // The X is still the power's, not doubled with the clause.
    expect(effectiveCost(s.state, power)).toBe(powerX("burn"));
    s.play(power);
    s.expectMana("p1", 7);
    s.expectHealth("p2", 26); // the radiant clause, once
    expect(() => s.activate(power)).toThrow(/already been used this turn/);
  });
});

// ---------------------------------------------------------------------------
// The roll (R43).
// ---------------------------------------------------------------------------

describe("#98 Heroic Power — the roll (R43)", () => {
  it("R43 the roll comes from the match rng: one of the seven, the same for the same seed", () => {
    const rolled = (seed: string): unknown => {
      const s = scenario({ seed, p1: { hand: [HEROIC, SPARE], mana: 8 } });
      const card = must(s.hand("p1")[0], "the Heroic Power");
      s.play(card);
      return s.card(card).memory[subsystems.POWER_KEY];
    };

    const first = rolled("hp-roll-a");
    expect(subsystems.HERO_POWER_NAMES).toContain(first);
    expect(rolled("hp-roll-a")).toBe(first);

    // …and it is a real seven-way roll rather than a constant.
    const seen = new Set<unknown>();
    for (let n = 0; n < 24; n += 1) seen.add(rolled(`hp-roll-${n}`));
    expect(seen.size).toBeGreaterThan(1);
  });

  it("R43 one that reaches a hand with no memory.power rolls as it arrives (R78)", () => {
    // #72 Reminisce moves a graveyard card into your hand, which is one of the arrivals R43 names:
    // "one that ends up in a hand or library with no `memory.power` (a bounced or reset instance,
    // R78) rolls as it arrives".
    //
    // KNOWN FAILING, and the gap is the engine's, not this card's: `startOfGame` covers the copies
    // §2.1 sees, and `usePower` rolls for one that is activated, but nothing in `zones.moveToZone`,
    // `draw.addToHand`, `state.newInstance` or `transform` calls `ensurePower`, so a copy that
    // ARRIVES later never rolls. #98's own script header reports it; no effect in the barrel can
    // reach an instance the card never saw, so the arrival hook has to be engine-side.
    const s = scenario({
      seed: "hp-arrival",
      p1: { hand: [REMINISCE, SPARE], graveyard: [HEROIC], mana: 8 },
    });
    const buried = must(s.pile("p1", "graveyard")[0], "the Heroic Power in the graveyard");
    expect(buried.memory[subsystems.POWER_KEY]).toBeUndefined();

    s.play(REMINISCE);
    s.answer(buried.id);
    const arrived = must(s.hand("p1").find((card) => card.id === buried.id), "it in hand");
    expect(
      arrived.memory[subsystems.POWER_KEY],
      "R43: a Heroic Power arriving in a hand with no memory.power must roll one as it arrives; " +
        "nothing in the engine's arrival paths calls ensurePower, so it arrives powerless and " +
        "costs 0 for ever",
    ).toBeDefined();
    expect(subsystems.HERO_POWER_NAMES).toContain(arrived.memory[subsystems.POWER_KEY]);
    expect(effectiveCost(s.state, arrived)).toBe(subsystems.powerCostOf(arrived));
  });
});
