// R280 (SPEC §10.8, §10.9): the number a formula comes to now, as `viewFor` carries it on a card
// view (`preview`), and a Fuse's list (R102).
//
// Every card here is a test-only definition whose script carries a `vi.fn` `preview`, so each test
// controls what the hook answers and reads back every question the engine asked it. The pattern is
// conditionActive.test.ts's: the definitions go on top of the fixture catalog and scripts, and the
// registries are put back in `afterAll`. The real Core hooks are proved in packages/cards
// (test/preview.test.ts).
//
// Where the view carries it (§10.8), both seats:
//   - the viewer's own hand, in any phase and on either turn;
//   - a unit on top of its pile, either seat's;
//   - a backrow card face-up to the viewer: a Field Spell and a fired Field Trap for both, a
//     face-down Trap or Field Trap for its controller alone (R33).
// Never: the opponent's hand, a library card, a card buried under a Stack, a graveyard, exile or
// resolving card — and the hook is not even asked about those. Absent, never `[]`, when the hook
// answers nothing or the card has none.

import type { CardDef, CardView, PlayerView, PreviewValue } from "@jackioh/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { previewOf } from "../src/preview";
import { openPrompt } from "../src/prompts";
import { hashState } from "../src/replay";
import type { CardScripts, ConditionContext } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import { fuse } from "../src/subsystems/fuse";
import { newInstance, type CardInstance, type GameState, type PromptOption, type Resume } from "../src/state";
import { viewFor } from "../src/viewFor";
import { placeOnField } from "../src/zones";
import { inHand, newGame, put, setLibrary, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * One labelled number per question, naming the card, the face and the zone it was asked about, so
 * a test can tell from the view alone which card's hook answered — and so an id never seen in a
 * view proves the hook's answer for that card did not leak into it.
 */
function answer(ctx: ConditionContext): PreviewValue[] {
  return [{ label: `n(${ctx.self.id})`, value: (ctx.radiant ? 20 : 10) + (ctx.zone === "hand" ? 1 : 2) }];
}

const baseHook = vi.fn((ctx: ConditionContext): PreviewValue[] => answer(ctx));
const radiantHook = vi.fn((ctx: ConditionContext): PreviewValue[] => answer(ctx));
/** Answers nothing: a card whose formula has no number to show. */
const emptyHook = vi.fn((_ctx: ConditionContext): PreviewValue[] => []);
/** Two ingredients' hooks for R102's concatenation, answering fixed labels. */
const hookA = vi.fn((_ctx: ConditionContext): PreviewValue[] => [{ label: "A", value: 1 }]);
const hookB = vi.fn((_ctx: ConditionContext): PreviewValue[] => [
  { label: "B1", value: 2 },
  { label: "B2", value: 3 },
]);

let nextIndex = 2800;
function def(name: string, type: CardDef["type"], extra: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `pv-${name}`,
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

const pvUnit = unitDef("unit");
const pvSpell = def("spell", "Spell");
const pvTrap = def("trap", "Trap");
const pvFieldTrap = def("field-trap", "Field Trap");
const pvFieldSpell = def("field-spell", "Field Spell");
/** A hooked Stack unit, to sit on top of a pile. */
const pvStack = unitDef("stack", {
  base: { attack: 1, health: 1, ...STACK_TEXT },
  radiant: { attack: 2, health: 2, ...STACK_TEXT },
});
/** A Stack unit with no hook, to bury a hooked card under. */
const plainStack = unitDef("plain-stack", {
  base: { attack: 1, health: 1, ...STACK_TEXT },
  radiant: { attack: 2, health: 2, ...STACK_TEXT },
});
/** A registered script that declares no `preview`. */
const quietUnit = unitDef("quiet-unit");
/** A registered def with no script entry at all. */
const unscriptedUnit = unitDef("unscripted-unit");
/** A hook that answers `[]`. */
const emptyUnit = unitDef("empty-unit");
/** A transient def with no script: it lives in `state.transientDefs` only. */
const transientUnit = unitDef("transient-unit");
/** R102's ingredients: two hooked units, and two that name cards (R279's `refs`). */
const pvA = unitDef("a", { refs: ["core-t-rush", "core-t-sheep"] });
const pvB = unitDef("b", { refs: ["core-t-sheep", "core-t-bread"] });

const DEFS: CardDef[] = [
  pvUnit,
  pvSpell,
  pvTrap,
  pvFieldTrap,
  pvFieldSpell,
  pvStack,
  plainStack,
  quietUnit,
  unscriptedUnit,
  emptyUnit,
  pvA,
  pvB,
];

const HOOKED: CardScripts = { base: { preview: baseHook }, radiant: { preview: radiantHook } };

const SCRIPTS: Record<string, CardScripts> = {
  [pvUnit.id]: HOOKED,
  [pvSpell.id]: HOOKED,
  [pvTrap.id]: HOOKED,
  [pvFieldTrap.id]: HOOKED,
  [pvFieldSpell.id]: HOOKED,
  [pvStack.id]: HOOKED,
  [plainStack.id]: { base: {}, radiant: {} },
  [quietUnit.id]: { base: {}, radiant: {} },
  [emptyUnit.id]: { base: { preview: emptyHook }, radiant: { preview: emptyHook } },
  [pvA.id]: { base: { preview: hookA }, radiant: { preview: hookA } },
  [pvB.id]: { base: { preview: hookB }, radiant: { preview: hookB } },
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
  for (const hook of [baseHook, radiantHook, emptyHook, hookA, hookB]) hook.mockClear();
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

/** The list the view carries, or null when the key is absent. A key holding `[]` fails here. */
function shown(card: object | null | undefined): PreviewValue[] | null {
  if (card === null || card === undefined) throw new Error("no card at that place in the view");
  if (!("preview" in card)) return null;
  const list = (card as { preview?: unknown }).preview;
  expect(Array.isArray(list) && list.length > 0, "preview is absent rather than empty").toBe(true);
  return list as PreviewValue[];
}

/** Every question either face's hook was asked since the last clear. */
function asked(): ConditionContext[] {
  return [...baseHook.mock.calls, ...radiantHook.mock.calls].map(([ctx]) => ctx);
}

function askedAbout(instanceId: string): ConditionContext[] {
  return asked().filter((ctx) => ctx.self.id === instanceId);
}

function clearHooks(): void {
  baseHook.mockClear();
  radiantHook.mockClear();
}

const inertResume: Resume = { defId: "", hook: "resume", step: "none", radiant: false, data: {} };

function openModePrompt(state: GameState, player: "p1" | "p2"): void {
  const option = (name: string): PromptOption => ({
    key: `mode:${name}`,
    label: name,
    selection: { pick: "mode", option: name },
  });
  openPrompt(sinkFor(state), {
    player,
    kind: "mode",
    prompt: "Choose one",
    options: [option("left"), option("right")],
    resume: inertResume,
  });
  expect(state.pending).not.toBeNull();
}

// ---------------------------------------------------------------------------
// The viewer's hand
// ---------------------------------------------------------------------------

describe("R280 preview in the viewer's own hand", () => {
  it("R280 a hand card carries its hook's list, asked as a hand card of its controller's", () => {
    const state = game("r280-hand");
    const spell = one(inHand(state, pvSpell.id, "p1"));
    const unit = one(inHand(state, pvUnit.id, "p1"));

    const view = viewFor(state, "p1");

    expect(shown(handCard(view, spell.id))).toEqual([{ label: `n(${spell.id})`, value: 11 }]);
    expect(shown(handCard(view, unit.id))).toEqual([{ label: `n(${unit.id})`, value: 11 }]);
    const calls = askedAbout(spell.id);
    expect(calls.length).toBeGreaterThan(0);
    for (const ctx of calls) {
      expect(ctx.zone).toBe("hand");
      expect(ctx.controller).toBe("p1");
      expect(ctx.radiant).toBe(false);
      expect(ctx.yourTurn).toBe(true);
      expect(ctx.state.turn).toBe(state.turn);
    }
  });

  it("R280 unlike the glow, a hand card carries it on the opponent's turn, outside the main phase and with a prompt open", () => {
    const state = game("r280-hand-any-phase");
    const spell = one(inHand(state, pvSpell.id, "p1"));

    state.active = "p2";
    expect(shown(handCard(viewFor(state, "p1"), spell.id))).toEqual([{ label: `n(${spell.id})`, value: 11 }]);
    expect(askedAbout(spell.id).every((ctx) => !ctx.yourTurn)).toBe(true);

    state.active = "p1";
    for (const phase of ["mulligan", "start", "end"] as const) {
      state.phase = phase;
      expect(shown(handCard(viewFor(state, "p1"), spell.id)), phase).not.toBeNull();
    }
    state.phase = "main";
    openModePrompt(state, "p1");
    expect(shown(handCard(viewFor(state, "p1"), spell.id))).not.toBeNull();
  });

  it("R280 each seat's own hand carries it in its own view, and the other seat's view carries nothing of it", () => {
    const state = game("r280-hand-both-seats");
    const mine = one(inHand(state, pvSpell.id, "p1"));
    const theirs = one(inHand(state, pvSpell.id, "p2"));

    const p2View = viewFor(state, "p2");
    expect(shown(handCard(p2View, theirs.id))).toEqual([{ label: `n(${theirs.id})`, value: 11 }]);
    expect(p2View.opponent.hand).toEqual({ count: 1 });
    expect(JSON.stringify(p2View)).not.toContain(`n(${mine.id})`);

    clearHooks();
    const p1View = viewFor(state, "p1");
    expect(shown(handCard(p1View, mine.id))).not.toBeNull();
    expect(p1View.opponent.hand).toEqual({ count: 1 });
    expect(JSON.stringify(p1View)).not.toContain(`n(${theirs.id})`);
    // Not only unshown: never asked. The opponent's hand card is hidden (§9.1).
    expect(askedAbout(theirs.id)).toEqual([]);
  });

  it("R280 a Radiant card asks its radiant face's hook, with radiant: true", () => {
    const state = game("r280-hand-radiant");
    const plain = one(inHand(state, pvSpell.id, "p1"));
    const shiny = one(inHand(state, pvSpell.id, "p1"));
    shiny.radiant = true;

    const view = viewFor(state, "p1");

    expect(shown(handCard(view, shiny.id))).toEqual([{ label: `n(${shiny.id})`, value: 21 }]);
    expect(shown(handCard(view, plain.id))).toEqual([{ label: `n(${plain.id})`, value: 11 }]);
    expect(radiantHook.mock.calls.map(([ctx]) => ctx.self.id)).toEqual([shiny.id]);
    expect(baseHook.mock.calls.map(([ctx]) => ctx.self.id)).toEqual([plain.id]);
  });
});

// ---------------------------------------------------------------------------
// The field: the top of a unit pile, the backrow
// ---------------------------------------------------------------------------

describe("R280 preview on the field", () => {
  it("R280 a unit on top of its pile carries it in both seats' views, asked for its own controller", () => {
    const state = game("r280-unit");
    const unit = put(state, pvUnit.id, slot("p1", "units", 2));

    const own = viewFor(state, "p1");
    const other = viewFor(state, "p2");

    const expected = [{ label: `n(${unit.id})`, value: 12 }];
    expect(shown(own.you.units[1])).toEqual(expected);
    expect(shown(other.opponent.units[1])).toEqual(expected);
    // The number is the card's, so p2's view asks the hook about p1's card as p1's.
    for (const ctx of askedAbout(unit.id)) {
      expect(ctx.zone).toBe("field");
      expect(ctx.controller).toBe("p1");
      expect(ctx.yourTurn).toBe(true);
    }
  });

  it("R280 a unit the viewer's opponent controls is asked with that controller's yourTurn", () => {
    const state = game("r280-unit-theirs");
    const theirs = put(state, pvUnit.id, slot("p2", "units", 1));

    expect(shown(viewFor(state, "p1").opponent.units[0])).not.toBeNull();
    const calls = askedAbout(theirs.id);
    expect(calls.length).toBeGreaterThan(0);
    for (const ctx of calls) {
      expect(ctx.controller).toBe("p2");
      expect(ctx.yourTurn).toBe(false);
    }
  });

  it("R280 a Field Spell and a fired Field Trap carry it in both seats' views", () => {
    const state = game("r280-backrow-public");
    const fieldSpell = put(state, pvFieldSpell.id, slot("p1", "backrow", 1));
    const firedFieldTrap = put(state, pvFieldTrap.id, slot("p1", "backrow", 2));
    firedFieldTrap.faceUp = true;

    for (const viewer of ["p1", "p2"] as const) {
      const view = viewFor(state, viewer);
      const side = viewer === "p1" ? view.you : view.opponent;
      expect(side.backrow[0]).toMatchObject({ faceDown: false, instanceId: fieldSpell.id });
      expect(shown(side.backrow[0]), viewer).toEqual([{ label: `n(${fieldSpell.id})`, value: 12 }]);
      expect(side.backrow[1]).toMatchObject({ faceDown: false, instanceId: firedFieldTrap.id });
      expect(shown(side.backrow[1]), viewer).toEqual([{ label: `n(${firedFieldTrap.id})`, value: 12 }]);
    }
  });

  it("R280 a face-down Trap or Field Trap carries it for its controller alone, and is not asked for the other seat", () => {
    const state = game("r280-backrow-face-down");
    const trap = put(state, pvTrap.id, slot("p1", "backrow", 1));
    const fieldTrap = put(state, pvFieldTrap.id, slot("p1", "backrow", 2));

    const own = viewFor(state, "p1");
    expect(shown(own.you.backrow[0])).toEqual([{ label: `n(${trap.id})`, value: 12 }]);
    expect(shown(own.you.backrow[1])).toEqual([{ label: `n(${fieldTrap.id})`, value: 12 }]);

    clearHooks();
    const other = viewFor(state, "p2");
    expect(other.opponent.backrow[0]).toEqual({ faceDown: true });
    expect(other.opponent.backrow[1]).toEqual({ faceDown: true });
    expect(JSON.stringify(other)).not.toContain(`n(${trap.id})`);
    expect(askedAbout(trap.id)).toEqual([]);
    expect(askedAbout(fieldTrap.id)).toEqual([]);
  });

  it("R280 a face-down trap follows control (R33): a stolen one shows to its new controller, not its owner", () => {
    const state = game("r280-backrow-stolen");
    const trap = put(state, pvTrap.id, slot("p2", "backrow", 3));
    trap.owner = "p1";

    expect(shown(viewFor(state, "p2").you.backrow[2])).toEqual([{ label: `n(${trap.id})`, value: 12 }]);
    clearHooks();
    expect(viewFor(state, "p1").opponent.backrow[2]).toEqual({ faceDown: true });
    expect(askedAbout(trap.id)).toEqual([]);
  });

  it("R280 a buried card is never asked; only the top of its pile carries one", () => {
    const state = game("r280-buried");
    const buried = put(state, pvUnit.id, slot("p1", "units", 3));
    const top = newInstance(state, plainStack.id, "p1", { z: "hand", player: "p1" });
    expect(placeOnField(state, top, slot("p1", "units", 3), { stack: true })).toBe(true);

    for (const viewer of ["p1", "p2"] as const) {
      const view = viewFor(state, viewer);
      const side = viewer === "p1" ? view.you : view.opponent;
      expect(side.units[2]).toMatchObject({ instanceId: top.id, buried: 1 });
      expect(shown(side.units[2]), viewer).toBeNull();
    }
    expect(askedAbout(buried.id)).toEqual([]);
    expect(previewOf(state, buried, "p1", "field")).toBeNull();
    expect(askedAbout(buried.id)).toEqual([]);

    // A hooked top of a pile does carry its own, still without asking about the card under it.
    const hookedPile = put(state, pvUnit.id, slot("p1", "units", 4));
    const hookedTop = newInstance(state, pvStack.id, "p1", { z: "hand", player: "p1" });
    expect(placeOnField(state, hookedTop, slot("p1", "units", 4), { stack: true })).toBe(true);
    clearHooks();
    expect(shown(viewFor(state, "p2").opponent.units[3])).toEqual([{ label: `n(${hookedTop.id})`, value: 12 }]);
    expect(askedAbout(hookedPile.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Nowhere else
// ---------------------------------------------------------------------------

describe("R280 preview is nowhere else", () => {
  it("R280 library, graveyard, exile and resolving cards never carry it and are never asked", () => {
    const state = game("r280-piles");
    const [inLibrary] = setLibrary(state, "p1", [pvSpell.id]);
    const inGrave = newInstance(state, pvUnit.id, "p1", { z: "graveyard", player: "p1" });
    state.players.p1.graveyard.push(inGrave);
    const inExile = newInstance(state, pvSpell.id, "p1", { z: "exile", player: "p1" });
    state.players.p1.exile.push(inExile);
    const resolving = newInstance(state, pvSpell.id, "p1", { z: "resolving", player: "p1" });
    state.players.p1.resolving.push(resolving);

    for (const viewer of ["p1", "p2"] as const) {
      const view = viewFor(state, viewer);
      const side = viewer === "p1" ? view.you : view.opponent;
      for (const card of [...side.graveyard, ...side.exile, ...side.resolving]) {
        expect("preview" in card, `${card.instanceId} in ${viewer}'s view`).toBe(false);
      }
      expect(side.graveyard.map((card) => card.instanceId)).toContain(inGrave.id);
      expect(side.exile.map((card) => card.instanceId)).toContain(inExile.id);
      expect(side.resolving.map((card) => card.instanceId)).toContain(resolving.id);
      expect(JSON.stringify(view)).not.toContain('"preview"');
    }
    for (const card of [inLibrary, inGrave, inExile, resolving]) {
      if (card === undefined) throw new Error("the library card was not made");
      expect(askedAbout(card.id)).toEqual([]);
    }
  });

  it("R280 previewOf refuses, without asking, a card its viewer may not read where it is asked about", () => {
    const state = game("r280-direct-refusals");
    const theirHand = one(inHand(state, pvSpell.id, "p2"));
    const theirTrap = put(state, pvTrap.id, slot("p2", "backrow", 1));
    const [library] = setLibrary(state, "p1", [pvSpell.id]);
    const unit = put(state, pvUnit.id, slot("p1", "units", 1));
    const myHand = one(inHand(state, pvSpell.id, "p1"));
    if (library === undefined) throw new Error("the library card was not made");

    expect(previewOf(state, theirHand, "p1", "hand")).toBeNull();
    expect(previewOf(state, theirTrap, "p1", "field")).toBeNull();
    expect(previewOf(state, library, "p1", "hand")).toBeNull();
    expect(previewOf(state, library, "p1", "field")).toBeNull();
    // A card asked about as where it is not: a field unit as a hand card, a hand card as a field one.
    expect(previewOf(state, unit, "p1", "hand")).toBeNull();
    expect(previewOf(state, myHand, "p1", "field")).toBeNull();
    expect(asked()).toEqual([]);

    // And the positive controls, asked once each.
    expect(previewOf(state, theirTrap, "p2", "field")).toEqual([{ label: `n(${theirTrap.id})`, value: 12 }]);
    expect(previewOf(state, myHand, "p1", "hand")).toEqual([{ label: `n(${myHand.id})`, value: 11 }]);
    expect(asked()).toHaveLength(2);
  });

  it("R280 the key is absent, never [], when the hook answers nothing or the card has none", () => {
    const state = game("r280-absent");
    state.transientDefs[transientUnit.id] = transientUnit;
    for (const player of ["p1", "p2"] as const) {
      inHand(state, emptyUnit.id, player);
      inHand(state, quietUnit.id, player);
      inHand(state, unscriptedUnit.id, player);
      inHand(state, transientUnit.id, player);
    }
    put(state, emptyUnit.id, slot("p1", "units", 1));
    put(state, quietUnit.id, slot("p1", "units", 2));
    put(state, unscriptedUnit.id, slot("p2", "units", 1));
    put(state, transientUnit.id, slot("p2", "units", 2));

    for (const viewer of ["p1", "p2"] as const) {
      expect(JSON.stringify(viewFor(state, viewer)), viewer).not.toContain('"preview"');
    }
    // The empty answer was asked for, and it is the answer that made the key absent.
    expect(emptyHook).toHaveBeenCalled();
  });

  it("R280 a Vanilla card has no text, so no preview (§6.3)", () => {
    const state = game("r280-vanilla");
    const unit = put(state, pvUnit.id, slot("p1", "units", 1));
    unit.vanilla = true;

    expect(shown(viewFor(state, "p1").you.units[0])).toBeNull();
    expect(askedAbout(unit.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A read, and nothing more
// ---------------------------------------------------------------------------

describe("R280 the hook is a pure read", () => {
  it("R280 the hook is handed no rng and no event sink, so it can neither draw nor emit", () => {
    const state = game("r280-context");
    one(inHand(state, pvSpell.id, "p1"));
    put(state, pvUnit.id, slot("p2", "units", 1));

    viewFor(state, "p1");

    const calls = asked();
    expect(calls.length).toBeGreaterThan(0);
    for (const ctx of calls) {
      expect(Object.keys(ctx).sort()).toEqual(["controller", "radiant", "self", "state", "yourTurn", "zone"]);
    }
  });

  it("R280 building the view with previews leaves the state exactly as it was, and the view holds copies", () => {
    const state = game("r280-unchanged");
    inHand(state, pvSpell.id, "p1");
    put(state, pvUnit.id, slot("p1", "units", 1));
    put(state, pvTrap.id, slot("p2", "backrow", 1));
    const before = hashState(state);
    const cursor = state.rngCursor;

    const views = [viewFor(state, "p1"), viewFor(state, "p2")];

    expect(hashState(state)).toBe(before);
    expect(state.rngCursor).toBe(cursor);

    // A list the view carries is its own: changing it changes no later view.
    const list = shown(views[0]?.you.units[0]);
    if (list === null) throw new Error("the unit carries a preview");
    const first = list[0];
    if (first === undefined) throw new Error("the preview has an entry");
    first.value = -1;
    expect(shown(viewFor(state, "p1").you.units[0])?.[0]?.value).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// R102: a fused card's list, and its refs
// ---------------------------------------------------------------------------

describe("R280 a fusion's preview is its ingredients' lists in ingredient order (R102)", () => {
  /** Craft a fusion of `defIds` into p1's hand through the real R77 `fuse`, the path #99 takes. */
  function craft(state: GameState, defIds: readonly string[]): CardInstance {
    const ingredients = defIds.map((defId) => one(inHand(state, defId, "p1")));
    const fused = fuse(sinkFor(state), { ingredients, toHand: "p1" });
    if (fused === null) throw new Error("the fusion did not happen");
    return fused;
  }

  it("R280 a crafted fusion carries A's list then B's, each hook asked about the fused card itself", () => {
    const state = game("r280-fused-two");
    const fused = craft(state, [pvA.id, pvB.id]);

    expect(shown(handCard(viewFor(state, "p1"), fused.id))).toEqual([
      { label: "A", value: 1 },
      { label: "B1", value: 2 },
      { label: "B2", value: 3 },
    ]);
    for (const [ctx] of [...hookA.mock.calls, ...hookB.mock.calls]) {
      expect(ctx.self.id).toBe(fused.id);
      expect(ctx.controller).toBe("p1");
      expect(ctx.zone).toBe("hand");
    }

    // The other order is the other list: ingredient order, not a sorted one.
    const reversed = craft(state, [pvB.id, pvA.id]);
    expect(shown(handCard(viewFor(state, "p1"), reversed.id))?.map((entry) => entry.label)).toEqual([
      "B1",
      "B2",
      "A",
    ]);
  });

  it("R280 one hooked ingredient's list is the fusion's, and a fusion of none carries no key", () => {
    const state = game("r280-fused-one");
    const withHook = craft(state, [quietUnit.id, pvA.id]);
    const withoutHook = craft(state, [quietUnit.id, plainStack.id]);

    const view = viewFor(state, "p1");
    expect(shown(handCard(view, withHook.id))).toEqual([{ label: "A", value: 1 }]);
    expect(shown(handCard(view, withoutHook.id))).toBeNull();
  });

  it("R280 a fusion kept on the field (R77's target) shows the list to both seats", () => {
    const state = game("r280-fused-field");
    const target = put(state, pvA.id, slot("p1", "units", 2));
    const ingredient = one(inHand(state, pvB.id, "p1"));
    const fused = fuse(sinkFor(state), { ingredients: [ingredient], target });
    expect(fused?.id).toBe(target.id);

    // The played ingredients come first and the target last (`fuse`), as the fused name says.
    expect(state.transientDefs[target.defId]?.name).toBe("b + a");
    const labels = ["B1", "B2", "A"];
    expect(shown(viewFor(state, "p1").you.units[1])?.map((entry) => entry.label)).toEqual(labels);
    expect(shown(viewFor(state, "p2").opponent.units[1])?.map((entry) => entry.label)).toEqual(labels);
  });

  it("R102 a fused definition names every card its ingredients name: their refs' union, in order (R279)", () => {
    const state = game("r102-fused-refs");
    const both = craft(state, [pvA.id, pvB.id]);
    const one_ = craft(state, [pvB.id, quietUnit.id]);
    const none = craft(state, [quietUnit.id, plainStack.id]);

    expect(state.transientDefs[both.defId]?.refs).toEqual(["core-t-rush", "core-t-sheep", "core-t-bread"]);
    expect(state.transientDefs[one_.defId]?.refs).toEqual(["core-t-sheep", "core-t-bread"]);
    expect(state.transientDefs[none.defId]).toBeDefined();
    expect("refs" in (state.transientDefs[none.defId] ?? {})).toBe(false);
  });
});
