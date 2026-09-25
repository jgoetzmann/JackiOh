// #50 Kpop Fanatic — SPEC §8.2, BUILD M4-T4: "Steal fires at your next start of turn even if it
// died (R76); fizzles if the target left; radiant Divine Shield". The polish-4 edge-case hunt, round 5
// (lens "card by card"): a base #50 made Radiant on the field gains its radiant face's Divine Shield
// at once, even after a granted one was spent (§5.2).
//
// Radiant (R275, R282): "…at the start of your next turn, steal it; it becomes Radiant". The rider
// lands only on a card the delayed steal took — never on a target that left the field (died, or
// bounced to a hand, R76, R174), lies dormant under a Stack pile (R13), was already this player's,
// or stayed with the opponent because the row was full (R15). Each of those has an `R282` case below.
//
// Every case here crosses a turn boundary, so both sides keep a card in hand, a unit on the board
// and a few library cards: the engine auto-ends a turn with nothing meaningful left (R82, and the
// harness header), and an empty library would add fatigue damage to the assertions.
//
// The sequence is always the same and is what R62 is about: `endTurn()` hands the turn to the
// opponent, who really takes one, and the second `endTurn()` comes back to this player's own start
// of turn, where `turn.runDelayed` resolves the entry before any start-of-turn trigger fires.
//
// Props with no script beyond printed keywords: #25 4-mana 7/7 (the steal target and the attacker
// that kills a 1/1), #45 Deft Duelist (4/3 → 8/6, the target that dies into The Rock), #66 The Rock
// (10/10 Indestructible, the wall), #16 Hit Job and #8 Mr. Vanilla as inert hand and library cards.
// The R282 cases also use #17 Flood (bounce every unit), #33 Unstable Clone Machine (a Field Spell to
// steal), #49 Snom Bunny Mind Control (a steal of its own) and #92 Felinor Fiender (a Stack card).

import { describe, expect, it } from "vitest";
import type { PlayerId } from "@jackioh/shared";
import { scenario, type Scenario } from "./_harness";
import { base, def, radiant } from "../src/scripts/050-kpop-fanatic";

const KPOP = "core-050";
const SEVEN_SEVEN = "core-025";
const DUELIST = "core-045";
const ROCK = "core-066";
const FILLER = "core-016";
const MENACE = "core-019";
const LIBRARY = [SEVEN_SEVEN, "core-008", "core-020"];

describe("#50 Kpop Fanatic", () => {
  it("R81, §8.2 Engine base: the Cry schedules a delayed effect keyed to the chosen permanent", () => {
    const g = scenario({
      p1: { hand: [KPOP, FILLER], library: [...LIBRARY] },
      p2: { hand: [FILLER], field: [{ def: SEVEN_SEVEN, lane: 4 }], library: [...LIBRARY] },
    });
    const prey = g.unit("p2", 4);
    if (prey === null) throw new Error("setup: p2 should hold the 7/7 in lane 4");

    g.play(KPOP, { targets: [{ pick: "instance", instanceId: prey.id }] });

    // The choice was made at play time, so resolution never paused (R81, §10.6).
    expect(g.state.pending).toBeNull();
    // Nothing is stolen on the turn it is played.
    expect(g.unit("p2", 4)?.id).toBe(prey.id);
    expect(g.card(prey).controller).toBe("p2");

    expect(g.state.delayed).toHaveLength(1);
    const entry = g.state.delayed[0];
    expect(entry?.owner).toBe("p1");
    expect(entry?.at).toEqual({ phase: "start", player: "p1" });
    expect(entry?.resume.defId).toBe(KPOP);
    expect(entry?.resume.step).toBe("steal");
    // Keyed to the TARGET, which is what lets it outlive Kpop Fanatic (R76).
    expect(entry?.resume.data).toMatchObject({ targetId: prey.id });
  });

  it("R62, R15 base: the steal happens at your next start of turn, same lane if free", () => {
    const g = scenario({
      p1: { hand: [KPOP, FILLER], library: [...LIBRARY] },
      p2: { hand: [FILLER], field: [{ def: SEVEN_SEVEN, lane: 2 }], library: [...LIBRARY] },
    });
    const prey = g.unit("p2", 2);
    if (prey === null) throw new Error("setup: p2 should hold the 7/7 in lane 2");
    g.play(KPOP, { targets: [{ pick: "instance", instanceId: prey.id }] });

    g.endTurn();
    // The entry names p1's start of turn, so the opponent's start of turn does not fire it.
    expect(g.state.active).toBe("p2");
    expect(g.state.delayed).toHaveLength(1);
    expect(g.unit("p2", 2)?.id).toBe(prey.id);

    g.endTurn();

    expect(g.state.active).toBe("p1");
    expect(g.unit("p1", 2)?.id).toBe(prey.id);
    expect(g.unit("p2", 2)).toBeNull();
    // R12: control moved, ownership did not.
    expect(g.card(prey).controller).toBe("p1");
    expect(g.card(prey).owner).toBe("p2");
    // The base face has no rider: the stolen card keeps its face (R282 is the radiant face's).
    expect(g.card(prey).radiant).toBe(false);
    expect(g.events.some((event) => event.type === "radiantSet")).toBe(false);
    // The entry is spent, so it never fires twice.
    expect(g.state.delayed).toHaveLength(0);
    g.expectEvents("cardPlayed", "turnStarted", "controlChanged");
  });

  it("R15 base: the first free zone when your same lane is occupied", () => {
    const g = scenario({
      p1: { hand: [KPOP, FILLER], field: [{ def: ROCK, lane: 2 }], library: [...LIBRARY] },
      p2: { hand: [FILLER], field: [{ def: SEVEN_SEVEN, lane: 2 }], library: [...LIBRARY] },
    });
    const prey = g.unit("p2", 2);
    if (prey === null) throw new Error("setup: p2 should hold the 7/7 in lane 2");
    // Kpop Fanatic takes the leftmost free zone, lane 1 (R64).
    g.play(KPOP, { targets: [{ pick: "instance", instanceId: prey.id }] });
    expect(g.unit("p1", 1)?.defId).toBe(KPOP);

    g.endTurn();
    g.endTurn();

    // Lanes 1 and 2 are taken, so `firstFreeZone` lands it in lane 3.
    expect(g.unit("p1", 3)?.id).toBe(prey.id);
  });

  it("R76 base: the steal fires even though Kpop Fanatic died in between", () => {
    const g = scenario({
      p1: { hand: [KPOP, FILLER], library: [...LIBRARY] },
      // The 7/7 carries 2 damage into the case. It cannot pick damage up in combat here: §8 row 25
      // prints Armor 7, so the 1 a 1/1 strikes back with is 0 after Armor and is not a damage
      // instance at all (§4.4 step 2, R63). Seeding it is the only way to have damage on the prey
      // before the steal, which is what makes the R78 claim below observable.
      p2: {
        hand: [FILLER],
        field: [{ def: SEVEN_SEVEN, lane: 2, damage: 2 }],
        library: [...LIBRARY],
      },
    });
    const prey = g.unit("p2", 2);
    if (prey === null) throw new Error("setup: p2 should hold the 7/7 in lane 2");
    g.play(KPOP, { targets: [{ pick: "instance", instanceId: prey.id }] });
    const fanatic = g.unit("p1", 1);
    if (fanatic === null) throw new Error("Kpop Fanatic should be in p1's lane 1");

    g.endTurn();
    // The 7/7 eats the 1/1 on the opponent's turn; it takes 1 back and stays on the field.
    g.attack(prey, fanatic);
    g.expectInZone(fanatic, "graveyard");
    expect(g.state.delayed).toHaveLength(1);

    g.endTurn();

    // R76: the continuation lives in `state.delayed`, not on the unit.
    expect(g.unit("p1", 2)?.id).toBe(prey.id);
    expect(g.card(prey).controller).toBe("p1");
    // A steal moves `controller` and nothing else: the card never leaves the field, so R78's reset
    // — which is about LEAVING it — does not run and the damage it was carrying is still there.
    expect(g.card(prey).damage).toBe(2);
  });

  it("R76 base: it fizzles when the target left the field", () => {
    const g = scenario({
      p1: { hand: [KPOP, FILLER], field: [{ def: ROCK, lane: 5 }], library: [...LIBRARY] },
      p2: { hand: [FILLER], field: [{ def: DUELIST, lane: 2 }], library: [...LIBRARY] },
    });
    const prey = g.unit("p2", 2);
    if (prey === null) throw new Error("setup: p2 should hold Deft Duelist in lane 2");
    g.play(KPOP, { targets: [{ pick: "instance", instanceId: prey.id }] });

    g.endTurn();
    // The 4/3 throws itself at a 10/10 Indestructible wall and dies.
    g.attack(prey, "core-066");
    g.expectInZone(prey, "graveyard");

    g.endTurn();

    // `steal` no-ops off the field (control means nothing there, R12), so nothing is taken.
    expect(g.pile("p2", "graveyard").some((card) => card.id === prey.id)).toBe(true);
    expect(g.unit("p1", 2)).toBeNull();
    expect(g.state.delayed).toHaveLength(0);
    expect(g.events.some((event) => event.type === "controlChanged")).toBe(false);
  });

  it("R76 base: it fizzles when the target is already under your control", () => {
    const g = scenario({
      p1: { hand: [KPOP, "core-049"], library: [...LIBRARY] },
      p2: { hand: [FILLER], field: [{ def: SEVEN_SEVEN, lane: 2 }], library: [...LIBRARY] },
    });
    const prey = g.unit("p2", 2);
    if (prey === null) throw new Error("setup: p2 should hold the 7/7 in lane 2");

    g.play(KPOP, { targets: [{ pick: "instance", instanceId: prey.id }] });
    // #49 takes the same permanent this turn, for 3 of the 4 mana left.
    g.play("core-049", { targets: [{ pick: "instance", instanceId: prey.id }] });
    expect(g.card(prey).controller).toBe("p1");

    g.endTurn();
    g.endTurn();

    expect(g.card(prey).controller).toBe("p1");
    expect(g.state.delayed).toHaveLength(0);
    // One steal, not two: `takeControl` refuses a card this player already controls.
    expect(g.events.filter((event) => event.type === "controlChanged")).toHaveLength(1);
  });

  it("radiant: Divine Shield eats the first hit, and the delayed steal lands with its rider (R282)", () => {
    const g = scenario({
      p1: { hand: [{ def: KPOP, radiant: true }, FILLER], library: [...LIBRARY] },
      p2: { hand: [FILLER], field: [{ def: DUELIST, lane: 3 }], library: [...LIBRARY] },
    });
    const prey = g.unit("p2", 3);
    if (prey === null) throw new Error("setup: p2 should hold Deft Duelist in lane 3");

    g.play(KPOP, { targets: [{ pick: "instance", instanceId: prey.id }] });
    const fanatic = g.unit("p1", 1);
    if (fanatic === null) throw new Error("Kpop Fanatic should be in p1's lane 1");
    g.expectStats(fanatic, { attack: 2, maxHealth: 2, health: 2 });
    expect(g.stats(fanatic).keywords.some((keyword) => keyword.kind === "Divine Shield")).toBe(true);

    g.endTurn();
    g.attack(prey, fanatic);

    // §6.1: the shield absorbs the whole hit, so a 4/3 attacker cannot kill the 2/2.
    g.expectEvents("divineShieldLost");
    g.expectInZone(fanatic, "field");
    expect(g.card(fanatic).damage).toBe(0);
    expect(g.card(fanatic).divineShieldSpent).toBe(true);
    // It still struck back for 2.
    expect(g.card(prey).damage).toBe(2);

    g.endTurn();

    expect(g.unit("p1", 3)?.id).toBe(prey.id);
    expect(g.card(prey).controller).toBe("p1");
    // R282: the stolen Duelist becomes Radiant in place (R22): the 8/6 face, its 2 damage kept.
    expect(g.card(prey).radiant).toBe(true);
    g.expectStats(prey, { attack: 8, maxHealth: 6, health: 4 });
  });

  it("radiant: the steal still fires after a radiant Kpop Fanatic dies (R76)", () => {
    // The radiant face is a 2/2 with Divine Shield, so killing it takes TWO hits — and R76 gives
    // the opponent exactly one turn in which to land them, because the steal resolves at p1's very
    // next start of turn. One attacker cannot do it (a unit has one attack exertion per turn,
    // §4.1), so p2 fields two: the Duelist pops the shield and the 7/7 finishes the job.
    const g = scenario({
      p1: { hand: [{ def: KPOP, radiant: true }, FILLER], library: [...LIBRARY] },
      p2: {
        hand: [FILLER],
        field: [
          { def: DUELIST, lane: 3 },
          { def: SEVEN_SEVEN, lane: 4 },
        ],
        library: [...LIBRARY],
      },
    });
    const prey = g.unit("p2", 4);
    const opener = g.unit("p2", 3);
    if (prey === null) throw new Error("setup: p2 should hold the 7/7 in lane 4");
    if (opener === null) throw new Error("setup: p2 should hold Deft Duelist in lane 3");
    g.play(KPOP, { targets: [{ pick: "instance", instanceId: prey.id }] });
    const fanatic = g.unit("p1", 1);
    if (fanatic === null) throw new Error("Kpop Fanatic should be in p1's lane 1");

    g.endTurn();
    // §6.1: the shield absorbs the whole first hit, so the 4/3 cannot kill the 2/2.
    g.attack(opener, fanatic);
    g.expectInZone(fanatic, "field");
    // The second hit lands on a shieldless 2/2 and kills it, on the same turn.
    g.attack(prey, fanatic);
    g.expectInZone(fanatic, "graveyard");

    g.endTurn();

    // R76: the delayed steal is state, not something the dead unit was holding.
    expect(g.unit("p1", 4)?.id).toBe(prey.id);
    expect(g.card(prey).controller).toBe("p1");
    // R282: and so is its rider — the face that ran the Cry is stored with the entry.
    expect(g.card(prey).radiant).toBe(true);
  });

  it("§8 Conventions: a Cry with nothing to choose fizzles and the unit still enters", () => {
    const g = scenario({ p1: { hand: [KPOP, FILLER], library: [...LIBRARY] } });

    g.play(KPOP);

    g.expectInZone(KPOP, "field");
    expect(g.state.delayed).toHaveLength(0);
  });

  it("R81, R282: both faces declare one enemy permanent and one resume step; only the step differs", () => {
    expect(def.id).toBe(KPOP);
    expect(def.type).toBe("Unit");
    expect(def.cost).toBe(1);
    expect(def.base).toMatchObject({ attack: 1, health: 1 });
    expect(def.radiant).toMatchObject({ attack: 2, health: 2 });
    // "Divine Shield" without "Plus" is the radiant form's whole keyword list (§8 Conventions).
    expect(def.radiant.keywords).toEqual([{ kind: "Divine Shield" }]);
    expect(def.base.keywords).toEqual([]);

    const decl = [{ kind: "target", min: 1, max: 1, filter: { side: "enemy", of: ["unit", "backrow"] } }];
    expect(base.targets).toEqual(decl);
    expect(radiant.targets).toEqual(decl);
    expect(base.modes).toBeUndefined();
    expect(typeof base.cry).toBe("function");
    expect(typeof radiant.cry).toBe("function");
    expect(typeof base.resume?.steal).toBe("function");
    // R282: the radiant face's step is its own — the steal plus "it becomes Radiant".
    expect(typeof radiant.resume?.steal).toBe("function");
    expect(radiant.resume?.steal).not.toBe(base.resume?.steal);
  });
});

/** Hand the turn over until `player` is the active one (R82 can end a turn with nothing left in it). */
function untilActive(g: Scenario, player: PlayerId): void {
  if (g.state.active !== player) g.endTurn();
  if (g.state.active !== player) g.endTurn();
  expect(g.state.active).toBe(player);
}

/** Whether any Make Radiant cue named this card (§10.3: every visible change is an event). */
function radiantSetOn(g: Scenario, instanceId: string): boolean {
  return g.events.some((event) => event.type === "radiantSet" && event.instanceId === instanceId);
}

const RADIANT_KPOP = { def: KPOP, radiant: true } as const;
const FLOOD = "core-017";
const CLONE_MACHINE = "core-033";
const MIND_CONTROL = "core-049";
const FIENDER = "core-092";
const VANILLA = "core-008";

describe("#50 Kpop Fanatic radiant — R282 the rider lands only on a card the steal took", () => {
  it("R282 the steal lands and the stolen unit becomes Radiant in place, its damage kept (R22)", () => {
    const g = scenario({
      p1: { hand: [RADIANT_KPOP, FILLER], library: [...LIBRARY] },
      p2: { hand: [FILLER], field: [{ def: SEVEN_SEVEN, lane: 2, damage: 2 }], library: [...LIBRARY] },
    });
    const prey = g.unit("p2", 2);
    if (prey === null) throw new Error("setup: p2 should hold the 7/7 in lane 2");
    g.play(KPOP, { targets: [{ pick: "instance", instanceId: prey.id }] });
    // Nothing becomes Radiant on the turn it is played: the rider rides the steal.
    expect(g.card(prey).radiant).toBe(false);

    g.endTurn();
    g.endTurn();

    expect(g.state.active).toBe("p1");
    expect(g.unit("p1", 2)?.id).toBe(prey.id);
    expect(g.card(prey).controller).toBe("p1");
    expect(g.card(prey).radiant).toBe(true);
    // #25's Radiant face: a 14/14 with Indestructible for Armor 7, the 2 damage still on it.
    g.expectStats(prey, { attack: 14, maxHealth: 14, health: 12 });
    expect(g.stats(prey).keywords.map((keyword) => keyword.kind)).toEqual(["Indestructible"]);
    g.expectEvents("turnStarted", "controlChanged", "radiantSet");
  });

  it("R282 a stolen Field Spell becomes Radiant too: a permanent is either row (§6.3)", () => {
    const g = scenario({
      p1: { hand: [RADIANT_KPOP, FILLER], library: [...LIBRARY] },
      p2: { hand: [FILLER], field: [VANILLA], backrow: [{ def: CLONE_MACHINE, lane: 3 }], library: [...LIBRARY] },
    });
    const prey = g.backrow("p2", 3);
    if (prey === null) throw new Error("setup: p2 should hold the Clone Machine in backrow lane 3");
    g.play(KPOP, { targets: [{ pick: "instance", instanceId: prey.id }] });

    g.endTurn();
    g.endTurn();

    expect(g.state.active).toBe("p1");
    expect(g.backrow("p1", 3)?.id).toBe(prey.id);
    expect(g.card(prey).controller).toBe("p1");
    expect(g.card(prey).radiant).toBe(true);
  });

  it("R282 a target that died before the steal is not made Radiant in the graveyard (R76)", () => {
    const g = scenario({
      p1: { hand: [RADIANT_KPOP, FILLER], field: [{ def: ROCK, lane: 5 }], library: [...LIBRARY] },
      p2: { hand: [FILLER], field: [{ def: DUELIST, lane: 2 }], library: [...LIBRARY] },
    });
    const prey = g.unit("p2", 2);
    if (prey === null) throw new Error("setup: p2 should hold Deft Duelist in lane 2");
    g.play(KPOP, { targets: [{ pick: "instance", instanceId: prey.id }] });

    g.endTurn();
    // The 4/3 throws itself at a 10/10 Indestructible wall and dies.
    g.attack(prey, ROCK);
    g.expectInZone(prey, "graveyard");
    g.endTurn();

    expect(g.state.active).toBe("p1");
    g.expectInZone(prey, "graveyard");
    expect(g.card(prey).radiant).toBe(false);
    expect(radiantSetOn(g, prey.id)).toBe(false);
    expect(g.state.delayed).toHaveLength(0);
  });

  it("R282 a target bounced to its owner's hand is not made Radiant there, where p1 may not read it (R174)", () => {
    const g = scenario({
      p1: { hand: [RADIANT_KPOP, FILLER], field: [{ def: VANILLA, lane: 1 }], library: [...LIBRARY] },
      p2: { hand: [FLOOD, FILLER], field: [{ def: SEVEN_SEVEN, lane: 2 }], library: [...LIBRARY] },
    });
    const prey = g.unit("p2", 2);
    if (prey === null) throw new Error("setup: p2 should hold the 7/7 in lane 2");
    g.play(KPOP, { targets: [{ pick: "instance", instanceId: prey.id }] });
    g.endTurn();

    // #17 Flood bounces every unit on both sides, the prey into p2's hand.
    g.play(FLOOD);
    g.expectInZone(prey, "hand");
    untilActive(g, "p1");

    g.expectInZone(prey, "hand");
    expect(g.card(prey).controller).toBe("p2");
    expect(g.card(prey).radiant).toBe(false);
    expect(radiantSetOn(g, prey.id)).toBe(false);
    expect(g.state.delayed).toHaveLength(0);
  });

  it("R282 a target bounced and replayed is a new arrival: neither stolen nor made Radiant (R174, R78)", () => {
    const g = scenario({
      p1: { hand: [RADIANT_KPOP, FILLER], field: [{ def: VANILLA, lane: 1 }], library: [...LIBRARY] },
      p2: { hand: [FLOOD, FILLER], field: [{ def: VANILLA, lane: 2 }], library: [...LIBRARY] },
    });
    const prey = g.unit("p2", 2);
    if (prey === null) throw new Error("setup: p2 should hold Mr. Vanilla in lane 2");
    g.play(KPOP, { targets: [{ pick: "instance", instanceId: prey.id }] });
    g.endTurn();

    g.play(FLOOD);
    g.play(prey, { zone: 2 });
    expect(g.unit("p2", 2)?.id).toBe(prey.id);
    untilActive(g, "p1");

    expect(g.unit("p2", 2)?.id).toBe(prey.id);
    expect(g.card(prey).controller).toBe("p2");
    expect(g.card(prey).radiant).toBe(false);
    expect(radiantSetOn(g, prey.id)).toBe(false);
  });

  it("R282 a target dormant under a Stack pile is neither taken nor made Radiant, nor is the card on top (R13)", () => {
    const g = scenario({
      p1: { hand: [RADIANT_KPOP, FILLER], field: [{ def: VANILLA, lane: 1 }], library: [...LIBRARY] },
      p2: { hand: [FIENDER, FILLER], field: [{ def: SEVEN_SEVEN, lane: 2 }], library: [...LIBRARY] },
    });
    const prey = g.unit("p2", 2);
    if (prey === null) throw new Error("setup: p2 should hold the 7/7 in lane 2");
    g.play(KPOP, { targets: [{ pick: "instance", instanceId: prey.id }] });
    g.endTurn();

    // p2 stacks Felinor Fiender onto the prey's zone: the prey is dormant (§3.2, R13).
    g.play(FIENDER, { zone: 2 });
    const fiender = g.unit("p2", 2);
    if (fiender === null || fiender.defId !== FIENDER) throw new Error("the Fiender should top lane 2");
    untilActive(g, "p1");

    expect(g.card(prey).controller).toBe("p2");
    expect(g.card(prey).radiant).toBe(false);
    expect(g.card(fiender).controller).toBe("p2");
    expect(g.card(fiender).radiant).toBe(false);
    expect(g.events.some((event) => event.type === "radiantSet")).toBe(false);
  });

  it("R282 a target already this player's is not made Radiant: the delayed steal took nothing (R76)", () => {
    const g = scenario({
      p1: { hand: [RADIANT_KPOP, MIND_CONTROL], library: [...LIBRARY] },
      p2: { hand: [FILLER], field: [{ def: SEVEN_SEVEN, lane: 2 }], library: [...LIBRARY] },
    });
    const prey = g.unit("p2", 2);
    if (prey === null) throw new Error("setup: p2 should hold the 7/7 in lane 2");
    g.play(KPOP, { targets: [{ pick: "instance", instanceId: prey.id }] });
    // Base #49 takes the same permanent this turn, with no rider of its own.
    g.play(MIND_CONTROL, { targets: [{ pick: "instance", instanceId: prey.id }] });
    expect(g.card(prey).controller).toBe("p1");

    untilActive(g, "p2");
    untilActive(g, "p1");

    expect(g.card(prey).controller).toBe("p1");
    expect(g.card(prey).radiant).toBe(false);
    expect(radiantSetOn(g, prey.id)).toBe(false);
    expect(g.events.filter((event) => event.type === "controlChanged")).toHaveLength(1);
  });

  it("R282 a full row keeps the target with the opponent, and it is not made Radiant (R15)", () => {
    const g = scenario({
      p1: {
        hand: [RADIANT_KPOP, FILLER],
        field: [VANILLA, VANILLA, VANILLA, VANILLA],
        library: [...LIBRARY],
      },
      p2: { hand: [FILLER], field: [{ def: SEVEN_SEVEN, lane: 2 }], library: [...LIBRARY] },
    });
    const prey = g.unit("p2", 2);
    if (prey === null) throw new Error("setup: p2 should hold the 7/7 in lane 2");
    // Kpop Fanatic takes p1's last free zone, lane 5.
    g.play(KPOP, { targets: [{ pick: "instance", instanceId: prey.id }] });
    expect(g.unit("p1", 5)?.defId).toBe(KPOP);

    g.endTurn();
    g.endTurn();

    expect(g.state.active).toBe("p1");
    expect(g.unit("p2", 2)?.id).toBe(prey.id);
    expect(g.card(prey).controller).toBe("p2");
    expect(g.card(prey).radiant).toBe(false);
    expect(radiantSetOn(g, prey.id)).toBe(false);
    expect(g.state.delayed).toHaveLength(0);
  });
});

const SAINTESS = "core-081";
const SURGERY = "core-063";

describe("#50 Kpop Fanatic — a Radiant flip on the field adds Divine Shield (§5.2)", () => {
  it("§5.2 a base #50 whose granted Divine Shield was spent gets its radiant face's Divine Shield when #81 radiates it", () => {
    // #63 Plastic Surgery grants one random keyword (R21); pick the cursor whose roll is Divine
    // Shield, the only way a base #50 (no keywords) ever has one.
    let s: Scenario | null = null;
    for (let cursor = 0; cursor < 200 && s === null; cursor += 1) {
      const trial = scenario({
        seed: "r5-ds-flip",
        p1: { hand: [SURGERY, MENACE], field: [KPOP, SAINTESS], mana: 20 },
        p2: { field: [MENACE] },
      });
      trial.state.rngCursor = cursor;
      trial.play(SURGERY, { targets: [{ pick: "instance", instanceId: trial.card(KPOP).id }] });
      if (trial.stats(KPOP).keywords.some((k) => k.kind === "Divine Shield")) s = trial;
    }
    if (s === null) throw new Error("no cursor below 200 grants #50 Divine Shield");
    const kpop = s.card(KPOP);
    const menace = s.unit("p2", 1);
    if (menace === null) throw new Error("p2's #19");

    // The granted shield takes #19's strike back and is spent (§6.1).
    s.attack(kpop, menace);
    expect(s.card(kpop).damage).toBe(0);
    expect(s.stats(kpop).keywords.some((k) => k.kind === "Divine Shield")).toBe(false);

    // #81 dies to #19 and its Death makes p1's other units Radiant: #50's radiant face prints
    // Divine Shield, a keyword its base face does not have, so it applies at once (§5.2) — the same
    // way a spent shield comes back when the keyword is granted again (§10.4, `grantTo`).
    s.attack(SAINTESS, menace);
    expect(s.card(kpop).radiant).toBe(true);
    expect(s.stats(kpop).keywords.map((k) => k.kind)).toContain("Divine Shield");

    // And it works as one: on p2's turn #19's 9 is negated whole, where the radiant 5/5 would die.
    s.endTurn();
    s.attack(menace, kpop);
    s.expectInZone(kpop, "field");
    expect(s.card(kpop).damage).toBe(0);
  });
});
