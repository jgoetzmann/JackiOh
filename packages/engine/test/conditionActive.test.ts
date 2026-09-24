// R195 (SPEC §10.8, §10.9): the engine's yellow glow, `conditionActive`, as `viewFor` surfaces it.
//
// Every card here is a test-only definition whose script carries a `vi.fn` `conditionMet`, so each
// test controls what the hook answers and can read back every question the engine asked it. The
// definitions are registered on top of the fixture catalog and scripts (the pattern viewFor.test.ts
// uses for its own defs), and the registries are put back in `afterAll`.
//
// The rules under test (docs/polish/7-mobile-ux.md, S2), first match wins:
//   1. the game is over                                   -> false
//   2. zone "field" and the card is not the viewer's      -> false, hook not called
//   3. zone "hand" outside the viewer's own main phase with no prompt open -> false, hook not called
//   4. the running face has no hook (a transient def with no script included) -> false
//   5. otherwise the hook's answer, and only an answer of exactly `true` lights the card.
// The key is absent otherwise: never `false`, never on the opponent's cards.
//
// R196 is proved here too, through a real `fuse` (R77): a fused card's hook is its ingredients'
// hooks or-ed, so it glows when any ingredient's condition holds.

import { readFileSync } from "node:fs";
import type { CardDef, CardView, PlayerView } from "@jackioh/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { conditionActive } from "../src/condition";
import { openPrompt } from "../src/prompts";
import type { CardScripts, ConditionContext } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import { newInstance, type CardInstance, type GameState, type PromptOption, type Resume } from "../src/state";
import { viewFor } from "../src/viewFor";
import { fuse } from "../src/subsystems/fuse";
import { placeOnField } from "../src/zones";
import { inHand, newGame, put, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * What each face's hook answers. Reset to `true` before every test. Typed `unknown` so one test can
 * hand back a truthy non-boolean and prove only `=== true` counts.
 */
let baseAnswer: unknown = true;
let radiantAnswer: unknown = true;

const baseHook = vi.fn((_ctx: ConditionContext): boolean => baseAnswer as boolean);
const radiantHook = vi.fn((_ctx: ConditionContext): boolean => radiantAnswer as boolean);

/** R196: what glow-a's and glow-b's hooks answer (both faces alike). Reset to `false` before every test. */
let answerA: unknown = false;
let answerB: unknown = false;
const hookA = vi.fn((_ctx: ConditionContext): boolean => answerA as boolean);
const hookB = vi.fn((_ctx: ConditionContext): boolean => answerB as boolean);

let nextIndex = 1950;
function def(name: string, type: CardDef["type"], extra: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `ca-${name}`,
    index: String(nextIndex),
    name,
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

function unitDef(name: string, extra: Partial<CardDef> = {}): CardDef {
  return def(name, "Unit", {
    base: { attack: 2, health: 3, keywords: [], text: name },
    radiant: { attack: 4, health: 6, keywords: [], text: name },
    ...extra,
  });
}

const STACK_TEXT = { keywords: [{ kind: "Stack" as const }], text: "stack" };

/** Hooked cards, one of each kind of place a card can sit. */
const glowUnit = unitDef("glow-unit");
const glowSpell = def("glow-spell", "Spell");
const glowTrap = def("glow-trap", "Trap");
const glowFieldTrap = def("glow-field-trap", "Field Trap");
const glowFieldSpell = def("glow-field-spell", "Field Spell");
/** A hooked Stack unit, to sit on top of a pile. */
const glowStack = unitDef("glow-stack", {
  base: { attack: 1, health: 1, ...STACK_TEXT },
  radiant: { attack: 2, health: 2, ...STACK_TEXT },
});
/** A Stack unit with no hook, to bury a hooked card under. */
const plainStack = unitDef("plain-stack", {
  base: { attack: 1, health: 1, ...STACK_TEXT },
  radiant: { attack: 2, health: 2, ...STACK_TEXT },
});
/** A registered script that declares no `conditionMet`. */
const quietUnit = unitDef("quiet-unit");
/** A registered def with no script entry at all. */
const unscriptedUnit = unitDef("unscripted-unit");
/** A transient def with no script: it lives in `state.transientDefs` only, never in a registry. */
const transientUnit = unitDef("transient-unit");
/** Two hooked units whose hooks answer independently, for R196's fusions. */
const glowA = unitDef("glow-a");
const glowB = unitDef("glow-b");

const DEFS: CardDef[] = [
  glowUnit,
  glowSpell,
  glowTrap,
  glowFieldTrap,
  glowFieldSpell,
  glowStack,
  plainStack,
  quietUnit,
  unscriptedUnit,
  glowA,
  glowB,
];

const HOOKED: CardScripts = { base: { conditionMet: baseHook }, radiant: { conditionMet: radiantHook } };

const SCRIPTS: Record<string, CardScripts> = {
  [glowUnit.id]: HOOKED,
  [glowSpell.id]: HOOKED,
  [glowTrap.id]: HOOKED,
  [glowFieldTrap.id]: HOOKED,
  [glowFieldSpell.id]: HOOKED,
  [glowStack.id]: HOOKED,
  [plainStack.id]: { base: {}, radiant: {} },
  [quietUnit.id]: { base: {}, radiant: {} },
  [glowA.id]: { base: { conditionMet: hookA }, radiant: { conditionMet: hookA } },
  [glowB.id]: { base: { conditionMet: hookB }, radiant: { conditionMet: hookB } },
};

let savedCatalog: ReturnType<typeof registeredCatalog> = {};
let savedScripts: ReturnType<typeof registeredScripts> = {};

beforeAll(() => {
  savedCatalog = registeredCatalog();
  savedScripts = registeredScripts();
});

afterAll(() => {
  registerCatalog(savedCatalog);
  registerScripts(savedScripts);
});

beforeEach(() => {
  baseAnswer = true;
  radiantAnswer = true;
  baseHook.mockClear();
  radiantHook.mockClear();
  answerA = false;
  answerB = false;
  hookA.mockClear();
  hookB.mockClear();
});

/** p1's main phase on turn 3, no prompt, no result, with this file's defs and scripts registered. */
function game(seed: string): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((d) => [d.id, d])) });
  registerScripts({ ...registeredScripts(), ...SCRIPTS });
  state.turn = 3;
  state.active = "p1";
  state.phase = "main";
  return state;
}

function one(cards: CardInstance[]): CardInstance {
  const card = cards[0];
  if (card === undefined) throw new Error("expected a card");
  return card;
}

function ownHand(view: PlayerView): CardView[] {
  const hand = view.you.hand;
  if (!Array.isArray(hand)) throw new Error("the viewer's own hand must travel in full (§10.8)");
  return hand;
}

function handCard(view: PlayerView, instanceId: string): CardView {
  const found = ownHand(view).find((card) => card.instanceId === instanceId);
  if (found === undefined) throw new Error(`${instanceId} is not in the viewer's hand`);
  return found;
}

/**
 * The flag as the view carries it. `true` when the key is present, which must then hold exactly
 * `true`; `false` when the key is absent. A key present with any other value fails here, because
 * R195 makes the key absent rather than `false`.
 */
function glows(card: object | null | undefined): boolean {
  if (card === null || card === undefined) throw new Error("no card at that place in the view");
  if (!("conditionActive" in card)) return false;
  expect((card as { conditionActive?: unknown }).conditionActive).toBe(true);
  return true;
}

/** Every question either face's hook was asked since the last clear (base face first). */
function asked(): ConditionContext[] {
  return [...baseHook.mock.calls, ...radiantHook.mock.calls].map(([ctx]) => ctx);
}

function askedAbout(instanceId: string): ConditionContext[] {
  return asked().filter((ctx) => ctx.self.id === instanceId);
}

const inertResume: Resume = { defId: "", hook: "resume", step: "none", radiant: false, data: {} };

function modeOption(option: string): PromptOption {
  return { key: `mode:${option}`, label: option, selection: { pick: "mode", option } };
}

function openModePrompt(state: GameState, player: "p1" | "p2"): void {
  openPrompt(sinkFor(state), {
    player,
    kind: "mode",
    prompt: "Choose one",
    options: [modeOption("left"), modeOption("right")],
    resume: inertResume,
  });
  expect(state.pending).not.toBeNull();
}

// ---------------------------------------------------------------------------
// B1: the viewer's hand, in their own main phase
// ---------------------------------------------------------------------------

describe("conditionActive in the viewer's hand (R195, B1)", () => {
  it("R195 B1: a hand card whose hook holds carries conditionActive: true in the viewer's main phase", () => {
    const state = game("r195-hand-true");
    const spell = one(inHand(state, glowSpell.id, "p1"));
    const unit = one(inHand(state, glowUnit.id, "p1"));

    const view = viewFor(state, "p1");

    expect(glows(handCard(view, spell.id))).toBe(true);
    expect(glows(handCard(view, unit.id))).toBe(true);
    // The hook was asked as a hand card of the viewer's, on the viewer's own turn.
    const calls = askedAbout(spell.id);
    expect(calls.length).toBeGreaterThan(0);
    for (const ctx of calls) {
      expect(ctx.zone).toBe("hand");
      expect(ctx.controller).toBe("p1");
      expect(ctx.yourTurn).toBe(true);
      expect(ctx.radiant).toBe(false);
      expect(ctx.state.turn).toBe(state.turn);
    }
  });

  it("R195 B1: when the hook returns false the key is absent, never false", () => {
    const state = game("r195-hand-false");
    baseAnswer = false;
    const spell = one(inHand(state, glowSpell.id, "p1"));

    const view = viewFor(state, "p1");
    const card = handCard(view, spell.id);

    expect("conditionActive" in card).toBe(false);
    expect(JSON.stringify(view)).not.toContain("conditionActive");
    // It was asked, and said no: the absence is the hook's answer, not a skipped question.
    expect(askedAbout(spell.id).length).toBeGreaterThan(0);
  });

  it("R195 B1: only an answer of exactly true lights the card", () => {
    const state = game("r195-hand-truthy");
    const spell = one(inHand(state, glowSpell.id, "p1"));
    baseAnswer = 1;

    expect("conditionActive" in handCard(viewFor(state, "p1"), spell.id)).toBe(false);
    expect(askedAbout(spell.id).length).toBeGreaterThan(0);

    baseAnswer = "yes";
    expect(conditionActive(state, spell, "p1", "hand")).toBe(false);
  });

  it("R195 B1: a Radiant card asks its radiant face's hook, with radiant: true", () => {
    const state = game("r195-hand-radiant");
    baseAnswer = false;
    radiantAnswer = true;
    const plain = one(inHand(state, glowSpell.id, "p1"));
    const shiny = one(inHand(state, glowSpell.id, "p1"));
    shiny.radiant = true;

    const view = viewFor(state, "p1");

    expect(glows(handCard(view, shiny.id))).toBe(true);
    expect(glows(handCard(view, plain.id))).toBe(false);
    expect(radiantHook.mock.calls.map(([ctx]) => ctx.self.id)).toContain(shiny.id);
    expect(radiantHook.mock.calls.map(([ctx]) => ctx.self.id)).not.toContain(plain.id);
    for (const [ctx] of radiantHook.mock.calls) expect(ctx.radiant).toBe(true);
    for (const [ctx] of baseHook.mock.calls) expect(ctx.radiant).toBe(false);
  });

  it("R195 B1: conditionActive() hands the hook the card, its controller, its face, the zone and the turn, and asks once", () => {
    const state = game("r195-direct-hand");
    const spell = one(inHand(state, glowSpell.id, "p1"));

    expect(conditionActive(state, spell, "p1", "hand")).toBe(true);

    expect(baseHook).toHaveBeenCalledTimes(1);
    const ctx = baseHook.mock.calls[0]?.[0];
    if (ctx === undefined) throw new Error("the hook was not called");
    expect(ctx.state).toBe(state);
    expect(ctx.self).toBe(spell);
    expect(ctx.controller).toBe("p1");
    expect(ctx.radiant).toBe(false);
    expect(ctx.zone).toBe("hand");
    expect(ctx.yourTurn).toBe(true);

    baseAnswer = false;
    expect(conditionActive(state, spell, "p1", "hand")).toBe(false);
  });

  it("R195 B1: a card with no hook in the same hand carries no key", () => {
    const state = game("r195-hand-mixed");
    const hooked = one(inHand(state, glowSpell.id, "p1"));
    const quiet = one(inHand(state, quietUnit.id, "p1"));
    const unscripted = one(inHand(state, unscriptedUnit.id, "p1"));

    const view = viewFor(state, "p1");

    expect(glows(handCard(view, hooked.id))).toBe(true);
    expect("conditionActive" in handCard(view, quiet.id)).toBe(false);
    expect("conditionActive" in handCard(view, unscripted.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B2: never in hand outside the viewer's own main phase with no prompt and no result
// ---------------------------------------------------------------------------

describe("conditionActive stays off a hand card outside its playable window (R195, B2)", () => {
  function handCallCount(): number {
    return asked().filter((ctx) => ctx.zone === "hand").length;
  }

  it("R195 B2: during the opponent's turn the viewer's hand carries no flag and the hook is not asked", () => {
    const state = game("r195-b2-their-turn");
    state.active = "p2";
    const spell = one(inHand(state, glowSpell.id, "p1"));

    const view = viewFor(state, "p1");

    expect("conditionActive" in handCard(view, spell.id)).toBe(false);
    expect(handCallCount()).toBe(0);
  });

  it("R195 B2: the non-active seat's own hand carries no flag either, from its own view", () => {
    const state = game("r195-b2-p2-hand");
    const theirs = one(inHand(state, glowSpell.id, "p2"));

    const view = viewFor(state, "p2");

    expect("conditionActive" in handCard(view, theirs.id)).toBe(false);
    expect(handCallCount()).toBe(0);
  });

  it("R195 B2: during the mulligan and every other non-main phase the hand carries no flag", () => {
    for (const phase of ["setup", "mulligan", "start", "end"] as const) {
      baseHook.mockClear();
      const state = game(`r195-b2-${phase}`);
      state.phase = phase;
      const spell = one(inHand(state, glowSpell.id, "p1"));

      const view = viewFor(state, "p1");

      expect("conditionActive" in handCard(view, spell.id), phase).toBe(false);
      expect(handCallCount(), phase).toBe(0);
    }
  });

  it("R195 B2: with the viewer's own prompt open the hand carries no flag", () => {
    const state = game("r195-b2-own-prompt");
    const spell = one(inHand(state, glowSpell.id, "p1"));
    openModePrompt(state, "p1");

    const view = viewFor(state, "p1");

    expect("conditionActive" in handCard(view, spell.id)).toBe(false);
    expect(handCallCount()).toBe(0);
  });

  it("R195 B2: with the opponent's prompt open the hand carries no flag", () => {
    const state = game("r195-b2-their-prompt");
    const spell = one(inHand(state, glowSpell.id, "p1"));
    openModePrompt(state, "p2");

    const view = viewFor(state, "p1");

    expect("conditionActive" in handCard(view, spell.id)).toBe(false);
    expect(handCallCount()).toBe(0);
  });

  it("R195 B2: after the game has ended nothing carries the flag, hand or field", () => {
    const state = game("r195-b2-over");
    const spell = one(inHand(state, glowSpell.id, "p1"));
    put(state, glowUnit.id, slot("p1", "units", 1));
    put(state, glowTrap.id, slot("p1", "backrow", 1));
    state.result = { winner: "p2", reason: "hero-death" };

    const view = viewFor(state, "p1");

    expect("conditionActive" in handCard(view, spell.id)).toBe(false);
    expect(glows(view.you.units[0])).toBe(false);
    expect(glows(view.you.backrow[0])).toBe(false);
    expect(JSON.stringify(view)).not.toContain("conditionActive");
    expect(handCallCount()).toBe(0);
  });

  it("R195 B2: conditionActive() refuses a hand card outside the window without asking the hook", () => {
    const state = game("r195-b2-direct");
    const spell = one(inHand(state, glowSpell.id, "p1"));

    state.active = "p2";
    expect(conditionActive(state, spell, "p1", "hand")).toBe(false);
    state.active = "p1";
    state.phase = "mulligan";
    expect(conditionActive(state, spell, "p1", "hand")).toBe(false);
    state.phase = "main";
    openModePrompt(state, "p1");
    expect(conditionActive(state, spell, "p1", "hand")).toBe(false);

    expect(baseHook).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// B3: the viewer's own units (top of the pile) and backrow, on either turn
// ---------------------------------------------------------------------------

describe("conditionActive on the viewer's own field (R195, B3)", () => {
  it("R195 B3: a unit the viewer controls carries the flag on the viewer's turn, asked as field with yourTurn true", () => {
    const state = game("r195-b3-unit-own-turn");
    const unit = put(state, glowUnit.id, slot("p1", "units", 2));

    const view = viewFor(state, "p1");

    expect(glows(view.you.units[1])).toBe(true);
    const calls = askedAbout(unit.id);
    expect(calls.length).toBeGreaterThan(0);
    for (const ctx of calls) {
      expect(ctx.zone).toBe("field");
      expect(ctx.controller).toBe("p1");
      expect(ctx.yourTurn).toBe(true);
    }
  });

  it("R195 B3: the same unit still carries it on the opponent's turn, asked with yourTurn false", () => {
    const state = game("r195-b3-unit-their-turn");
    state.active = "p2";
    const unit = put(state, glowUnit.id, slot("p1", "units", 1));

    const view = viewFor(state, "p1");

    expect(glows(view.you.units[0])).toBe(true);
    const calls = askedAbout(unit.id);
    expect(calls.length).toBeGreaterThan(0);
    for (const ctx of calls) {
      expect(ctx.zone).toBe("field");
      expect(ctx.yourTurn).toBe(false);
    }
  });

  it("R195 B3: a Trap, a Field Trap and a Field Spell in the viewer's backrow carry the flag on either turn", () => {
    for (const active of ["p1", "p2"] as const) {
      baseHook.mockClear();
      const state = game(`r195-b3-backrow-${active}`);
      state.active = active;
      const trap = put(state, glowTrap.id, slot("p1", "backrow", 1));
      const fieldTrap = put(state, glowFieldTrap.id, slot("p1", "backrow", 2));
      const fieldSpell = put(state, glowFieldSpell.id, slot("p1", "backrow", 3));

      const view = viewFor(state, "p1");

      for (const [lane, card] of [
        [0, trap],
        [1, fieldTrap],
        [2, fieldSpell],
      ] as const) {
        const entry = view.you.backrow[lane];
        expect(entry, `${card.defId} on ${active}'s turn`).toMatchObject({ faceDown: false, instanceId: card.id });
        expect(glows(entry), `${card.defId} on ${active}'s turn`).toBe(true);
        for (const ctx of askedAbout(card.id)) {
          expect(ctx.zone).toBe("field");
          expect(ctx.yourTurn).toBe(active === "p1");
        }
      }
    }
  });

  it("R195 B3: a field card is asked outside the main phase and with a prompt open, and still carries the flag", () => {
    const state = game("r195-b3-field-prompt");
    put(state, glowUnit.id, slot("p1", "units", 1));
    put(state, glowTrap.id, slot("p1", "backrow", 1));
    openModePrompt(state, "p2");

    const withPrompt = viewFor(state, "p1");
    expect(glows(withPrompt.you.units[0])).toBe(true);
    expect(glows(withPrompt.you.backrow[0])).toBe(true);

    // The end-of-turn window: not the main phase, and the field is still asked.
    state.phase = "end";
    const atEnd = viewFor(state, "p1");
    expect(glows(atEnd.you.units[0])).toBe(true);
    expect(glows(atEnd.you.backrow[0])).toBe(true);
  });

  it("R195 B3: a field card whose hook returns false carries no key", () => {
    const state = game("r195-b3-field-false");
    baseAnswer = false;
    put(state, glowUnit.id, slot("p1", "units", 1));
    put(state, glowTrap.id, slot("p1", "backrow", 1));

    const view = viewFor(state, "p1");

    expect(glows(view.you.units[0])).toBe(false);
    expect(glows(view.you.backrow[0])).toBe(false);
    expect(JSON.stringify(view)).not.toContain("conditionActive");
  });

  it("R195 B3: a unit the viewer controls but does not own carries it; its owner's view does not", () => {
    const state = game("r195-b3-stolen");
    const stolen = put(state, glowUnit.id, slot("p1", "units", 3));
    stolen.owner = "p2";

    expect(glows(viewFor(state, "p1").you.units[2])).toBe(true);

    baseHook.mockClear();
    expect(glows(viewFor(state, "p2").opponent.units[2])).toBe(false);
    expect(askedAbout(stolen.id)).toEqual([]);
  });

  it("R195 B3: graveyard, exile and resolving cards never carry the flag and are never asked", () => {
    const state = game("r195-b3-piles");
    const inGrave = newInstance(state, glowUnit.id, "p1", { z: "graveyard", player: "p1" });
    state.players.p1.graveyard.push(inGrave);
    const inExile = newInstance(state, glowSpell.id, "p1", { z: "exile", player: "p1" });
    state.players.p1.exile.push(inExile);
    const resolving = newInstance(state, glowSpell.id, "p1", { z: "resolving", player: "p1" });
    state.players.p1.resolving.push(resolving);

    const view = viewFor(state, "p1");

    for (const card of [...view.you.graveyard, ...view.you.exile, ...view.you.resolving]) {
      expect("conditionActive" in card, card.instanceId).toBe(false);
    }
    // Not vacuous: all three piles really travelled.
    expect(view.you.graveyard.map((card) => card.instanceId)).toContain(inGrave.id);
    expect(view.you.exile.map((card) => card.instanceId)).toContain(inExile.id);
    expect(view.you.resolving.map((card) => card.instanceId)).toContain(resolving.id);
    for (const card of [inGrave, inExile, resolving]) expect(askedAbout(card.id)).toEqual([]);
  });

  it("R195 B3: a buried card is never asked; only the top of its pile is", () => {
    const state = game("r195-b3-buried");
    const buried = put(state, glowUnit.id, slot("p1", "units", 3));
    const top = newInstance(state, plainStack.id, "p1", { z: "hand", player: "p1" });
    expect(placeOnField(state, top, slot("p1", "units", 3), { stack: true })).toBe(true);

    const view = viewFor(state, "p1");

    expect(view.you.units[2]).toMatchObject({ instanceId: top.id, buried: 1 });
    // The top has no hook, and the hooked card under it lends it nothing.
    expect(glows(view.you.units[2])).toBe(false);
    expect(askedAbout(buried.id)).toEqual([]);
  });

  it("R195 B3: a hooked top of a Stack pile carries the flag while the hooked card under it is not asked", () => {
    const state = game("r195-b3-hooked-top");
    const buried = put(state, glowUnit.id, slot("p1", "units", 4));
    const top = newInstance(state, glowStack.id, "p1", { z: "hand", player: "p1" });
    expect(placeOnField(state, top, slot("p1", "units", 4), { stack: true })).toBe(true);

    const view = viewFor(state, "p1");

    expect(view.you.units[3]).toMatchObject({ instanceId: top.id, buried: 1 });
    expect(glows(view.you.units[3])).toBe(true);
    expect(askedAbout(top.id).length).toBeGreaterThan(0);
    expect(askedAbout(buried.id)).toEqual([]);
  });

  it("R195 B3: conditionActive() asks a field card on the opponent's turn with yourTurn false", () => {
    const state = game("r195-b3-direct");
    state.active = "p2";
    const unit = put(state, glowUnit.id, slot("p1", "units", 1));

    expect(conditionActive(state, unit, "p1", "field")).toBe(true);
    expect(baseHook).toHaveBeenCalledTimes(1);
    expect(baseHook.mock.calls[0]?.[0]).toMatchObject({ zone: "field", controller: "p1", yourTurn: false });
  });
});

// ---------------------------------------------------------------------------
// B4: never on the opponent's side, and never without a hook
// ---------------------------------------------------------------------------

describe("conditionActive is the viewer's alone (R195, B4)", () => {
  it("R195 B4: the opponent's view of p1's glowing cards carries no key anywhere, and p1's cards are not asked", () => {
    const state = game("r195-b4-opponent-view");
    const hand = one(inHand(state, glowSpell.id, "p1"));
    const unit = put(state, glowUnit.id, slot("p1", "units", 1));
    const trap = put(state, glowTrap.id, slot("p1", "backrow", 1));
    const fieldSpell = put(state, glowFieldSpell.id, slot("p1", "backrow", 2));
    const firedFieldTrap = put(state, glowFieldTrap.id, slot("p1", "backrow", 3));
    firedFieldTrap.faceUp = true;
    // p2's own hooked unit, so p2's view is not simply a view with nothing to ask about.
    const theirUnit = put(state, glowUnit.id, slot("p2", "units", 2));

    // p1 sees all five of its own cards glowing.
    const mine = viewFor(state, "p1");
    expect(glows(handCard(mine, hand.id))).toBe(true);
    expect(glows(mine.you.units[0])).toBe(true);
    expect(glows(mine.you.backrow[0])).toBe(true);
    expect(glows(mine.you.backrow[1])).toBe(true);
    expect(glows(mine.you.backrow[2])).toBe(true);
    // And p2's unit from the other side carries nothing.
    expect(glows(mine.opponent.units[1])).toBe(false);

    baseHook.mockClear();
    radiantHook.mockClear();
    const theirs = viewFor(state, "p2");

    expect(theirs.opponent.hand).toEqual({ count: 1 });
    expect(glows(theirs.opponent.units[0])).toBe(false);
    expect(theirs.opponent.backrow[0]).toEqual({ faceDown: true });
    expect(theirs.opponent.backrow[1]).toMatchObject({ faceDown: false, instanceId: fieldSpell.id });
    expect(glows(theirs.opponent.backrow[1])).toBe(false);
    expect(theirs.opponent.backrow[2]).toMatchObject({ faceDown: false, instanceId: firedFieldTrap.id });
    expect(glows(theirs.opponent.backrow[2])).toBe(false);
    // p2's own unit is the positive control: the view does ask, just never about p1's cards.
    expect(glows(theirs.you.units[1])).toBe(true);

    const calls = asked();
    expect(calls.length).toBeGreaterThan(0);
    for (const ctx of calls) {
      expect(ctx.self.controller).toBe("p2");
      expect(ctx.controller).toBe("p2");
    }
    for (const card of [hand, unit, trap, fieldSpell, firedFieldTrap]) expect(askedAbout(card.id)).toEqual([]);
    expect(askedAbout(theirUnit.id).length).toBeGreaterThan(0);
  });

  it("R195 B4: conditionActive() refuses a field card the viewer does not control without asking the hook", () => {
    const state = game("r195-b4-direct");
    const theirs = put(state, glowUnit.id, slot("p2", "units", 1));

    expect(conditionActive(state, theirs, "p1", "field")).toBe(false);
    expect(baseHook).not.toHaveBeenCalled();
    expect(radiantHook).not.toHaveBeenCalled();
  });

  it("R195 B4: cards with no hook never carry the key on either seat, a transient def with no script included", () => {
    const state = game("r195-b4-no-hook");
    state.transientDefs[transientUnit.id] = transientUnit;

    for (const player of ["p1", "p2"] as const) {
      inHand(state, quietUnit.id, player);
      inHand(state, unscriptedUnit.id, player);
      inHand(state, transientUnit.id, player);
    }
    put(state, quietUnit.id, slot("p1", "units", 1));
    put(state, unscriptedUnit.id, slot("p1", "units", 2));
    const transient = put(state, transientUnit.id, slot("p1", "units", 3));
    put(state, transientUnit.id, slot("p2", "units", 1));
    put(state, quietUnit.id, slot("p2", "units", 2));

    for (const active of ["p1", "p2"] as const) {
      state.active = active;
      for (const viewer of ["p1", "p2"] as const) {
        const view = viewFor(state, viewer);
        expect(JSON.stringify(view), `${viewer}'s view on ${active}'s turn`).not.toContain("conditionActive");
      }
    }
    expect(conditionActive(state, transient, "p1", "field")).toBe(false);
    state.active = "p1";
    const transientInHand = one(inHand(state, transientUnit.id, "p1"));
    expect(conditionActive(state, transientInHand, "p1", "hand")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R196: a fused card glows when any ingredient's condition holds
// ---------------------------------------------------------------------------

describe("R196 a fusion's conditionMet is its ingredients' hooks or-ed", () => {
  /** Craft a fusion of `defIds` into p1's hand through the real R77 `fuse`, the path #99 takes. */
  function craft(state: GameState, defIds: readonly string[]): CardInstance {
    const ingredients = defIds.map((defId) => one(inHand(state, defId, "p1")));
    const fused = fuse(sinkFor(state), { ingredients, toHand: "p1" });
    if (fused === null) throw new Error("the fusion did not happen");
    return fused;
  }

  it("R196 a fusion of two hooked cards glows when either hook holds, and not when neither does", () => {
    const state = game("r196-two-hooks");
    const fused = craft(state, [glowA.id, glowB.id]);
    expect(fused.zone).toEqual({ z: "hand", player: "p1" });

    const cases: readonly [unknown, unknown, boolean][] = [
      [false, false, false],
      [true, false, true],
      [false, true, true],
      [true, true, true],
    ];
    for (const [a, b, expected] of cases) {
      answerA = a;
      answerB = b;
      expect(glows(handCard(viewFor(state, "p1"), fused.id)), `A ${String(a)}, B ${String(b)}`).toBe(expected);
    }
  });

  it("R196 each ingredient's hook is asked about the fused card itself, and only an answer of exactly true counts", () => {
    const state = game("r196-context");
    const fused = craft(state, [glowA.id, glowB.id]);

    answerA = 1;
    answerB = "yes";
    expect(conditionActive(state, fused, "p1", "hand")).toBe(false);
    expect(hookA).toHaveBeenCalled();
    expect(hookB).toHaveBeenCalled();
    for (const [ctx] of [...hookA.mock.calls, ...hookB.mock.calls]) {
      expect(ctx.self.id).toBe(fused.id);
      expect(ctx.controller).toBe("p1");
      expect(ctx.zone).toBe("hand");
      expect(ctx.yourTurn).toBe(true);
    }
  });

  it("R196 one hooked ingredient's hook is the fusion's, and a fusion with no hooked ingredient never glows", () => {
    const state = game("r196-one-hook");
    const withHook = craft(state, [glowA.id, quietUnit.id]);
    const withoutHook = craft(state, [quietUnit.id, plainStack.id]);

    answerA = true;
    expect(glows(handCard(viewFor(state, "p1"), withHook.id))).toBe(true);
    answerA = false;
    expect(glows(handCard(viewFor(state, "p1"), withHook.id))).toBe(false);
    expect(glows(handCard(viewFor(state, "p1"), withoutHook.id))).toBe(false);
    expect(conditionActive(state, withoutHook, "p1", "hand")).toBe(false);
  });

  it("R196 a fusion kept on the field (R77's target) glows for its controller when either hook holds", () => {
    const state = game("r196-field");
    const target = put(state, glowA.id, slot("p1", "units", 2));
    const ingredient = one(inHand(state, glowB.id, "p1"));
    const fused = fuse(sinkFor(state), { ingredients: [ingredient], target });
    expect(fused?.id).toBe(target.id);

    answerB = true;
    expect(glows(viewFor(state, "p1").you.units[1])).toBe(true);
    expect(hookB.mock.calls.some(([ctx]) => ctx.zone === "field" && ctx.self.id === target.id)).toBe(true);
    // Still the controller's alone (R195).
    expect(glows(viewFor(state, "p2").opponent.units[1])).toBe(false);

    answerB = false;
    expect(glows(viewFor(state, "p1").you.units[1])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B10: the ruling is written down where CLAUDE.md rule 3 says it must be
// ---------------------------------------------------------------------------

/** A file's text, resolved against this directory (the way rulings.test.ts reads its proofs). */
function textOf(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

/** SPEC's text from one heading up to the next one given. */
function specBetween(spec: string, from: string, to: string): string {
  const start = spec.indexOf(`\n${from}`);
  const end = spec.indexOf(`\n${to}`, start + 1);
  expect(start, `SPEC has a "${from}" heading`).toBeGreaterThanOrEqual(0);
  expect(end, `SPEC has a "${to}" heading after "${from}"`).toBeGreaterThan(start);
  return spec.slice(start, end);
}

// `pnpm rulings:coverage` is the other half of B10. It runs in the gate and in CI rather than
// here, because it scans every package; what it checks for this row is what the last test does.
describe("R195 in SPEC §10.8, §10.9 and §11, and in the rulings index (B10)", () => {
  const spec = textOf("../../../SPEC.md");

  it("R195 B10: §11 carries one R195 row, in numeric position, citing §10.8, §10.9 and the five cards", () => {
    const rows = [...spec.matchAll(/^\| R(\d+) \|/gm)].map((match) => Number(match[1]));
    expect(rows.filter((row) => row === 195)).toHaveLength(1);
    const at = rows.indexOf(195);
    expect(rows[at - 1], "the row before R195").toBeLessThan(195);
    if (at + 1 < rows.length) expect(rows[at + 1], "the row after R195").toBeGreaterThan(195);

    const row = /^\| R195 \|.*$/m.exec(spec)?.[0] ?? "";
    expect(row).toContain("| When a card glows yellow (`conditionActive`) |");
    const cells = row.split("|").map((cell) => cell.trim());
    expect(cells.at(-2), "the sections and cards the row cites").toBe("§10.8, §10.9, #10, #53, #68, #71, #93");
  });

  it("R195 B10: §10.8 puts conditionActive on the viewer's own cards, and §10.9 adds conditionMet to Script", () => {
    const view = specBetween(spec, "### 10.8", "### 10.9");
    expect(view).toContain("`conditionActive: true`");
    expect(view).toContain("never set on the opponent's cards");
    expect(view).toContain("R195");

    const scripts = specBetween(spec, "### 10.9", "### 10.10");
    expect(scripts).toMatch(/`Script = \{[^`]*\bmodes\?, conditionMet\? \}`/);
    expect(scripts).toContain("`conditionMet` is R195's read-only predicate");
    expect(scripts).toContain("a card with `conditionMet` also tests both answers of it");
  });

  it("R195 B10: the rulings index points R195 at both proof files, and each carries R195 tests", () => {
    const index = textOf("rulings.test.ts");
    const entry = /it\("(R195 [^"]*)", \(\) => \{\s*provenIn\(195, ([^)]*)\);/.exec(index);
    expect(entry, "rulings.test.ts has an it(\"R195 …\") that calls provenIn(195, …)").not.toBeNull();
    const files = [...(entry?.[2] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
    expect(files).toEqual(["conditionActive.test.ts", "../../cards/test/condition-active.test.ts"]);

    for (const file of files) {
      const titles = [...textOf(file).matchAll(/\bit\(\s*"(R195 [^"]*)"/g)];
      expect(titles.length, `${file} carries it("R195 …") tests`).toBeGreaterThan(0);
    }
  });
});
