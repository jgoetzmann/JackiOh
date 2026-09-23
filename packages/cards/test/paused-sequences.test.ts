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
// Round 6 (lens L7 again) added the rest of this file's cases: the traps a play's event is still
// owed behind a trap that asked answer before the play goes on (R17, R118); a power whose draw's
// cast asks runs no check (R59); My Pawn's AI turn goes on after the other player's answer (R44); a
// cast asks for its declared choices (R70, R81); Call to Chaos's partner waits for its recursion
// (R87); a trap owed an event, and a list's tail, meet the board the pause left (R174); a Death pass
// a nested death paused still owes the rest (R156); a delayed effect made while its point resolves
// waits for the next (R68); and step 3's hooks resume by the holders the step began with.
//
// No Core card opens a prompt from a delayed effect, a cast on draw, a trap's list or a Death hook,
// so each case builds the prompting continuation out of engine verbs on a fixture card (a transient
// def, the way a fusion's is held) and uses real cards for everything else.

import { describe, expect, it } from "vitest";
import type { CardDef, CardType, PlayerId, Row, TargetDecl } from "@jackioh/shared";
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
import {
  bounce,
  buff,
  chooseMode,
  chooseTarget,
  damage,
  delay,
  destroy,
  sacrifice,
} from "@jackioh/engine/effects";
import { scenario, type Scenario } from "./_harness";

const TEMPO_TIMMY = "core-011";
const KPOP_FANATIC = "core-050";
const RENO = "core-053";
const MANA_WELL = "core-006";
const MOTHS_TO_THE_FLAME = "core-009";
const ME_AND_MR_TOKEN = "core-015";
const SHEEPISH = "core-041";
const SHEEP_TOKEN = "core-t-sheep";
const RUSH_TOKEN = "core-t-rush";
const MY_PAWN = "core-096";
const HEROIC_POWER = "core-098";
const CALL_TO_CHAOS = "core-095";
const RIGHT_HOUSE_DEFENDER = "core-003";
const UNLICENSED_EXPERIMENTATION = "core-085";
const RADIANT_SAINTESS = "core-081";
const HIT_JOB = "core-016";

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

/** A face-down trap that asks its controller one question whenever the opponent plays a card. */
function askingTrapOnPlay(s: Scenario, id: string): void {
  fixture(s, id, "Trap", {
    triggers: [
      {
        id: `${id}:asks`,
        on: ["cardPlayed"],
        when: (ctx) => ctx.event.type === "cardPlayed" && ctx.event.player !== ctx.controller,
        run: () => [chooseMode({ options: ["ok"], step: "answered", prompt: `${id}: a question` })],
      },
    ],
    resume: { answered: () => [] },
  });
}

describe("R17, R118: the traps an event is still owed answer it before the interrupted play goes on", () => {
  it("R17 Sheepish, owed the play's cardPlayed behind a trap that asked, still fires before the Cry (R118, §10.3)", () => {
    const s = scenario({
      p1: { hand: [ME_AND_MR_TOKEN, RENO], mana: 4 },
      p2: { backrow: [{ def: SHEEPISH, lane: 2 }], hand: [RENO] },
    });
    askingTrapOnPlay(s, "edge-r6-l7-asks-on-play");
    placeFixture(s, "edge-r6-l7-asks-on-play", "p2", "backrow", 1);

    s.play(ME_AND_MR_TOKEN);
    expect(must(s.state.pending, "the first trap's question").playerId).toBe("p2");
    s.answer("ok");

    // §10.3: both traps answer the play's `cardPlayed` before the play goes on, and R17 puts
    // Sheepish before the Cry: Me and Mr Token is a Sheep before its Cry can summon anything.
    expect(s.state.pending).toBeNull();
    expect(s.unit("p1", 1)?.defId).toBe(SHEEP_TOKEN);
    const rushTokens = [1, 2, 3, 4, 5].filter((lane) => s.unit("p1", lane)?.defId === RUSH_TOKEN);
    expect(rushTokens, "the Cry of a unit Sheepish transformed first is lost (R17)").toEqual([]);
  });
});

describe("R59: activating a power whose draw's cast is still asking runs no state check", () => {
  it("R59 a unit the power's draw's cast brought to 0 before it asked is still there to be saved (R156, §2.4)", () => {
    const s = scenario({
      p1: { backrow: [HEROIC_POWER], hand: [RENO], library: [RENO, RENO] },
      p2: { field: [TEMPO_TIMMY], hand: [RENO] },
    });
    const power = must(s.backrow("p1", 1), "p1's Heroic Power");
    // R43: the power lives on the instance; this one is "lose 2 health, draw 1".
    s.card(power).memory.power = "draw";
    const timmy = must(s.unit("p2", 1), "p2's Tempo Timmy");
    // A cast-on-draw Spell: deal the 3/3 Timmy 5, then ask for a unit and give it +10 health.
    fixture(s, "edge-r6-l7-power-cod", "Spell", {
      staticFlags: { castOnDraw: true },
      cry: () => [
        damage({ to: { of: "instance", instanceId: timmy.id }, amount: 5 }),
        chooseTarget({ step: "save", scope: ANY_UNIT }),
      ],
      resume: { save: () => [buff({ target: { of: "chosen" }, health: 10 })] },
    });
    const cod = newInstance(s.state, "edge-r6-l7-power-cod", "p1", { z: "library", player: "p1" });
    s.state.players.p1.library.unshift(cod);

    s.activate(power);
    must(s.state.pending, "the cast's target prompt");
    // R59: the check follows the whole power, and its draw's cast is still asking, so Timmy is still
    // on the field at -2 where the prompt offered it.
    s.expectInZone(timmy, "field");

    s.answer(timmy.id);
    s.expectInZone(timmy, "field");
    expect(s.stats(timmy).health).toBe(8);
  });
});

describe("R44, R113: My Pawn's AI turn is a sequence, and the other player's prompt only pauses it", () => {
  it("R44 the AI still plays out the rest of the turn once the opponent has answered the trap its play set off (R152, R113)", () => {
    const s = scenario({
      p1: { field: [TEMPO_TIMMY], hand: [RENO, TEMPO_TIMMY], mana: 4 },
      p2: { health: 3, backrow: [{ def: MY_PAWN, lane: 1 }], hand: [RENO] },
    });
    askingTrapOnPlay(s, "edge-r6-l7-asks-ai");
    placeFixture(s, "edge-r6-l7-asks-ai", "p2", "backrow", 2);
    const turn = s.state.turn;

    // Timmy's 3 would be lethal: My Pawn cancels it and hands p1's turn to the AI (R44), whose play
    // sets off p2's trap, which asks p2.
    s.attack(must(s.unit("p1", 1), "p1's Tempo Timmy"), "hero");
    expect(s.state.players.p1.aiTurn).toBe(true);
    const pending = must(s.state.pending, "p2's trap question during the AI turn");
    expect(pending.playerId).toBe("p2");

    s.answer("ok");
    // R44: the AI plays out the rest of the turn while p1 is locked out, so once p2 has answered it
    // goes on until the turn ends; the turn is not left to a player the lockout keeps out of it.
    expect(s.state.pending).toBeNull();
    expect(s.state.turn, "the AI turn should have played on to its end").toBeGreaterThan(turn);
    expect(s.state.players.p1.aiTurn).toBe(false);
  });
});

describe("R70, R81: a cast asks for the choices its card declares", () => {
  it("R70 a cast-on-draw Spell that declares a target asks the caster for it (R81)", () => {
    const s = scenario({
      p1: { hand: [RENO], library: [RENO, RENO] },
      p2: { field: [TEMPO_TIMMY], hand: [RENO] },
    });
    const timmy = must(s.unit("p2", 1), "p2's Tempo Timmy");
    const declared: TargetDecl[] = [{ kind: "target", min: 1, max: 1, filter: { side: "enemy", of: ["unit"] } }];
    fixture(s, "edge-r6-l7-targeted-cod", "Spell", {
      staticFlags: { castOnDraw: true },
      targets: declared,
      cry: () => [damage({ to: { of: "chosen" }, amount: 5 })],
    });
    const cod = newInstance(s.state, "edge-r6-l7-targeted-cod", "p1", { z: "library", player: "p1" });
    s.state.players.p1.library.unshift(cod);

    s.startTurn();
    // R81: a choice made during resolution — a cast's among them — is a prompt, and R70 gives it to
    // the caster. The play action that would have carried it never happened.
    const pending = must(s.state.pending, "the cast's target prompt");
    expect(pending.playerId).toBe("p1");
    s.answer(timmy.id);
    s.expectInZone(timmy, "graveyard");
  });
});

describe("R87, R113: Call to Chaos's recursion finishes before its partner resolves", () => {
  it("R87 radiant Call to Chaos's partner effect waits for the cast its recursion is still asking about (R113)", () => {
    const s = scenario({
      p1: {
        hand: [{ def: CALL_TO_CHAOS, radiant: true }, RENO, RENO],
        library: [RENO, RENO, RENO],
        health: 20,
        mana: 4,
      },
      p2: { hand: [RENO] },
    });
    // An onPlayHook that asks p1 something at §10.5 step 3 of every play, a cast's included (R70).
    fixture(s, "edge-r6-l7-asks-on-every-play", "Field Spell", {
      onPlayHook: () => [chooseMode({ options: ["ok"], step: "answered", prompt: "on-play question" })],
      resume: { answered: () => [] },
    });
    placeFixture(s, "edge-r6-l7-asks-on-every-play", "p1", "backrow", 1);

    s.play(CALL_TO_CHAOS);
    // The play's own step 3 asks first.
    must(s.state.pending, "the hook's question for the play of Call to Chaos");
    s.answer("ok");
    // The Cry rolls "cast a random Call to Chaos" plus a partner (R28). The cast's step 3 asks.
    must(s.state.pending, "the hook's question for the cast Call to Chaos");
    const events = s.lastEvents;
    const opened = events.map((event) => event.type).lastIndexOf("promptOpened");
    const after = events.slice(opened + 1).map((event) => event.type);
    // R87: the recursion resolves first and its whole chain is done before the partner reads the
    // board; a cast that is asking has not resolved, so nothing may have happened after the prompt.
    expect(after, `events after the cast's prompt opened: ${after.join(", ")}`).toEqual([]);
  });
});

describe("R174: a trap owed an event behind another trap's question meets the event as the board now stands", () => {
  it("R174 Unlicensed Experimentation owed a play's cardResolved fuses nothing out of a graveyard once the trap before it has killed the card (R61)", () => {
    const s = scenario({
      p1: { hand: [TEMPO_TIMMY, RENO], mana: 4 },
      p2: { field: [RENO], backrow: [{ def: UNLICENSED_EXPERIMENTATION, lane: 2 }], hand: [RENO] },
    });
    // Lane 1, ahead of #85 in R68's order: asks about the opponent's resolved permanent, then
    // destroys it.
    fixture(s, "edge-r6-l7-asks-then-kills", "Trap", {
      triggers: [
        {
          id: "edge-r6-l7-asks-then-kills:asks",
          on: ["cardResolved"],
          when: (ctx) => ctx.event.type === "cardResolved" && ctx.event.player !== ctx.controller && ctx.event.permanent,
          run: (ctx) => [
            chooseMode({
              options: ["ok"],
              step: "answered",
              prompt: "a question",
              data: { played: ctx.event.type === "cardResolved" ? ctx.event.instanceId : "" },
            }),
          ],
        },
      ],
      resume: {
        answered: (ctx) => [destroy({ target: { of: "instance", instanceId: String(ctx.data.played) } })],
      },
    });
    placeFixture(s, "edge-r6-l7-asks-then-kills", "p2", "backrow", 1);
    const reno = must(s.unit("p2", 1), "p2's Reno");

    s.play(TEMPO_TIMMY);
    must(s.state.pending, "the first trap's question");
    s.answer("ok");

    // The played Timmy died before #85 was offered the event, so the play is no longer in play:
    // #85 is not set off (R61, R99), and Timmy stays in p1's graveyard rather than being fused away.
    const timmy = must(s.pile("p1", "graveyard").find((card) => card.defId === TEMPO_TIMMY), "Timmy in p1's graveyard");
    s.expectInZone(timmy, "graveyard");
    expect(s.card(reno).defId).toBe(RENO);
    expect(s.backrow("p2", 2)?.defId).toBe(UNLICENSED_EXPERIMENTATION);
  });
});

describe("R174, R113: a list's tail after a prompt still meets the stay the play chose", () => {
  it("R174 a unit the list sacrificed before its prompt is gone for the damage after it, even back through Reborn (R83, R113)", () => {
    const s = scenario({
      p1: { field: [RADIANT_SAINTESS], hand: [RENO], mana: 4 },
      p2: { hand: [RENO] },
    });
    const saintess = must(s.unit("p1", 1), "p1's Radiant Saintess");
    // A 0-cost Spell: sacrifice your chosen unit, ask something, then deal the chosen unit 5.
    fixture(s, "edge-r6-l7-sac-ask-hit", "Spell", {
      targets: [{ kind: "target", min: 1, max: 1, filter: { side: "ally", of: ["unit"] } }],
      cry: () => [
        sacrifice({ target: { of: "chosen" } }),
        chooseMode({ options: ["ok"], step: "answered", prompt: "a question" }),
        damage({ to: { of: "chosen" }, amount: 5 }),
      ],
      resume: { answered: () => [] },
    });
    const spell = newInstance(s.state, "edge-r6-l7-sac-ask-hit", "p1", { z: "hand", player: "p1" });
    s.state.players.p1.hand.push(spell);

    s.play(spell, { targets: [{ pick: "instance", instanceId: saintess.id }] });
    must(s.state.pending, "the Spell's question");
    // The sacrifice is a death in full: Reborn has already brought the Saintess back, a new arrival.
    expect(s.card(saintess).rebornSpent).toBe(true);
    s.answer("ok");

    // R174: the damage was aimed at the stay the play chose, which the sacrifice ended; the list is
    // one effect list whether or not a prompt split it (R113), so the damage fizzles as it does with
    // no question between (a fused Cube+Sorcerer, re-entry.test.ts). The body stands at 1 health.
    s.expectInZone(saintess, "field");
    s.expectStats(saintess, { health: 1 });
  });
});

describe("R156, R113: a Death pass whose hook ends in a nested death that asks still owes the rest of the pass", () => {
  it("R156 the Reborn unit collected with a unit whose Death sacrificed an asking unit still comes back once the question is answered (R64, §4.5)", () => {
    const s = scenario({
      p1: { hand: [{ def: HIT_JOB, radiant: true }, RENO], field: [{ def: RIGHT_HOUSE_DEFENDER, lane: 2 }], mana: 4 },
      p2: { hand: [RENO] },
    });
    // Lane 5: a 2/2 whose Death asks its controller something.
    fixture(
      s,
      "edge-r6-l7-asking-death",
      "Unit",
      { death: () => [chooseMode({ options: ["ok"], step: "answered", prompt: "a last word" })], resume: { answered: () => [] } },
      { attack: 2, health: 2 },
    );
    const asker = placeFixture(s, "edge-r6-l7-asking-death", "p1", "units", 5);
    // Lane 1: a 2/2 whose Death sacrifices the asker, as its last effect.
    fixture(
      s,
      "edge-r6-l7-sacrificing-death",
      "Unit",
      { death: () => [sacrifice({ target: { of: "instance", instanceId: asker.id } })] },
      { attack: 2, health: 2 },
    );
    const sacrificer = placeFixture(s, "edge-r6-l7-sacrificing-death", "p1", "units", 1);
    const defender = must(s.unit("p1", 2), "p1's Right-house defender");

    // Radiant Hit Job on the defender destroys it and the unit beside it in lane 1 (lane 3 is empty).
    s.play(HIT_JOB, { targets: [{ pick: "instance", instanceId: defender.id }] });
    s.expectInZone(sacrificer, "graveyard");
    s.expectInZone(asker, "graveyard");
    must(s.state.pending, "the sacrificed unit's Death question");
    // R156: while the question stands the Reborn unit waits in the graveyard, its zone reserved.
    s.expectInZone(defender, "graveyard");

    s.answer("ok");
    // §4.5 step 4 is still owed once the last Death hook has run: the defender comes back.
    s.expectInZone(defender, "field");
    expect(s.card(defender).rebornSpent).toBe(true);
  });
});

describe("R68, R62: a delayed effect made while its point is resolving waits for the next one", () => {
  it("R68 a start-of-turn delayed effect scheduled by the answer to an earlier one's question fires at the next start of turn, not this one (R113)", () => {
    const s = scenario({
      p1: { hand: [RENO], library: [RENO, RENO] },
      p2: { hand: [RENO] },
    });
    // A p1 Field Spell whose start-of-turn delayed effect asks, and whose answer schedules "at the
    // start of your next turn: deal 5 damage to the enemy hero".
    fixture(s, "edge-r6-l7-reschedules", "Field Spell", {
      resume: {
        armed: () => [chooseMode({ options: ["ok"], step: "answered", prompt: "a question" })],
        answered: () => [delay({ at: { phase: "start", player: "self" }, step: "later", hook: "resume" })],
        later: () => [damage({ to: { of: "enemyHero" }, amount: 5 })],
      },
    });
    const card = placeFixture(s, "edge-r6-l7-reschedules", "p1", "backrow", 5);
    scheduleDelayed(sinkFor(s), "p1", { phase: "start", player: "p1" }, {
      defId: card.defId,
      hook: "resume",
      step: "armed",
      radiant: false,
      instanceId: card.id,
      data: {},
    });

    s.startTurn();
    must(s.state.pending, "the delayed effect's question");
    s.answer("ok");

    // The new delayed effect was made at this start of turn, so it is due at p1's next one (R62: the
    // stage resolves the effects due as it begins, in creation order, R68), as it would be had the
    // first one not asked anything.
    s.expectHealth("p2", 30);
    expect(s.state.delayed.filter((effect) => effect.at.phase === "start" && effect.at.player === "p1")).toHaveLength(1);
  });
});

describe("§10.5 step 3, R113: step 3's hooks resume where they stopped, whatever the answer did to the board", () => {
  it("§10.5 step 3 the second onPlayHook still runs for the play when the first one's answer took its own card off the field (R113, R153)", () => {
    const s = scenario({
      p1: { hand: [TEMPO_TIMMY, RENO], mana: 4 },
      p2: { hand: [RENO] },
    });
    // Lane 1: asks at every play of its controller's, and the answer returns it to its owner's hand.
    fixture(s, "edge-r6-l7-hook-leaves", "Field Spell", {
      onPlayHook: () => [chooseMode({ options: ["ok"], step: "answered", prompt: "a question" })],
      resume: { answered: () => [bounce({ target: { of: "self" } })] },
    });
    placeFixture(s, "edge-r6-l7-hook-leaves", "p1", "backrow", 1);
    // Lane 2: deals the enemy hero 1 at every play.
    fixture(s, "edge-r6-l7-hook-pings", "Field Spell", {
      onPlayHook: () => [damage({ to: { of: "enemyHero" }, amount: 1 })],
    });
    placeFixture(s, "edge-r6-l7-hook-pings", "p1", "backrow", 2);

    s.play(TEMPO_TIMMY);
    must(s.state.pending, "the first hook's question");
    s.answer("ok");

    // Both hooks were on the field when the play reached step 3, in R68's order: the first one
    // leaving on its own answer does not drop the second (R113: a sequence is never dropped).
    s.expectHealth("p2", 29);
  });
});
