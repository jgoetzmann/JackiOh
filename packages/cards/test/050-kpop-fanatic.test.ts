// #50 Kpop Fanatic — SPEC §8.2, BUILD M4-T4: "Steal fires at your next start of turn even if it
// died (R76); fizzles if the target left; radiant Divine Shield".
//
// Every case here crosses a turn boundary, so both sides keep a card in hand, a unit on the board
// and a few library cards: the engine auto-ends a turn with nothing meaningful left (R82, and the
// harness header), and an empty library would add fatigue damage to the assertions.
//
// The sequence is always the same and is what R62 is about: `endTurn()` hands the turn to the
// opponent, who really takes one, and the second `endTurn()` comes back to this player's own start
// of turn, where `turn.runDelayed` resolves the entry before any start-of-turn trigger fires.
//
// !! BLOCKED — the `delay` verb does not exist in `engine/src/effects` (see the card file's header
// for the signature this is written against). Until it lands, every case that plays Kpop Fanatic
// fails at the Cry, and `turn.runDelayed` also has to re-enter the continuation through
// `prompts.runResume` rather than `resolve.runHook` for the `resume` step table to be reachable at
// all. Both are reported with this card; nothing is worked around here.
//
// Props with no script beyond printed keywords: #25 4-mana 7/7 (the steal target and the attacker
// that kills a 1/1), #45 Deft Duelist (4/3 → 8/6, the target that dies into The Rock), #66 The Rock
// (10/10 Indestructible, the wall), #16 Hit Job and #8 Mr. Vanilla as inert hand and library cards.

import { describe, expect, it } from "vitest";
import { scenario } from "./_harness";
import { base, def, radiant } from "../src/scripts/050-kpop-fanatic";

const KPOP = "core-050";
const SEVEN_SEVEN = "core-025";
const DUELIST = "core-045";
const ROCK = "core-066";
const FILLER = "core-016";
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

  it("radiant: Divine Shield eats the first hit, and the delayed steal is unchanged (\"same\")", () => {
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
  });

  it("§8 Conventions: a Cry with nothing to choose fizzles and the unit still enters", () => {
    const g = scenario({ p1: { hand: [KPOP, FILLER], library: [...LIBRARY] } });

    g.play(KPOP);

    g.expectInZone(KPOP, "field");
    expect(g.state.delayed).toHaveLength(0);
  });

  it("R74, R81: one script for both faces, declaring one enemy permanent and one resume step", () => {
    expect(def.id).toBe(KPOP);
    expect(def.type).toBe("Unit");
    expect(def.cost).toBe(1);
    expect(def.base).toMatchObject({ attack: 1, health: 1 });
    expect(def.radiant).toMatchObject({ attack: 2, health: 2 });
    // "Divine Shield" without "Plus" is the radiant form's whole keyword list (§8 Conventions).
    expect(def.radiant.keywords).toEqual([{ kind: "Divine Shield" }]);
    expect(def.base.keywords).toEqual([]);

    // "same": the radiant text is the base text, so it is the same script.
    expect(radiant).toBe(base);
    expect(base.targets).toEqual([
      { kind: "target", min: 1, max: 1, filter: { side: "enemy", of: ["unit", "backrow"] } },
    ]);
    expect(base.modes).toBeUndefined();
    expect(typeof base.cry).toBe("function");
    expect(typeof base.resume?.steal).toBe("function");
  });
});
