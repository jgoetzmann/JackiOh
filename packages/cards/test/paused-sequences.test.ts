// Sequences a prompt interrupts, and the state check around them (SPEC §2.4, §4.5, §9.3, §10.3,
// §10.6, R53, R59, R89, R113, R127, R156, R158, R174). Found by the polish-4 edge-case hunt, round 5
// (docs/polish/4-edge-cases.md, lens L7); every case here failed before its fix.
//
//  - R59: the check runs after a whole delayed effect or a whole cast-on-draw cast, never between its
//    parts, so a unit one of them brought to 0 before it asks is still there for the answer to save;
//    and once the answer has finished a delayed effect its check runs before the next one (R174).
//  - R127: a continuation whose card has ceased to exist still names its script when it asks again.
//  - §10.3, R113: a trap's list is resumable like any other, and the trap ends (consumed, checked)
//    only once its list has.
//  - R53, R113: a forced run waits for a Death hook's question before its next combat.
//  - R89: the step a Death hook's prompt re-enters reads the unit as it died.
//
// No Core card opens a prompt from a delayed effect, a cast on draw, a trap's list or a Death hook,
// so each case builds the prompting continuation out of engine verbs on a fixture card (a transient
// def, the way a fusion's is held) and uses real cards for everything else.

import { describe, expect, it } from "vitest";
import type { CardDef, CardType, PlayerId, Row } from "@jackioh/shared";
import {
  createRng,
  newInstance,
  placeOnField,
  registerScripts,
  registeredScripts,
  scheduleDelayed,
  subsystems,
  unitView,
  type CardInstance,
  type EngineSink,
  type Script,
} from "@jackioh/engine";
import { buff, chooseMode, chooseTarget, damage } from "@jackioh/engine/effects";
import { scenario, type Scenario } from "./_harness";

const TEMPO_TIMMY = "core-011";
const KPOP_FANATIC = "core-050";
const RENO = "core-053";
const MANA_WELL = "core-006";
const MOTHS_TO_THE_FLAME = "core-009";

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

function sinkFor(s: Scenario): EngineSink {
  return { state: s.state, events: [], rng: createRng(s.state.seed, s.state.rngCursor) };
}

/** A fixture card: a transient def in the match state and its script in the registry. */
function fixture(s: Scenario, id: string, type: CardType, script: Script, stats = { attack: 2, health: 2 }): void {
  const face = type === "Unit" ? { ...stats, keywords: [], text: id } : { keywords: [], text: id };
  const def: CardDef = {
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
  s.state.transientDefs[id] = def;
  registerScripts({ ...registeredScripts(), [id]: { base: script, radiant: script } });
}

function placeFixture(s: Scenario, defId: string, player: PlayerId, row: Row, lane: number): CardInstance {
  const card = newInstance(s.state, defId, player, { z: "hand", player });
  if (!placeOnField(s.state, card, { player, row, lane })) throw new Error(`could not place ${defId}`);
  return card;
}

/** A start-of-turn delayed effect of p1's that re-enters the fixture card's `armed` step. */
function delayArmed(s: Scenario, card: CardInstance): void {
  scheduleDelayed(sinkFor(s), "p1", { phase: "start", player: "p1" }, {
    defId: card.defId,
    hook: "resume",
    step: "armed",
    radiant: false,
    instanceId: card.id,
    data: {},
  });
}

const ANY_UNIT = { side: "any" as const, of: ["unit" as const] };

describe("R174, R59: a delayed effect that asks is still followed by the check before the next one", () => {
  it("R174 Kpop Fanatic's steal fizzles on a target the delayed effect before it killed once its prompt was answered (R59, R68)", () => {
    const s = scenario({
      p1: { hand: [KPOP_FANATIC, RENO], library: [RENO, RENO] },
      p2: { field: [TEMPO_TIMMY], hand: [RENO], library: [RENO, RENO] },
    });
    // D1: a start-of-turn delayed effect of p1's, created first, that asks for a unit and deals it 3.
    fixture(s, "edge-r5-pinger", "Field Spell", {
      resume: {
        armed: () => [chooseTarget({ step: "picked", scope: ANY_UNIT })],
        picked: () => [damage({ to: { of: "chosen" }, amount: 3 })],
      },
    });
    delayArmed(s, placeFixture(s, "edge-r5-pinger", "p1", "backrow", 5));

    // D2: #50's steal of the 3/3 Tempo Timmy, due at the same point and created after D1 (R68).
    const timmy = must(s.unit("p2", 1), "p2's Tempo Timmy");
    s.play(KPOP_FANATIC, { targets: [{ pick: "instance", instanceId: timmy.id }] });
    s.startTurn();
    expect(s.state.pending?.kind).toBe("target");

    // D1 deals Timmy its 3. §4.5 runs after that whole delayed effect, before D2 (R59), so Timmy
    // has died as p2's by the time the steal fires, and the steal fizzles (R76, R174).
    s.answer(timmy.id);

    expect(s.events.some((event) => event.type === "controlChanged" && event.instanceId === timmy.id)).toBe(false);
    s.expectInZone(timmy, "graveyard");
  });
});

describe("R59: no state check between the halves of one delayed effect or one cast", () => {
  it("R59 a unit a delayed effect brought to 0 before its prompt is still standing to be saved by the answer (R156)", () => {
    const s = scenario({
      p1: { hand: [RENO], library: [RENO, RENO] },
      p2: { field: [TEMPO_TIMMY], hand: [RENO] },
    });
    const timmy = must(s.unit("p2", 1), "p2's Tempo Timmy");
    // One delayed effect: deal the 3/3 Timmy 5, then ask for a unit and give it +10 health.
    fixture(s, "edge-r5-saver", "Field Spell", {
      resume: {
        armed: () => [
          damage({ to: { of: "instance", instanceId: timmy.id }, amount: 5 }),
          chooseTarget({ step: "save", scope: ANY_UNIT }),
        ],
        save: () => [buff({ target: { of: "chosen" }, health: 10 })],
      },
    });
    delayArmed(s, placeFixture(s, "edge-r5-saver", "p1", "backrow", 5));

    s.startTurn();
    const pending = must(s.state.pending, "the delayed effect's target prompt");
    expect(
      pending.options.some((option) => option.selection.pick === "instance" && option.selection.instanceId === timmy.id),
    ).toBe(true);
    // The question is part of the delayed effect, so §4.5 has not run yet: Timmy is where the
    // prompt offered it, on the field at -2 (R59: never between the parts of one effect).
    s.expectInZone(timmy, "field");

    s.answer(timmy.id);
    s.expectInZone(timmy, "field");
    expect(s.stats(timmy).health).toBe(8);
  });

  it("R59 a unit a cast-on-draw card brought to 0 before its prompt is still standing to be saved by the answer (§2.4, R158)", () => {
    const s = scenario({
      p1: { hand: [RENO], library: [RENO, RENO] },
      p2: { field: [TEMPO_TIMMY], hand: [RENO] },
    });
    const timmy = must(s.unit("p2", 1), "p2's Tempo Timmy");
    // A cast-on-draw Spell: deal the 3/3 Timmy 5, then ask for a unit and give it +10 health.
    fixture(s, "edge-r5-cod", "Spell", {
      staticFlags: { castOnDraw: true },
      cry: () => [
        damage({ to: { of: "instance", instanceId: timmy.id }, amount: 5 }),
        chooseTarget({ step: "save", scope: ANY_UNIT }),
      ],
      resume: { save: () => [buff({ target: { of: "chosen" }, health: 10 })] },
    });
    const cod = newInstance(s.state, "edge-r5-cod", "p1", { z: "library", player: "p1" });
    s.state.players.p1.library.unshift(cod);

    // The turn's draw casts it (§2.4), and the cast asks mid-Cry.
    s.startTurn();
    must(s.state.pending, "the cast's target prompt");
    // R59: the check follows the whole cast, so Timmy is still on the field while the cast asks.
    s.expectInZone(timmy, "field");

    s.answer(timmy.id);
    s.expectInZone(timmy, "field");
    expect(s.stats(timmy).health).toBe(8);
  });
});

describe("R127: a continuation with no instance keeps its script across its own prompt", () => {
  it("R127 a delayed effect whose card has ceased to exist still resolves the step its prompt asked for (R113)", () => {
    const s = scenario({
      p1: { hand: [RENO], backrow: [MANA_WELL], library: [RENO, RENO] },
      p2: { field: [TEMPO_TIMMY], hand: [RENO] },
    });
    fixture(s, "edge-r5-orphan", "Field Spell", {
      resume: {
        armed: () => [chooseTarget({ step: "picked", scope: ANY_UNIT })],
        picked: () => [damage({ to: { of: "chosen" }, amount: 3 })],
      },
    });
    const orphan = placeFixture(s, "edge-r5-orphan", "p1", "backrow", 5);
    delayArmed(s, orphan);
    // The card that scheduled it is fused away onto p1's Mana Well and ceases to exist (R86, R102),
    // as a Kpop Fanatic #85 fuses does; its delayed effect still fires, named by its def (R127).
    const well = must(s.backrow("p1", 1), "p1's Mana Well");
    must(subsystems.fuse(sinkFor(s), { ingredients: [orphan], target: well }), "the fusion");
    s.expectInZone(orphan.id, "gone");

    const timmy = must(s.unit("p2", 1), "p2's Tempo Timmy");
    s.startTurn();
    must(s.state.pending, "the orphaned delayed effect's target prompt");
    s.answer(timmy.id);

    // The answer re-enters the step the prompt named, so Timmy takes the 3 and dies.
    s.expectInZone(timmy, "graveyard");
  });
});

describe("§10.3, R113: a trap's list is resumable like any other", () => {
  it("R113 a trap whose list asks twice asks its second question after the first is answered, before the play goes on (§10.3)", () => {
    const s = scenario({
      p1: { hand: [RENO, RENO], mana: 4 },
      p2: { hand: [RENO] },
    });
    fixture(s, "edge-r5-asking-trap", "Trap", {
      triggers: [
        {
          id: "edge-r5-asks",
          on: ["cardPlayed"],
          when: (ctx) => ctx.event.type === "cardPlayed" && ctx.event.player !== ctx.controller,
          run: () => [
            chooseMode({ options: ["first"], step: "one", prompt: "trap: first question" }),
            chooseMode({ options: ["second"], step: "two", prompt: "trap: second question" }),
          ],
        },
      ],
      resume: { one: () => [], two: () => [] },
    });
    placeFixture(s, "edge-r5-asking-trap", "p2", "backrow", 1);

    s.play(RENO);
    expect(s.state.pending?.prompt).toBe("trap: first question");
    // §5.1, §10.3: the trap has not finished, so it is not consumed yet, and the play waits.
    expect(s.pile("p2", "graveyard")).toEqual([]);
    s.answer("first");
    // §10.3: the trap resolves to completion, prompts included, before the play continues; its
    // second question is never dropped (R113).
    expect(s.state.pending?.prompt).toBe("trap: second question");
    expect(s.pile("p2", "graveyard")).toEqual([]);
    s.answer("second");
    // Its list is done: the trap reaches the graveyard, and the play has gone on to its end.
    expect(s.pile("p2", "graveyard").map((card) => card.defId)).toEqual(["edge-r5-asking-trap"]);
    expect(s.state.pending).toBeNull();
    expect(s.unit("p1", 1)?.defId).toBe(RENO);
  });
});

describe("R53, R113: a forced run waits for a Death hook's question before its next combat", () => {
  it("R53 Moths to the Flame's next forced attack waits until the Death hook of the unit the last one killed has been answered (R59, R113)", () => {
    const s = scenario({
      active: "p2",
      p1: { field: [{ def: TEMPO_TIMMY, lane: 2 }], hand: [RENO] },
      p2: { field: [MOTHS_TO_THE_FLAME], hand: [RENO], library: [RENO, RENO] },
    });
    // A 1/1 in p1's lane 1 whose Death asks p1 for a unit.
    fixture(
      s,
      "edge-r5-last-word",
      "Unit",
      {
        death: () => [chooseTarget({ step: "said", scope: ANY_UNIT })],
        resume: { said: () => [] },
      },
      { attack: 1, health: 1 },
    );
    const lastWord = placeFixture(s, "edge-r5-last-word", "p1", "units", 1);
    const timmy = must(s.unit("p1", 2), "p1's Tempo Timmy");
    const moths = must(s.unit("p2", 1), "p2's Moths to the Flame");

    // p2's start of turn: every p1 unit attacks Moths, lane 1 first (R53). Moths strikes the 1/1
    // back and it dies in that combat's check, whose Death hook asks p1 something.
    s.startTurn();
    s.expectInZone(lastWord, "graveyard");
    expect(must(s.state.pending, "the Death hook's question").playerId).toBe("p1");
    // §4.5 step 3 is part of the first combat's check (R59), and the run is a sequence spanning the
    // question (R113): Timmy's combat comes after the answer, not over the open prompt.
    expect(s.card(moths).damage).toBe(1);
    expect(s.card(timmy).damage).toBe(0);

    s.answer(timmy.id);
    expect(s.card(moths).damage).toBe(4);
    expect(s.card(timmy).damage).toBe(1);
  });
});

describe("R89: a Death hook's answered step reads the unit as it died", () => {
  it("R89 the step a Death hook's prompt re-enters reads the snapshot, not the instance R78 has reset (§4.5 step 3, R156)", () => {
    const s = scenario({
      p1: { field: [TEMPO_TIMMY], hand: [RENO] },
      p2: { hand: [RENO] },
    });
    // A 2/2 whose Death asks for an enemy target and deals it 1 plus the attack buffs it died with.
    fixture(
      s,
      "edge-r5-grudge",
      "Unit",
      {
        death: () => [chooseTarget({ step: "revenge", scope: { side: "enemy", of: ["unit", "hero"] } })],
        resume: {
          revenge: (ctx) => [damage({ to: { of: "chosen" }, amount: 1 + (ctx.self?.buffs.attack ?? 0) })],
        },
      },
      { attack: 2, health: 2 },
    );
    const grudge = placeFixture(s, "edge-r5-grudge", "p2", "units", 1);
    grudge.buffs.attack += 3;
    expect(unitView(s.state, grudge).attack).toBe(5);

    // First Strike: Timmy kills it without being struck back.
    s.attack(TEMPO_TIMMY, grudge);
    const pending = must(s.state.pending, "the Death hook's prompt");
    expect(pending.playerId).toBe("p2");
    s.answer("hero:p1");

    // R89: the hook reads the snapshot taken as the unit died, +3 attack included: 1 + 3 = 4.
    s.expectHealth("p1", 26);
  });
});
