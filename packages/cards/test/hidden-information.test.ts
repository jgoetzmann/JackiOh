// What `viewFor` hands each seat about cards it may not read (SPEC §9.1, §10.8, R33, R35, R97,
// R177). Found by the polish-4 edge-case hunt (docs/polish/4-edge-cases.md, lens L10, rounds 1 to
// 3); every case here failed before its fix. Where a leak is a difference between two games that
// differ only in hidden cards, the test builds both and asserts the viewer cannot tell them apart.

import type { GameEvent, PlayerId, PlayerView } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

/** viewFor's R97 sentinel. */
const HIDDEN = "hidden";

const GARY = "core-004";
const STOCKPILE = "core-005";
const HIT_JOB = "core-016";
const MENACE = "core-019";
const MATH_EQUATION = "core-031";
const SHEEPISH = "core-041";
const SPEK = "core-048";
const MIND_CONTROL = "core-049";
const TWINSPELL = "core-079";
const SEVEN_SEVEN = "core-025";
const LUNAR_ECLIPSE = "core-035";
const MAGIC_JAMMED = "core-036";
const EUGENICS = "core-042";
const MR_VANILLA = "core-008";
const BIGOT = "core-002";
const TRANSMOGULATE = "core-083";
const UNLICENSED = "core-085";
const CORPSE_EATER = "core-089";
const COMBO_INDEX = "core-093";
const CALL_TO_CHAOS = "core-095";
const MY_PAWN = "core-096";

function eventsOf<T extends GameEvent["type"]>(view: PlayerView, type: T): Extract<GameEvent, { type: T }>[] {
  return view.events.filter((event): event is Extract<GameEvent, { type: T }> => event.type === type);
}

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`missing ${what}`);
  return value;
}

describe("R177: a prompt option that offers a face-down card", () => {
  it("R177 an Echo repeat's target prompt names an enemy face-down trap by id only: no defId, and no name in its label or key (§10.8, R33)", () => {
    const s = scenario({
      seed: "hunt-l10-echo",
      p1: { hand: [TWINSPELL, MIND_CONTROL, STOCKPILE], mana: 10, library: [HIT_JOB, HIT_JOB] },
      p2: {
        field: [MENACE],
        backrow: [
          { def: MY_PAWN, lane: 1 },
          { def: SHEEPISH, lane: 2 },
        ],
        hand: [STOCKPILE],
        library: [HIT_JOB],
      },
    });
    const pawn = must(s.backrow("p2", 1), "p2's lane-1 trap");
    const sheep = must(s.backrow("p2", 2), "p2's lane-2 trap");
    const menace = must(s.unit("p2", 1), "p2's unit");

    s.play(TWINSPELL);
    s.play(MIND_CONTROL, { targets: [{ pick: "instance", instanceId: menace.id }] });

    // The Echo repeat asks again (§10.5 step 6, R81) and offers p2's two face-down traps.
    const view = s.view("p1");
    expect(view.opponent.backrow[0]).toEqual({ faceDown: true });
    const pending = must(view.pending, "p1's Echo prompt");
    if (!pending.forYou) throw new Error("the Echo prompt should be p1's");
    const trapOptions = pending.options.filter((option) => option.instanceId === pawn.id || option.instanceId === sheep.id);
    expect(trapOptions).toHaveLength(2);
    for (const option of trapOptions) {
      expect(option.defId).toBeUndefined();
      expect(option.label).not.toMatch(/Pawn|Sheepish|core-0/);
      expect(option.key).not.toMatch(/Pawn|Sheepish|core-0/);
    }
    // The chooser still answers with the id it was given.
    s.answer([{ pick: "instance", instanceId: sheep.id }]);
    expect(s.card(sheep).controller).toBe("p1");
  });
});

describe("R177: a card replaced where the viewer cannot see it", () => {
  it("R177 Transmogulate's transformed events name no replaced library card or face-down trap (§9.1, R35)", () => {
    const s = scenario({
      seed: "hunt-l10-transmogulate",
      p1: { hand: [TRANSMOGULATE, STOCKPILE], backrow: [{ def: SHEEPISH, lane: 1 }], library: ["core-025", "core-002", "core-030"] },
      p2: { hand: [STOCKPILE], library: [HIT_JOB] },
    });

    s.play(TRANSMOGULATE);

    // p1's view: the three library replacements are hidden. p2's view: those three plus the trap.
    const expectHidden: Record<PlayerId, number> = { p1: 3, p2: 4 };
    for (const viewer of ["p1", "p2"] as const) {
      const intoHidden = eventsOf(s.view(viewer), "transformed").filter((event) => event.newInstanceId === HIDDEN);
      expect(intoHidden).toHaveLength(expectHidden[viewer]);
      for (const event of intoHidden) {
        expect({ instanceId: event.instanceId, fromDefId: event.fromDefId }).toEqual({ instanceId: HIDDEN, fromDefId: HIDDEN });
      }
    }
    // p1 controls its own trap, so it reads that replacement in full.
    const own = eventsOf(s.view("p1"), "transformed").filter((event) => event.fromDefId === SHEEPISH);
    expect(own).toHaveLength(1);
  });
});

describe("R177: a cost change on a card the viewer may not read", () => {
  /** #93 at E, one card played, so end of turn runs E and D: two random hand cards cost 1 less. */
  function comboIndexGame(held: readonly string[]): Scenario {
    const s = scenario({
      seed: "hunt-l10-combo",
      p1: { backrow: [COMBO_INDEX], hand: [SPEK, ...held], library: [HIT_JOB, HIT_JOB] },
      p2: { hand: [STOCKPILE], library: [HIT_JOB, HIT_JOB] },
    });
    s.play(SPEK).endTurn();
    return s;
  }

  it("R177 grade D's discount does not tell the opponent what p1's hidden hand cards cost (§10.8)", () => {
    // Two games that differ only in which (hidden) cards p1 holds; every position differs in cost.
    const a = comboIndexGame(["core-025", "core-030"]);
    const b = comboIndexGame(["core-020", "core-011"]);

    expect(eventsOf(a.view("p2"), "costChanged")).toHaveLength(2);
    expect(eventsOf(b.view("p2"), "costChanged")).toHaveLength(2);
    expect(b.view("p2")).toEqual(a.view("p2"));
    // The owner still reads its own discounts.
    expect(eventsOf(a.view("p1"), "costChanged").every((event) => event.instanceId !== HIDDEN && event.cost >= 0)).toBe(true);
  });

  /** "chaos-2" is a seed whose #95 rolls "every card in your hand and library costs 2 less". */
  function chaosDiscountGame(library: readonly string[]): Scenario {
    const s = scenario({
      seed: "chaos-2",
      p1: { hand: [CALL_TO_CHAOS, STOCKPILE], mana: 10, library: [...library] },
      p2: { hand: [STOCKPILE], library: [HIT_JOB] },
    });
    s.play(CALL_TO_CHAOS);
    return s;
  }

  it("R177 Call to Chaos's library discount does not reveal the library's order to either player (§9.1)", () => {
    const a = chaosDiscountGame(["core-025", "core-002"]);
    const b = chaosDiscountGame(["core-002", "core-025"]);

    // The discount rolled: the hand card and both library cards changed cost.
    expect(eventsOf(a.view("p1"), "costChanged")).toHaveLength(3);
    expect(b.view("p1")).toEqual(a.view("p1"));
    expect(b.view("p2")).toEqual(a.view("p2"));
  });
});

describe("R177: identities an event carries outside its redacted fields", () => {
  it("R177 destroyed.killerId does not name a killer that now sits in the opponent's hand (R97)", () => {
    const s = scenario({
      seed: "hunt-r2-hidden-killer",
      p1: { hand: [MATH_EQUATION, STOCKPILE], library: [HIT_JOB, HIT_JOB] },
      p2: { field: [GARY], hand: [STOCKPILE], library: [HIT_JOB, HIT_JOB] },
    });
    const gary = must(s.unit("p2", 1), "p2's Gary");
    const math = must(s.hand("p1").find((card) => card.defId === MATH_EQUATION), "p1's Math Equation");

    // Fib(1 + 1) = 1 damage kills the 1/1; at end of turn the Spell returns to p1's hand.
    s.play(math, { targets: [{ pick: "instance", instanceId: gary.id }] });
    s.expectInZone(gary, "graveyard");
    s.endTurn();
    s.expectInZone(math, "hand");

    const view = s.view("p2");
    // The damage event already hides the Spell, since it now sits in p1's hand (R97)...
    const hit = must(eventsOf(view, "damage").find((event) => event.targetId === gary.id), "the damage event");
    expect(hit.sourceId).toBe(HIDDEN);
    // ...so the destroyed event must not name it either.
    const death = must(eventsOf(view, "destroyed").find((event) => event.instanceId === gary.id), "Gary's destroyed event");
    expect(death.killerId).toBe(HIDDEN);
  });
});

describe("R177: a card that ceased to exist in a hidden zone stays hidden in earlier events", () => {
  it("R177 after Transmogulate replaces a face-down trap, its earlier cardPlayed does not name it to the opponent (R33, R35, R97)", () => {
    const s = scenario({
      seed: "hunt-r2-transmogulated-trap",
      p1: { hand: [SHEEPISH, TRANSMOGULATE, STOCKPILE], mana: 10, library: [HIT_JOB, HIT_JOB] },
      p2: { hand: [STOCKPILE], library: [HIT_JOB] },
    });
    const sheep = must(s.hand("p1").find((card) => card.defId === SHEEPISH), "p1's Sheepish");

    s.play(sheep, { zone: 1 });
    // Before the transform p2 reads nothing of it: a bare face-down zone and a redacted play.
    expect(s.view("p2").opponent.backrow[0]).toEqual({ faceDown: true });
    expect(JSON.stringify(s.view("p2"))).not.toContain(SHEEPISH);

    s.play(TRANSMOGULATE);
    s.expectInZone(sheep, "gone");

    // Sheepish was never revealed to p2: it never fired and never reached a public pile.
    const view = s.view("p2");
    const played = eventsOf(view, "cardPlayed").filter((event) => event.player === "p1");
    expect(played.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(view)).not.toContain(SHEEPISH);
    expect(JSON.stringify(view.events)).not.toContain(`"${sheep.id}"`);
  });

  /** "chaos-2" is a seed whose #95 rolls "every card in your hand and library costs 2 less". */
  function chaosThenTransmogulate(library: readonly string[]): Scenario {
    const s = scenario({
      seed: "chaos-2",
      p1: { hand: [CALL_TO_CHAOS, TRANSMOGULATE, STOCKPILE], mana: 10, library: [...library] },
      p2: { hand: [STOCKPILE], library: [HIT_JOB] },
    });
    s.play(CALL_TO_CHAOS);
    s.play(TRANSMOGULATE);
    return s;
  }

  it("R177 after Transmogulate replaces the library, Call to Chaos's cost changes still do not spell out its old order (§9.1)", () => {
    const a = chaosThenTransmogulate(["core-025", "core-002"]);
    const b = chaosThenTransmogulate(["core-002", "core-025"]);

    // The discount rolled for both library cards (and the hand), and both games transformed alike.
    expect(eventsOf(a.view("p1"), "costChanged").length).toBeGreaterThanOrEqual(3);
    expect(eventsOf(a.view("p1"), "transformed").length).toBeGreaterThanOrEqual(2);
    // Two games that differ only in the (hidden) order of p1's library look the same to both seats.
    expect(b.view("p2")).toEqual(a.view("p2"));
    expect(b.view("p1")).toEqual(a.view("p1"));
  });
});

describe("R177: a hidden hand card's buff", () => {
  /** p1 Hit Jobs p2's Mr. Vanilla (3/3); p2 holds a Corpse Eater, base or Radiant. */
  function eaterGame(radiant: boolean): Scenario {
    const s = scenario({
      seed: "hunt-r3-hidden-eater",
      p1: { hand: [HIT_JOB, STOCKPILE], library: [HIT_JOB, HIT_JOB] },
      p2: { field: [MR_VANILLA], hand: [{ def: CORPSE_EATER, radiant }, STOCKPILE], library: [HIT_JOB, HIT_JOB] },
    });
    const vanilla = must(s.unit("p2", 1), "p2's Mr. Vanilla");
    s.play(HIT_JOB, { targets: [{ pick: "instance", instanceId: vanilla.id }] });
    s.expectInZone(vanilla, "graveyard");
    return s;
  }

  it("R177 a Corpse Eater's gain in hand does not tell the opponent whether it is Radiant (§9.1, R97)", () => {
    const base = eaterGame(false);
    const radiant = eaterGame(true);

    // Both Eaters fed: +3/+3 on the base face, double on the radiant one (§8 #89).
    const eaterOf = (s: Scenario) => must(s.hand("p2").find((card) => card.defId === CORPSE_EATER), "p2's Eater");
    expect(eaterOf(base).buffs).toEqual({ attack: 3, health: 3 });
    expect(eaterOf(radiant).buffs).toEqual({ attack: 6, health: 6 });

    // p2's hand is a count to p1 (§10.8), and the size of a hidden card's buff is the card's: the
    // event still plays its cue, and p1 cannot tell the two games apart.
    expect(eventsOf(base.view("p1"), "buffed")).toEqual([{ type: "buffed", instanceId: HIDDEN, attack: 0, health: 0 }]);
    expect(radiant.view("p1")).toEqual(base.view("p1"));
    // p2 reads its own card's buff in full.
    expect(eventsOf(radiant.view("p2"), "buffed").map((event) => event.attack)).toEqual([6]);
  });
});

describe("R177: a card that ceased to exist where the viewer could not read it stays unread", () => {
  it("R177 a face-down trap Transmogulate replaced stays hidden after its replacement reaches the graveyard (R33, R35)", () => {
    const s = scenario({
      seed: "hunt-r3-transmog-trap",
      p1: {
        hand: [TRANSMOGULATE, MAGIC_JAMMED, STOCKPILE],
        backrow: [{ def: SHEEPISH, lane: 1 }],
        mana: 10,
        library: [HIT_JOB],
      },
      p2: { hand: [STOCKPILE], library: [HIT_JOB] },
    });
    const sheep = must(s.backrow("p1", 1), "p1's Sheepish");

    s.play(TRANSMOGULATE);
    s.expectInZone(sheep, "gone");
    const replacement = must(s.backrow("p1", 1), "the replacement trap");
    expect(replacement.defId).toBe(UNLICENSED);

    // p1 destroys its own face-down replacement, which reaches p1's public graveyard.
    s.play(MAGIC_JAMMED, { targets: [{ pick: "instance", instanceId: replacement.id }] });
    s.expectInZone(replacement, "graveyard");

    // Sheepish never fired and never reached a public pile, so p2 still reads nothing of it, while
    // p1, its controller, still reads what it replaced.
    const view = s.view("p2");
    expect(eventsOf(view, "transformed").length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(view)).not.toContain(SHEEPISH);
    expect(JSON.stringify(view.events)).not.toContain(`"${sheep.id}"`);
    expect(eventsOf(s.view("p1"), "transformed")).toContainEqual(
      expect.objectContaining({ instanceId: sheep.id, fromDefId: SHEEPISH }),
    );
    // The record the view reads is never forwarded to either seat.
    expect(JSON.stringify(s.view("p1").events)).not.toContain("hiddenFrom");
  });

  /** p1's one library card is replaced, then Eugenics exiles the replacement into public view. */
  function libraryGame(card: string): Scenario {
    const s = scenario({
      seed: "hunt-r3-transmog-library",
      p1: { hand: [TRANSMOGULATE, EUGENICS, STOCKPILE], mana: 10, library: [card] },
      p2: { hand: [STOCKPILE], library: [HIT_JOB] },
    });
    s.play(TRANSMOGULATE);
    s.play(EUGENICS);
    return s;
  }

  it("R177 a library card Transmogulate replaced stays hidden after its replacement is exiled (§9.1, R35)", () => {
    const a = libraryGame(SEVEN_SEVEN);
    const b = libraryGame(BIGOT);

    // The replacement is in p1's exile, a public pile, in both games.
    expect(a.pile("p1", "exile")).toHaveLength(1);
    expect(a.pile("p1", "exile")[0]?.defId).toBe(b.pile("p1", "exile")[0]?.defId);

    // p1's library held a card neither player saw and that has ceased to exist (R35): two games that
    // differ only in what it was look the same to both seats.
    expect(b.view("p2")).toEqual(a.view("p2"));
    expect(b.view("p1")).toEqual(a.view("p1"));
  });

  /** p1's two-card library, replaced by Transmogulate; p2 watches. */
  function immutableLibraryGame(first: string): Scenario {
    const s = scenario({
      seed: "hunt-r3-transmog-immutable",
      p1: { hand: [TRANSMOGULATE, STOCKPILE], mana: 10, library: [first, HIT_JOB] },
      p2: { hand: [STOCKPILE], library: [HIT_JOB] },
    });
    s.play(TRANSMOGULATE);
    return s;
  }

  it("R35 Transmogulate replaces an Immutable library card too, so the opponent cannot count the library's Immutable cards (§9.1, R23)", () => {
    const withVanilla = immutableLibraryGame(MR_VANILLA);
    const without = immutableLibraryGame(STOCKPILE);

    // "Other zones: any card from the pool, same counts": Immutable stays only on the board, where
    // the Replace is a Transform (R23, §8 #83), so the library is replaced whole.
    expect(withVanilla.pile("p1", "library").map((card) => card.defId)).not.toContain(MR_VANILLA);
    expect(withVanilla.view("p2")).toEqual(without.view("p2"));
  });
});

describe("R177: a number the view carries is never taken by a hidden card", () => {
  /** A Rush Token dies (no Eater gain, R11), then p1 installs a modifier with Lunar Eclipse. */
  function modifierGame(p2Hand: string): Scenario {
    const s = scenario({
      seed: "hunt-r3-seq",
      p1: { hand: [HIT_JOB, LUNAR_ECLIPSE, STOCKPILE], library: [HIT_JOB, HIT_JOB] },
      p2: { field: ["T-rush"], hand: [p2Hand, STOCKPILE], library: [HIT_JOB, HIT_JOB] },
    });
    const token = must(s.unit("p2", 1), "p2's Rush Token");
    s.play(HIT_JOB, { targets: [{ pick: "instance", instanceId: token.id }] });
    s.expectInZone(token, "gone");
    s.play(LUNAR_ECLIPSE, { targets: [{ pick: "hero", player: "p2" }] });
    return s;
  }

  it("R177 a modifier's id does not tell the opponent that p2 holds a Corpse Eater (§9.1, R169)", () => {
    const eater = modifierGame(CORPSE_EATER);
    const plain = modifierGame(SEVEN_SEVEN);

    // The token fed nothing (R11), so no `buffed` went out, and the hand is a count (§10.8).
    expect(eventsOf(eater.view("p1"), "buffed")).toHaveLength(0);
    expect(eater.view("p1").you.modifiers).toHaveLength(1);
    expect(eater.view("p1")).toEqual(plain.view("p1"));
  });
});
