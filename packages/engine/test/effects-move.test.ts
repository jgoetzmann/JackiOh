// Exile, Bounce, Discard and Counter (SPEC §6.3, §2.4, §3.2, R11, R12, R16, R78, BUILD M3-T1).
// The fixture defs and scripts these tests need are registered here, on top of the shared fixture
// catalog, so no shared fixture has to grow for them (CLAUDE.md, BUILD §0).

import type { CardDef, GameEvent, PlayerId, Selection } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { HAND_CAP, HERO_HEALTH } from "../src/config";
import { damage } from "../src/effects";
import { bounce, counter, discard, discardRandom, exile } from "../src/effects/move";
import { giftedMakesRadiant } from "../src/playChoices";
import { makeContext } from "../src/resolve";
import { createRng } from "../src/rng";
import type { CardScripts, Effect, Script } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import { newInstance, type CardInstance, type GameState } from "../src/state";
import { cardAt, placeOnField } from "../src/zones";
import { tokenDef } from "./fixtures/catalog";
import { eventsOfType, inHand, newGame, put, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixture cards.
// ---------------------------------------------------------------------------

let nextIndex = 800;

function unitDefOf(name: string, overrides: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `mv-${name}`,
    index: String(nextIndex),
    name: `${name} (move)`,
    set: "Core",
    type: "Unit",
    tags: [],
    rarity: "Common",
    token: false,
    cost: 1,
    base: { attack: 2, health: 2, keywords: [], text: name },
    radiant: { attack: 4, health: 4, keywords: [], text: `${name} radiant` },
    ...overrides,
  };
}

/** A unit with both a Cry and a Death hook: Exile and Counter must fire neither. */
const noisy = unitDefOf("noisy");
/** A permanent carrying #64 Gifted Program's static flag (threshold 1), for R213's count. */
const gifted = unitDefOf("gifted");
/** A unit-token card that can sit in a hand (#75), for R11's "leaves that zone" clause. */
const handToken: CardDef = { ...tokenDef("rush"), id: "mv-hand-token", index: "T-hand" };

const rushToken = tokenDef("rush");

const DEFS: CardDef[] = [noisy, gifted, handToken];

function both(script: Script): CardScripts {
  return { base: script, radiant: script };
}

const SCRIPTS: Record<string, CardScripts> = {
  [noisy.id]: both({
    cry: () => [damage({ to: { of: "enemyHero" }, amount: 4 })],
    death: () => [damage({ to: { of: "enemyHero" }, amount: 6 })],
  }),
  [gifted.id]: both({ staticFlags: { giftedProgram: 1 } }),
};

/** A fresh game whose catalog and script registry also carry this file's fixtures. */
function game(seed = "effects-move"): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((def) => [def.id, def])) });
  registerScripts({ ...registeredScripts(), ...SCRIPTS });
  state.turn = 3;
  return state;
}

type RunOptions = { controller?: PlayerId; self?: CardInstance };

/** Apply one effect the way a script's hook would, and hand back the events it emitted. */
function run(state: GameState, effect: Effect, target?: CardInstance, options: RunOptions = {}): GameEvent[] {
  const sink = sinkFor(state);
  const targets: Selection[] = target === undefined ? [] : [{ pick: "instance", instanceId: target.id }];
  const ctx = makeContext(sink, options.self ?? null, {
    controller: options.controller ?? "p1",
    targets,
  });
  effect.apply(ctx);
  state.rngCursor = sink.rng.cursor;
  return sink.events;
}

const chosen = { of: "chosen" } as const;

// ---------------------------------------------------------------------------
// exile
// ---------------------------------------------------------------------------

describe("exile (§6.3, M3-T1)", () => {
  it("§6.3 moves a unit from the field to its owner's exile pile and counts it (R55)", () => {
    const state = game();
    const victim = put(state, "fx-1", slot("p1", "units", 2));

    const events = run(state, exile({ target: chosen }), victim);

    expect(cardAt(state, slot("p1", "units", 2))).toBeNull();
    expect(state.players.p1.exile.map((c) => c.id)).toEqual([victim.id]);
    expect(state.players.p1.graveyard).toHaveLength(0);
    expect(state.counters.exiled).toBe(1);
    expect(eventsOfType(events, "exiled")).toEqual([
      { type: "exiled", instanceId: victim.id, defId: "fx-1", owner: "p1" },
    ]);
  });

  it("§6.3 exiles from anywhere: a hand card and a graveyard card both reach the pile", () => {
    const state = game();
    const [fromHand] = inHand(state, "fx-1", "p1");
    const fromGraveyard = newInstance(state, "fx-2", "p1", { z: "graveyard", player: "p1" });
    state.players.p1.graveyard.push(fromGraveyard);

    run(state, exile({ target: chosen }), fromHand);
    run(state, exile({ target: chosen }), fromGraveyard);

    expect(state.players.p1.hand).toHaveLength(0);
    expect(state.players.p1.graveyard).toHaveLength(0);
    expect(state.players.p1.exile.map((c) => c.defId)).toEqual(["fx-1", "fx-2"]);
    expect(state.counters.exiled).toBe(2);
  });

  it("§6.3 fires no Death trigger", () => {
    const state = game();
    const victim = put(state, noisy.id, slot("p1", "units", 1));

    const events = run(state, exile({ target: chosen }), victim);

    expect(state.players.p2.hero.health).toBe(HERO_HEALTH);
    expect(eventsOfType(events, "damage")).toEqual([]);
    expect(eventsOfType(events, "destroyed")).toEqual([]);
  });

  it("R11 an exiled unit token vanishes and never enters the exile pile", () => {
    const state = game();
    const token = put(state, rushToken.id, slot("p1", "units", 1));

    const events = run(state, exile({ target: chosen }), token);

    expect(cardAt(state, slot("p1", "units", 1))).toBeNull();
    expect(state.players.p1.exile).toHaveLength(0);
    expect(state.players.p1.graveyard).toHaveLength(0);
    expect(state.counters.exiled).toBe(0);
    expect(eventsOfType(events, "exiled").map((e) => e.instanceId)).toEqual([token.id]);
  });

  it("R12 a stolen unit is exiled to its owner's pile", () => {
    const state = game();
    const theirs = newInstance(state, "fx-4", "p2", { z: "hand", player: "p2" });
    expect(placeOnField(state, theirs, slot("p1", "units", 1))).toBe(true);

    run(state, exile({ target: chosen }), theirs, { controller: "p1" });

    expect(state.players.p2.exile.map((c) => c.id)).toEqual([theirs.id]);
    expect(state.players.p1.exile).toHaveLength(0);
  });

  it("R78 exile resets the instance but keeps costMod and radiant", () => {
    const state = game();
    const victim = put(state, "fx-1", slot("p1", "units", 1));
    victim.damage = 1;
    victim.buffs = { attack: 2, health: 2 };
    victim.radiant = true;
    victim.costMod = -2;

    run(state, exile({ target: chosen }), victim);

    expect(victim.damage).toBe(0);
    expect(victim.buffs).toEqual({ attack: 0, health: 0 });
    expect(victim.radiant).toBe(true);
    expect(victim.costMod).toBe(-2);
  });
});

// ---------------------------------------------------------------------------
// bounce
// ---------------------------------------------------------------------------

describe("bounce (§6.3, M3-T1)", () => {
  it("R78 returns a unit to its owner's hand and drops its damage, buffs and position", () => {
    const state = game();
    const victim = put(state, "fx-1", slot("p1", "units", 3));
    victim.damage = 1;
    victim.buffs = { attack: 3, health: 3 };
    victim.position = "DEF";
    victim.counters = { plague: 2 };
    victim.costMod = -1;
    victim.radiant = true;

    const events = run(state, bounce({ target: chosen }), victim);

    expect(cardAt(state, slot("p1", "units", 3))).toBeNull();
    expect(state.players.p1.hand.map((c) => c.id)).toEqual([victim.id]);
    expect(victim.damage).toBe(0);
    expect(victim.buffs).toEqual({ attack: 0, health: 0 });
    expect(victim.position).toBeUndefined();
    expect(victim.counters).toEqual({});
    expect(victim.costMod).toBe(-1);
    expect(victim.radiant).toBe(true);
    expect(eventsOfType(events, "bounced")).toEqual([
      { type: "bounced", instanceId: victim.id, defId: "fx-1", owner: "p1" },
    ]);
    expect(eventsOfType(events, "addedToHand").map((e) => e.instanceId)).toEqual([victim.id]);
  });

  it("R11 a bounced unit token vanishes instead of reaching a hand", () => {
    const state = game();
    const token = put(state, rushToken.id, slot("p1", "units", 1));

    const events = run(state, bounce({ target: chosen }), token);

    expect(cardAt(state, slot("p1", "units", 1))).toBeNull();
    expect(state.players.p1.hand).toHaveLength(0);
    expect(state.players.p1.graveyard).toHaveLength(0);
    expect(eventsOfType(events, "bounced").map((e) => e.instanceId)).toEqual([token.id]);
    expect(eventsOfType(events, "addedToHand")).toEqual([]);
  });

  it("§2.4 a bounce into a full hand burns the card to the graveyard", () => {
    const state = game();
    inHand(state, "fx-2", "p1", HAND_CAP);
    const victim = put(state, "fx-1", slot("p1", "units", 1));

    const events = run(state, bounce({ target: chosen }), victim);

    expect(state.players.p1.hand).toHaveLength(HAND_CAP);
    expect(state.players.p1.graveyard.map((c) => c.id)).toEqual([victim.id]);
    expect(eventsOfType(events, "bounced").map((e) => e.instanceId)).toEqual([victim.id]);
    expect(eventsOfType(events, "burned").map((e) => e.instanceId)).toEqual([victim.id]);
    expect(eventsOfType(events, "enteredGraveyard").map((e) => e.instanceId)).toEqual([victim.id]);
  });

  it("R12 a stolen unit bounces to its owner's hand, not the controller's", () => {
    const state = game();
    const theirs = newInstance(state, "fx-4", "p2", { z: "hand", player: "p2" });
    expect(placeOnField(state, theirs, slot("p1", "units", 1))).toBe(true);

    run(state, bounce({ target: chosen }), theirs, { controller: "p1" });

    expect(state.players.p2.hand.map((c) => c.id)).toEqual([theirs.id]);
    expect(state.players.p1.hand).toHaveLength(0);
    expect(theirs.controller).toBe("p2");
  });

  it("§6.3 fires no Death trigger", () => {
    const state = game();
    const victim = put(state, noisy.id, slot("p1", "units", 1));

    const events = run(state, bounce({ target: chosen }), victim);

    expect(state.players.p2.hero.health).toBe(HERO_HEALTH);
    expect(eventsOfType(events, "damage")).toEqual([]);
  });

  it("§6.3 leaves a card that is already in its owner's hand alone", () => {
    const state = game();
    const [card] = inHand(state, "fx-1", "p1");

    const events = run(state, bounce({ target: chosen }), card);

    expect(state.players.p1.hand.map((c) => c.id)).toEqual([card?.id]);
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// discard
// ---------------------------------------------------------------------------

describe("discard (§6.3, R16, M3-T1)", () => {
  it("R16 a named card goes from the hand to the graveyard", () => {
    const state = game();
    const [keep, toss] = inHand(state, "fx-1", "p1", 2);

    const events = run(state, discard({ target: chosen }), toss);

    expect(state.players.p1.hand.map((c) => c.id)).toEqual([keep?.id]);
    expect(state.players.p1.graveyard.map((c) => c.id)).toEqual([toss?.id]);
    expect(events.map((e) => e.type)).toEqual(["discarded", "enteredGraveyard"]);
    expect(eventsOfType(events, "discarded")[0]?.owner).toBe("p1");
  });

  it("R16 the random form draws its pick from the match rng", () => {
    const state = game();
    const hand = inHand(state, "fx-1", "p1", 5).map((card) => card.id);
    const expected = hand[createRng(state.seed, state.rngCursor).int(hand.length)];

    const events = run(state, discardRandom());

    expect(state.players.p1.graveyard.map((c) => c.id)).toEqual([expected]);
    expect(eventsOfType(events, "discarded").map((e) => e.instanceId)).toEqual([expected]);
    expect(state.rngCursor).toBe(1);
  });

  it("R16 the random form replays identically from the same seed", () => {
    const first = game("replay-seed");
    inHand(first, "fx-1", "p1", 4);
    run(first, discardRandom({ count: 2 }));

    const second = game("replay-seed");
    inHand(second, "fx-1", "p1", 4);
    run(second, discardRandom({ count: 2 }));

    expect(first.players.p1.graveyard.map((c) => c.id)).toEqual(
      second.players.p1.graveyard.map((c) => c.id),
    );
    expect(first.players.p1.graveyard).toHaveLength(2);
  });

  it("R16 a random discard of more cards than the hand holds empties it and stops", () => {
    const state = game();
    inHand(state, "fx-1", "p1", 2);

    run(state, discardRandom({ count: 5 }));

    expect(state.players.p1.hand).toHaveLength(0);
    expect(state.players.p1.graveyard).toHaveLength(2);
  });

  it("R11 a discarded unit-token card vanishes and reaches no graveyard", () => {
    const state = game();
    const [token] = inHand(state, handToken.id, "p1");

    const events = run(state, discard({ target: chosen }), token);

    expect(state.players.p1.hand).toHaveLength(0);
    expect(state.players.p1.graveyard).toHaveLength(0);
    expect(events.map((e) => e.type)).toEqual(["discarded"]);
  });

  it("§6.3 discards the enemy's hand when the effect says so", () => {
    const state = game();
    inHand(state, "fx-1", "p2", 3);

    run(state, discardRandom({ player: "enemy" }), undefined, { controller: "p1" });

    expect(state.players.p2.hand).toHaveLength(2);
    expect(state.players.p2.graveyard).toHaveLength(1);
    expect(state.players.p1.graveyard).toHaveLength(0);
  });

  it("§6.3 ignores a card that is not in a hand", () => {
    const state = game();
    const unit = put(state, "fx-1", slot("p1", "units", 1));

    const events = run(state, discard({ target: chosen }), unit);

    expect(cardAt(state, slot("p1", "units", 1))?.id).toBe(unit.id);
    expect(state.players.p1.graveyard).toHaveLength(0);
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// counter
// ---------------------------------------------------------------------------

describe("counter (§6.3, M3-T1)", () => {
  it("§6.3 sends the card to the graveyard with no Cry and no Death", () => {
    const state = game();
    const [card] = inHand(state, noisy.id, "p1");

    const events = run(state, counter({ target: chosen }), card);

    expect(state.players.p1.hand).toHaveLength(0);
    expect(state.players.p1.graveyard.map((c) => c.id)).toEqual([card?.id]);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH);
    expect(events.map((e) => e.type)).toEqual(["enteredGraveyard"]);
    expect(eventsOfType(events, "destroyed")).toEqual([]);
  });

  it("§6.3 treats the card as never played, so the play counters roll back", () => {
    const state = game();
    const [card] = inHand(state, noisy.id, "p1");
    // What §10.5 records when the play starts, before a Counter cancels it.
    const side = state.players.p1;
    side.turnLog.playedIds.push(card?.id ?? "");
    side.turnLog.cardsPlayed = 1;
    state.counters.played = 1;

    run(state, counter({ target: chosen }), card);

    expect(side.turnLog.playedIds).toEqual([]);
    expect(side.turnLog.cardsPlayed).toBe(0);
    expect(state.counters.played).toBe(0);
  });

  it("R213 a countered play takes back what it paid, so the next cheap card is still Gifted Program's first", () => {
    const state = game();
    put(state, gifted.id, slot("p1", "units", 1));
    const [earlier] = inHand(state, noisy.id, "p1");
    const [card] = inHand(state, noisy.id, "p1");
    // What §10.5 step 4 logs for a 3-cost play and then a 1-cost one, before a Counter cancels the
    // second: the turn log keeps what each play paid beside its id (R213).
    const side = state.players.p1;
    side.turnLog.playedIds.push(earlier?.id ?? "", card?.id ?? "");
    side.turnLog.costsPaid = [3, 1];
    side.turnLog.cardsPlayed = 2;
    state.counters.played = 2;
    expect(giftedMakesRadiant(state, "p1", 1)).toBe(false);

    run(state, counter({ target: chosen }), card);

    expect(side.turnLog.playedIds).toEqual([earlier?.id]);
    expect(side.turnLog.costsPaid).toEqual([3]);
    expect(giftedMakesRadiant(state, "p1", 1)).toBe(true);
  });

  it("§6.3 counters a card that is already resolving", () => {
    const state = game();
    const card = newInstance(state, noisy.id, "p1", { z: "resolving", player: "p1" });

    const events = run(state, counter({ target: { of: "self" } }), undefined, { self: card });

    expect(state.players.p1.graveyard.map((c) => c.id)).toEqual([card.id]);
    expect(card.zone).toEqual({ z: "graveyard", player: "p1" });
    expect(eventsOfType(events, "enteredGraveyard").map((e) => e.instanceId)).toEqual([card.id]);
  });

  it("R11 a countered unit-token card vanishes and reaches no graveyard", () => {
    const state = game();
    const [token] = inHand(state, handToken.id, "p1");

    const events = run(state, counter({ target: chosen }), token);

    expect(state.players.p1.hand).toHaveLength(0);
    expect(state.players.p1.graveyard).toHaveLength(0);
    expect(events).toEqual([]);
  });

  it("R12 a countered card goes to its owner's graveyard", () => {
    const state = game();
    const [theirs] = inHand(state, "fx-4", "p2");

    run(state, counter({ target: chosen }), theirs, { controller: "p1" });

    expect(state.players.p2.graveyard.map((c) => c.id)).toEqual([theirs?.id]);
    expect(state.players.p1.graveyard).toHaveLength(0);
  });
});
