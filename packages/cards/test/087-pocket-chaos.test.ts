// #87 Pocket Chaos (SPEC §8.5, BUILD M4-T4 row 87): "Health swap, lane-preserving board swap
// including face-down traps with locks staying put, library swap that transfers ownership of the
// swapped cards (R73); opponent gains a Pocket Chaos; exiled; radiant may skip the gift". R275 adds a
// draw to the radiant face: "…; then you may add a Pocket Chaos to the opponent's hand; draw 1;
// exile this".

import { describe, expect, it } from "vitest";
import { isLocked, lockZone } from "@jackioh/engine";
import { scenario } from "./_harness";
import { base, radiant } from "../src/scripts/087-pocket-chaos";

const CHAOS = "core-087";

// Inert fixtures: every unit below has a Cry and nothing else, and the harness's `field` setup
// never fires a Cry. Sheepish is a Trap that watches for a Unit the opponent plays, so a Spell
// never sets it off — which makes it a stable face-down card to swap.
const GARY = "core-004"; // 1/1
const RENO = "core-053"; // 4/6
const POSTDOC = "core-061"; // 2/4
const SHEEPISH = "core-041"; // Trap
const MANA_WELL = "core-006"; // Field Spell; start-of-turn only

// §2.5: one always-playable card per hand keeps a scenario on the turn it started on.
const FILLER = "core-005";

const SEED = "chaos-87";

describe("#87 Pocket Chaos — declared play choices (R81, §10.6)", () => {
  it("R81 declares the Choose one as a play-time mode, not a prompt", () => {
    expect(base.modes).toEqual([{ kind: "mode", options: ["health", "board", "library"] }]);
    // The base face has exactly one choice: the gift is unconditional.
    expect(base.modes).toHaveLength(1);
  });

  it("R81 the radiant face declares a second mode for the optional gift", () => {
    expect(radiant.modes).toEqual([
      { kind: "mode", options: ["health", "board", "library"] },
      { kind: "mode", options: ["gift", "skip"] },
    ]);
  });
});

describe("#87 Pocket Chaos — base", () => {
  it("R73 swaps the two heroes' health and leaves each hero's armor where it was", () => {
    const s = scenario({
      seed: SEED,
      p1: { hand: [CHAOS, FILLER], health: 12, armor: 2 },
      p2: { hand: [FILLER], health: 25, armor: 0 },
    });
    const self = s.card(CHAOS);

    s.play(self, { modes: ["health"] });

    s.expectHealth("p1", 25).expectHealth("p2", 12);
    // R73: "armor stays with its hero", and this is not damage or "lose health" (R18).
    expect(s.state.players.p1.hero.armor).toBe(2);
    expect(s.state.players.p2.hero.armor).toBe(0);
    s.expectEvents("cardPlayed", "swapped");
  });

  it("then adds a Pocket Chaos to the opponent's hand and exiles this one", () => {
    const s = scenario({
      seed: SEED,
      p1: { hand: [CHAOS, FILLER], health: 12 },
      p2: { hand: [FILLER], health: 25 },
    });
    const self = s.card(CHAOS);

    s.play(self, { modes: ["health"] });

    // The gift is a fresh, non-Radiant instance owned by the opponent.
    const gifts = s.hand("p2").filter((card) => card.defId === CHAOS);
    expect(gifts).toHaveLength(1);
    expect(gifts[0]?.owner).toBe("p2");
    expect(gifts[0]?.radiant).toBe(false);
    expect(gifts[0]?.id).not.toBe(self.id);

    // §8.5: "exile this". The play pipeline must not then send it on to the graveyard.
    s.expectInZone(self, "exile").expectEvents("swapped", "addedToHand", "exiled");
    expect(s.state.counters.exiled).toBe(1);
  });

  it("the base face draws nothing: the draw is the radiant face's", () => {
    const s = scenario({
      seed: SEED,
      p1: { hand: [CHAOS, FILLER], library: [GARY, RENO] },
      p2: { hand: [FILLER] },
    });

    s.play(CHAOS, { modes: ["health"] });

    expect(s.events.some((event) => event.type === "drawn")).toBe(false);
    expect(s.pile("p1", "library").map((card) => card.defId)).toEqual([GARY, RENO]);
    expect(s.hand("p1").map((card) => card.defId)).toEqual([FILLER]);
  });

  it("R73 swaps the board lane by lane in both rows: control changes, ownership does not", () => {
    const s = scenario({
      seed: SEED,
      p1: {
        hand: [CHAOS, FILLER],
        field: [{ def: GARY, lane: 1 }],
        backrow: [{ def: SHEEPISH, lane: 2 }],
      },
      p2: {
        hand: [FILLER],
        field: [{ def: RENO, lane: 3 }],
        backrow: [{ def: MANA_WELL, lane: 4 }],
      },
    });
    const gary = s.card(GARY);
    const reno = s.card(RENO);
    const trap = s.card(SHEEPISH);
    const well = s.card(MANA_WELL);

    s.play(CHAOS, { modes: ["board"] });

    // Lane-preserving: the same row and lane on the other side of the centre line.
    expect(s.unit("p2", 1)?.id).toBe(gary.id);
    expect(s.unit("p1", 1)).toBeNull();
    expect(s.unit("p1", 3)?.id).toBe(reno.id);
    expect(s.unit("p2", 3)).toBeNull();
    expect(s.backrow("p2", 2)?.id).toBe(trap.id);
    expect(s.backrow("p1", 2)).toBeNull();
    expect(s.backrow("p1", 4)?.id).toBe(well.id);
    expect(s.backrow("p2", 4)).toBeNull();

    // R12, R73: control changed for everything; ownership changed for nothing.
    expect(s.card(gary).controller).toBe("p2");
    expect(s.card(gary).owner).toBe("p1");
    expect(s.card(reno).controller).toBe("p1");
    expect(s.card(reno).owner).toBe("p2");
    expect(s.card(trap).controller).toBe("p2");
    expect(s.card(trap).owner).toBe("p1");
  });

  it("R33 a swapped face-down trap stays face-down and only its new controller may read it", () => {
    const s = scenario({
      seed: SEED,
      p1: { hand: [CHAOS, FILLER], backrow: [{ def: SHEEPISH, lane: 2 }] },
      p2: { hand: [FILLER] },
    });
    const trap = s.card(SHEEPISH);

    s.play(CHAOS, { modes: ["board"] });

    // `faceUp` is untouched by a swap: the card is still hidden, just on the other side.
    expect(s.card(trap).faceUp).not.toBe(true);
    expect(s.card(trap).controller).toBe("p2");

    // §10.8: readability keys on the controller, so p2 now reads it and p1 no longer does.
    const forP2 = s.view("p2").you.backrow[1];
    const forP1 = s.view("p1").opponent.backrow[1];
    expect(forP2?.faceDown).toBe(false);
    expect(forP1?.faceDown).toBe(true);
  });

  it("R88 locks stay with their zones, so a card whose destination is Locked bounces home", () => {
    const s = scenario({
      seed: SEED,
      p1: { hand: [CHAOS, FILLER], field: [{ def: GARY, lane: 1 }] },
      p2: { hand: [FILLER] },
    });
    const gary = s.card(GARY);
    // A Locked zone is ordinary state (#36 Magic Jammed locks one); this seeds it directly.
    lockZone(s.state, { player: "p2", row: "units", lane: 1 });

    s.play(CHAOS, { modes: ["board"] });

    // R88, following R14: an ordinary return to the owner's hand.
    s.expectInZone(gary, "hand");
    expect(s.hand("p1").some((card) => card.id === gary.id)).toBe(true);
    expect(s.unit("p2", 1)).toBeNull();
    // The lock is a zone flag: it neither travelled nor was cleared.
    expect(isLocked(s.state, { player: "p2", row: "units", lane: 1 })).toBe(true);
    expect(isLocked(s.state, { player: "p1", row: "units", lane: 1 })).toBe(false);
    s.expectEvents("swapped", "bounced");
  });

  it("R73 swaps the libraries whole and in order, and each swapped card changes owner (R12)", () => {
    const s = scenario({
      seed: SEED,
      p1: { hand: [CHAOS, FILLER], library: [GARY] },
      p2: { hand: [FILLER], library: [RENO, POSTDOC] },
    });

    s.play(CHAOS, { modes: ["library"] });

    // The piles changed places whole, keeping their order: library[0] is still the next draw.
    expect(s.pile("p1", "library").map((card) => card.defId)).toEqual([RENO, POSTDOC]);
    expect(s.pile("p2", "library").map((card) => card.defId)).toEqual([GARY]);

    // R12's one exception: the owner of a swapped library card becomes the player holding it.
    expect(s.pile("p1", "library").every((card) => card.owner === "p1")).toBe(true);
    expect(s.pile("p1", "library").every((card) => card.controller === "p1")).toBe(true);
    expect(s.pile("p2", "library")[0]?.owner).toBe("p2");

    // §2.4: fatigue belongs to the player, not the library.
    expect(s.state.players.p1.fatigueCount).toBe(0);
    expect(s.state.players.p2.fatigueCount).toBe(0);
  });

  it("§6.3 a play naming no swap mode fizzles that clause; the gift and the exile still happen", () => {
    const s = scenario({
      seed: SEED,
      p1: { hand: [CHAOS, FILLER], health: 12 },
      p2: { hand: [FILLER], health: 25 },
    });
    const self = s.card(CHAOS);

    // `playChoices` refuses a play that answers a declared mode with nothing, which is the engine's
    // own guard; the script's fizzle is the second line of defence §8's Conventions ask for.
    expect(() => s.play(self, { modes: [] })).toThrow(/mode/);
    s.expectHealth("p1", 12).expectHealth("p2", 25);
  });
});

describe("#87 Pocket Chaos — radiant", () => {
  it("may skip adding it: the swap, the draw and the exile still happen, the opponent gains nothing", () => {
    const s = scenario({
      seed: SEED,
      p1: { hand: [{ def: CHAOS, radiant: true }, FILLER], health: 12, library: [GARY] },
      p2: { hand: [FILLER], health: 25 },
    });
    const self = s.card(CHAOS);

    s.play(self, { modes: ["health", "skip"] });

    s.expectHealth("p1", 25).expectHealth("p2", 12);
    expect(s.hand("p2").filter((card) => card.defId === CHAOS)).toHaveLength(0);
    expect(s.hand("p1").map((card) => card.defId)).toEqual([FILLER, GARY]);
    s.expectInZone(self, "exile").expectEvents("swapped", "drawn", "exiled");
  });

  it("R275 draw 1 comes after the gift and before the exile", () => {
    const s = scenario({
      seed: SEED,
      p1: { hand: [{ def: CHAOS, radiant: true }, FILLER], library: [GARY, RENO] },
      p2: { hand: [FILLER] },
    });
    const self = s.card(CHAOS);

    s.play(self, { modes: ["health", "gift"] });

    s.expectEvents("swapped", "addedToHand", "drawn", "exiled");
    // Exactly one card: the top of the caster's library.
    expect(s.events.filter((event) => event.type === "drawn")).toHaveLength(1);
    expect(s.hand("p1").map((card) => card.defId)).toEqual([FILLER, GARY]);
    expect(s.pile("p1", "library").map((card) => card.defId)).toEqual([RENO]);
    s.expectInZone(self, "exile");
  });

  it('"gift" is still an option, the radiant copy hands over a base one, and the draw is from the swapped library', () => {
    const s = scenario({
      seed: SEED,
      p1: { hand: [{ def: CHAOS, radiant: true }, FILLER], library: [GARY] },
      p2: { hand: [FILLER], library: [RENO, POSTDOC] },
    });
    const self = s.card(CHAOS);

    s.play(self, { modes: ["library", "gift"] });

    const gifts = s.hand("p2").filter((card) => card.defId === CHAOS);
    expect(gifts).toHaveLength(1);
    // R57's "a copy carries the radiant flag" is about copies of an existing card; the gift is a
    // fresh card, and neither #87's text nor its radiant cell makes it Radiant.
    expect(gifts[0]?.radiant).toBe(false);
    // R73: the libraries swapped first, so the draw takes the top of what was p2's library, and the
    // drawn card is p1's now (R12's exception).
    const drawn = s.hand("p1").find((card) => card.defId === RENO);
    expect(drawn?.owner).toBe("p1");
    expect(s.pile("p1", "library").map((card) => card.defId)).toEqual([POSTDOC]);
    expect(s.pile("p2", "library").map((card) => card.defId)).toEqual([GARY]);
    s.expectInZone(self, "exile");
  });

  it("skipping the gift does not skip the board swap either", () => {
    const s = scenario({
      seed: SEED,
      p1: {
        hand: [{ def: CHAOS, radiant: true }, FILLER],
        field: [{ def: GARY, lane: 2 }],
        library: [RENO],
      },
      p2: { hand: [FILLER] },
    });
    const self = s.card(CHAOS);
    const gary = s.card(GARY);

    s.play(self, { modes: ["board", "skip"] });

    expect(s.unit("p2", 2)?.id).toBe(gary.id);
    expect(s.card(gary).controller).toBe("p2");
    expect(s.hand("p2").filter((card) => card.defId === CHAOS)).toHaveLength(0);
    // The draw is still the caster's, board swap or not.
    expect(s.hand("p1").map((card) => card.defId)).toEqual([FILLER, RENO]);
  });

  it("§2.4 an empty library makes the radiant draw a fatigue hit", () => {
    const s = scenario({
      seed: SEED,
      p1: { hand: [{ def: CHAOS, radiant: true }, FILLER], health: 12 },
      p2: { hand: [FILLER], health: 25 },
    });

    s.play(CHAOS, { modes: ["health", "skip"] });

    // Health swapped to 25, then the first fatigue draw deals 1.
    s.expectHealth("p1", 24).expectHealth("p2", 12);
  });
});

describe("#87 Pocket Chaos — R312 the owners' library lists", () => {
  it("R312 a swapped library is unknown to its new owner, on both sides", () => {
    const s = scenario({
      seed: SEED,
      p1: { hand: [CHAOS, FILLER], library: [GARY] },
      p2: { hand: [FILLER], library: [RENO, POSTDOC] },
    });
    expect(s.view("p1").you.library).toEqual({ cards: [{ defId: GARY, radiant: false, count: 1 }], unknown: 0 });

    s.play(CHAOS, { modes: ["library"] });

    // Each player now holds the other's old library, and was shown none of it.
    expect(s.view("p1").you.library).toEqual({ cards: [], unknown: 2 });
    expect(s.view("p2").you.library).toEqual({ cards: [], unknown: 1 });
    const mine = JSON.stringify(s.view("p1"));
    expect(mine).not.toContain(`"${RENO}"`);
    expect(mine).not.toContain(`"${POSTDOC}"`);
    expect(JSON.stringify(s.view("p2"))).not.toContain(`"${GARY}"`);
  });
});
