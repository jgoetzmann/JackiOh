// #36 Magic Jammed (SPEC §8.2, BUILD M4-T4): "Destroy backrow and lock zone, locked zone rejects
// play; radiant steals into same-lane zone else first free, original zone locked, trap identity
// visible to thief (R33)."

import { describe, expect, it } from "vitest";
import type { Selection } from "@jackioh/shared";
import { base, def, radiant } from "../src/scripts/036-magic-jammed";
import { scenario } from "./_harness";

const MAGIC_JAMMED = "core-036";
/** A Field Spell: a public backrow card (§3.2). */
const MANA_WELL = "core-006";
/** A Trap: face-down in the backrow, so R33 has something to hide (§3.2). */
const SHEEPISH = "core-041";
/** A spare hand card, so no side runs out of meaningful actions and auto-ends its turn. */
const SPARE = "core-005";

const pick = (instanceId: string): Selection[] => [{ pick: "instance", instanceId }];

describe("#36 Magic Jammed", () => {
  it("is §8.2's #36: a 1-cost Spell", () => {
    expect(def.index).toBe("36");
    expect(def.type).toBe("Spell");
    expect(def.cost).toBe(1);
  });

  it("R81 declares its backrow target as a play-time choice, unnarrowed by side", () => {
    // §8 Conventions: "target" is either side unless the cell narrows it, and neither cell does.
    for (const face of [base, radiant]) {
      expect(face.targets).toEqual([
        { kind: "target", min: 1, max: 1, filter: { side: "any", of: ["backrow"] } },
      ]);
    }
  });

  it("base destroys the target backrow card and locks its zone (§3.2 Lock)", () => {
    const s = scenario({
      p1: { hand: [MAGIC_JAMMED, SPARE], library: [SPARE] },
      p2: { backrow: [{ def: MANA_WELL, lane: 3 }], hand: [SPARE], library: [SPARE] },
    });
    const target = s.backrow("p2", 3);
    expect(target, "setup should have put Mana Well in p2's backrow lane 3").not.toBeNull();

    s.play(MAGIC_JAMMED, { targets: pick((target as { id: string }).id) });

    s.expectInZone(target as never, "graveyard");
    expect(s.backrow("p2", 3)).toBeNull();
    // §3.2: the lock lives on the zone and outlives its occupant.
    expect(s.state.players.p2.locks.backrow[2]).toBe(true);
    // R81: the target travelled with the play, so resolution never paused.
    expect(s.state.pending).toBeNull();
  });

  it("base's locked zone rejects a later play into it (§3.2)", () => {
    const s = scenario({
      p1: { hand: [MAGIC_JAMMED, SPARE], library: [SPARE, SPARE] },
      p2: { backrow: [{ def: MANA_WELL, lane: 3 }], hand: [MANA_WELL, SPARE], library: [SPARE, SPARE] },
    });
    const target = s.backrow("p2", 3) as { id: string };

    s.play(MAGIC_JAMMED, { targets: pick(target.id) }).endTurn();

    // p2 is active now and holds a Field Spell; lane 3 is the zone Magic Jammed locked.
    expect(() => s.play(MANA_WELL, { zone: 3 })).toThrow(/not open/);
    // Every other backrow zone still takes it.
    s.play(MANA_WELL, { zone: 4 });
    expect(s.backrow("p2", 4)).not.toBeNull();
  });

  it("radiant steals the target into the same lane and locks its ORIGINAL zone (R15, §3.2)", () => {
    const s = scenario({
      p1: { hand: [{ def: MAGIC_JAMMED, radiant: true }, SPARE], library: [SPARE] },
      p2: { backrow: [{ def: SHEEPISH, lane: 2 }], hand: [SPARE], library: [SPARE] },
    });
    const target = s.backrow("p2", 2) as { id: string };

    s.play(MAGIC_JAMMED, { targets: pick(target.id) });

    // R15: the same lane on the thief's side, because it was free.
    expect(s.backrow("p1", 2)?.id).toBe(target.id);
    expect(s.backrow("p2", 2)).toBeNull();
    expect(s.card(target.id).controller).toBe("p1");
    // R12: control moved, ownership did not.
    expect(s.card(target.id).owner).toBe("p2");
    // "Lock its original zone": the zone it came from, not the one it landed in.
    expect(s.state.players.p2.locks.backrow[1]).toBe(true);
    expect(s.state.players.p1.locks.backrow[1]).toBe(false);
    // Steal, not destroy: the card is still on the field.
    s.expectInZone(target.id, "field");
  });

  it("radiant steals into the first free zone when the same lane is taken (R15)", () => {
    const s = scenario({
      p1: {
        hand: [{ def: MAGIC_JAMMED, radiant: true }, SPARE],
        backrow: [
          { def: MANA_WELL, lane: 1 },
          { def: MANA_WELL, lane: 2 },
        ],
        library: [SPARE],
      },
      p2: { backrow: [{ def: SHEEPISH, lane: 2 }], hand: [SPARE], library: [SPARE] },
    });
    const target = s.backrow("p2", 2) as { id: string };

    s.play(MAGIC_JAMMED, { targets: pick(target.id) });

    // Lane 2 is occupied on p1's side, so R15 falls through to the leftmost free zone.
    expect(s.backrow("p1", 3)?.id).toBe(target.id);
    expect(s.state.players.p2.locks.backrow[1]).toBe(true);
  });

  it("R33 the thief reads a stolen face-down trap and its owner stops reading it", () => {
    const s = scenario({
      p1: { hand: [{ def: MAGIC_JAMMED, radiant: true }, SPARE], library: [SPARE] },
      p2: { backrow: [{ def: SHEEPISH, lane: 2 }], hand: [SPARE], library: [SPARE] },
    });
    const target = s.backrow("p2", 2) as { id: string };

    // Before: p2 controls it and reads it; p1 sees a face-down marker and nothing else (§10.8).
    expect(s.view("p2").you.backrow[1]).toMatchObject({ faceDown: false, defId: SHEEPISH });
    expect(s.view("p1").opponent.backrow[1]).toEqual({ faceDown: true });

    s.play(MAGIC_JAMMED, { targets: pick(target.id) });

    // After: R33 keys readability on the CONTROLLER, so the thief reads it even though p2 owns it.
    expect(s.view("p1").you.backrow[1]).toMatchObject({
      faceDown: false,
      defId: SHEEPISH,
      owner: "p2",
      controller: "p1",
    });
    expect(s.view("p2").opponent.backrow[1]).toEqual({ faceDown: true });
  });
});
