// #80 Zao Gao — SPEC §8.3, R11, R16, R21, R64, R215, R275, R276, §5.2, §7, §9.3, §10.6.
//
// BUILD M4-T4: "Discard prompt for 2 or fewer; two Rush Tokens each with two distinct pool
// keywords; radiant the tokens are Radiant 6/6 Rush, Cleave, and roll no keyword they have".
//
// Radiant (R276): "Discard 2 cards of your choice; summon 2 Radiant Rush Tokens, each with 2 random
// keywords". Each token is summoned on its Radiant face (§7: 6/6, Rush, Cleave) and then rolls its
// two keywords, which never repeat one it has (R21) — so neither Rush nor Cleave is ever one of the
// two.

import { describe, expect, it } from "vitest";
import { RANDOM_KEYWORD_POOL } from "@jackioh/engine/config";
import { scenario, type Scenario } from "./_harness";
import { base, radiant } from "../src/scripts/080-zao-gao";

const ZAO_GAO = "core-080";
const RUSH_TOKEN = "core-t-rush";

const DISCARDABLE = ["core-001", "core-002", "core-003"] as const;
const LIBRARY = ["core-008", "core-008", "core-008", "core-008"] as const;

/** R21's pool as keyword KINDS; "Armor 1" is its one numbered entry (§6.1). */
const POOL_KINDS: ReadonlySet<string> = new Set<string>(
  RANDOM_KEYWORD_POOL.map((entry) => (entry === "Armor 1" ? "Armor" : entry)),
);

/** The live keyword list of the unit in a lane, read through `viewFor`'s §10.4 layers. */
function keywordKinds(s: Scenario, lane: number): string[] {
  const view = s.view("p1").you.units[lane - 1];
  if (view === undefined || view === null) throw new Error(`p1 has no unit in lane ${lane}`);
  return view.keywords.map((keyword) => keyword.kind);
}

/** §7: the Rush Token's printed keywords on each face. */
const BASE_PRINTED = ["Rush"] as const;
const RADIANT_PRINTED = ["Rush", "Cleave"] as const;

/**
 * R21 on one token: its printed keywords (§7) plus exactly two more, all distinct, all from the
 * pool, and neither of the two one it already printed.
 */
function expectTwoPoolKeywords(
  s: Scenario,
  lane: number,
  printed: readonly string[] = BASE_PRINTED,
): void {
  const kinds = keywordKinds(s, lane);
  for (const kind of printed) expect(kinds).toContain(kind);
  // R21: "no repeats on one unit".
  expect(new Set(kinds).size).toBe(kinds.length);
  const granted = kinds.filter((kind) => !printed.includes(kind));
  expect(granted).toHaveLength(2);
  for (const kind of granted) expect(POOL_KINDS.has(kind)).toBe(true);

  // The `keywordGranted` events for this token are the roll itself: two, never a printed keyword.
  const tokenId = s.unit("p1", lane)!.id;
  const rolled = s.events.flatMap((event) =>
    event.type === "keywordGranted" && event.instanceId === tokenId ? [event.keyword.kind] : [],
  );
  expect(rolled).toHaveLength(2);
  for (const kind of printed) expect(rolled).not.toContain(kind);
}

function occupiedLanes(s: Scenario): number[] {
  return s.state.players.p1.units.flatMap((pile, index) => (pile === null ? [] : [index + 1]));
}

function board(radiantFace: boolean, hand: readonly string[]): Scenario {
  return scenario({
    p1: {
      hand: [{ def: ZAO_GAO, radiant: radiantFace }, ...hand],
      library: [...LIBRARY],
    },
    // R82: the opponent keeps something to do, so nothing auto-ends under the assertions.
    p2: { hand: ["core-005"], field: ["core-019"], library: [...LIBRARY] },
  });
}

describe("#80 Zao Gao — base", () => {
  it("R16 the discard is a hand prompt for 2 of the player's own choosing (§10.6)", () => {
    const s = board(false, DISCARDABLE);

    s.play(ZAO_GAO);

    const pending = s.state.pending;
    expect(pending).not.toBeNull();
    expect(pending?.kind).toBe("hand");
    expect(pending?.playerId).toBe("p1");
    // R16: chosen, not random — every card in hand is on offer, exactly two are taken.
    expect(pending?.min).toBe(2);
    expect(pending?.max).toBe(2);
    expect(pending?.options).toHaveLength(DISCARDABLE.length);
    s.expectEvents("cardPlayed", "promptOpened");
  });

  it("the two chosen cards are discarded and the rest of the hand stays", () => {
    const s = board(false, DISCARDABLE);
    s.play(ZAO_GAO);

    s.answer([DISCARDABLE[0], DISCARDABLE[1]]);

    // Zao Gao is there too: §10.5 step 7 sends the resolved Spell to the graveyard.
    expect(s.pile("p1", "graveyard").map((card) => card.defId).sort()).toEqual(
      [DISCARDABLE[0], DISCARDABLE[1], ZAO_GAO].sort(),
    );
    expect(s.pile("p1", "hand").map((card) => card.defId)).toEqual([DISCARDABLE[2]]);
    s.expectEvents("promptOpened", "promptAnswered", "discarded", "enteredGraveyard");
  });

  it("R64 two Rush Tokens stand in the leftmost free zones once the prompt is answered", () => {
    const s = board(false, DISCARDABLE);

    s.play(ZAO_GAO).answer([DISCARDABLE[0], DISCARDABLE[1]]);

    expect(occupiedLanes(s)).toEqual([1, 2]);
    expect(s.unit("p1", 1)?.defId).toBe(RUSH_TOKEN);
    expect(s.unit("p1", 2)?.defId).toBe(RUSH_TOKEN);
    expect(s.state.pending).toBeNull();
    expect(s.state.work).toHaveLength(0);
  });

  it("§7 the base face's tokens are base Rush Tokens: 3/3, not Radiant", () => {
    const s = board(false, DISCARDABLE);

    s.play(ZAO_GAO).answer([DISCARDABLE[0], DISCARDABLE[1]]);

    for (const lane of [1, 2]) {
      const token = s.unit("p1", lane)!;
      expect(token.radiant).toBe(false);
      s.expectStats(token, { attack: 3, health: 3, maxHealth: 3 });
    }
  });

  it("§9.3 the summons wait for the answer: the tail of the list is parked, not stepped over", () => {
    const s = board(false, DISCARDABLE);

    s.play(ZAO_GAO);

    // `prompts.applyResumable` parks the tail of the Cry's list in `state.work` until the answer.
    expect(occupiedLanes(s)).toEqual([]);
    expect(s.state.work.length).toBeGreaterThan(0);
  });

  it("R21 each Rush Token carries two distinct keywords from the pool, rolled independently", () => {
    const s = board(false, DISCARDABLE);

    s.play(ZAO_GAO).answer([DISCARDABLE[0], DISCARDABLE[1]]);

    // `summon`'s `randomKeywords` rolls on the token it just made (a script cannot name it).
    expectTwoPoolKeywords(s, 1);
    expectTwoPoolKeywords(s, 2);
    // Rolled independently: two grants of two draws each come off the seeded rng.
    expect(s.state.rngCursor).toBeGreaterThan(0);
  });

  it("§8.3 fewer than 2 in hand: the prompt clamps and only that card is discarded", () => {
    const s = board(false, [DISCARDABLE[0]]);

    s.play(ZAO_GAO);

    expect(s.state.pending?.min).toBe(1);
    expect(s.state.pending?.max).toBe(1);

    s.answer([DISCARDABLE[0]]);

    expect(s.pile("p1", "graveyard").map((card) => card.defId).sort()).toEqual(
      [DISCARDABLE[0], ZAO_GAO].sort(),
    );
    expect(s.pile("p1", "hand")).toHaveLength(0);
    // The second `discard` finds no second selection and fizzles; the tokens still arrive.
    expect(occupiedLanes(s)).toEqual([1, 2]);
  });

  it("an empty hand opens no prompt and the two tokens are summoned all the same", () => {
    const s = board(false, []);

    s.play(ZAO_GAO);

    // `chooseFromHand` returns early on an empty hand, so nothing is asked and nothing is parked —
    // which is why the hook needs no empty-hand branch of its own.
    expect(s.state.pending).toBeNull();
    expect(s.state.work).toHaveLength(0);
    expect(s.pile("p1", "graveyard").map((card) => card.defId)).toEqual([ZAO_GAO]);
    expect(occupiedLanes(s)).toEqual([1, 2]);
  });

  it("R64 a nearly full board gets fewer tokens and the extra summon fizzles", () => {
    const s = scenario({
      p1: {
        hand: [ZAO_GAO, ...DISCARDABLE],
        // Four of the five unit zones are taken, so only one token fits.
        field: ["core-019", "core-019", "core-019", "core-019"],
        library: [...LIBRARY],
      },
      p2: { hand: ["core-005"], field: ["core-019"], library: [...LIBRARY] },
    });

    s.play(ZAO_GAO).answer([DISCARDABLE[0], DISCARDABLE[1]]);

    expect(occupiedLanes(s)).toEqual([1, 2, 3, 4, 5]);
    expect(s.unit("p1", 5)?.defId).toBe(RUSH_TOKEN);
    // The discard happened either way: it is not conditional on the summons.
    expect(s.pile("p1", "graveyard")).toHaveLength(3); // two discards plus Zao Gao itself
  });

  it("R64 a full board summons nothing and the discard still happens", () => {
    const s = scenario({
      p1: {
        hand: [ZAO_GAO, ...DISCARDABLE],
        field: ["core-019", "core-019", "core-019", "core-019", "core-019"],
        library: [...LIBRARY],
      },
      p2: { hand: ["core-005"], field: ["core-019"], library: [...LIBRARY] },
    });

    s.play(ZAO_GAO).answer([DISCARDABLE[0], DISCARDABLE[1]]);

    expect(s.state.players.p1.units.filter((pile) => pile !== null)).toHaveLength(5);
    expect(s.unit("p1", 5)?.defId).not.toBe(RUSH_TOKEN);
    expect(s.pile("p1", "hand").map((card) => card.defId)).toEqual([DISCARDABLE[2]]);
  });
});

describe("#80 Zao Gao — radiant", () => {
  it("R276 the radiant face is its own Script, not the base object", () => {
    expect(radiant).not.toBe(base);
  });

  it("a Radiant Zao Gao discards two chosen cards and summons two Radiant Rush Tokens", () => {
    const s = board(true, DISCARDABLE);

    s.play(ZAO_GAO);

    expect(s.state.pending?.kind).toBe("hand");
    expect(s.state.pending?.min).toBe(2);

    s.answer([DISCARDABLE[0], DISCARDABLE[1]]);

    expect(s.pile("p1", "graveyard").map((card) => card.defId).sort()).toEqual(
      [DISCARDABLE[0], DISCARDABLE[1], ZAO_GAO].sort(),
    );
    expect(occupiedLanes(s)).toEqual([1, 2]);
    for (const lane of [1, 2]) {
      const token = s.unit("p1", lane)!;
      expect(token.defId).toBe(RUSH_TOKEN);
      // §7: the Radiant Rush Token is 6/6 with Rush and Cleave.
      expect(token.radiant).toBe(true);
      s.expectStats(token, { attack: 6, health: 6, maxHealth: 6 });
    }
  });

  it("R21 a Radiant Zao Gao's tokens roll two pool keywords each, never Rush or Cleave", () => {
    const s = board(true, DISCARDABLE);

    s.play(ZAO_GAO).answer([DISCARDABLE[0], DISCARDABLE[1]]);

    expectTwoPoolKeywords(s, 1, RADIANT_PRINTED);
    expectTwoPoolKeywords(s, 2, RADIANT_PRINTED);
  });

  it("R21 the roll reads the Radiant face on every seed: Cleave is never rolled onto a token that prints it", () => {
    // Each token's two draws come from the nine pool keywords a Radiant Rush Token lacks; were the
    // roll made before the flag set (or off the base face), Cleave would be offered and, over
    // enough seeds, rolled.
    const SEEDS = 40;
    for (let n = 0; n < SEEDS; n += 1) {
      const s = scenario({
        seed: `core-080-radiant-roll-${n}`,
        p1: { hand: [{ def: ZAO_GAO, radiant: true }, ...DISCARDABLE], library: [...LIBRARY] },
        p2: { hand: ["core-005"], field: ["core-019"], library: [...LIBRARY] },
      });
      s.play(ZAO_GAO).answer([DISCARDABLE[0], DISCARDABLE[1]]);
      expectTwoPoolKeywords(s, 1, RADIANT_PRINTED);
      expectTwoPoolKeywords(s, 2, RADIANT_PRINTED);
    }
  });

  it("R276 a Radiant Zao Gao summons Radiant Rush Tokens, 6/6 with Rush and Cleave, each rolling two keywords it lacks, and goes to the graveyard Radiant", () => {
    const s = board(true, DISCARDABLE);
    const self = s.card(ZAO_GAO);
    expect(self.radiant).toBe(true);

    s.play(ZAO_GAO).answer([DISCARDABLE[0], DISCARDABLE[1]]);

    for (const lane of [1, 2]) {
      const token = s.unit("p1", lane)!;
      expect(token.radiant).toBe(true);
      s.expectStats(token, { attack: 6, health: 6, maxHealth: 6 });
      // §7's Rush and Cleave, plus two pool keywords that are neither (R21).
      expectTwoPoolKeywords(s, lane, RADIANT_PRINTED);
    }
    // §5.2, R215: the flag goes with the spent Spell into the graveyard.
    s.expectInZone(self, "graveyard");
    expect(s.card(self).radiant).toBe(true);
  });

  it("an empty hand opens no prompt on the radiant face either, and its tokens are Radiant", () => {
    const s = board(true, []);

    s.play(ZAO_GAO);

    expect(s.state.pending).toBeNull();
    expect(occupiedLanes(s)).toEqual([1, 2]);
    expect(s.unit("p1", 1)?.radiant).toBe(true);
    expect(s.unit("p1", 2)?.radiant).toBe(true);
  });

  it("R64 a nearly full board gets one Radiant token and the extra summon fizzles", () => {
    const s = scenario({
      p1: {
        hand: [{ def: ZAO_GAO, radiant: true }, ...DISCARDABLE],
        field: ["core-019", "core-019", "core-019", "core-019"],
        library: [...LIBRARY],
      },
      p2: { hand: ["core-005"], field: ["core-019"], library: [...LIBRARY] },
    });

    s.play(ZAO_GAO).answer([DISCARDABLE[0], DISCARDABLE[1]]);

    expect(occupiedLanes(s)).toEqual([1, 2, 3, 4, 5]);
    const token = s.unit("p1", 5)!;
    expect(token.defId).toBe(RUSH_TOKEN);
    expect(token.radiant).toBe(true);
    expectTwoPoolKeywords(s, 5, RADIANT_PRINTED);
  });
});
