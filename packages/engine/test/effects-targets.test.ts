// The target and scope vocabulary every other verb's arguments are written in (SPEC §3.1, §3.2,
// §6.3, §10.6, R13, R68, R81). Two things are under test: `{ of: "instance" }`, the TargetSpec
// variant that lets a verb name a card a script already holds the id of, and the board scope
// (`cardsInScope`, `adjacentTo`, `matchesScope`) that the board-wide verbs are thin walks over.
//
// The scope lives here rather than on `TargetSpec` because `resolveTarget` answers with one
// `DamageTarget | null`: every verb written in a TargetSpec — damage, destroy, buff, transform —
// is single-target by construction, so a multi-card spec could not be threaded through them. The
// fixture cards these tests need are registered here, so no shared fixture has to grow (BUILD §0).

import type { CardDef } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { makeContext } from "../src/resolve";
import type { EffectContext } from "../src/script";
import type { CardInstance, GameState } from "../src/state";
import { placeOnField } from "../src/zones";
import {
  adjacentTo,
  cardsInScope,
  instanceOf,
  matchesScope,
  resolveTarget,
} from "../src/effects/targets";
import { spellDef, unitDef } from "./fixtures/catalog";
import { newGame, put, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixture cards: two tags and a backrow type, so every filter has something to bite on.
// ---------------------------------------------------------------------------

const human = unitDef(760, { id: "tg-human", name: "Human (fixture)", tags: ["Human"] });
const felinor = unitDef(761, { id: "tg-felinor", name: "Felinor (fixture)", tags: ["Felinor"] });
const untagged = unitDef(762, { id: "tg-untagged", name: "Untagged (fixture)" });
const stackable = unitDef(763, { id: "tg-stackable", name: "Stackable (fixture)" });
const fieldSpell: CardDef = {
  ...spellDef(764, { id: "tg-field", name: "Field Spell (fixture)" }),
  type: "Field Spell",
};

function game(seed = "targets-test"): GameState {
  const state = newGame(seed);
  registerCatalog({
    ...registeredCatalog(),
    [human.id]: human,
    [felinor.id]: felinor,
    [untagged.id]: untagged,
    [stackable.id]: stackable,
    [fieldSpell.id]: fieldSpell,
  });
  return state;
}

function ctxOf(state: GameState, self: CardInstance | null = null): EffectContext {
  return makeContext(sinkFor(state), self, { controller: "p1" });
}

function idsOf(cards: readonly CardInstance[]): string[] {
  return cards.map((card) => card.id);
}

// ---------------------------------------------------------------------------
// `{ of: "instance" }`
// ---------------------------------------------------------------------------

describe("TargetSpec { of: \"instance\" }", () => {
  it("resolves a card by the id a script captured, wherever it is", () => {
    const state = game();
    const onField = put(state, human.id, slot("p2", "units", 3));
    const ctx = ctxOf(state);

    const target = resolveTarget(ctx, { of: "instance", instanceId: onField.id });
    expect(target).toEqual({ kind: "unit", instance: onField });
    expect(instanceOf(ctx, { of: "instance", instanceId: onField.id })).toBe(onField);
  });

  it("resolves a card that has left the field, so a delayed step can still name it (R76)", () => {
    const state = game();
    const card = put(state, human.id, slot("p1", "units", 1));
    // The card dies; the id a Resume captured must still find it in the graveyard.
    state.players.p1.units[0] = null;
    card.zone = { z: "graveyard", player: "p1" };
    state.players.p1.graveyard.push(card);

    expect(instanceOf(ctxOf(state), { of: "instance", instanceId: card.id })).toBe(card);
  });

  it("answers null for an id nothing holds, so the verb fizzles and the card still resolves", () => {
    const state = game();
    expect(resolveTarget(ctxOf(state), { of: "instance", instanceId: "c9999" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// `cardsInScope`
// ---------------------------------------------------------------------------

describe("cardsInScope", () => {
  it("defaults to every unit on both sides and no backrow card", () => {
    const state = game();
    const mine = put(state, human.id, slot("p1", "units", 2));
    const theirs = put(state, felinor.id, slot("p2", "units", 1));
    const backrow = put(state, fieldSpell.id, slot("p1", "backrow", 1));

    const found = idsOf(cardsInScope(ctxOf(state)));
    expect(found).toContain(mine.id);
    expect(found).toContain(theirs.id);
    expect(found).not.toContain(backrow.id);
  });

  it("walks R68 order: the active player's side first, then the opponent's, lane 1 upward", () => {
    const state = game();
    state.active = "p2";
    const p1Lane1 = put(state, untagged.id, slot("p1", "units", 1));
    const p1Lane4 = put(state, untagged.id, slot("p1", "units", 4));
    const p2Lane2 = put(state, untagged.id, slot("p2", "units", 2));
    const p2Lane5 = put(state, untagged.id, slot("p2", "units", 5));

    // p2 is active, so its side comes first, and within each side the lanes ascend.
    expect(idsOf(cardsInScope(ctxOf(state)))).toEqual([
      p2Lane2.id,
      p2Lane5.id,
      p1Lane1.id,
      p1Lane4.id,
    ]);
  });

  it("reads `side` relative to the controller, not to the active player", () => {
    const state = game();
    state.active = "p2";
    const mine = put(state, human.id, slot("p1", "units", 1));
    const theirs = put(state, human.id, slot("p2", "units", 1));
    const ctx = ctxOf(state); // controller is p1

    expect(idsOf(cardsInScope(ctx, { side: "self" }))).toEqual([mine.id]);
    expect(idsOf(cardsInScope(ctx, { side: "enemy" }))).toEqual([theirs.id]);
  });

  it("covers the named rows, so a permanents scope reaches the backrow (§6.3)", () => {
    const state = game();
    const unit = put(state, human.id, slot("p1", "units", 1));
    const backrow = put(state, fieldSpell.id, slot("p1", "backrow", 2));

    const found = idsOf(cardsInScope(ctxOf(state), { side: "self", rows: ["units", "backrow"] }));
    // Rows are walked in the order given: every unit lane, then every backrow lane.
    expect(found).toEqual([unit.id, backrow.id]);
  });

  it("keeps `tags` and rejects `notTags` by the definition", () => {
    const state = game();
    const theHuman = put(state, human.id, slot("p1", "units", 1));
    put(state, felinor.id, slot("p1", "units", 2));
    const theUntagged = put(state, untagged.id, slot("p1", "units", 3));
    const ctx = ctxOf(state);

    expect(idsOf(cardsInScope(ctx, { side: "self", tags: ["Human"] }))).toEqual([theHuman.id]);
    // "non-Felinor" keeps everything that is not tagged Felinor, the untagged card included (#43).
    expect(idsOf(cardsInScope(ctx, { side: "self", notTags: ["Felinor"] }))).toEqual([
      theHuman.id,
      theUntagged.id,
    ]);
  });

  it("filters by card type", () => {
    const state = game();
    const unit = put(state, human.id, slot("p1", "units", 1));
    put(state, fieldSpell.id, slot("p1", "backrow", 1));

    const found = cardsInScope(ctxOf(state), {
      side: "self",
      rows: ["units", "backrow"],
      types: ["Unit"],
    });
    expect(idsOf(found)).toEqual([unit.id]);
  });

  it("excludeSelf leaves the card running the script standing (#100 \"all other permanents\")", () => {
    const state = game();
    const self = put(state, untagged.id, slot("p1", "units", 1));
    const other = put(state, untagged.id, slot("p1", "units", 2));

    const found = idsOf(cardsInScope(ctxOf(state, self), { side: "self", excludeSelf: true }));
    expect(found).toEqual([other.id]);
    expect(found).not.toContain(self.id);
  });

  it("matches only the top of a Stack pile, never the dormant card underneath (§3.2, R13)", () => {
    const state = game();
    const ref = slot("p1", "units", 1);
    const bottom = put(state, untagged.id, ref);
    const top = state.players.p1.units[0];
    expect(top?.[0]).toBe(bottom);

    // A Stack card lands on the occupied zone and becomes the only active card there.
    const stacked = put(state, stackable.id, slot("p1", "units", 2));
    state.players.p1.units[1] = null;
    stacked.zone = { z: "field", player: "p1", row: "units", lane: 1 };
    expect(placeOnField(state, stacked, ref, { stack: true })).toBe(true);

    const found = idsOf(cardsInScope(ctxOf(state), { side: "self" }));
    expect(found).toEqual([stacked.id]);
    expect(found).not.toContain(bottom.id);
  });

  it("returns nothing for an empty board rather than throwing", () => {
    expect(cardsInScope(ctxOf(game()))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// `adjacentTo`
// ---------------------------------------------------------------------------

describe("adjacentTo", () => {
  it("takes lanes N-1 and N+1 on the target's own side and row, never lane N (§3.1)", () => {
    const state = game();
    const left = put(state, untagged.id, slot("p1", "units", 2));
    const middle = put(state, untagged.id, slot("p1", "units", 3));
    const right = put(state, untagged.id, slot("p1", "units", 4));
    const far = put(state, untagged.id, slot("p1", "units", 5));

    const found = idsOf(adjacentTo(ctxOf(state), { of: "instance", instanceId: middle.id }));
    expect(found).toEqual([left.id, right.id]);
    expect(found).not.toContain(middle.id);
    expect(found).not.toContain(far.id);
  });

  it("never crosses to the other side, even in the facing lane (§3.1)", () => {
    const state = game();
    const middle = put(state, untagged.id, slot("p1", "units", 3));
    const facing = put(state, untagged.id, slot("p2", "units", 3));
    const facingNeighbour = put(state, untagged.id, slot("p2", "units", 2));

    const found = idsOf(adjacentTo(ctxOf(state), { of: "instance", instanceId: middle.id }));
    expect(found).not.toContain(facing.id);
    expect(found).not.toContain(facingNeighbour.id);
  });

  it("never crosses rows, so \"adjacent in its row\" needs no extra filter (#34)", () => {
    const state = game();
    const middle = put(state, fieldSpell.id, slot("p1", "backrow", 2));
    const backrowNeighbour = put(state, fieldSpell.id, slot("p1", "backrow", 1));
    const unitBeside = put(state, untagged.id, slot("p1", "units", 1));

    const found = idsOf(adjacentTo(ctxOf(state), { of: "instance", instanceId: middle.id }));
    expect(found).toEqual([backrowNeighbour.id]);
    expect(found).not.toContain(unitBeside.id);
  });

  it("clamps at the ends of a row", () => {
    const state = game();
    const first = put(state, untagged.id, slot("p1", "units", 1));
    const second = put(state, untagged.id, slot("p1", "units", 2));

    expect(idsOf(adjacentTo(ctxOf(state), { of: "instance", instanceId: first.id }))).toEqual([
      second.id,
    ]);
  });

  it("skips empty neighbouring zones and applies the scope's filters", () => {
    const state = game();
    put(state, felinor.id, slot("p1", "units", 1));
    const middle = put(state, untagged.id, slot("p1", "units", 2));
    const theHuman = put(state, human.id, slot("p1", "units", 3));

    const found = adjacentTo(ctxOf(state), { of: "instance", instanceId: middle.id }, {
      notTags: ["Felinor"],
    });
    expect(idsOf(found)).toEqual([theHuman.id]);
  });

  it("gives a card that is off the field no neighbours", () => {
    const state = game();
    const card = put(state, untagged.id, slot("p1", "units", 2));
    put(state, untagged.id, slot("p1", "units", 1));
    state.players.p1.units[1] = null;
    card.zone = { z: "graveyard", player: "p1" };
    state.players.p1.graveyard.push(card);

    expect(adjacentTo(ctxOf(state), { of: "instance", instanceId: card.id })).toEqual([]);
  });

  it("gives a hero spec no neighbours rather than throwing", () => {
    const state = game();
    put(state, untagged.id, slot("p1", "units", 1));
    expect(adjacentTo(ctxOf(state), { of: "enemyHero" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// `matchesScope`
// ---------------------------------------------------------------------------

describe("matchesScope", () => {
  it("passes a card no filter rejects and is independent of where the card sits", () => {
    const state = game();
    const card = put(state, human.id, slot("p2", "units", 5));
    const ctx = ctxOf(state);

    expect(matchesScope(ctx, card)).toBe(true);
    expect(matchesScope(ctx, card, { tags: ["Human"] })).toBe(true);
    expect(matchesScope(ctx, card, { notTags: ["Human"] })).toBe(false);
    expect(matchesScope(ctx, card, { types: ["Spell"] })).toBe(false);
  });

  it("rejects the running card only when excludeSelf says so", () => {
    const state = game();
    const self = put(state, untagged.id, slot("p1", "units", 1));
    const ctx = ctxOf(state, self);

    expect(matchesScope(ctx, self)).toBe(true);
    expect(matchesScope(ctx, self, { excludeSelf: true })).toBe(false);
  });

  it("keeps a card matching any one of several tags", () => {
    const state = game();
    const theFelinor = put(state, felinor.id, slot("p1", "units", 1));
    expect(matchesScope(ctxOf(state), theFelinor, { tags: ["Human", "Felinor"] })).toBe(true);
  });
});
