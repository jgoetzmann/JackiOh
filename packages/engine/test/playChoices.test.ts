// The refusals a play's choices go through, and the channel they travel in (SPEC §10.5 step 1,
// §10.6, R81, R90).
//
// This file owns the refusals the M3 BLOCKER was about: a card dormant under a Stack, the
// opponent's hand, and the counts a declaration asks for. Its sibling
// `playChoices-filters.test.ts` drives the rest of the module — several declarations reading the
// flat `targets` list, the `type`, `tags` and `notTags` filters, the backrow, hero and zone kinds,
// `excludeSelf`, an ally-only side and two mode declarations at once — so nothing here repeats
// those.
//
// It also holds R81's core, which is a statement about *where* a choice lives: "Zone, X, embiggen,
// Tribute and the targets and modes a card's script declares travel in the `play` action, which
// `legalActions` enumerates … and never pause resolution. Every choice made during resolution
// (Discover, chained steps, Echo repeats, casts, triggers, mulligan) opens a `PendingChoice`."
// That sentence is the line between this module and `prompts.ts`, and it has its own test below.
//
// Tribute is the one play choice this file leaves alone: `tribute.test.ts` owns it.
//
// Fixtures are prefixed `pc-` and indexed above 1450 so they cannot collide (BUILD §0).

import type { Action, ActionInput, CardDef, PlayerId, Selection } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { MAX_CHOICE_COMBINATIONS } from "../src/config";
import { chosenOptions, addToHand as addToHandEffect, damage, discoverFromCatalog } from "../src/effects";
import {
  declaredModes,
  declaredTargets,
  legalSelectionsFor,
  playChoiceCombinations,
  whyChoicesRefused,
} from "../src/playChoices";
import { beginGame, legalActions, reduce } from "../src/reduce";
import type { CardScripts, Effect, Script } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import type { CardInstance, GameState } from "../src/state";
import { placeOnField } from "../src/zones";
import { plain, stacker } from "./fixtures/combat";
import { inHand, newGame, put, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

let nextIndex = 1450;

function def(name: string, type: CardDef["type"], extra: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `pc-${name}`,
    index: String(nextIndex),
    name: `${name} (playChoices)`,
    set: "Core",
    type,
    tags: [],
    rarity: "Common",
    token: false,
    cost: 1,
    base: { keywords: [], text: name },
    radiant: { keywords: [], text: name },
    ...extra,
  };
}

function unit(name: string, extra: Partial<CardDef> = {}): CardDef {
  return def(name, "Unit", {
    base: { attack: 2, health: 2, keywords: [], text: name },
    radiant: { attack: 4, health: 4, keywords: [], text: name },
    ...extra,
  });
}

/** One unit pick on your own side: what a Stack pile offers is the whole question (R13, R90). */
const unitHitter = def("unit-hitter", "Spell");
/** #26's shape: one card out of a hand. §9.1 decides whose hand that may be. */
const handPicker = def("hand-picker", "Spell");
/** "Choose 1 or 2 units": the plain min-and-max counts of one declaration (R90). */
const oneToTwo = def("one-to-two", "Spell");
/** A card that declares nothing at all, so it may be handed nothing (R90). */
const declaresNothing = def("declares-nothing", "Spell");
/** #2 Glowy Jelly Bean plus Silly Silas: a hand pick and a direction, both play choices (R81). */
const traveller = unit("traveller");
/** A Cry that Discovers, so the choice is made during resolution and becomes a prompt (R81). */
const discoverer = def("discoverer", "Spell");
/** A spare card to sit in a hand as a candidate. */
const candidate = def("candidate", "Spell");

const DEFS = [unitHitter, handPicker, oneToTwo, declaresNothing, traveller, discoverer, candidate];

/** Records the selections and modes a play delivered, so "it travelled" is observable. */
function recordChoices(): Effect {
  return {
    kind: "pc:record",
    apply(ctx): void {
      const self = ctx.self;
      if (self === null) return;
      self.memory.gotTargets = ctx.targets.map((selection) =>
        selection.pick === "instance" ? selection.instanceId : selection.pick,
      );
      self.memory.gotModes = [...ctx.modes];
    },
  };
}

function both(script: Script): CardScripts {
  return { base: script, radiant: script };
}

const SCRIPTS: Record<string, CardScripts> = {
  [unitHitter.id]: both({
    targets: [{ kind: "target", min: 1, max: 1, filter: { side: "ally", of: ["unit"] } }],
    cry: () => [damage({ to: { of: "chosen" }, amount: 1 })],
  }),
  [handPicker.id]: both({
    targets: [{ kind: "hand", min: 1, max: 1 }],
    cry: () => [],
  }),
  [oneToTwo.id]: both({
    targets: [{ kind: "target", min: 1, max: 2, filter: { side: "any", of: ["unit"] } }],
    cry: () => [],
  }),
  [declaresNothing.id]: both({ cry: () => [] }),
  [traveller.id]: both({
    targets: [{ kind: "hand", min: 1, max: 1 }],
    modes: [{ kind: "direction", options: ["left", "right"] }],
    cry: () => [recordChoices()],
  }),
  [discoverer.id]: both({
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
  return reduce(state, { ...body, nonce: `pc${nonce}` } as Action);
}

/** Past the mulligans, in p1's main phase, with this file's fixtures registered and 4 mana. */
function playing(seed: string): GameState {
  let state = beginGame(newGame(seed)).state;
  state = actResult(state, {
    type: "mulligan",
    keep: state.players.p1.hand.map((c) => c.id),
    playerId: "p1",
  }).state;
  state = actResult(state, {
    type: "mulligan",
    keep: state.players.p2.hand.map((c) => c.id),
    playerId: "p2",
  }).state;
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

const onInstance = (id: string): Selection => ({ pick: "instance", instanceId: id });
const ids = (selections: readonly Selection[]): string[] =>
  selections.flatMap((s) => (s.pick === "instance" ? [s.instanceId] : []));

function firstDecl(card: CardInstance): ReturnType<typeof declaredTargets>[number] {
  return only(declaredTargets(card));
}

// ---------------------------------------------------------------------------

describe("the refusals a play's choices go through (§10.5 step 1, R81, R90)", () => {
  it("R90 offers only the top of a Stack pile and refuses a card dormant under it (R13)", () => {
    const state = playing("stack-dormant");
    const buried = put(state, plain.id, slot("p1", "units", 1));
    const top = put(state, stacker.id, slot("p1", "units", 2));
    // Move the Stack card onto the occupied lane, which turns it into a pile (§3.2).
    expect(placeOnField(state, top, slot("p1", "units", 1), { stack: true })).toBe(true);
    const pile = state.players.p1.units[0] ?? [];
    expect(pile.map((card) => card.id)).toEqual([top.id, buried.id]);

    const card = handCard(state, unitHitter.id);
    const decl = firstDecl(card);
    // R13: a dormant card is not "on the field" for effects, so it is never offered.
    expect(ids(legalSelectionsFor(state, "p1", card, decl))).toEqual([top.id]);
    expect(playChoiceCombinations(state, "p1", card).map((combo) => ids(combo.targets ?? []))).toEqual([
      [top.id],
    ]);

    // Naming it anyway is refused rather than silently retargeted: a client may not reach it.
    expect(
      whyChoicesRefused(state, "p1", card, {
        type: "play",
        instanceId: card.id,
        targets: [onInstance(buried.id)],
      }),
    ).toMatch(/not a legal target/);
    expect(
      whyChoicesRefused(state, "p1", card, {
        type: "play",
        instanceId: card.id,
        targets: [onInstance(top.id)],
      }),
    ).toBeNull();

    const refused = actResult(state, {
      type: "play",
      instanceId: card.id,
      playerId: "p1",
      targets: [onInstance(buried.id)],
    });
    expect(refused.error).toMatch(/not a legal target/);
    expect(refused.state).toBe(state);
    expect(buried.damage).toBe(0);
  });

  it("R90 refuses a hand pick that names a card in the opponent's hand, which the chooser cannot see (§9.1)", () => {
    const state = playing("opponent-hand");
    const mine = handCard(state, candidate.id, "p1");
    const theirs = handCard(state, candidate.id, "p2");
    const card = handCard(state, handPicker.id);
    const decl = firstDecl(card);

    // §9.1: a hand pick only ever offers the chooser's own hand, and never the card leaving it.
    const offered = ids(legalSelectionsFor(state, "p1", card, decl));
    expect(offered).toContain(mine.id);
    expect(offered).not.toContain(card.id);
    for (const held of state.players.p2.hand) expect(offered).not.toContain(held.id);

    expect(
      whyChoicesRefused(state, "p1", card, {
        type: "play",
        instanceId: card.id,
        targets: [onInstance(theirs.id)],
      }),
    ).toMatch(/not a legal target/);
    expect(
      actResult(state, {
        type: "play",
        instanceId: card.id,
        playerId: "p1",
        targets: [onInstance(theirs.id)],
      }).error,
    ).toMatch(/not a legal target/);
    // The hand pick the chooser does own goes through.
    expect(
      actResult(state, { type: "play", instanceId: card.id, playerId: "p1", targets: [onInstance(mine.id)] })
        .error,
    ).toBeUndefined();
  });

  it("R90 refuses fewer picks than a declaration's minimum and more than its maximum", () => {
    const state = playing("counts");
    const a = put(state, plain.id, slot("p1", "units", 1));
    const b = put(state, plain.id, slot("p1", "units", 2));
    const c = put(state, plain.id, slot("p2", "units", 1));
    const card = handCard(state, oneToTwo.id);
    const decl = firstDecl(card);
    expect(decl.min).toBe(1);
    expect(decl.max).toBe(2);
    expect(ids(legalSelectionsFor(state, "p1", card, decl))).toEqual([a.id, b.id, c.id]);

    const play = (targets: Selection[]): ReturnType<typeof whyChoicesRefused> =>
      whyChoicesRefused(state, "p1", card, { type: "play", instanceId: card.id, targets });

    expect(play([])).toMatch(/needs 1 target/);
    expect(play([onInstance(a.id)])).toBeNull();
    expect(play([onInstance(a.id), onInstance(c.id)])).toBeNull();
    expect(play([onInstance(a.id), onInstance(b.id), onInstance(c.id)])).toMatch(/at most 2 targets/);
    // Within one declaration the same card twice is not two picks (R90).
    expect(play([onInstance(a.id), onInstance(a.id)])).toMatch(/same target twice/);

    // The enumeration offers exactly the answers the validator accepts: 3 singles and 3 pairs.
    const combos = playChoiceCombinations(state, "p1", card);
    expect(combos.map((combo) => ids(combo.targets ?? []))).toEqual([
      [a.id],
      [b.id],
      [c.id],
      [a.id, b.id],
      [a.id, c.id],
      [b.id, c.id],
    ]);
    expect(combos.length).toBeLessThanOrEqual(MAX_CHOICE_COMBINATIONS);
    for (const combo of combos) {
      expect(whyChoicesRefused(state, "p1", card, { type: "play", instanceId: card.id, ...combo })).toBeNull();
    }
    expect(actResult(state, { type: "play", instanceId: card.id, playerId: "p1", targets: [] }).error).toMatch(
      /needs 1 target/,
    );
  });

  it("R90 gives a card that declared nothing nothing: a target or a mode it never asked for is refused", () => {
    const state = playing("declared-nothing");
    const victim = put(state, plain.id, slot("p2", "units", 1));
    const card = handCard(state, declaresNothing.id);

    expect(declaredTargets(card)).toEqual([]);
    expect(declaredModes(card)).toEqual([]);
    // One answer, and it is the empty one, so the card is still offered exactly once.
    expect(playChoiceCombinations(state, "p1", card)).toEqual([{}]);

    expect(whyChoicesRefused(state, "p1", card, { type: "play", instanceId: card.id })).toBeNull();
    expect(
      whyChoicesRefused(state, "p1", card, {
        type: "play",
        instanceId: card.id,
        targets: [onInstance(victim.id)],
      }),
    ).toMatch(/takes no targets/);
    expect(
      whyChoicesRefused(state, "p1", card, { type: "play", instanceId: card.id, modes: ["left"] }),
    ).toMatch(/takes no mode choices/);

    expect(
      actResult(state, {
        type: "play",
        instanceId: card.id,
        playerId: "p1",
        targets: [onInstance(victim.id)],
      }).error,
    ).toMatch(/takes no targets/);
  });

  it("R81 carries a declared hand pick in targets and a declared direction in modes, in the play action itself", () => {
    const state = playing("choices-travel");
    const spare = handCard(state, candidate.id, "p1");
    const card = handCard(state, traveller.id);

    // Both declarations are the card's own, so `legalActions` has to enumerate them (R81).
    expect(declaredTargets(card).map((decl) => decl.kind)).toEqual(["hand"]);
    expect(declaredModes(card).map((decl) => decl.kind)).toEqual(["direction"]);
    const combos = playChoiceCombinations(state, "p1", card);
    expect(combos.every((combo) => (combo.targets ?? []).length === 1)).toBe(true);
    expect(new Set(combos.map((combo) => only(combo.modes ?? [])))).toEqual(new Set(["left", "right"]));

    const plays = legalActions(state, "p1").filter(
      (action) => action.type === "play" && action.instanceId === card.id,
    );
    expect(plays.length).toBeGreaterThan(0);
    for (const play of plays) {
      if (play.type !== "play") continue;
      // A unit takes a zone, so zone, targets and modes ride in the one action (R81).
      expect(play.zone).toBeDefined();
      expect(play.targets).toBeDefined();
      expect(play.modes).toBeDefined();
      expect(whyChoicesRefused(state, "p1", card, play)).toBeNull();
    }

    const played = actResult(state, {
      type: "play",
      instanceId: card.id,
      playerId: "p1",
      zone: { row: "units", lane: 1 },
      targets: [onInstance(spare.id)],
      modes: ["right"],
    });
    expect(played.error).toBeUndefined();
    // The script saw both answers, and resolution never paused for either (R81).
    const resolved = played.state.players.p1.units[0]?.[0];
    expect(resolved?.memory.gotTargets).toEqual([spare.id]);
    expect(resolved?.memory.gotModes).toEqual(["right"]);
    expect(played.state.pending).toBeNull();
  });

  it("R81 opens a PendingChoice for a choice made during resolution, not a play choice", () => {
    const state = playing("resolution-choice");
    const card = handCard(state, discoverer.id);

    // The card declares nothing, so nothing travels in the play …
    expect(declaredTargets(card)).toEqual([]);
    expect(declaredModes(card)).toEqual([]);
    expect(playChoiceCombinations(state, "p1", card)).toEqual([{}]);

    // … and its Discover, made while the card resolves, becomes the one open prompt of §10.1.
    const played = actResult(state, { type: "play", instanceId: card.id, playerId: "p1" });
    expect(played.error).toBeUndefined();
    const pending = played.state.pending;
    expect(pending?.kind).toBe("discover");
    expect(pending?.playerId).toBe("p1");
    expect(pending?.options).toHaveLength(3);
    expect(played.events.some((event) => event.type === "promptOpened")).toBe(true);
    // And a prompt is never something a `play` action could have answered up front.
    expect(
      whyChoicesRefused(state, "p1", card, {
        type: "play",
        instanceId: card.id,
        modes: [only(pending?.options ?? []).key],
      }),
    ).toMatch(/takes no mode choices/);
  });
});
