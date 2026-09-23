// Echo and Twinspell (SPEC §6.3's Echo row, §10.5 step 6, §2.2's cleanup line, R30, R70).
//
// §6.3 Echo: "Echo X | Recast this card X more times | Play resolves, then the same instance
// re-resolves X times with fresh mode/target prompts; Twinspell grants Echo +1 to the next spell.
// The repeats outstanding live in `state.echoQueue` and resolve one at a time in the resolution
// loop, so a prompt inside one repeat pauses the rest until it is answered (§10.5 step 6)".
//
// R30 Twinspell lifetime: "Stays until a spell is played, then goes to the GY" (#79). §2.2:
// "Twinspell's pending Echo is not turn-scoped and survives cleanup". §8 #79: "The next Spell you
// play gains Echo +1", radiant "Echo +2", "Consumed to the GY when it applies (ruling)". R70: "a
// cast Spell does use Twinspell's Echo".
//
// DISCREPANCY (the whole file): SPEC §10.1 declares `echoQueue: EchoRepeat[]` on `GameState` and
// §6.3 puts the outstanding repeats there, but `grep -rn "echoQueue" packages/engine/src` returns
// nothing — the field does not exist, and no engine module repeats a played card. The only echo
// machinery in the source is `state.ts`'s player modifier `{ kind: "echoNextSpell"; amount: number;
// sourceId?: string }`, which nothing reads: `grep -rn "echoNextSpell" packages/engine/src` finds
// only that type declaration. Per CLAUDE.md the tests below assert what SPEC says and each
// affected one carries its own DISCREPANCY note; `turn.test.ts`'s R30 test and
// `replay-scripted.test.ts`'s `state.echoQueue.length` are the surviving witnesses to the same gap.
//
// Fixtures are prefixed `ec-` and indexed above 1500 so they cannot collide (BUILD §0).

import type { Action, ActionInput, CardDef, PlayerId } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { HERO_HEALTH, UNIT_ZONES } from "../src/config";
import { chosenOptions, addToHand as addToHandEffect, damage, discoverFromCatalog } from "../src/effects";
import { addModifier } from "../src/modifiers";
import { beginGame, reduce } from "../src/reduce";
import { castCard } from "../src/resolve";
import type { CardScripts, Effect, Script } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import type { CardInstance, GameState, PlayerModifier } from "../src/state";
import { settle } from "../src/triggers";
import { eventsOfType, inHand, newGame, put, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

let nextIndex = 1500;

function def(name: string, type: CardDef["type"], extra: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `ec-${name}`,
    index: String(nextIndex),
    name: `${name} (echo)`,
    set: "Core",
    type,
    tags: [],
    rarity: "Common",
    token: false,
    cost: 0,
    base: { keywords: [], text: name },
    radiant: { keywords: [], text: name },
    ...extra,
  };
}

/** #79 Twinspell: a Field Spell that gives the next Spell you play Echo +1, or +2 radiant. */
const twinspell = def("twinspell", "Field Spell", { cost: 2 });
/** A Spell whose whole effect is countable, so N resolutions read as 2N damage. */
const pinger = def("pinger", "Spell");
/** A Spell whose resolution prompts, so a prompt inside one repeat can be seen to pause the rest. */
const askSpell = def("ask-spell", "Spell");
/** A permanent with a Cry, so a cast can be read on something that goes to the field, not the GY. */
const castUnit = def("cast-unit", "Unit", {
  base: { attack: 1, health: 3, keywords: [], text: "cast-unit" },
  radiant: { attack: 2, health: 6, keywords: [], text: "cast-unit" },
});
/** The same, with a printed Echo 1 (§6.1), which is the only Echo a permanent can have (R30). */
const echoUnit = def("echo-unit", "Unit", {
  base: { attack: 1, health: 3, keywords: [], text: "echo-unit" },
  radiant: { attack: 2, health: 6, keywords: [], text: "echo-unit" },
});

const DEFS = [twinspell, pinger, askSpell, castUnit, echoUnit];

/** #79's engine half: the pending Echo is a player modifier naming the Twinspell that granted it. */
function grantEcho(amount: number): Effect {
  return {
    kind: "ec:grantEcho",
    apply(ctx): void {
      const self = ctx.self;
      addModifier(ctx, ctx.controller, {
        kind: "echoNextSpell",
        amount,
        expiry: { until: "used" },
        ...(self === null ? {} : { sourceId: self.id }),
      });
    },
  };
}

function both(script: Script): CardScripts {
  return { base: script, radiant: script };
}

const SCRIPTS: Record<string, CardScripts> = {
  [twinspell.id]: {
    base: { cry: () => [grantEcho(1)] },
    radiant: { cry: () => [grantEcho(2)] },
  },
  [pinger.id]: both({ cry: () => [damage({ to: { of: "enemyHero" }, amount: 2 })] }),
  [castUnit.id]: both({ cry: () => [damage({ to: { of: "enemyHero" }, amount: 2 })] }),
  [echoUnit.id]: both({
    staticFlags: { echo: 1 },
    cry: () => [damage({ to: { of: "enemyHero" }, amount: 2 })],
  }),
  [askSpell.id]: both({
    cry: () => [discoverFromCatalog({ step: "picked", query: { type: "Unit" } })],
    resume: {
      picked: (ctx) => {
        const defId = chosenOptions(ctx)[0];
        return defId === undefined ? [] : [addToHandEffect({ defId })];
      },
    },
  }),
};

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

let nonce = 0;

function actResult(state: GameState, body: ActionInput): ReturnType<typeof reduce> {
  nonce += 1;
  return reduce(state, { ...body, nonce: `ec${nonce}` } as Action);
}

function act(state: GameState, body: ActionInput): GameState {
  const result = actResult(state, body);
  if (result.error !== undefined) throw new Error(result.error);
  return result.state;
}

/** Past the mulligans, in p1's main phase, with this file's fixtures registered and 4 mana. */
function playing(seed: string): GameState {
  let state = beginGame(newGame(seed)).state;
  state = act(state, { type: "mulligan", keep: state.players.p1.hand.map((c) => c.id), playerId: "p1" });
  state = act(state, { type: "mulligan", keep: state.players.p2.hand.map((c) => c.id), playerId: "p2" });
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((d) => [d.id, d])) });
  registerScripts({ ...registeredScripts(), ...SCRIPTS });
  state.players.p1.mana = { current: 4, max: 4, nextTurnMod: 0, permMod: 0 };
  return state;
}

function only<T>(items: readonly T[]): T {
  const first = items[0];
  if (first === undefined) throw new Error("expected at least one item");
  return first;
}

function handCard(state: GameState, defId: string, player: PlayerId = "p1"): CardInstance {
  return only(inHand(state, defId, player));
}

function echoMods(state: GameState, player: PlayerId): Extract<PlayerModifier, { kind: "echoNextSpell" }>[] {
  return state.players[player].mods.flatMap((mod) => (mod.kind === "echoNextSpell" ? [mod] : []));
}

/**
 * §10.1's `echoQueue`, read structurally so this file's own typecheck stays clean.
 *
 * DISCREPANCY: `state.ts`'s `GameState` declares no `echoQueue` and `createGame` initialises none,
 * although SPEC §10.1 lists it beside `triggerQueue` and §6.3 puts the outstanding repeats there;
 * `src/playSteps.ts` works around the same gap with its own lazily-created `echoQueueOf`. The test
 * below asserts the field is on a fresh state, which is where the gap shows.
 */
function echoQueue(state: GameState): unknown[] {
  const queue = (state as unknown as { echoQueue?: unknown }).echoQueue;
  return Array.isArray(queue) ? (queue as unknown[]) : [];
}

/** An Echo the engine owes, granted the way #79 grants one, so each test starts from one line. */
function pendingEcho(state: GameState, player: PlayerId, amount: number): void {
  addModifier(sinkFor(state), player, { kind: "echoNextSpell", amount, expiry: { until: "used" } });
}

// ---------------------------------------------------------------------------

describe("Echo and Twinspell (§6.3, §10.5 step 6, R30, R70)", () => {
  it("R30 keeps a pending Echo until a spell is played, across cleanup, then sends the Twinspell to the GY", () => {
    let state = playing("r30-lifetime");
    const card = handCard(state, twinspell.id);
    state = act(state, {
      type: "play",
      instanceId: card.id,
      playerId: "p1",
      zone: { row: "backrow", lane: 1 },
    });

    // #79's Echo +1, tied to the Twinspell that granted it, and not spent by playing the Twinspell.
    const granted = only(echoMods(state, "p1"));
    expect(granted.amount).toBe(1);
    expect(granted.expiry).toEqual({ until: "used" });
    expect(granted.sourceId).toBe(card.id);
    expect(state.players.p1.backrow[0]?.id).toBe(card.id);

    // §2.2: "Twinspell's pending Echo is not turn-scoped and survives cleanup" — two turns of it.
    state = act(state, { type: "endTurn", playerId: "p1" });
    expect(echoMods(state, "p1")).toHaveLength(1);
    state = act(state, { type: "endTurn", playerId: "p2" });
    expect(echoMods(state, "p1")).toHaveLength(1);
    state.players.p1.mana = { current: 4, max: 4, nextTurnMod: 0, permMod: 0 };

    // R30: playing a Spell is what ends it, and the Twinspell goes to the graveyard as it applies.
    // DISCREPANCY: nothing in packages/engine/src reads `echoNextSpell`, so the modifier is never
    // consumed and #79 never leaves the backrow. SPEC R30 and §8 #79 both say it must.
    const spell = handCard(state, pinger.id);
    state = act(state, { type: "play", instanceId: spell.id, playerId: "p1" });
    expect(echoMods(state, "p1")).toEqual([]);
    expect(state.players.p1.graveyard.some((held) => held.id === card.id)).toBe(true);
    expect(state.players.p1.backrow[0]).toBeNull();
  });

  it("§6.3 re-resolves a played Spell once for Echo 1, and twice for Twinspell radiant's Echo 2", () => {
    // DISCREPANCY: no engine module repeats a played card. SPEC §6.3 ("Recast this card X more
    // times … the same instance re-resolves X times") and §10.5 step 6 ("Echo: repeat step 5 with
    // fresh prompts N times") both require it, so each play below lands only its first resolution.
    const once = playing("echo-1");
    pendingEcho(once, "p1", 1);
    const first = actResult(once, { type: "play", instanceId: handCard(once, pinger.id).id, playerId: "p1" });
    expect(first.error).toBeUndefined();
    // Play resolves, then the same instance re-resolves 1 more time: 2 damage twice.
    expect(first.state.players.p2.hero.health).toBe(HERO_HEALTH - 4);
    // One play, two resolutions: the repeat is not a second play, so `played` rises once (§6.3).
    expect(first.state.counters.played).toBe(once.counters.played + 1);

    const twice = playing("echo-2");
    pendingEcho(twice, "p1", 2);
    const second = actResult(twice, { type: "play", instanceId: handCard(twice, pinger.id).id, playerId: "p1" });
    expect(second.error).toBeUndefined();
    expect(second.state.players.p2.hero.health).toBe(HERO_HEALTH - 6);
  });

  it("§10.1 declares echoQueue on every GameState, beside triggerQueue and delayed", () => {
    // DISCREPANCY: SPEC §10.1's state model lists `echoQueue: EchoRepeat[]` on `GameState`, so
    // every state carries one from `createGame` onward, the way `triggerQueue` and `delayed` do.
    // `packages/engine/src/state.ts` declares no such field and `createGame` initialises none;
    // `src/playSteps.ts` works around it with a lazily-created `echoQueueOf`, and
    // `replay-scripted.test.ts` reads `state.echoQueue.length` expecting the field to be there.
    const state = playing("echo-queue-field");
    expect(Object.hasOwn(state, "echoQueue")).toBe(true);
    expect(echoQueue(state)).toEqual([]);
    expect(Object.hasOwn(state, "triggerQueue")).toBe(true);
    expect(Object.hasOwn(state, "delayed")).toBe(true);
  });

  it("§6.3 holds the outstanding repeats in state.echoQueue and resolves them one at a time", () => {
    const state = playing("echo-queue");
    expect(echoQueue(state)).toEqual([]);

    pendingEcho(state, "p1", 2);
    const played = actResult(state, { type: "play", instanceId: handCard(state, pinger.id).id, playerId: "p1" });
    expect(played.error).toBeUndefined();

    // The repeats are state, not a loop variable, so they survive a JSON round trip (§9.3, §10.1).
    const round = JSON.parse(JSON.stringify(played.state)) as GameState;
    expect(echoQueue(round)).toEqual(echoQueue(played.state));
    // And by the time the action returns the loop has drained them (§10.3).
    expect(echoQueue(played.state)).toEqual([]);
    expect(played.state.players.p2.hero.health).toBe(HERO_HEALTH - 6);
  });

  it("§10.5 step 6 asks fresh prompts inside each Echo repeat, and one pauses the repeats behind it (R81)", () => {
    // §6.3: "the same instance re-resolves X times with fresh mode/target prompts … a prompt inside
    // one repeat pauses the rest until it is answered". With Echo 2 there are three resolutions and
    // three Discovers, each its own prompt, and the repeat still owed waits in the queue meanwhile.
    const state = playing("echo-prompt");
    pendingEcho(state, "p1", 2);
    const played = actResult(state, { type: "play", instanceId: handCard(state, askSpell.id).id, playerId: "p1" });
    expect(played.error).toBeUndefined();

    /** Answer the open Discover with its first option, and say what opened next. */
    const answer = (from: GameState): GameState => {
      const pending = from.pending;
      expect(pending?.kind).toBe("discover");
      expect(pending?.playerId).toBe("p1");
      return act(from, {
        type: "answer",
        choiceId: pending?.id ?? "",
        selection: [only(pending?.options ?? []).selection],
        playerId: "p1",
      });
    };

    // Resolution 1's prompt is open, and both repeats are still owed behind it.
    const firstId = played.state.pending?.id;
    expect(played.state.pending?.kind).toBe("discover");

    // Repeat 1 asks its own fresh prompt, with the last repeat still waiting in the queue (§6.3).
    const afterFirst = answer(played.state);
    expect(afterFirst.pending?.kind).toBe("discover");
    expect(afterFirst.pending?.id).not.toBe(firstId);
    expect(echoQueue(afterFirst)).toHaveLength(1);

    // Repeat 2 asks the last one, and once it is answered nothing is owed and nothing is pending.
    const afterSecond = answer(afterFirst);
    expect(afterSecond.pending?.kind).toBe("discover");
    expect(echoQueue(afterSecond)).toEqual([]);
    const done = answer(afterSecond);
    expect(done.pending).toBeNull();
    expect(echoQueue(done)).toEqual([]);
  });

  it("R70 gives a cast Spell Twinspell's Echo, even though the cast itself pays nothing", () => {
    // DISCREPANCY: `castCard` in packages/engine/src/resolve.ts runs the card's hook exactly once
    // and never looks at `echoNextSpell`. R70: "A cast never uses a cost discount, since it pays
    // nothing, but a cast Spell does use Twinspell's Echo".
    const state = playing("r70-cast-echo");
    pendingEcho(state, "p1", 1);
    const card = handCard(state, pinger.id);

    const sink = sinkFor(state);
    castCard(sink, card);
    settle(sink);

    // Free, counted as a play, and repeated once: 2 damage twice.
    expect(eventsOfType(sink.events, "cardPlayed").map((event) => event.costPaid)).toEqual([0]);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 4);
    expect(echoMods(state, "p1")).toEqual([]);
    expect(state.players.p1.graveyard.some((held) => held.id === card.id)).toBe(true);
  });

  it("R70 sends a cast permanent to the field, not the graveyard, and fires its Cry there once", () => {
    // §6.3's Cast row: the card "goes where its type sends it", and §10.5 step 4 sends a permanent
    // to the field — the leftmost free zone, as a play that names none takes (R64). This is the case
    // step 7 could have swallowed: a card left `resolving` is graveyarded there.
    const state = playing("r70-cast-permanent");
    const before = state.counters.played;
    const card = handCard(state, castUnit.id);

    const sink = sinkFor(state);
    castCard(sink, card);
    settle(sink);

    expect(state.players.p1.units[0]?.[0]?.id).toBe(card.id);
    expect(card.zone).toEqual({ z: "field", player: "p1", row: "units", lane: 1 });
    expect(state.players.p1.graveyard.some((held) => held.id === card.id)).toBe(false);
    expect(state.players.p1.hand.some((held) => held.id === card.id)).toBe(false);
    expect(state.players.p1.resolving).toEqual([]);

    // A cast is a play: free, counted, `cardPlayed` and the `summoned` of a card entering the field.
    expect(eventsOfType(sink.events, "cardPlayed").map((event) => event.costPaid)).toEqual([0]);
    expect(eventsOfType(sink.events, "summoned").map((event) => event.instanceId)).toEqual([card.id]);
    expect(state.counters.played).toBe(before + 1);
    // Once, not twice: the Cry has one owner (R1, R117).
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 2);
  });

  it("§6.3 repeats a cast permanent's printed Echo and leaves it on the field, not in the GY (R70)", () => {
    const state = playing("r70-cast-permanent-echo");
    const card = handCard(state, echoUnit.id);

    const sink = sinkFor(state);
    castCard(sink, card);
    // A cast is §10.5's pipeline (R70), so its repeat resolves inside the cast: nothing asked, so
    // nothing was owed to `state.work` (R117), and the cast is whole when the call returns.
    expect(echoQueue(state)).toEqual([]);
    expect(state.work).toEqual([]);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 4);
    settle(sink);

    // Two resolutions, one play, and the card is on the field with nothing left owed.
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 4);
    expect(eventsOfType(sink.events, "cardPlayed")).toHaveLength(1);
    expect(state.players.p1.units[0]?.[0]?.id).toBe(card.id);
    expect(state.players.p1.graveyard.some((held) => held.id === card.id)).toBe(false);
    expect(echoQueue(state)).toEqual([]);
    expect(state.work).toEqual([]);
  });

  it("R30 leaves the pending Echo armed for a cast permanent, since only a Spell takes it", () => {
    // R30 is "the next Spell you play"; R70 gives a cast Spell that grant, and a permanent — cast or
    // played — neither takes it nor spends the Twinspell that is holding it.
    const state = playing("r30-cast-permanent");
    pendingEcho(state, "p1", 1);
    const card = handCard(state, castUnit.id);

    const sink = sinkFor(state);
    castCard(sink, card);
    settle(sink);

    expect(echoMods(state, "p1")).toHaveLength(1);
    expect(echoQueue(state)).toEqual([]);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 2);
  });

  it("§10.5 step 7 lands a cast permanent with no free zone in the graveyard, after it resolves", () => {
    // A played permanent with no room is refused in step 1 ("no free zone"); a cast cannot be
    // refused, so the card resolves and is then still in `resolving`, which step 7 empties. NOTE:
    // §11 does not rule on this corner — it is reported with this milestone, not decided here.
    const state = playing("r70-cast-permanent-full");
    for (let lane = 1; lane <= UNIT_ZONES; lane += 1) put(state, castUnit.id, slot("p1", "units", lane));
    const card = handCard(state, castUnit.id);

    const sink = sinkFor(state);
    castCard(sink, card);
    settle(sink);

    expect(state.players.p1.graveyard.some((held) => held.id === card.id)).toBe(true);
    expect(state.players.p1.resolving).toEqual([]);
    expect(eventsOfType(sink.events, "summoned")).toEqual([]);
    // It still resolved: a cast fires the script whatever happens to the card afterwards (R70).
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 2);
  });
});
