// The effects that ask the controller something (BUILD M3-T1 "every effect has its own test file";
// SPEC §6.3, §10.6, §5.1, R50, R81). `prompts.test.ts` covers the prompt machinery — one at a
// time, the serializable resume, chaining. This file covers the six factories in
// `effects/choose.ts` and the two scope readers beside them: what each declares, what it puts in
// `state.pending`, what it emits, and what it does when there is nothing to offer.

import type { CardDef, Selection } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import {
  chooseFromHand,
  chooseMode,
  chooseTarget,
  chosenOptions,
  discoverFromCatalog,
  discoverFromGraveyard,
  targetsInScope,
} from "../src/effects";
import { makeContext } from "../src/resolve";
import type { EffectContext } from "../src/script";
import { newInstance, type CardInstance, type GameState } from "../src/state";
import { placeOnField } from "../src/zones";
import { plain, stacker, taunter } from "./fixtures/combat";
import { eventsOfType, inHand, newGame, put, sinkFor, slot } from "./fixtures/harness";

let nextIndex = 1300;
function def(name: string, type: CardDef["type"], extra: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `ec-pick-${name}`,
    index: String(nextIndex),
    name: `${name} (choose)`,
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

function fruit(name: string): CardDef {
  return def(name, "Unit", {
    tags: ["Fruit"],
    base: { attack: 1, health: 1, keywords: [], text: name },
    radiant: { attack: 2, health: 2, keywords: [], text: name },
  });
}

/** The unit whose script does the asking. */
const caller = def("caller", "Unit", {
  base: { attack: 2, health: 3, keywords: [], text: "caller" },
  radiant: { attack: 4, health: 6, keywords: [], text: "caller" },
});
/** A backrow card, for a backrow scope and for `excludeSelf` on one. */
const fieldCard = def("field", "Field Spell");
/** A Discover pool of exactly four, one of which is the card that generates it (§5.1). */
const fruitGenerator = fruit("fruit-generator");
const fruitA = fruit("fruit-a");
const fruitB = fruit("fruit-b");
const fruitC = fruit("fruit-c");

const DEFS = [caller, fieldCard, fruitGenerator, fruitA, fruitB, fruitC];

function game(seed: string): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((d) => [d.id, d])) });
  state.turn = 3;
  state.active = "p1";
  state.phase = "main";
  return state;
}

function ctxFor(state: GameState, self: CardInstance | null, extra: Partial<EffectContext> = {}): EffectContext {
  return { ...makeContext(sinkFor(state), self, { controller: "p1" }), ...extra };
}

function run(ctx: EffectContext, effects: { apply: (c: EffectContext) => void }[]): void {
  for (const effect of effects) effect.apply(ctx);
}

/** Only one prompt may be open at a time (§10.1), so a probe clears the last one first. */
function clearPrompt(state: GameState): void {
  state.pending = null;
}

const ids = (selections: readonly Selection[]): string[] =>
  selections.flatMap((s) => (s.pick === "instance" ? [s.instanceId] : []));
const optionSelections = (state: GameState): Selection[] =>
  (state.pending?.options ?? []).map((option) => option.selection);

describe("target scopes (§10.6, R13)", () => {
  it("§10.6 offers every active unit by default, the chooser's side first, in lane order", () => {
    const state = game("scope-default");
    const mineA = put(state, plain.id, slot("p1", "units", 1));
    const mineB = put(state, taunter.id, slot("p1", "units", 3));
    const theirs = put(state, plain.id, slot("p2", "units", 2));

    // §3.2 and R13: a card dormant under a Stack is not on the field, so it is never offered.
    const buried = put(state, plain.id, slot("p2", "units", 1));
    const top = newInstance(state, stacker.id, "p2", { z: "hand", player: "p2" });
    expect(placeOnField(state, top, slot("p2", "units", 1), { stack: true })).toBe(true);

    const offered = targetsInScope(ctxFor(state, mineA));
    expect(ids(offered)).toEqual([mineA.id, mineB.id, top.id, theirs.id]);
    expect(ids(offered)).not.toContain(buried.id);
  });

  it("§10.6 narrows a scope by side, and offers heroes and backrow cards when it names them", () => {
    const state = game("scope-sides");
    const mine = put(state, plain.id, slot("p1", "units", 1));
    const theirs = put(state, plain.id, slot("p2", "units", 1));
    const myBackrow = put(state, fieldCard.id, slot("p1", "backrow", 2));
    const theirBackrow = put(state, fieldCard.id, slot("p2", "backrow", 5));
    const ctx = ctxFor(state, mine);

    expect(ids(targetsInScope(ctx, { side: "ally" }))).toEqual([mine.id]);
    expect(ids(targetsInScope(ctx, { side: "enemy" }))).toEqual([theirs.id]);
    expect(targetsInScope(ctx, { of: ["hero"] })).toEqual([
      { pick: "hero", player: "p1" },
      { pick: "hero", player: "p2" },
    ]);
    expect(ids(targetsInScope(ctx, { of: ["backrow"] }))).toEqual([myBackrow.id, theirBackrow.id]);
    // Within one side the kinds come in the order the scope lists them in the module: units,
    // backrow, then the hero.
    expect(targetsInScope(ctx, { side: "enemy", of: ["unit", "backrow", "hero"] })).toEqual([
      { pick: "instance", instanceId: theirs.id },
      { pick: "instance", instanceId: theirBackrow.id },
      { pick: "hero", player: "p2" },
    ]);
  });

  it("§10.6 excludeSelf drops the card running the script, from a unit and from a backrow scope", () => {
    const state = game("scope-exclude-self");
    const self = put(state, caller.id, slot("p1", "units", 1));
    const other = put(state, plain.id, slot("p1", "units", 2));
    const selfBackrow = put(state, fieldCard.id, slot("p1", "backrow", 1));
    const otherBackrow = put(state, fieldCard.id, slot("p1", "backrow", 2));

    const unitCtx = ctxFor(state, self);
    expect(ids(targetsInScope(unitCtx, { side: "ally", excludeSelf: true }))).toEqual([other.id]);
    expect(ids(targetsInScope(unitCtx, { side: "ally" }))).toEqual([self.id, other.id]);

    const backrowCtx = ctxFor(state, selfBackrow);
    expect(ids(targetsInScope(backrowCtx, { side: "ally", of: ["backrow"], excludeSelf: true }))).toEqual([
      otherBackrow.id,
    ]);
    // With no instance running the script the flag excludes nothing (a Spell resolving).
    expect(ids(targetsInScope(ctxFor(state, null), { side: "ally", excludeSelf: true }))).toEqual([
      self.id,
      other.id,
    ]);
  });

  it("R81 reads a prompt's mode pick out of ctx.targets and a play's modes out of ctx.modes", () => {
    const state = game("chosen-options");
    const self = put(state, caller.id, slot("p1", "units", 1));

    // A Discover's answer arrives as a `mode` selection carrying a def id (§10.6).
    const answered = ctxFor(state, self, {
      targets: [
        { pick: "mode", option: fruitA.id },
        { pick: "instance", instanceId: self.id },
        { pick: "hero", player: "p1" },
        { pick: "none" },
      ],
      modes: ["left"],
    });
    // The prompt's picks come first, then the play's modes; nothing else is read.
    expect(chosenOptions(answered)).toEqual([fruitA.id, "left"]);
    expect(chosenOptions(ctxFor(state, self))).toEqual([]);
    expect(chosenOptions(ctxFor(state, self, { modes: ["burn", "freeze"] }))).toEqual(["burn", "freeze"]);
  });
});

describe("the choose effects (§6.3, §10.6, M3-T1)", () => {
  it("§6.3 Choose one opens a mode prompt that resumes the step it names", () => {
    const state = game("choose-mode");
    const self = put(state, caller.id, slot("p1", "units", 1));
    const effect = chooseMode({ options: ["burn", "heal"], step: "picked" });
    expect(effect.kind).toBe("chooseMode");

    const ctx = ctxFor(state, self);
    run(ctx, [effect]);
    expect(state.pending).toMatchObject({
      playerId: "p1",
      kind: "mode",
      prompt: "Choose one",
      min: 1,
      max: 1,
      resume: { defId: caller.id, hook: "resume", step: "picked", radiant: false, instanceId: self.id, data: {} },
    });
    expect(state.pending?.options).toEqual([
      { key: "mode:burn", label: "burn", selection: { pick: "mode", option: "burn" } },
      { key: "mode:heal", label: "heal", selection: { pick: "mode", option: "heal" } },
    ]);
    expect(eventsOfType(ctx.events, "promptOpened")).toEqual([
      { type: "promptOpened", player: "p1", choiceId: state.pending?.id ?? "", kind: "mode" },
    ]);

    // Its own prompt text, the radiant face and the data a chain has captured all carry through.
    clearPrompt(state);
    self.radiant = true;
    const radiantCtx = ctxFor(state, self, { data: { mode: "burn" } });
    run(radiantCtx, [chooseMode({ options: ["a"], step: "again", prompt: "Which one?", data: { round: 2 } })]);
    expect(state.pending).toMatchObject({
      prompt: "Which one?",
      resume: { step: "again", radiant: true, data: { mode: "burn", round: 2 } },
    });
  });

  it("§10.6 chooseTarget offers the scope it names, labelled, and fizzles on an empty scope (§6.3)", () => {
    const state = game("choose-target");
    const self = put(state, caller.id, slot("p1", "units", 1));
    const enemy = put(state, taunter.id, slot("p2", "units", 1));
    const enemyBackrow = put(state, fieldCard.id, slot("p2", "backrow", 3));
    const effect = chooseTarget({ step: "zap", scope: { side: "enemy", of: ["unit", "backrow", "hero"] } });
    expect(effect.kind).toBe("chooseTarget");

    const ctx = ctxFor(state, self);
    run(ctx, [effect]);
    expect(state.pending).toMatchObject({ kind: "target", prompt: "Choose a target", min: 1, max: 1 });
    // Each option is labelled with the card's name, or the side whose hero it is.
    expect(state.pending?.options).toEqual([
      {
        key: `instance:${taunter.name}`,
        label: taunter.name,
        selection: { pick: "instance", instanceId: enemy.id },
      },
      {
        key: `instance:${fieldCard.name}`,
        label: fieldCard.name,
        selection: { pick: "instance", instanceId: enemyBackrow.id },
      },
      { key: "hero:p2's hero", label: "p2's hero", selection: { pick: "hero", player: "p2" } },
    ]);

    // An empty scope opens no prompt and emits nothing: the effect fizzles and the card resolves.
    clearPrompt(state);
    const emptyBoard = game("choose-target-empty");
    const lonely = put(emptyBoard, caller.id, slot("p1", "units", 1));
    const quiet = ctxFor(emptyBoard, lonely);
    run(quiet, [chooseTarget({ step: "zap", scope: { side: "enemy", of: ["unit"] }, prompt: "Zap what?" })]);
    expect(emptyBoard.pending).toBeNull();
    expect(quiet.events).toEqual([]);
  });

  it("#26 chooseFromHand offers your own hand only, and asks for what the hand can give", () => {
    const state = game("choose-hand");
    const self = put(state, caller.id, slot("p1", "units", 1));

    // An empty hand opens nothing at all.
    const empty = ctxFor(state, self);
    run(empty, [chooseFromHand({ step: "picked" })]);
    expect(state.pending).toBeNull();
    expect(empty.events).toEqual([]);

    const mine = inHand(state, plain.id, "p1", 3);
    inHand(state, taunter.id, "p2", 2);
    const ctx = ctxFor(state, self);
    run(ctx, [chooseFromHand({ step: "picked", count: 2, prompt: "Discard two" })]);
    expect(state.pending).toMatchObject({
      kind: "hand",
      prompt: "Discard two",
      min: 2,
      max: 2,
      resume: { step: "picked", instanceId: self.id },
    });
    expect(ids(optionSelections(state))).toEqual(mine.map((card) => card.id));
    expect(state.pending?.options.map((option) => option.key)).toEqual(
      mine.map((card) => `instance:${card.id}`),
    );
    for (const theirs of state.players.p2.hand) {
      expect(ids(optionSelections(state))).not.toContain(theirs.id);
    }

    // A count above the hand size asks for the whole hand rather than for an impossible number.
    clearPrompt(state);
    run(ctxFor(state, self), [chooseFromHand({ step: "picked", count: 9 })]);
    expect(state.pending).toMatchObject({ min: 3, max: 3 });

    // With no count stated it asks for one, under the default prompt text.
    clearPrompt(state);
    run(ctxFor(state, self), [chooseFromHand({ step: "picked" })]);
    expect(state.pending).toMatchObject({ prompt: "Choose a card in your hand", min: 1, max: 1 });
  });

  it("§6.3 Discover offers three from the pool it names, never the card that generated it (§5.1)", () => {
    const state = game("discover-catalog");
    const self = put(state, fruitGenerator.id, slot("p1", "units", 1));
    const effect = discoverFromCatalog({ step: "chosen", query: { tags: ["Fruit"] } });
    expect(effect.kind).toBe("discoverFromCatalog");

    const ctx = ctxFor(state, self);
    run(ctx, [effect]);
    expect(state.pending).toMatchObject({
      kind: "discover",
      prompt: "Discover a card",
      min: 1,
      max: 1,
      resume: { step: "chosen", instanceId: self.id },
    });
    const offered = (state.pending?.options ?? []).flatMap((option) =>
      option.selection.pick === "mode" ? [option.selection.option] : [],
    );
    // The Fruit pool is four cards and one of them is the generator, so it is exactly the other
    // three — no repeats, and never itself.
    expect([...offered].sort()).toEqual([fruitA.id, fruitB.id, fruitC.id].sort());
    expect(offered).not.toContain(fruitGenerator.id);
    expect(state.pending?.options.map((option) => option.key)).toEqual(offered.map((id) => `mode:${id}`));

    // The same seed and the same pool offer them in the same order (§10.7).
    const twin = game("discover-catalog");
    const twinSelf = put(twin, fruitGenerator.id, slot("p1", "units", 1));
    run(ctxFor(twin, twinSelf), [discoverFromCatalog({ step: "chosen", query: { tags: ["Fruit"] } })]);
    expect(twin.pending?.options.map((option) => option.key)).toEqual(
      state.pending?.options.map((option) => option.key),
    );

    // A narrower count offers fewer, and a pool with nothing in it opens no prompt (it fizzles).
    clearPrompt(state);
    run(ctxFor(state, self), [
      discoverFromCatalog({ step: "chosen", query: { tags: ["Fruit"] }, count: 2, prompt: "Pick a fruit" }),
    ]);
    expect(state.pending?.options).toHaveLength(2);
    expect(state.pending?.prompt).toBe("Pick a fruit");

    clearPrompt(state);
    const fizzle = ctxFor(state, self);
    run(fizzle, [discoverFromCatalog({ step: "chosen", query: { cost: 99 } })]);
    expect(state.pending).toBeNull();
    expect(fizzle.events).toEqual([]);

    // With no query the pool is the whole catalog, and with no instance running the script there
    // is no generating card to exclude (§5.1's exclusion is the card's own index).
    clearPrompt(state);
    run(ctxFor(state, null), [discoverFromCatalog({ step: "chosen" })]);
    const wide = (state.pending?.options ?? []).flatMap((option) =>
      option.selection.pick === "mode" ? [option.selection.option] : [],
    );
    expect(wide).toHaveLength(3);
    expect(new Set(wide).size).toBe(3);
    for (const id of wide) expect(registeredCatalog()[id]?.token).toBe(false);
    expect(state.pending?.resume).toMatchObject({ defId: "", step: "chosen" });
    expect(state.pending?.resume.instanceId).toBeUndefined();
  });

  it("R50 Discover from the graveyard offers the cards actually in your own graveyard", () => {
    const state = game("discover-graveyard");
    const self = put(state, caller.id, slot("p1", "units", 1));
    const effect = discoverFromGraveyard({ step: "chosen" });
    expect(effect.kind).toBe("discoverFromGraveyard");

    // An empty graveyard opens nothing.
    const empty = ctxFor(state, self);
    run(empty, [effect]);
    expect(state.pending).toBeNull();
    expect(empty.events).toEqual([]);

    const mine = [plain.id, taunter.id, fieldCard.id].map((defId) => {
      const card = newInstance(state, defId, "p1", { z: "graveyard", player: "p1" });
      state.players.p1.graveyard.push(card);
      return card;
    });
    const theirs = newInstance(state, plain.id, "p2", { z: "graveyard", player: "p2" });
    state.players.p2.graveyard.push(theirs);

    const ctx = ctxFor(state, self);
    run(ctx, [effect]);
    expect(state.pending).toMatchObject({ kind: "discover", prompt: "Discover a card from your graveyard" });
    const offered = ids(optionSelections(state));
    // R50: the options are the actual instances there, so a spell token in the graveyard is
    // eligible, and the opponent's graveyard is never offered.
    expect([...offered].sort()).toEqual(mine.map((card) => card.id).sort());
    expect(offered).not.toContain(theirs.id);
    expect(state.pending?.options.map((option) => option.label)).toEqual(
      offered.map((id) => {
        const card = mine.find((c) => c.id === id);
        return registeredCatalog()[card?.defId ?? ""]?.name ?? "";
      }),
    );

    clearPrompt(state);
    run(ctxFor(state, self), [discoverFromGraveyard({ step: "chosen", count: 2, prompt: "Raise two" })]);
    expect(state.pending?.options).toHaveLength(2);
    expect(state.pending?.prompt).toBe("Raise two");
  });
});
