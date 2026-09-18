// #88 Twisting Nether (SPEC §8.5, BUILD M4-T4 row 88): "Every permanent on both rows destroyed,
// Indestructibles survive; radiant enemy-only mode".
//
// BLOCKED on one engine addition, which `src/scripts/088-twisting-nether.ts` documents in full:
// the effects barrel has no verb that can destroy a permanent nobody chose (`destroy` takes a
// `TargetSpec` of `self | selfHero | enemyHero | chosen`), so #88 — like #43 Big Felinor, which
// already needs the same call — needs `destroyAll`, with a `rows` option so it reaches the backrow.
// The script imports nothing for it: one unresolvable import in a card file takes down the
// typecheck and the test run for all 109, since `src/scripts/_generated.ts` imports every one.
//
// Every case that needs the verb is `it.todo` WITH ITS BODY INTACT, per the wave contract: the
// assertions are the acceptance for the verb and become live the moment it exists, rather than
// being deleted or weakened. The cases that need nothing missing are ordinary tests.

import { describe, expect, it } from "vitest";
import { scenario } from "./_harness";
import { base, radiant } from "../src/scripts/088-twisting-nether";

const NETHER = "core-088";

// Inert fixtures: each unit below has a Cry and nothing else, and the harness's `field` setup never
// fires a Cry. Mana Well and Sheepish have no Indestructible, so both rows are destructible.
const GARY = "core-004"; // 1/1
const RENO = "core-053"; // 4/6
const ROCK = "core-066"; // 10/10, printed Indestructible
const MANA_WELL = "core-006"; // Field Spell
const SHEEPISH = "core-041"; // Trap; watches for a Unit the opponent plays, so a Spell is safe

// §2.5: one always-playable card per hand keeps a scenario on the turn it started on.
const FILLER = "core-005";

const SEED = "nether-88";

describe("#88 Twisting Nether — declared play choices (R81, §10.6)", () => {
  it("R81 the base face has no choice to make", () => {
    expect(base.modes).toBeUndefined();
  });

  it("R81 the radiant face declares the side as a play-time mode, not a prompt", () => {
    expect(radiant.modes).toEqual([{ kind: "mode", options: ["enemy", "all"] }]);
  });
});

describe("#88 Twisting Nether — base", () => {
  it.todo("destroys every permanent on both rows, the backrow included — blocked on destroyAll", () => {
    const s = scenario({
      seed: SEED,
      p1: {
        hand: [NETHER, FILLER],
        field: [{ def: GARY, lane: 1 }],
        backrow: [{ def: MANA_WELL, lane: 1 }],
      },
      p2: {
        hand: [FILLER],
        field: [{ def: RENO, lane: 3 }],
        backrow: [{ def: SHEEPISH, lane: 2 }],
      },
    });
    const gary = s.card(GARY);
    const reno = s.card(RENO);
    const well = s.card(MANA_WELL);
    const trap = s.card(SHEEPISH);

    s.play(NETHER);

    s.expectInZone(gary, "graveyard")
      .expectInZone(reno, "graveyard")
      .expectInZone(well, "graveyard")
      .expectInZone(trap, "graveyard");
    expect(s.unit("p1", 1)).toBeNull();
    expect(s.unit("p2", 3)).toBeNull();
    expect(s.backrow("p1", 1)).toBeNull();
    expect(s.backrow("p2", 2)).toBeNull();

    // R12: each card went to ITS OWN owner's graveyard.
    expect(s.pile("p1", "graveyard").map((card) => card.id)).toContain(gary.id);
    expect(s.pile("p2", "graveyard").map((card) => card.id)).toContain(reno.id);
  });

  it.todo("R59 every permanent dies together in one state check — blocked on destroyAll", () => {
    const s = scenario({
      seed: SEED,
      p1: { hand: [NETHER, FILLER], field: [{ def: GARY, lane: 1 }, { def: RENO, lane: 2 }] },
      p2: { hand: [FILLER], field: [{ def: GARY, lane: 1 }] },
    });
    const before = s.state.counters.destroyed;

    s.play(NETHER);

    expect(s.state.counters.destroyed).toBe(before + 3);
    expect(s.lastEvents.filter((event) => event.type === "destroyed")).toHaveLength(3);
  });

  it.todo("R46 an Indestructible unit survives, switches to ATK and loses Taunt — blocked on destroyAll", () => {
    const s = scenario({
      seed: SEED,
      p1: {
        hand: [NETHER, FILLER],
        field: [
          { def: ROCK, lane: 1, position: "DEF" },
          { def: GARY, lane: 2 },
        ],
      },
      p2: { hand: [FILLER] },
    });
    const rock = s.card(ROCK);
    const gary = s.card(GARY);

    s.play(NETHER);

    // R46: the destroy mark is dropped, the unit stays, and Defense Position is given up — which
    // is why the filter must mark Indestructibles rather than skipping them.
    s.expectInZone(rock, "field");
    expect(s.unit("p1", 1)?.id).toBe(rock.id);
    expect(s.stats(rock).position).toBe("ATK");
    expect(s.stats(rock).keywords.some((keyword) => keyword.kind === "Taunt")).toBe(false);

    // Everything destructible still died.
    s.expectInZone(gary, "graveyard");
  });

  it("destroys nothing and still counts as played when both boards are empty", () => {
    const s = scenario({ seed: SEED, p1: { hand: [NETHER, FILLER] }, p2: { hand: [FILLER] } });

    s.play(NETHER);

    s.expectInZone(NETHER, "graveyard").expectEvents("cardPlayed");
    expect(s.lastEvents.filter((event) => event.type === "destroyed")).toHaveLength(0);
  });
});

describe("#88 Twisting Nether — radiant", () => {
  it.todo('"enemy": only the opponent\'s permanents are destroyed, both rows — blocked on destroyAll', () => {
    const s = scenario({
      seed: SEED,
      p1: {
        hand: [{ def: NETHER, radiant: true }, FILLER],
        field: [{ def: GARY, lane: 1 }],
        backrow: [{ def: MANA_WELL, lane: 1 }],
      },
      p2: {
        hand: [FILLER],
        field: [{ def: RENO, lane: 1 }],
        backrow: [{ def: SHEEPISH, lane: 1 }],
      },
    });
    const mine = s.card(GARY);
    const myWell = s.card(MANA_WELL);
    const theirs = s.card(RENO);
    const theirTrap = s.card(SHEEPISH);

    s.play(NETHER, { modes: ["enemy"] });

    s.expectInZone(theirs, "graveyard").expectInZone(theirTrap, "graveyard");
    s.expectInZone(mine, "field").expectInZone(myWell, "field");
    expect(s.unit("p1", 1)?.id).toBe(mine.id);
    expect(s.backrow("p1", 1)?.id).toBe(myWell.id);
  });

  it.todo('"all": the radiant face can still sweep both sides — blocked on destroyAll', () => {
    const s = scenario({
      seed: SEED,
      p1: { hand: [{ def: NETHER, radiant: true }, FILLER], field: [{ def: GARY, lane: 1 }] },
      p2: { hand: [FILLER], field: [{ def: RENO, lane: 1 }] },
    });
    const mine = s.card(GARY);
    const theirs = s.card(RENO);

    s.play(NETHER, { modes: ["all"] });

    s.expectInZone(mine, "graveyard").expectInZone(theirs, "graveyard");
  });

  it.todo("R46 Indestructibles survive the enemy-only mode too — blocked on destroyAll", () => {
    const s = scenario({
      seed: SEED,
      p1: { hand: [{ def: NETHER, radiant: true }, FILLER] },
      p2: { hand: [FILLER], field: [{ def: ROCK, lane: 1 }, { def: GARY, lane: 2 }] },
    });
    const rock = s.card(ROCK);
    const gary = s.card(GARY);

    s.play(NETHER, { modes: ["enemy"] });

    s.expectInZone(rock, "field").expectInZone(gary, "graveyard");
  });
});
