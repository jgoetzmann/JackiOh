// What `viewFor` hands each seat about cards it may not read (SPEC §9.1, §10.8, R33, R35, R97,
// R177, R222, R223). Found by the polish-4 edge-case hunt (docs/polish/4-edge-cases.md, lens L10,
// rounds 1 to 6); every case here failed before its fix. Where a leak is a difference between two
// games that differ only in hidden cards, the test builds both and asserts the viewer cannot tell
// them apart. Round 6 found #97 Zephyrs' offer reading a face-down trap and the library's order
// (R222), a library-wide discount whose events spelled out the library's order once a card read
// openly (R177), and instance ids numbered in the order the store sorts a deck in (R223). Round 7
// found a random Make Radiant cueing only the cards it changed, which counted a hidden hand's Radiant
// cards (R177), and #83's library replacements numbered top down, which located a revealed library
// card by its id (R223). Round 8 found a hidden cue's zone saying where #28's pick landed, and #23
// rolling only for a hand that held a base-face card, both of which told p2 about p1's hidden faces
// (R177). The last case, R119's, is the one that did not fail first: it pins the strip `viewFor`
// already made of `cardResolved.arrivedDuring`, which would name a face-down trap if it went out.
//
// Round 9 found three more: a card the mulligan returned, waiting in no pile while a replacement
// draw's cast asks, read as public, so the deal's events named it to the other seat (R224); and #28's
// cues trailed its real picks and landed on the owner's own hand first, so their order told the
// other seat, and their place told the owner, which hidden faces were base-face (R177).
//
// Round 10 found two more in #28, and three things the view left out. R60's pick over the
// non-Radiant cards alone made the chance that #28 passed over p1's public unit hang on how many of
// p1's hidden cards were base-face, and its picks in the zones' order put a face-down trap's after
// the public unit's and a hand card's before it (R242). And a card's own owner could not read what
// it is made of beyond its printed face: a Corpse Eater's meals in hand, a Heroic Power's rolled
// power, a crafted card's definition (R243).

import type {
  Action,
  ActionBody,
  GameEvent,
  PlayerId,
  PlayerView,
  ActionInput,
  CardDef,
  CardType,
} from "@jackioh/shared";
import {
  beginGame,
  createGame,
  createRng,
  defOf,
  effectiveCost,
  legalActions,
  reduce,
  subsystems,
  viewFor,
  type GameState,
  type PendingChoice,
  HIDDEN_ID,
  newInstance,
  registerScripts,
  registeredScripts,
  type Script,
  type CardInstance,
  type EngineSink,
} from "@jackioh/engine";
import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";
import { chooseMode } from "@jackioh/engine/effects";

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
const GLOWY = "core-026";
const GIGA = "core-029";
const GIFTED = "core-064";
const SORCERER = "core-068";
const MASK = "core-065";
const HONEYPOT = "core-060";
const CALL_TO_ARMS = "core-069";
const MOTHS = "core-009";
const BLOOD_RIDDEN = "core-027";
const ZEPHYRS = "core-097";
const HEROIC_POWER = "core-098";
const DREAM = "core-023";
const KNOCKOFF = "core-028";

function eventsOf<T extends GameEvent["type"]>(view: PlayerView, type: T): Extract<GameEvent, { type: T }>[] {
  return view.events.filter((event): event is Extract<GameEvent, { type: T }> => event.type === type);
}

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`missing ${what}`);
  return value;
}

/** The viewer's two views are identical, event list first so a failure names the extra event. */
function indistinguishable(viewer: PlayerId, a: Scenario, b: Scenario): void {
  expect(b.view(viewer).events.map((event) => event.type)).toEqual(a.view(viewer).events.map((event) => event.type));
  expect(b.view(viewer)).toEqual(a.view(viewer));
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

describe("R177: Make Radiant on a hidden card that is already Radiant", () => {
  it("R177 #29 GIGA and #26 Glowy Jelly Bean do not tell the opponent which hidden hand cards were already Radiant (§9.1, §10.8, R97)", () => {
    // #29: "Every card in your hand becomes Radiant". Afterwards both hands are wholly Radiant, so
    // the games differ only in the face p1's 4-mana 7/7 had while p2 could not read it.
    const giga = (radiant: boolean): Scenario => {
      const s = scenario({
        seed: "hunt-r4-giga",
        p1: { hand: [GIGA, { def: SEVEN_SEVEN, radiant }, BIGOT], mana: 10, library: [HIT_JOB] },
        p2: { hand: [STOCKPILE], library: [HIT_JOB] },
      });
      s.play(GIGA);
      return s;
    };
    const gigaBase = giga(false);
    const gigaRadiant = giga(true);
    expect(gigaBase.hand("p1").every((card) => card.radiant)).toBe(true);
    expect(gigaRadiant.hand("p1").every((card) => card.radiant)).toBe(true);
    // A cue only for the cards that changed would count, for p2, how many were Radiant before.
    indistinguishable("p2", gigaBase, gigaRadiant);

    // #26: "Choose a card in your hand; it becomes Radiant". The same no-op on the chosen card.
    const glowy = (radiant: boolean): Scenario => {
      const s = scenario({
        seed: "hunt-r4-glowy",
        p1: { hand: [GLOWY, { def: SEVEN_SEVEN, radiant }, BIGOT], mana: 10, library: [HIT_JOB] },
        p2: { hand: [STOCKPILE], library: [HIT_JOB] },
      });
      const chosen = must(s.hand("p1").find((card) => card.defId === SEVEN_SEVEN), "p1's 7/7");
      s.play(GLOWY, { targets: [{ pick: "instance", instanceId: chosen.id }] });
      expect(s.card(chosen).radiant).toBe(true);
      return s;
    };
    indistinguishable("p2", glowy(false), glowy(true));
  });

  it("R177 #64 Gifted Program does not tell the opponent that a face-down trap was already Radiant (§9.1, §10.8, R33, R97, R213)", () => {
    // The trap is p1's first card costing 1 or less this turn, so §10.5 step 3 makes it Radiant
    // (R213). It lands face-down and Radiant in both games; only its face in hand differed.
    const game = (radiant: boolean): Scenario => {
      const s = scenario({
        seed: "hunt-r4-gifted",
        p1: { backrow: [GIFTED], hand: [{ def: SHEEPISH, radiant }, STOCKPILE], mana: 4, library: [HIT_JOB] },
        p2: { hand: [STOCKPILE], library: [HIT_JOB] },
      });
      s.play(SHEEPISH, { zone: 2 });
      return s;
    };
    const base = game(false);
    const radiant = game(true);
    expect(base.backrow("p1", 2)?.radiant).toBe(true);
    expect(radiant.backrow("p1", 2)?.radiant).toBe(true);
    expect(base.view("p2").opponent.backrow[1]).toEqual({ faceDown: true });
    indistinguishable("p2", base, radiant);
  });
});

describe("R177: Eugenics' Radiant roll over a hidden library", () => {
  /**
   * p1's library is nine 4-mana 7/7s. Eugenics exiles 8 at random, and with this seed the card left
   * is library[5]; each remaining library card then has a 30% chance to become Radiant (§8 #42),
   * and with this seed that card's roll comes up. The two games differ only in whether that one
   * library card, which neither player can read (§9.1), was Radiant already.
   */
  function eugenicsGame(leftCardRadiant: boolean): Scenario {
    const library = Array.from({ length: 9 }, (_, at) => ({ def: SEVEN_SEVEN, radiant: leftCardRadiant && at === 5 }));
    const s = scenario({
      seed: "r5-eugenics-0",
      p1: { hand: [EUGENICS, STOCKPILE], mana: 10, library },
      p2: { hand: [STOCKPILE], library: [STOCKPILE] },
    });
    s.play(EUGENICS);
    return s;
  }

  it("R177 #42 rolls every remaining library card, so its cues do not count the ones already Radiant (§8 #42, §9.1, R97)", () => {
    const base = eugenicsGame(false);
    const radiant = eugenicsGame(true);

    // The same eight cards went to the (public) exile pile in both games, all of them base-face.
    expect(base.pile("p1", "exile").map((card) => card.id)).toEqual(radiant.pile("p1", "exile").map((card) => card.id));
    expect(base.pile("p1", "exile").every((card) => !card.radiant)).toBe(true);
    // One card is left, and it ends Radiant in both games: rolled into it, or already there.
    expect(base.pile("p1", "library").map((card) => card.radiant)).toEqual([true]);
    expect(radiant.pile("p1", "library").map((card) => card.radiant)).toEqual([true]);

    // "Each remaining library card has a 30% chance" (§8 #42): the already-Radiant card is rolled
    // like any other, and a success on a card nobody may read is cued whether or not its flag
    // changed (R177). A cue for the changed cards only lets both seats count the Radiant ones.
    indistinguishable("p2", base, radiant);
    indistinguishable("p1", base, radiant);
  });
});

describe("R177: a number taken by a face-down trap owed an event", () => {
  /**
   * p1's Twisted Sorcerer swings for lethal at p2 (5 health). p2's lane-1 My Pawn cancels it and
   * the AI plays out p1's turn (R44); p2's turn starts inside that playout and Masochism Mask asks
   * p2 (§8 #65), so the declaration's trap window stops with a prompt open. p2's lane-2 card is
   * face-down, and the games differ only in what it is. p2 answers, then plays Lunar Eclipse,
   * whose "next Spell costs 1 less" is a modifier both seats read with its id (R169).
   */
  function pawnGame(laneTwo: string): Scenario {
    const s = scenario({
      seed: "r5-owed-window",
      p1: { field: [SORCERER], library: [GIGA, GIGA, GIGA] },
      p2: {
        health: 5,
        hand: [LUNAR_ECLIPSE, STOCKPILE],
        backrow: [
          { def: MY_PAWN, lane: 1, faceUp: false },
          { def: laneTwo, lane: 2, faceUp: false },
          { def: MASK, lane: 3 },
        ],
        library: [GIGA, GIGA, GIGA],
      },
    });
    s.attack(SORCERER, "hero");
    s.answer("lose 3");
    s.play(LUNAR_ECLIPSE, { targets: [{ pick: "hero", player: "p1" }] });
    return s;
  }

  it("R177 p1 cannot tell from a modifier's id that p2's other face-down trap is a second My Pawn (§10.8, R33, R169)", () => {
    const twoPawns = pawnGame(MY_PAWN);
    const pawnAndSheep = pawnGame(SHEEPISH);
    const pawnAndHoneypot = pawnGame(HONEYPOT);

    // Every game played the same public course: the attack cancelled, p1's turn handed over and
    // ended, p2 on turn 10 with Lunar Eclipse's discount live, and the lane-2 card still face-down.
    for (const s of [twoPawns, pawnAndSheep, pawnAndHoneypot]) {
      expect(s.state.turn).toBe(10);
      expect(s.state.active).toBe("p2");
      expect(s.view("p1").opponent.backrow[1]).toEqual({ faceDown: true });
      expect(s.view("p1").opponent.modifiers).toHaveLength(1);
    }

    // What p2's lane-2 face-down card is must not reach p1 (R33), not even through the number the
    // counter hands the next modifier: R177's "no number the view carries is taken by a hidden card".
    indistinguishable("p1", pawnAndSheep, twoPawns);
    indistinguishable("p1", pawnAndHoneypot, twoPawns);
  });
});

/** The def ids a Discover prompt offers the viewer, sorted. */
function offeredTo(s: Scenario, viewer: PlayerId): string[] {
  const pending = s.view(viewer).pending;
  if (pending === null || !pending.forYou) throw new Error(`no prompt open for ${viewer}`);
  return pending.options.map((option) => option.defId ?? option.key).sort();
}

describe("R222: #97 Zephyrs' dry run and hidden information", () => {
  /**
   * p1 casts Zephyrs against p2's 1/14 Moths, which no affordable printed attack kills, so a
   * candidate "clears the enemy board" (§10.7) only through what its text does. p2's lane-1 card is
   * face-down, and the two games differ only in what it is: Sheepish, or My Pawn (which answers a
   * declared attack and never a play).
   */
  function zephyrsAgainst(trap: string): Scenario {
    const s = scenario({
      seed: "r6-zephyrs-trap",
      p1: { hand: [ZEPHYRS, STOCKPILE], library: [HIT_JOB, HIT_JOB] },
      p2: { field: [MOTHS], backrow: [{ def: trap, lane: 1 }], hand: [STOCKPILE], library: [HIT_JOB] },
    });
    s.play(ZEPHYRS);
    return s;
  }

  it("R222 the cards #97 offers do not tell p1 what p2's face-down trap is (§9.1, §10.8, R33)", () => {
    const sheep = zephyrsAgainst(SHEEPISH);
    const pawn = zephyrsAgainst(MY_PAWN);

    // p1 reads a bare face-down zone in both games, and both have the Discover open.
    expect(sheep.view("p1").opponent.backrow[0]).toEqual({ faceDown: true });
    expect(pawn.view("p1").opponent.backrow[0]).toEqual({ faceDown: true });
    expect(offeredTo(sheep, "p1")).toHaveLength(3);

    // The scorer ranks for p1 (§10.7, R29), and what p1 may read is the same in both games, so the
    // three cards it offers must be too: an offer that moves with p2's face-down card names it.
    expect(offeredTo(sheep, "p1")).toEqual(offeredTo(pawn, "p1"));
    indistinguishable("p1", pawn, sheep);
  });

  /**
   * p1 is at 5 health, so §10.7's heal priority applies, and p2 has no units. The two games differ
   * only in the order of p1's own library, which nobody may read (§3, §9.1, §10.8): Blood Ridden
   * Glowy Jelly Bean (cast on draw: lose 5) is on top, or at the bottom.
   */
  function zephyrsOverLibrary(library: readonly string[]): Scenario {
    const s = scenario({
      seed: "r6-zephyrs-library",
      p1: { hand: [ZEPHYRS, STOCKPILE], health: 5, library: [...library] },
      p2: { hand: [STOCKPILE], library: [HIT_JOB] },
    });
    s.play(ZEPHYRS);
    return s;
  }

  it("R222 the cards #97 offers do not tell p1 the order of its own library (§3, §9.1, §10.8)", () => {
    const onTop = zephyrsOverLibrary([BLOOD_RIDDEN, HIT_JOB, HIT_JOB]);
    const atBottom = zephyrsOverLibrary([HIT_JOB, HIT_JOB, BLOOD_RIDDEN]);

    expect(offeredTo(onTop, "p1")).toHaveLength(3);
    expect(onTop.view("p1").you.libraryCount).toBe(3);

    // "The rest of the library stays hidden from both" (§10.8): an offer that moves with the order
    // of p1's library tells p1 what is on top of it.
    expect(offeredTo(onTop, "p1")).toEqual(offeredTo(atBottom, "p1"));
    expect(eventsOf(onTop.view("p1"), "drawn")).toHaveLength(0);
    indistinguishable("p1", atBottom, onTop);
  });
});

describe("R177: a library card's place in a library-wide event sequence", () => {
  /**
   * "chaos-2" is a seed whose #95 rolls "every card in your hand and library costs 2 less", which
   * emits one `costChanged` per hand card and then one per library card, top first. #69 Call to
   * Arms then recruits p1's one Unit (Gary, 1 cost) out of the library. The games differ only in
   * where Gary was: on top of the two Hit Jobs, or between them.
   */
  function chaosThenRecruit(library: readonly string[]): Scenario {
    const s = scenario({
      seed: "chaos-2",
      p1: { hand: [CALL_TO_CHAOS, CALL_TO_ARMS, STOCKPILE], mana: 10, library: [...library] },
      p2: { hand: [STOCKPILE], library: [HIT_JOB] },
    });
    s.play(CALL_TO_CHAOS);
    s.play(CALL_TO_ARMS);
    return s;
  }

  /** Where in the view's `costChanged` sequence the recruited card's own event sits. */
  function placeOfRecruited(s: Scenario, viewer: PlayerId): number {
    const gary = s.unit("p1", 1);
    if (gary === null || gary.defId !== GARY) throw new Error("Call to Arms recruited no Gary");
    return eventsOf(s.view(viewer), "costChanged").findIndex((event) => event.instanceId === gary.id);
  }

  /** The view's `costChanged` events, in order. */
  function discounts(s: Scenario, viewer: PlayerId): GameEvent[] {
    return eventsOf(s.view(viewer), "costChanged");
  }

  it("R177 a discount made while a card lay in the library stays unread once the card reads openly, so its place says nothing (§3, §9.1, R97)", () => {
    const onTop = chaosThenRecruit([GARY, HIT_JOB, HIT_JOB]);
    const second = chaosThenRecruit([HIT_JOB, GARY, HIT_JOB]);

    // The discount rolled for the two hand cards and the three library cards, and Gary is on the
    // field in both games, the two Hit Jobs still in the library.
    for (const s of [onTop, second]) {
      expect(eventsOf(s.view("p2"), "costChanged").length).toBeGreaterThanOrEqual(5);
      expect(s.pile("p1", "library").map((card) => card.defId)).toEqual([HIT_JOB, HIT_JOB]);
    }

    // §9.1 hides library order from both players, which is why R97 blanks `shuffledIn.position`
    // even for a card the viewer may read, and why R177 hides a library card's cost. The discount
    // went out one event per card in library order, so read openly once Gary did, its place among
    // them would say how deep Gary lay — here, whether p1's next draw was a 1-cost Unit. The finder
    // asked for Gary's event to read openly at the same place in both games; what SPEC asks is that
    // neither seat learns the order, and the event was made where nobody could read it (§3), so it
    // stays unread for good (R177) and both seats read the same batch in both games.
    for (const viewer of ["p1", "p2"] as const) {
      expect(placeOfRecruited(onTop, viewer)).toBe(-1);
      expect(placeOfRecruited(second, viewer)).toBe(-1);
      expect(discounts(second, viewer)).toEqual(discounts(onTop, viewer));
    }
  });
});

describe("R223: instance ids and the order a deck was submitted in", () => {
  /**
   * `apps/server`'s store hands `createGame` each deck ordered by card id (`app.resolve_deck`,
   * "a deck saved in one order comes back sorted"), and `createGame` numbers every card in that
   * order before §2.1 shuffles the library. This test cannot use `scenario()`, which numbers its
   * cards in its own setup order: it plays the engine's own path, `createGame` → `beginGame` →
   * mulligans → turns, as `replay.fold` and the server do.
   *
   * p2's deck is 18 cards costing 1 and #98 Heroic Power (a Quickdraw card, so it starts in the
   * opening hand whatever the shuffle does), plus one card p2 never shows: #1 Big D-fender, which
   * sorts before every other card of the deck, or #100 Ceaseless Void, which sorts after them all.
   * p1 only ever ends its turn; p2 plays Heroic Power as soon as it can pay its X, and nothing else.
   */
  const P1_DECK = [
    "core-003", "core-004", "core-005", "core-007", "core-008", "core-010", "core-011", "core-015",
    "core-018", "core-023", "core-031", "core-035", "core-036", "core-039", "core-041", "core-044",
    "core-048", "core-050", "core-060", "core-062",
  ];
  const P2_SHARED = [
    "core-003", "core-004", "core-005", "core-007", "core-008", "core-011", "core-015", "core-023",
    "core-031", "core-035", "core-036", "core-044", "core-050", "core-062", "core-063", "core-081",
    "core-082", "core-086", HEROIC_POWER,
  ];
  /** The order the server's store returns a deck in: by card id. */
  const sortedDeck = (ids: readonly string[]): string[] => [...ids].sort();

  function heroicPowerOf(state: GameState): string | undefined {
    return state.players.p2.backrow.find((card) => card?.defId === HEROIC_POWER)?.id;
  }

  function gameWithHidden(hidden: string): GameState {
    const decks: [string[], string[]] = [sortedDeck(P1_DECK), sortedDeck([...P2_SHARED, hidden])];
    let state = beginGame(createGame({ seed: "r6-deck-order", decks })).state;
    let nonce = 0;
    const act = (player: PlayerId, body: ActionBody): void => {
      const result = reduce(state, { ...body, playerId: player, nonce: `r6-${nonce}` } as Action);
      nonce += 1;
      if (result.error !== undefined) throw new Error(`${player} ${body.type}: ${result.error}`);
      state = result.state;
    };
    act("p1", { type: "mulligan", keep: state.players.p1.hand.map((card) => card.id) });
    act("p2", { type: "mulligan", keep: state.players.p2.hand.map((card) => card.id) });
    for (let guard = 0; guard < 16 && heroicPowerOf(state) === undefined; guard += 1) {
      if (state.result !== null || state.pending !== null) break;
      if (state.active === "p1") {
        act("p1", { type: "endTurn" });
        continue;
      }
      const power = state.players.p2.hand.find((card) => card.defId === HEROIC_POWER);
      const play = legalActions(state, "p2").find((body) => body.type === "play" && body.instanceId === power?.id);
      act("p2", play ?? { type: "endTurn" });
    }
    return state;
  }

  /** The id `createGame` gives p2's Heroic Power, with `hidden` as p2's one card that never shows. */
  function powerIdAt(seed: string, hidden: string): string | undefined {
    const decks: [string[], string[]] = [sortedDeck(P1_DECK), sortedDeck([...P2_SHARED, hidden])];
    return createGame({ seed, decks }).players.p2.library.find((card) => card.defId === HEROIC_POWER)?.id;
  }

  const SEEDS = Array.from({ length: 200 }, (_, at) => `r6-deck-order-${at}`);

  it("R223 a card's instance id does not tell the opponent where it sorts in its owner's deck (§2.1, §9.1, R97)", () => {
    // The id reaches the opponent: p2 plays Heroic Power and p1's view names it (§10.8, R97).
    const game = gameWithHidden("core-100");
    const id = must(heroicPowerOf(game), "p2's Heroic Power on the field");
    expect(viewFor(game, "p1").opponent.hero.powers[0]?.instanceId).toBe(id);

    // Numbered in the order the store sorts a deck in, the power was c40 when p2's hidden card sorts
    // before it (#1) and c39 when it sorts after it (#100): the id was its rank. The finder asked for
    // one id in both games under the same seed, which no numbering can give — any order a card takes
    // among its deck's shifts with the cards around it. What §9.1 asks is that the id tell p1 nothing,
    // and the seed that orders the numbers is as hidden as the one that shuffles the library (§2.1):
    // whatever id p1 reads, the other game shows it under some seed, and the id is not the rank.
    for (const hidden of ["core-001", "core-100"]) {
      const other = hidden === "core-001" ? "core-100" : "core-001";
      const seen = powerIdAt(SEEDS[0] ?? "", hidden);
      expect(SEEDS.some((seed) => powerIdAt(seed, other) === seen), `${seen} is possible either way`).toBe(true);
      expect(new Set(SEEDS.map((seed) => powerIdAt(seed, hidden))).size).toBeGreaterThan(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Round 7 (lens L10): a random Make Radiant's cue count, and the ids a Replace mints in a library.
// ---------------------------------------------------------------------------

const RAPID = "core-010";
const TUTOR = "core-051";

function idNumber(id: string): number {
  const n = Number(id.replace(/^c/, ""));
  if (!Number.isInteger(n)) throw new Error(`not an instance id: ${id}`);
  return n;
}

describe("R177: a random Make Radiant over a hidden hand", () => {
  /**
   * p1 plays Stockpile; its first draw is #27 Blood Ridden Glowy Jelly Bean, which casts itself and
   * makes a random non-Radiant card of p1's hand Radiant (R60). p1's hand then holds two cards, both
   * Radiant or both not — hidden from p2 (§9.1, §10.8).
   */
  function bloodRiddenGame(handRadiant: boolean): Scenario {
    const s = scenario({
      seed: "hunt-r7-blood-ridden",
      p1: {
        hand: [STOCKPILE, { def: HIT_JOB, radiant: handRadiant }, { def: RAPID, radiant: handRadiant }],
        library: [BLOOD_RIDDEN, SEVEN_SEVEN, SEVEN_SEVEN, SEVEN_SEVEN],
      },
      p2: { hand: [STOCKPILE], library: [HIT_JOB, HIT_JOB] },
    });
    s.play(STOCKPILE);
    return s;
  }

  it("R177 #27's cue does not tell the opponent whether p1's hidden hand was already all Radiant (§9.1, R60)", () => {
    const plain = bloodRiddenGame(false);
    const radiant = bloodRiddenGame(true);

    // The cast happened in both games (a public play), and p1's hand ends up the same size.
    for (const s of [plain, radiant]) {
      expect(eventsOf(s.view("p2"), "cardPlayed").some((event) => event.defId === BLOOD_RIDDEN)).toBe(true);
    }
    expect(radiant.view("p2").opponent.hand).toEqual(plain.view("p2").opponent.hand);

    // R177: "a cue for the changed cards only would count the Radiant ones". R60 narrows the random
    // pick to non-Radiant cards, so a cue only for a card that changed tells p2 whether any of p1's
    // hidden hand cards was still non-Radiant. p2 must not be able to tell the two games apart.
    indistinguishable("p2", plain, radiant);
  });
});

describe("R223: instance ids Transmogulate gives a library", () => {
  it("R223 the ids Transmogulate mints for p1's library do not tell p1 where a revealed library card lies (§9.1, §10.8)", () => {
    const s = scenario({
      seed: "hunt-r7-transmog-ids",
      p1: {
        hand: [TRANSMOGULATE, TUTOR, RAPID],
        library: Array.from({ length: 16 }, () => HIT_JOB),
        graveyard: [HIT_JOB],
      },
      p2: { hand: [STOCKPILE], library: [HIT_JOB, HIT_JOB] },
    });

    s.play(TRANSMOGULATE);

    // What p1 reads after the Replace: the graveyard card's replacement is public, and the library is
    // a count. R35 walks the library top down and then the graveyard, so if the replacements were
    // numbered in that walk the library's ids are the block just below the graveyard one's.
    const afterReplace = s.view("p1");
    const gyReplacement = must(
      eventsOf(afterReplace, "transformed").find((event) => event.newInstanceId !== HIDDEN),
      "the graveyard card's public replacement",
    );
    const libraryCount = afterReplace.you.libraryCount;
    const firstLibraryId = idNumber(gyReplacement.newInstanceId) - libraryCount;

    // #51 Private Tutor reveals library cards to p1 as prompt options (§10.8). Pick the type and
    // bracket with the most matches so the reveal shows as many cards as it can.
    s.play(TUTOR);
    const library = s.pile("p1", "library");
    const typeMatches = (defId: string, want: string): boolean => {
      const type = defOf(s.state, defId).type;
      return want === "Trap" ? type === "Trap" || type === "Field Trap" : type === want;
    };
    const bestType = mostMatching(must(s.state.pending, "the type prompt"), (want) =>
      library.filter((card) => typeMatches(card.defId, want)).length,
    );
    s.answer(bestType);
    const bestBracket = mostMatching(must(s.state.pending, "the bracket prompt"), (want) =>
      library.filter((card) => typeMatches(card.defId, bestType) && inBracket(effectiveCost(s.state, card), want)).length,
    );
    s.answer(bestBracket);

    const reveal = must(s.view("p1").pending, "p1's reveal prompt");
    if (!reveal.forYou) throw new Error("the reveal should be p1's");
    const revealed = reveal.options.flatMap((option) => (option.instanceId === undefined ? [] : [option.instanceId]));
    expect(revealed.length).toBeGreaterThanOrEqual(2);

    // §9.1 and §10.8: "the rest of the library stays hidden from both" — its order included, for its
    // own player too (§3's "Nobody"). R223: an instance id says nothing of where its card came from.
    // The option's id is the answer's handle and is p1's to read; what it must not do is give p1 the
    // card's place. Reading each revealed card's place off its id must not give its real place — the
    // two cards p1 does not take stay in the library, where p1 would know when each comes up.
    const ids = s.pile("p1", "library").map((card) => card.id);
    const readOffTheId = revealed.map((id) => idNumber(id) - firstLibraryId);
    const actual = revealed.map((id) => ids.indexOf(id));
    expect(readOffTheId).not.toEqual(actual);
  });
});

/** The mode option with the most library matches. */
function mostMatching(pending: PendingChoice, count: (option: string) => number): string {
  const options = pending.options.flatMap((option) => (option.selection.pick === "mode" ? [option.selection.option] : []));
  return must([...options].sort((a, b) => count(b) - count(a))[0], "a mode option");
}

function inBracket(cost: number, bracket: string): boolean {
  if (bracket === "0-1") return cost <= 1;
  if (bracket === "4+") return cost >= 4;
  return cost === Number(bracket);
}

// ---------------------------------------------------------------------------
// #28 Knockoff Temu Glowy Jelly Bean: where a hidden Make Radiant landed
// ---------------------------------------------------------------------------

describe("R177: where a random Make Radiant over hidden zones landed", () => {
  /**
   * p1 plays #28 ("2 random cards among your library, hand and field become Radiant", R60). p1's
   * hand then holds one Hit Job, Radiant already or not, and the library three 4-mana 7/7s, none
   * Radiant; p1 has nothing on the field. Neither the hand nor the library is p2's to read (§9.1).
   * With this seed the base-face Hit Job is one of the two picks.
   */
  function knockoffGame(handRadiant: boolean): Scenario {
    const s = scenario({
      seed: "r8-l10-knockoff-0",
      p1: {
        hand: [KNOCKOFF, { def: HIT_JOB, radiant: handRadiant }],
        library: [SEVEN_SEVEN, SEVEN_SEVEN, SEVEN_SEVEN],
      },
      p2: { hand: [STOCKPILE], library: [HIT_JOB] },
    });
    s.play(KNOCKOFF);
    return s;
  }

  it("R177 #28's cues do not tell p2 whether p1's hidden hand card was already Radiant (§9.1, R60)", () => {
    const plain = knockoffGame(false);
    const radiant = knockoffGame(true);

    // Two picks in both games, none of them on a card p2 may read, and the Hit Job ends Radiant in
    // both: picked in one game, already Radiant in the other.
    for (const s of [plain, radiant]) {
      const cues = s.view("p2").events.filter((event) => event.type === "radiantSet");
      expect(cues).toHaveLength(2);
      expect(must(s.hand("p1")[0], "p1's Hit Job").radiant).toBe(true);
    }

    // R177: a cue on a card p2 may not read must not count p1's hidden Radiant cards. The zone a
    // redacted `radiantSet` carries says whether the pick landed in the hand or the library, so a
    // "hand" cue tells p2 that p1's hand still held a non-Radiant card.
    indistinguishable("p2", plain, radiant);
  });

  /**
   * The same pick over "field" (§8 #28): p1's lane-2 Sheepish is face-down, so only p1 reads it
   * (R33), and it is Radiant already or not. With this seed the base-face trap is one of the picks
   * (R242 draws the owner's hidden cards' share of the pick by the groups' sizes alone).
   */
  function trapGame(trapRadiant: boolean): Scenario {
    const s = scenario({
      seed: "r8-l10-knockoff-trap-5",
      p1: {
        hand: [KNOCKOFF, STOCKPILE],
        backrow: [{ def: SHEEPISH, lane: 2, radiant: trapRadiant }],
        library: [SEVEN_SEVEN, SEVEN_SEVEN, SEVEN_SEVEN],
      },
      p2: { hand: [STOCKPILE], library: [HIT_JOB] },
    });
    s.play(KNOCKOFF);
    return s;
  }

  it("R177 #28's cues do not tell p2 whether p1's face-down trap was already Radiant (§9.1, §10.8, R33, R60)", () => {
    const plain = trapGame(false);
    const radiant = trapGame(true);

    for (const s of [plain, radiant]) {
      expect(s.view("p2").opponent.backrow[1]).toEqual({ faceDown: true });
      expect(s.view("p2").events.filter((event) => event.type === "radiantSet")).toHaveLength(2);
      expect(must(s.backrow("p1", 2), "p1's trap").radiant).toBe(true);
    }

    // Which of p1's hidden cards the owner's share of the pick lands on hangs on their faces (R60
    // picks the non-Radiant ones, R242), so a cue whose zone named the face-down trap's lane would
    // tell p2 the trap was base-face, the face R33 keeps from p2: the view says only whose it was.
    indistinguishable("p2", plain, radiant);
  });
});

// ---------------------------------------------------------------------------
// #23 Reoccurring Dream: the roll on an all-Radiant hand
// ---------------------------------------------------------------------------

describe("R177: #23's chance on a hidden hand", () => {
  /** p1 plays #23 with one other card in hand, Radiant or not. With this seed the 30% succeeds. */
  function dreamGame(handRadiant: boolean): Scenario {
    const s = scenario({
      seed: "r8-l10-dream-8",
      p1: { hand: [DREAM, { def: HIT_JOB, radiant: handRadiant }], library: [SEVEN_SEVEN] },
      p2: { hand: [STOCKPILE], library: [HIT_JOB] },
    });
    s.play(DREAM);
    return s;
  }

  it("R177 #23's cue does not tell p2 whether p1's hidden hand was already all Radiant (§9.1, R60, R129)", () => {
    const plain = dreamGame(false);
    const radiant = dreamGame(true);

    // The roll succeeded in the game with a base-face Hit Job, which became Radiant.
    expect(must(plain.hand("p1").find((card) => card.defId === HIT_JOB), "p1's Hit Job").radiant).toBe(true);
    expect(plain.view("p2").events.some((event) => event.type === "radiantSet")).toBe(true);

    // R177 lists #23 among the random picks whose unmade picks are cued on the zone's Radiant cards,
    // "so an all-Radiant hand … is cued as a hand the pick changed". #23 skips its roll when the
    // hand holds nothing it could change, so it never cues then, and a cue tells p2 the hand held a
    // non-Radiant card.
    indistinguishable("p2", plain, radiant);
  });
});

// ---------------------------------------------------------------------------
// R119's bookkeeping on `cardResolved`
// ---------------------------------------------------------------------------

describe("R119: the arrivals a play's cardResolved names stay the engine's", () => {
  it("R119 cardResolved's arrivedDuring, which can name a face-down trap the play's Recruit set, reaches neither seat's view (§9.1, §10.8, R33, R97)", () => {
    const s = scenario({
      seed: "edge-r8-hp-honeypot",
      p1: { hand: [HEROIC_POWER, MR_VANILLA], library: [HONEYPOT, MR_VANILLA, MR_VANILLA, MR_VANILLA], mana: 8 },
      p2: { hand: [MR_VANILLA], library: [MR_VANILLA, MR_VANILLA, MR_VANILLA, MR_VANILLA, MR_VANILLA, MR_VANILLA] },
    });
    // R43: the power lives on the instance; "(3) Recruit a permanent".
    const power = must(s.hand("p1")[0], "p1's Heroic Power");
    power.memory[subsystems.POWER_KEY] = "recruit";

    s.play(power);

    // The Recruit set the Bear Honeypot face-down on p1's backrow while the play resolved, so the
    // raw cardResolved names it among the play's arrivals.
    const honeypot = must(
      [1, 2, 3, 4, 5].map((lane) => s.backrow("p1", lane)).find((card) => card?.defId === HONEYPOT),
      "the recruited Bear Honeypot",
    );
    expect(honeypot.faceUp).not.toBe(true);
    const resolved = s.events.filter(
      (event): event is Extract<GameEvent, { type: "cardResolved" }> =>
        event.type === "cardResolved" && event.instanceId === power.id,
    );
    expect(resolved.map((event) => event.arrivedDuring)).toEqual([[honeypot.id]]);

    // Neither seat's view carries the field, and p2's does not name p1's face-down trap through it.
    for (const seat of ["p1", "p2"] as const) {
      expect(eventsOf(s.view(seat), "cardResolved").length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(s.view(seat).events)).not.toContain("arrivedDuring");
    }
    expect(JSON.stringify(s.view("p2").events)).not.toContain(`"${honeypot.id}"`);
  });
});

// ---------------------------------------------------------------------------
// Round 9: the mulligan's returned cards and #28's cues (R224, R177)
// ---------------------------------------------------------------------------

function fixtureDef(id: string, type: CardType): CardDef {
  const face = type === "Unit" ? { attack: 2, health: 2, keywords: [], text: id } : { keywords: [], text: id };
  return {
    id,
    index: id,
    name: id,
    set: "Core",
    type,
    tags: [],
    rarity: "Common",
    token: false,
    cost: 0,
    base: { ...face },
    radiant: { ...face },
  };
}

let setupNonce = 0;
function actAs(state: GameState, player: PlayerId, body: ActionInput | Record<string, unknown>): GameState {
  setupNonce += 1;
  const result = reduce(state, { ...body, playerId: player, nonce: `edge-r9-view-${setupNonce}` } as Action);
  if (result.error !== undefined) throw new Error(result.error);
  return result.state;
}

/** Every id or def id an event names, for "does this view name X" checks. */
function named(event: GameEvent): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(event)) {
    if (typeof value === "string" && /(Id|Ids)$/.test(key)) out.push(value);
    if (Array.isArray(value) && /Ids$/.test(key)) out.push(...value.filter((v): v is string => typeof v === "string"));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The mulligan's returned cards while setup waits on a cast's question (R224, R97)
// ---------------------------------------------------------------------------

const ASKING = "edge-r9-view-cod-asks";

function asking(state: GameState): void {
  state.transientDefs[ASKING] = fixtureDef(ASKING, "Spell");
  const script: Script = {
    staticFlags: { castOnDraw: true },
    cry: () => [chooseMode({ options: ["ok"], step: "ok", prompt: "the cast's question" })],
    resume: { ok: () => [] },
  };
  registerScripts({ ...registeredScripts(), [ASKING]: { base: script, radiant: script } });
}

const SETUP_P1_DECK = Array.from({ length: 20 }, (_, at) => `core-${String(at + 1).padStart(3, "0")}`);
const SETUP_P2_DECK = Array.from({ length: 20 }, (_, at) => `core-${String(at + 30).padStart(3, "0")}`);

describe("R224, R97: a card the mulligan returned, while setup waits", () => {
  it("R224 p2's returned opening card stays unread by p1 while p2's replacement cast asks (R97, §9.1)", () => {
    // p1's opening draw hits an asking cast, so p2's opening deal happens inside p1's answer: a
    // recorded action, whose `drawn` events for p2's cards are in p1's view, redacted (R97).
    let seed: string | undefined;
    let begun: GameState | undefined;
    for (let at = 0; at < 300 && seed === undefined; at += 1) {
      const candidate = `edge-r9-view-deal-${at}`;
      const game = createGame({ seed: candidate, decks: [[...SETUP_P1_DECK], [...SETUP_P2_DECK]] });
      asking(game);
      game.players.p1.library[0] = newInstance(game, ASKING, "p1", { z: "library", player: "p1" });
      const state = beginGame(game).state;
      if (state.pending?.kind === "mode" && state.pending.playerId === "p1") {
        seed = candidate;
        begun = state;
      }
    }
    let state = must(begun, "a seed whose opening draw casts the asking card");
    const first = must(state.pending, "p1's cast question");
    state = actAs(state, "p1", { type: "answer", choiceId: first.id, selection: [{ pick: "mode", option: "ok" }] });
    expect(state.pending?.kind).toBe("mulligan");
    expect(state.players.p2.hand.length).toBeGreaterThan(0);

    // p1 keeps its hand; p2's mulligan opens.
    state = actAs(state, "p1", { type: "mulligan", keep: state.players.p1.hand.map((card) => card.id) });
    expect(state.pending?.kind).toBe("mulligan");
    expect(state.pending?.playerId).toBe("p2");

    // p2 returns one card, and its replacement draw is an asking cast, so setup waits (R224) with
    // the returned card in no pile until it goes back.
    const returned = must(state.players.p2.hand[0], "a card for p2 to return");
    const cod = newInstance(state, ASKING, "p2", { z: "library", player: "p2" });
    state.players.p2.library.unshift(cod);
    state = actAs(state, "p2", { type: "mulligan", keep: state.players.p2.hand.slice(1).map((card) => card.id) });
    expect(state.pending?.kind).toBe("mode");
    expect(state.pending?.playerId).toBe("p2");

    // The deal's event naming the returned card is still in p1's window.
    const view = viewFor(state, "p1");
    const deal = view.events.filter((event) => event.type === "drawn" && event.player === "p2");
    expect(deal.length).toBeGreaterThan(0);

    // §9.1: p2's hand is hidden from p1, and the card is on its way back to p2's library, hidden
    // from both. Nothing in p1's view may name it.
    const leaks = view.events.filter((event) => named(event).includes(returned.id) || named(event).includes(returned.defId));
    expect(leaks, JSON.stringify(leaks)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #28's picks and its cues, in the order the other seat sees them (R177, R60, §9.1)
// ---------------------------------------------------------------------------

/** p2's view of the `radiantSet` events #28's play made, redacted as p2 reads them. */
function knockoffCues(seed: string, handRadiant: boolean): { order: string[]; events: GameEvent[] } {
  const s = scenario({
    seed,
    p1: {
      mana: 2,
      // The one card left in p1's hand once #28 is played, Radiant or not; the library is empty.
      hand: ["core-028", { def: "core-016", radiant: handRadiant }],
      library: [],
      field: ["core-025"],
    },
  });
  s.play("core-028");
  const unitId = must(s.unit("p1", 1), "p1's unit").id;
  const events = s.view("p2").events.filter((event) => event.type === "radiantSet");
  const order = events.map((event) => (event.type === "radiantSet" && event.instanceId === unitId ? "unit" : event.instanceId));
  return { order, events };
}

describe("R177, R60: #28's cues keep the hidden faces hidden", () => {
  it("R177 #28's cue on an all-Radiant hand can come in any order a pick could (R60, §9.1)", () => {
    // Two worlds p2 cannot tell apart by what changed: p1's one hidden hand card is base-face (A)
    // or already Radiant (B). Either way #28's two picks make p1's public unit Radiant and cue one
    // hidden card in p1's hand, since R177 cues the pick R60 could not make on the Radiant card, "so
    // an all-Radiant hand ... is cued as a hand the pick changed". The order the two arrive in must
    // not tell the worlds apart either: every order p2 can see in A must be one B can produce.
    const seeds = Array.from({ length: 40 }, (_, at) => `edge-r9-view-28-${at}`);
    const orders = (radiant: boolean): Set<string> =>
      new Set(seeds.map((seed) => JSON.stringify(knockoffCues(seed, radiant).order)));
    const inA = orders(false);
    const inB = orders(true);
    // Sanity: both worlds show p2 the same outcome, the unit and one hidden cue.
    for (const order of [...inA, ...inB]) expect(JSON.parse(order).slice().sort()).toEqual([HIDDEN_ID, "unit"]);
    // A cue that always trailed the public pick said "the hand was all Radiant" whenever a pick led;
    // R242 sends the public card's event first and the hand's after it, in both worlds alike.
    const onlyInA = [...inA].filter((order) => !inB.has(order));
    expect(onlyInA, `A ${JSON.stringify([...inA])} B ${JSON.stringify([...inB])}`).toEqual([]);
  });

  it("R177 #28's cue for a pick it could not make lands where its owner cannot read it either (R60, §9.1, §3)", () => {
    // p1's hand holds two cards that are already Radiant, and its library one card: base-face in
    // world A, Radiant in world B. §3 and §9.1: a library is read by nobody, p1 included, so p1
    // must not learn which world it is in. #28 wants two picks and R177 cues the ones R60 could not
    // make; if the cues go to p1's own hand cards, which p1 reads, the number of them spells out
    // how many of p1's library cards were base-face.
    const cuesFor = (libraryRadiant: boolean): GameEvent[] => {
      const s = scenario({
        seed: "edge-r9-view-28-owner",
        p1: {
          mana: 2,
          hand: ["core-028", { def: "core-016", radiant: true }, { def: "core-005", radiant: true }],
          library: [{ def: "core-010", radiant: libraryRadiant }],
          field: [],
        },
      });
      s.play("core-028");
      return s.view("p1").events.filter((event) => event.type === "radiantSet");
    };
    const worldA = cuesFor(false);
    const worldB = cuesFor(true);
    const shape = (events: readonly GameEvent[]): string[] =>
      events
        .map((event) => (event.type === "radiantSet" ? `${event.zone.z}:${event.instanceId === HIDDEN_ID ? "unread" : "read"}` : ""))
        .sort();
    expect(worldA).toHaveLength(2);
    expect(shape(worldB), `A ${JSON.stringify(worldA)}\nB ${JSON.stringify(worldB)}`).toEqual(shape(worldA));
  });
});

// ---------------------------------------------------------------------------
// Round 10: a random pick over public and hidden cards (R242), and what the view carries (R243)
// ---------------------------------------------------------------------------

const TEMPO_TIMMY = "core-011";

describe("R242: #28's pick over public and hidden cards", () => {
  /**
   * p1 plays #28 with one card left in hand and two in the library, all base-face in world A and all
   * Radiant in world B, and one public unit on the field. Neither the hand nor the library is p2's to
   * read (§9.1).
   */
  function oddsGame(seed: string, hiddenRadiant: boolean): Scenario {
    const s = scenario({
      seed,
      p1: {
        mana: 2,
        hand: [KNOCKOFF, { def: HIT_JOB, radiant: hiddenRadiant }],
        library: [
          { def: SEVEN_SEVEN, radiant: hiddenRadiant },
          { def: SEVEN_SEVEN, radiant: hiddenRadiant },
        ],
        field: [TEMPO_TIMMY],
      },
      p2: { hand: [HIT_JOB], library: [HIT_JOB] },
    });
    s.play(KNOCKOFF);
    return s;
  }

  /** What p2 can see #28 did: whether p1's public unit turned Radiant, and the cues' shape. */
  function outcome(s: Scenario): string {
    const unit = must(s.view("p2").opponent.units[0], "p1's unit");
    const cues = eventsOf(s.view("p2"), "radiantSet").map((event) =>
      event.instanceId === HIDDEN_ID ? `hidden@${event.zone.z}` : "unit",
    );
    return JSON.stringify({ unitRadiant: unit.radiant, cues });
  }

  it("R242 #28 picking p1's public unit or not does not tell p2 whether p1's hidden cards were Radiant (§9.1, R60, R177)", () => {
    const seeds = Array.from({ length: 24 }, (_, at) => `r10-l10-knockoff-odds-${at}`);
    const worldA = new Set(seeds.map((seed) => outcome(oddsGame(seed, false))));
    const worldB = new Set(seeds.map((seed) => outcome(oddsGame(seed, true))));
    // R177's cues make an all-Radiant hidden pile look like a pile the pick changed: every outcome p2
    // can see in the base-face world must be one the all-Radiant world can produce too. Drawn from
    // the non-Radiant cards alone, the two picks always took the public unit when every hidden card
    // was Radiant, so a game where it was passed over told p2 that p1 held a base-face hidden card.
    const onlyInA = [...worldA].filter((seen) => !worldB.has(seen));
    expect(onlyInA, `A ${JSON.stringify([...worldA])}\nB ${JSON.stringify([...worldB])}`).toEqual([]);
    // And the pick is still random: some seeds pass the public unit over.
    expect([...worldA].some((seen) => JSON.parse(seen).unitRadiant === false)).toBe(true);
  });

  /**
   * p1 holds a Hit Job and has Sheepish face-down in backrow lane 2 and Tempo Timmy in unit lane 1,
   * public. Exactly one of the two hidden cards is base-face: the Hit Job in world A, the trap in
   * world B. #28's two picks take that card and the unit in both worlds, so both end with the same
   * faces everywhere.
   */
  function orderGame(trapBase: boolean): Scenario {
    const s = scenario({
      seed: "r10-l10-knockoff-order",
      p1: {
        mana: 2,
        hand: [KNOCKOFF, { def: HIT_JOB, radiant: trapBase }],
        field: [TEMPO_TIMMY],
        backrow: [{ def: SHEEPISH, lane: 2, radiant: !trapBase }],
        library: [],
      },
      p2: { hand: [HIT_JOB], library: [HIT_JOB] },
    });
    s.play(KNOCKOFF);
    return s;
  }

  it("R242 #28's event order does not tell p2 whether its hidden pick was p1's hand card or p1's face-down trap (§9.1, §10.8, R33, R177)", () => {
    const handPick = orderGame(false);
    const trapPick = orderGame(true);
    for (const s of [handPick, trapPick]) {
      expect(must(s.unit("p1", 1), "Timmy").radiant).toBe(true);
      expect(must(s.backrow("p1", 2), "Sheepish").radiant).toBe(true);
      expect(must(s.hand("p1")[0], "Hit Job").radiant).toBe(true);
      expect(s.view("p2").opponent.backrow[1]).toEqual({ faceDown: true });
    }
    // Both worlds end with every card Radiant; which hidden card was base-face is the face R33 and
    // §9.1 keep from p2. In the zones' own order the backrow comes after the unit row, so a hidden
    // pick after the public unit's could only have been the face-down trap; R242 sends the public
    // cards' events first and then p1's hidden ones.
    indistinguishable("p2", handPick, trapPick);
  });
});

describe("R243: what the view carries of a card beyond its printed face", () => {
  function handEntry(view: PlayerView, id: string): Record<string, unknown> {
    const hand = view.you.hand;
    if (!Array.isArray(hand)) throw new Error("expected the viewer's own hand in full");
    return must(hand.find((card) => card.instanceId === id), `${id} in the viewer's hand`) as unknown as Record<string, unknown>;
  }

  it("R243 a Corpse Eater that fed in its owner's hand shows its owner the stats it now has (§10.4 layer 4, §10.8, BUILD M5-T4 buffed)", () => {
    const g = scenario({
      p1: { hand: [CORPSE_EATER, "core-021"], field: [{ def: SEVEN_SEVEN, lane: 1 }], library: [MR_VANILLA, MR_VANILLA] },
      p2: { hand: ["core-021"], field: [{ def: TEMPO_TIMMY, lane: 1 }], library: [MR_VANILLA] },
    });
    const eater = g.card(CORPSE_EATER);
    // The 7/7's Armor 7 eats Timmy's First Strike 3 whole; its 7 kills the 3/3 Timmy.
    g.attack(SEVEN_SEVEN, TEMPO_TIMMY);
    g.expectInZone(TEMPO_TIMMY, "graveyard");
    // §8 #89: in hand it gains the dead unit's attack and max health, 2/2 + 3/3.
    expect(g.card(eater).buffs).toEqual({ attack: 3, health: 3 });

    const entry = handEntry(g.view("p1"), eater.id);
    expect(entry["attack"], "the hand card's attack in p1's view").toBe(5);
    expect(entry["health"], "the hand card's health in p1's view").toBe(5);
    // p2 sees a count of p1's hand, as before (§10.8).
    expect(g.view("p2").opponent.hand).toEqual({ count: 2 });
  });

  it("R243 a Heroic Power in its owner's hand shows the power it rolled, which its cost alone does not name (R43, R151, §10.8)", () => {
    const g = scenario({
      p1: { hand: ["core-021"], library: [HEROIC_POWER, MR_VANILLA, MR_VANILLA] },
      p2: { hand: ["core-021"], library: [MR_VANILLA] },
    });
    // The turn's draw puts the Heroic Power in hand, and R151 rolls its power as it arrives.
    g.startTurn();
    const power = must(g.hand("p1").find((card) => card.defId === HEROIC_POWER), "the drawn Heroic Power");
    const rolled = must(subsystems.powerOf(power), "a rolled power on the drawn Heroic Power");
    const entry = handEntry(g.view("p1"), power.id);
    // Four powers cost 1 and two cost 2 (§8 #98), so the cost in the view does not say which it is.
    expect(entry["cost"]).toBe(rolled.x);
    expect(entry["power"], "p1's view of the card names its power").toBe(rolled.name);
  });

  it("R243 a card Craft a Card fused into its owner's hand can be read from the view: its name and summed stats, and still not by the other seat (R77, R179, §10.8, BUILD M5-T4 fused)", () => {
    const g = scenario({
      p1: { hand: ["core-092", "core-066", "core-021"], library: [MR_VANILLA, MR_VANILLA] },
      p2: { hand: ["core-021"], library: [MR_VANILLA] },
    });
    const ingredients: CardInstance[] = [g.card("core-092"), g.card("core-066")];
    const sink: EngineSink = { state: g.state, events: [], rng: createRng(g.state.seed, g.state.rngCursor) };
    const crafted = must(subsystems.fuse(sink, { ingredients, toHand: "p1" }), "the crafted card");
    const def = must(g.state.transientDefs[crafted.defId], "the fused definition in match state");
    expect(def.name).toBe("Felinor Fiender + The Rock");
    expect([def.base.attack, def.base.health]).toEqual([15, 17]);

    // The definition exists only in match state (R179): no catalog a client holds has it, so the
    // view is the only place its owner can read what they crafted.
    const own = g.view("p1");
    expect(own.defs?.[crafted.defId]?.name).toBe(def.name);
    expect(handEntry(own, crafted.id)["attack"]).toBe(15);
    // It is still a hidden hand card for the other seat (§10.8): nothing names it there.
    expect(JSON.stringify(g.view("p2"))).not.toContain(def.name);
    expect(g.view("p2").defs?.[crafted.defId]).toBeUndefined();
  });
});
