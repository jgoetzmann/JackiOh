// #90 CN-Viral Injection and #90.1 CN-Virus (SPEC §8 rows 90 / 90.1, §7, §2.4, §4.4, §9.2;
// R11, R12, R57, R58, R63, R70, R80).
//
// BUILD M4-T4 row 90:   "Virus shuffled into the opponent's library at a random position; radiant
//                        virus is radiant".
// BUILD M4-T4 row 90.1: "On draw: 1 damage through the pipeline (Going Long reduces it), 2 copies
//                        shuffled, draw again; a chain stops at 20 casts (R58); radiant 3 copies".
//                        R275 scales the radiant face's damage too: "take 2 damage; 3 copies".
//
// The two cards are tested in one file because #90's whole effect is to hand #90.1 to the OTHER
// player: ownership (R12) is what makes the token's cast-on-draw chain run on the opponent's draws
// and damage the opponent's hero, so "who owns the virus" is asserted on #90 and "what the virus
// does to its owner" on #90.1.
//
// R11 is the difference from every unit token in the game: #90.1 is a SPELL token, so it lives in
// a hand and a library like a real card and reaches the graveyard after resolving. A card that
// ceased to exist is tagged `gone`, never `exile` (R86), and nothing here is ever `gone`.
//
// Two routes reach the virus's script and both are tested: playing it from hand (its `cry` alone,
// with no draw around it) and drawing it (`staticFlags.castOnDraw`, which is where R58's chain cap
// lives). CAST_ON_DRAW_CHAIN_CAP is 20 and HERO_HEALTH is 30, so a library of nothing but viruses
// costs its owner exactly 20 health and leaves the 21st virus in hand uncast.

import { describe, expect, it } from "vitest";
import type { PlayerId } from "@jackioh/shared";
import { scenario, type Scenario } from "./_harness";
import { query } from "../src/query";

const INJECTION = "core-090";
const VIRUS = "core-090-1";

/** R58's cap, restated from `engine/src/config.ts` so a change to it fails here by name. */
const CHAIN_CAP = 20;
/** R80's cap, likewise. */
const LIBRARY_CAP = 60;

function shuffledIn(s: Scenario, player?: PlayerId): { defId: string; position: number; player: PlayerId }[] {
  return s.events.flatMap((event) =>
    event.type === "shuffledIn" && (player === undefined || event.player === player)
      ? [{ defId: event.defId, position: event.position, player: event.player }]
      : [],
  );
}

function damageTo(s: Scenario, targetId: string): number[] {
  return s.events.flatMap((event) =>
    event.type === "damage" && event.targetId === targetId ? [event.amount] : [],
  );
}

function defIds(cards: readonly { defId: string }[]): string[] {
  return cards.map((card) => card.defId);
}

/** A pile of harmless ordinary cards, for a library whose length is the point. */
function filler(count: number): string[] {
  return Array.from({ length: count }, () => "core-005");
}

// =============================================================================================
// #90 CN-Viral Injection — base
// =============================================================================================

describe("#90 CN-Viral Injection — base", () => {
  it("shuffles one CN-Virus into the OPPONENT's library and nothing into yours", () => {
    const s = scenario({
      seed: "core-090-enemy-library",
      p1: { hand: [INJECTION, "core-005"], library: filler(3) },
      p2: { hand: ["core-005"], library: filler(4) },
    });

    s.play(INJECTION);

    expect(s.state.players.p2.library).toHaveLength(5);
    expect(defIds(s.state.players.p2.library)).toContain(VIRUS);
    // Nothing was added to the caster's own library.
    expect(s.state.players.p1.library).toHaveLength(3);
    expect(defIds(s.state.players.p1.library)).not.toContain(VIRUS);
    s.expectEvents("cardPlayed", "shuffledIn");
  });

  it("R12 the opponent OWNS the virus, so it feeds their draws and not yours", () => {
    const s = scenario({
      seed: "core-090-ownership",
      p1: { hand: [INJECTION, "core-005"], library: filler(3) },
      p2: { hand: ["core-005"], library: filler(4) },
    });

    s.play(INJECTION);

    const virus = s.state.players.p2.library.find((card) => card.defId === VIRUS);
    expect(virus).toBeDefined();
    expect(virus?.owner).toBe("p2");
    expect(virus?.controller).toBe("p2");
    expect(shuffledIn(s)).toEqual([{ defId: VIRUS, position: expect.any(Number), player: "p2" }]);
  });

  it("the base face shuffles a NON-Radiant virus (§8: only the radiant cell adds the flag)", () => {
    const s = scenario({
      seed: "core-090-not-radiant",
      p1: { hand: [INJECTION, "core-005"], library: filler(3) },
      p2: { hand: ["core-005"], library: filler(4) },
    });

    s.play(INJECTION);

    const virus = s.state.players.p2.library.find((card) => card.defId === VIRUS);
    expect(virus?.radiant).toBe(false);
  });

  it("§3.2 the spell itself reaches the graveyard and counts as played", () => {
    const s = scenario({
      seed: "core-090-graveyard",
      p1: { hand: [INJECTION, "core-005"], library: filler(3) },
      p2: { hand: ["core-005"], library: filler(4) },
    });

    s.play(INJECTION);

    s.expectInZone(INJECTION, "graveyard");
    expect(s.state.players.p1.turnLog.cardsPlayed).toBe(1);
    s.expectMana("p1", 3);
  });

  it("§9.2 the random position is inside the whole pile and replays identically from the seed", () => {
    const build = (): Scenario =>
      scenario({
        seed: "core-090-replay",
        p1: { hand: [INJECTION, "core-005"], library: filler(3) },
        p2: { hand: ["core-005"], library: filler(4) },
      }).play(INJECTION);

    const first = shuffledIn(build());
    const second = shuffledIn(build());

    expect(first).toHaveLength(1);
    // A uniformly random spot in a pile of 4 is one of the 5 gaps 0..4 (`shuffleIntoLibrary`).
    expect(first[0]?.position).toBeGreaterThanOrEqual(0);
    expect(first[0]?.position).toBeLessThanOrEqual(4);
    // Same seed, same steps, same position — which is what makes replay and fuzz meaningful.
    expect(second).toEqual(first);
  });

  it("R80 a full library refuses the shuffle: no virus is created and the spell still resolves", () => {
    const s = scenario({
      seed: "core-090-library-cap",
      p1: { hand: [INJECTION, "core-005"], library: filler(3) },
      p2: { hand: ["core-005"], library: filler(LIBRARY_CAP) },
    });

    s.play(INJECTION);

    expect(s.state.players.p2.library).toHaveLength(LIBRARY_CAP);
    expect(defIds(s.state.players.p2.library)).not.toContain(VIRUS);
    expect(shuffledIn(s)).toEqual([]);
    // §8 Conventions: a fizzled clause does not un-play the card.
    s.expectInZone(INJECTION, "graveyard");
    expect(s.state.players.p1.turnLog.cardsPlayed).toBe(1);
  });
});

// =============================================================================================
// #90 CN-Viral Injection — radiant
// =============================================================================================

describe("#90 CN-Viral Injection — radiant", () => {
  it('"A Radiant CN-Virus": the flag is set and everything else is kept (§8 Conventions)', () => {
    const s = scenario({
      seed: "core-090-radiant",
      p1: { hand: [{ def: INJECTION, radiant: true }, "core-005"], library: filler(3) },
      p2: { hand: ["core-005"], library: filler(4) },
    });

    s.play(INJECTION);

    const virus = s.state.players.p2.library.find((card) => card.defId === VIRUS);
    expect(virus?.radiant).toBe(true);
    // Still ONE virus, still the opponent's library, still their card.
    expect(shuffledIn(s)).toHaveLength(1);
    expect(virus?.owner).toBe("p2");
    expect(s.state.players.p2.library).toHaveLength(5);
  });

  it("the Radiant virus runs its radiant face when drawn: 2 damage and 3 copies instead of 1 and 2", () => {
    // The virus sits on top of its owner's library, so the very next draw casts it.
    const s = scenario({
      seed: "core-090-radiant-face",
      p1: { library: [{ def: VIRUS, radiant: true }, "core-005"], hand: [] },
      p2: { hand: ["core-005"] },
    });

    s.startTurn();

    // One cast of the radiant face: 3 copies, all Radiant (R57), then the chain draws on.
    const copies = shuffledIn(s, "p1").filter((event) => event.defId === VIRUS);
    expect(copies.length).toBeGreaterThanOrEqual(3);
    expect(s.state.players.p1.library.filter((card) => card.defId === VIRUS).every((c) => c.radiant)).toBe(true);
    // Every cast in the chain is a radiant face, so every hit is 2.
    const hits = damageTo(s, "hero-p1");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.every((amount) => amount === 2)).toBe(true);
  });
});

// =============================================================================================
// R311: what the library's owner is shown of a virus going in (SPEC §10.8)
// =============================================================================================

describe("#90 and #90.1 — R311 the owner's library list", () => {
  it("R311 the victim's list names the virus the opponent's Injection shuffled in, Radiant on the Radiant face", () => {
    const s = scenario({
      seed: "core-090-r311",
      p1: { hand: [{ def: INJECTION, radiant: true }, "core-005"], library: filler(3) },
      p2: { hand: ["core-005"], library: filler(4) },
    });

    s.play(INJECTION);

    // The play was public and its text names the card, so p2 knows what went in; never where.
    // Both cost 1, so the list goes by name (R310): CN-Virus before Stockpile.
    expect(s.view("p2").you.ownLibrary).toEqual({
      cards: [
        { defId: VIRUS, radiant: true, count: 1 },
        { defId: "core-005", radiant: false, count: 4 },
      ],
      unknown: 0,
    });
    // The caster reads p2's library as a count and nothing else.
    expect(s.view("p1").opponent.ownLibrary).toBeUndefined();
    expect(s.view("p1").opponent.libraryCount).toBe(5);
  });

  it("R311 a virus's own copies are listed as their owner saw them go in", () => {
    const s = scenario({
      seed: "core-090-1-r311",
      p1: { hand: [VIRUS, "core-005"], library: filler(3) },
      p2: { hand: ["core-005"] },
    });

    s.play(VIRUS);

    const list = s.view("p1").you.ownLibrary;
    expect(list?.unknown).toBe(0);
    expect(list?.cards).toContainEqual({ defId: VIRUS, radiant: false, count: 2 });
    expect(list?.cards).toContainEqual({ defId: "core-005", radiant: false, count: 3 });
  });
});

// =============================================================================================
// #90.1 CN-Virus — base, played from hand (the `cry` with no draw around it)
// =============================================================================================

describe("#90.1 CN-Virus — base", () => {
  it("1 damage to its OWN hero and 2 copies into its own library", () => {
    const s = scenario({
      seed: "core-090-1-cry",
      p1: { hand: [VIRUS, "core-005"], library: filler(3) },
      p2: { hand: ["core-005"] },
    });

    s.play(VIRUS);

    s.expectHealth("p1", 29);
    expect(damageTo(s, "hero-p1")).toEqual([1]);
    s.expectHealth("p2", 30);
    expect(shuffledIn(s, "p1").filter((e) => e.defId === VIRUS)).toHaveLength(2);
    expect(s.state.players.p1.library).toHaveLength(5);
  });

  it("R11 a SPELL token reaches the graveyard — it never ceases to exist", () => {
    const s = scenario({
      seed: "core-090-1-graveyard",
      p1: { hand: [VIRUS, "core-005"], library: filler(3) },
      p2: { hand: ["core-005"] },
    });
    const virus = s.hand("p1")[0];
    expect(virus?.defId).toBe(VIRUS);

    s.play(VIRUS);

    // R86: "gone" is what a card that ceased to exist is tagged; a spell token is not one.
    if (virus !== undefined) s.expectInZone(virus, "graveyard");
    expect(defIds(s.pile("p1", "graveyard"))).toContain(VIRUS);
  });

  it("R57 the copies of a non-Radiant virus are non-Radiant", () => {
    const s = scenario({
      seed: "core-090-1-copies-plain",
      p1: { hand: [VIRUS, "core-005"], library: filler(3) },
      p2: { hand: ["core-005"] },
    });

    s.play(VIRUS);

    const copies = s.state.players.p1.library.filter((card) => card.defId === VIRUS);
    expect(copies).toHaveLength(2);
    expect(copies.every((card) => card.radiant === false)).toBe(true);
  });

  it("§4.4 step 2 / R63: Armor absorbs the 1 damage, no damage event fires, and the copies still land", () => {
    // What "Going Long (#84) reduces it" means for the pipeline: the two clauses are independent.
    const s = scenario({
      seed: "core-090-1-armor",
      p1: { hand: [VIRUS, "core-005"], library: filler(3), armor: 2 },
      p2: { hand: ["core-005"] },
    });

    s.play(VIRUS);

    s.expectHealth("p1", 30);
    expect(damageTo(s, "hero-p1")).toEqual([]);
    expect(shuffledIn(s, "p1").filter((e) => e.defId === VIRUS)).toHaveLength(2);
  });

  it("R80 the copies stop at the library cap: the second is never created", () => {
    const s = scenario({
      seed: "core-090-1-library-cap",
      p1: { hand: [VIRUS, "core-005"], library: filler(LIBRARY_CAP - 1) },
      p2: { hand: ["core-005"] },
    });

    s.play(VIRUS);

    expect(s.state.players.p1.library).toHaveLength(LIBRARY_CAP);
    expect(shuffledIn(s, "p1").filter((e) => e.defId === VIRUS)).toHaveLength(1);
    // The damage clause is unaffected by the library being full.
    s.expectHealth("p1", 29);
  });
});

// =============================================================================================
// #90.1 CN-Virus — cast on draw and R58's chain
// =============================================================================================

describe("#90.1 CN-Virus — cast on draw (R58, R70)", () => {
  it("a drawn virus casts at once, shuffles 2 copies and repeats the draw", () => {
    // The library holds nothing but the one virus, so every draw of the chain finds a virus and
    // the chain runs to R58's cap: 20 casts, 1 damage each, 2 copies each.
    const s = scenario({
      seed: "core-090-1-chain",
      p1: { library: [VIRUS], hand: [] },
      p2: { hand: ["core-005"] },
    });

    s.startTurn();

    expect(damageTo(s, "hero-p1")).toHaveLength(CHAIN_CAP);
    s.expectHealth("p1", 30 - CHAIN_CAP);
    expect(shuffledIn(s, "p1").filter((e) => e.defId === VIRUS)).toHaveLength(CHAIN_CAP * 2);
  });

  it("R58 the chain stops at the cap and the next virus sits in hand UNCAST", () => {
    const s = scenario({
      seed: "core-090-1-chain-cap",
      p1: { library: [VIRUS], hand: [] },
      p2: { hand: ["core-005"] },
    });

    s.startTurn();

    // 1 in the library, net +1 per cast, minus the one drawn uncast at the end.
    expect(s.state.players.p1.library).toHaveLength(CHAIN_CAP);
    expect(defIds(s.hand("p1"))).toEqual([VIRUS]);
    // Uncast means its own damage never happened: 20 casts, not 21.
    expect(damageTo(s, "hero-p1")).toHaveLength(CHAIN_CAP);
  });

  it("R70 every cast counts as a card played, so the turn log sees the whole chain", () => {
    const s = scenario({
      seed: "core-090-1-chain-played",
      p1: { library: [VIRUS], hand: [] },
      p2: { hand: ["core-005"] },
    });

    s.startTurn();

    expect(s.state.players.p1.turnLog.cardsPlayed).toBe(CHAIN_CAP);
    expect(s.state.players.p1.turnLog.playedIds).toHaveLength(CHAIN_CAP);
    // A cast is free (R70): the mana the start of turn refreshed is untouched.
    s.expectMana("p1", 4);
  });

  it("every cast virus ends in the graveyard (R11), none of them `gone`", () => {
    const s = scenario({
      seed: "core-090-1-chain-graveyard",
      p1: { library: [VIRUS], hand: [] },
      p2: { hand: ["core-005"] },
    });

    s.startTurn();

    expect(s.pile("p1", "graveyard").filter((card) => card.defId === VIRUS)).toHaveLength(CHAIN_CAP);
    expect(s.pile("p1", "exile")).toHaveLength(0);
  });
});

describe("#90.1 CN-Virus — radiant", () => {
  it('R275 "take 2 damage; 3 copies": both numbers scale on the radiant face', () => {
    const s = scenario({
      seed: "core-090-1-radiant-cry",
      p1: { hand: [{ def: VIRUS, radiant: true }, "core-005"], library: filler(3) },
      p2: { hand: ["core-005"] },
    });

    s.play(VIRUS);

    expect(shuffledIn(s, "p1").filter((e) => e.defId === VIRUS)).toHaveLength(3);
    s.expectHealth("p1", 28);
    expect(damageTo(s, "hero-p1")).toEqual([2]);
    s.expectHealth("p2", 30);
  });

  it("§4.4 the radiant 2 is one damage instance: 1 Armor leaves 1, and the copies still land", () => {
    const s = scenario({
      seed: "core-090-1-radiant-armor",
      p1: { hand: [{ def: VIRUS, radiant: true }, "core-005"], library: filler(3), armor: 1 },
      p2: { hand: ["core-005"] },
    });

    s.play(VIRUS);

    s.expectHealth("p1", 29);
    expect(damageTo(s, "hero-p1")).toEqual([1]);
    expect(shuffledIn(s, "p1").filter((e) => e.defId === VIRUS)).toHaveLength(3);
  });

  it("R57 a Radiant virus breeds Radiant viruses, so the whole chain stays radiant", () => {
    // 20 casts of 2 is 40, more than a 30-health hero has, so the hero starts higher to let R58's
    // cap be what stops the chain here (the lethal chain is the next test).
    const HEALTH = 50;
    const s = scenario({
      seed: "core-090-1-radiant-chain",
      p1: { library: [{ def: VIRUS, radiant: true }], hand: [], health: HEALTH },
      p2: { hand: ["core-005"] },
    });

    s.startTurn();

    // 3 copies per cast for all 20 casts: every drawn copy ran the radiant face, not the base one.
    expect(shuffledIn(s, "p1").filter((e) => e.defId === VIRUS)).toHaveLength(CHAIN_CAP * 3);
    expect(damageTo(s, "hero-p1")).toEqual(Array.from({ length: CHAIN_CAP }, () => 2));
    s.expectHealth("p1", HEALTH - CHAIN_CAP * 2);
    // 1 + 3·20 created, 21 drawn.
    expect(s.state.players.p1.library).toHaveLength(1 + CHAIN_CAP * 3 - (CHAIN_CAP + 1));
    expect(s.state.players.p1.library.every((card) => card.radiant)).toBe(true);
    expect(s.hand("p1")[0]?.radiant).toBe(true);
  });

  it("§2.5, R59 a radiant chain on a 30-health hero is lethal before R58's cap: 15 casts of 2", () => {
    const s = scenario({
      seed: "core-090-1-radiant-lethal",
      p1: { library: [{ def: VIRUS, radiant: true }], hand: [] },
      p2: { hand: ["core-005"] },
    });

    s.startTurn();

    expect(damageTo(s, "hero-p1")).toEqual(Array.from({ length: 30 / 2 }, () => 2));
    expect(s.state.result?.winner).toBe("p2");
  });
});

// =============================================================================================
// §5.1: the token is in no random pool
// =============================================================================================

describe("#90.1 CN-Virus — §5.1 pools", () => {
  it("§5.1 no random pool offers the token, and the 1-cost Spell pool does not either", () => {
    expect(query({}).map((card) => card.id)).not.toContain(VIRUS);
    expect(query({ type: "Spell", cost: 1 }).map((card) => card.id)).not.toContain(VIRUS);
    // Reachable only by a query that asks for tokens or names it.
    expect(query({ tags: ["Token"] }).map((card) => card.id)).toContain(VIRUS);
    expect(query({ defId: VIRUS }).map((card) => card.id)).toEqual([VIRUS]);
  });

  it("§5.1 #90 itself is an ordinary catalog card and stays in the pool", () => {
    expect(query({}).map((card) => card.id)).toContain(INJECTION);
    // Both carry the CN tag (§8), which is how a CN-tagged pool finds #90 but never the token.
    expect(query({ tags: ["CN"] }).map((card) => card.id)).toContain(INJECTION);
    expect(query({ tags: ["CN"] }).map((card) => card.id)).not.toContain(VIRUS);
  });
});
