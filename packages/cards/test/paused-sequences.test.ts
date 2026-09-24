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
// Round 7 (lens L7) added the cases at the end: a queued trigger's tail after a prompt runs the face
// its head ran (§5.2, R113); step 3's hooks, the played card's Cry and the traps owed its
// `cardPlayed` follow the stays they began with, not a Reborn body or a card in a hand (R174, R118);
// the answer to a cast's own choice finishes the draw chain before the traps answer the cast (R122);
// and a list a prompt split still reads what its head summoned (R136) and the stays it began with,
// in the step the answer re-enters as much as in its tail (R174).
//
// Round 8 (lens L7) added the last cases: an Echo repeat's fresh pick is aimed at the stay it was
// made on (R174); a trap that declined an event is not offered it again, and the traps a question
// kept waiting meet it in the order the dispatch had (R99, R113); a card named by id after the
// list's own sacrifice is gone, while one picked at a prompt after it is picked on the stay offered
// (R174, §10.6); a played card a Tribute's question discarded is not placed too (R226); and the
// check follows a trigger that asked at step 4 before the Cry (R59, R118).
//
// No Core card opens a prompt from a delayed effect, a cast on draw, a trap's list or a Death hook,
// so each case builds the prompting continuation out of engine verbs on a fixture card (a transient
// def, the way a fusion's is held) and uses real cards for everything else.

import { describe, expect, it } from "vitest";
import type { CardDef, CardType, Keyword, PlayerId, Row, TargetDecl } from "@jackioh/shared";
import {
  activeUnitsOf,
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
  type GameState,
  type Script,
} from "@jackioh/engine";
import {
  bounce,
  buff,
  chooseFromHand,
  chooseMode,
  chooseTarget,
  damage,
  damageAll,
  delay,
  destroy,
  discard,
  forcedAttacks,
  rotate,
  sacrifice,
  setRadiant,
  steal,
  summon,
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

// ---------------------------------------------------------------------------
// Round 7 (lens L7): the stays and faces a paused or queued list carries, the plays a trap answering
// at step 4 has taken off the field, and the order an answer to a cast's own choice finishes in.
// ---------------------------------------------------------------------------

/** A fixture def with its own base and radiant scripts and a face of its own, held like a fusion's. */
function fixtureFaces(
  state: GameState,
  id: string,
  type: CardType,
  scripts: { base: Script; radiant: Script },
  options: { stats?: { attack: number; health: number }; keywords?: Keyword[] } = {},
): void {
  const stats = options.stats ?? { attack: 2, health: 2 };
  const keywords = options.keywords ?? [];
  const face = type === "Unit" ? { ...stats, keywords, text: id } : { keywords, text: id };
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
  state.transientDefs[id] = def;
  registerScripts({ ...registeredScripts(), [id]: scripts });
}

describe("§5.2, R113: a queued trigger's parked tail runs the face its head ran", () => {
  it("R113 a trigger whose card turned Radiant while it waited in the queue finishes on the radiant text after its prompt (§5.2)", () => {
    const s = scenario({
      p1: { hand: [RENO], mana: 4 },
      p2: { hand: [RENO] },
    });
    // Lane 2: on any play, deal the enemy hero 1 (radiant 2), ask something, then deal it 10
    // (radiant 20). The same trigger id on both faces, as a card's radiant face keeps its triggers.
    const asking = (first: number, second: number): Script => ({
      triggers: [
        {
          id: "edge-r7-l7-face",
          on: ["cardPlayed"],
          run: () => [
            damage({ to: { of: "enemyHero" }, amount: first }),
            chooseMode({ options: ["ok"], step: "ok", prompt: "a question" }),
            damage({ to: { of: "enemyHero" }, amount: second }),
          ],
        },
      ],
      resume: { ok: () => [] },
    });
    fixtureFaces(s.state, "edge-r7-l7-face", "Unit", { base: asking(1, 10), radiant: asking(2, 20) });
    const faced = placeFixture(s, "edge-r7-l7-face", "p1", "units", 2);

    // Lane 1, ahead of it in R68's order: on any play, make the lane-2 unit Radiant.
    const radiates: Script = {
      triggers: [
        { id: "edge-r7-l7-radiates", on: ["cardPlayed"], run: () => [setRadiant({ instanceId: faced.id })] },
      ],
    };
    fixtureFaces(s.state, "edge-r7-l7-radiates", "Unit", { base: radiates, radiant: radiates });
    placeFixture(s, "edge-r7-l7-radiates", "p1", "units", 1);

    // Both triggers are queued on Reno's `cardPlayed` while the lane-2 unit is still base. The first
    // makes it Radiant, so by the time its own trigger resolves it runs the radiant text (§5.2:
    // "ongoing triggers use the radiant text from then on"; `runQueuedTrigger` reads the card again).
    s.play(RENO, { zone: 3 });
    expect(s.card(faced).radiant).toBe(true);
    must(s.state.pending, "the lane-2 trigger's question");
    // Its first damage came from the radiant text.
    s.expectHealth("p2", 28);

    s.answer("ok");
    // One trigger, one face: the rest of its list after the prompt is the radiant text's 20, not the
    // base text's 10 (R113: the paused list continues, it is not a different list).
    s.expectHealth("p2", 8);
  });
});

describe("R174, §10.5 step 3: step 3's hooks are the stays the step began with", () => {
  it("R174 a Reborn body is not run as an onPlayHook holder of the play whose earlier hook's answer killed it (§10.5 step 3, R83)", () => {
    const s = scenario({
      p1: { hand: [RENO], mana: 4 },
      p2: { hand: [RENO] },
    });
    // Lane 2: a Reborn unit whose onPlayHook deals the enemy hero 5.
    const pings: Script = { onPlayHook: () => [damage({ to: { of: "enemyHero" }, amount: 5 })] };
    fixtureFaces(s.state, "edge-r7-l7-pinger", "Unit", { base: pings, radiant: pings }, { keywords: [{ kind: "Reborn" }] });
    const pinger = placeFixture(s, "edge-r7-l7-pinger", "p1", "units", 2);

    // Lane 1, ahead of it in R68's order: its onPlayHook asks, and the answer sacrifices the pinger.
    const asks: Script = {
      onPlayHook: () => [chooseMode({ options: ["ok"], step: "ok", prompt: "a question" })],
      resume: { ok: () => [sacrifice({ target: { of: "instance", instanceId: pinger.id } })] },
    };
    fixtureFaces(s.state, "edge-r7-l7-asker", "Unit", { base: asks, radiant: asks });
    placeFixture(s, "edge-r7-l7-asker", "p1", "units", 1);

    s.play(RENO, { zone: 3 });
    must(s.state.pending, "the lane-1 hook's question");
    s.answer("ok");

    // The sacrifice is a death in full, and Reborn has put a new body in lane 2 (§4.5 step 4).
    expect(s.card(pinger).rebornSpent).toBe(true);
    s.expectInZone(pinger, "field");
    // R174: the stay step 3 began with has ended, and the body is a new arrival that was not a holder
    // when the play reached step 3 (as a start-of-turn hook queued before a death does not fire for
    // the Reborn body, R174), so it deals nothing for this play.
    s.expectHealth("p2", 30);
  });
});

describe("R1, R118, R174: a played unit a trap killed at step 4 does not Cry with its Reborn body", () => {
  it("R118 a trap that asks and then destroys the played Reborn unit leaves the play no Cry to resolve (R1, R174, §10.5 step 5)", () => {
    const s = scenario({
      p1: { hand: [RENO], mana: 4 },
      p2: { hand: [RENO] },
    });
    // p1's 0-cost Reborn unit whose Cry deals the enemy hero 5.
    const cries: Script = { cry: () => [damage({ to: { of: "enemyHero" }, amount: 5 })] };
    fixtureFaces(s.state, "edge-r7-l7-crier", "Unit", { base: cries, radiant: cries }, { keywords: [{ kind: "Reborn" }] });
    const crier = newInstance(s.state, "edge-r7-l7-crier", "p1", { z: "hand", player: "p1" });
    s.state.players.p1.hand.push(crier);

    // p2's trap: when the opponent plays a card, ask p2 something, then destroy the played card.
    const trap: Script = {
      triggers: [
        {
          id: "edge-r7-l7-kill-on-play",
          on: ["cardPlayed"],
          when: (ctx) => ctx.event.type === "cardPlayed" && ctx.event.player !== ctx.controller,
          run: (ctx) => [
            chooseMode({
              options: ["ok"],
              step: "ok",
              prompt: "a question",
              data: { played: ctx.event.type === "cardPlayed" ? ctx.event.instanceId : "" },
            }),
          ],
        },
      ],
      resume: { ok: (ctx) => [destroy({ target: { of: "instance", instanceId: String(ctx.data.played) } })] },
    };
    fixtureFaces(s.state, "edge-r7-l7-kill-on-play", "Trap", { base: trap, radiant: trap });
    placeFixture(s, "edge-r7-l7-kill-on-play", "p2", "backrow", 1);

    s.play(crier, { zone: 1 });
    expect(must(s.state.pending, "the trap's question").playerId).toBe("p2");
    s.answer("ok");

    // The trap resolved to completion before the play went on (§10.3): the unit died and Reborn put a
    // new body in its zone (§4.5 step 4).
    expect(s.card(crier).rebornSpent).toBe(true);
    s.expectInZone(crier, "field");
    // R118: the Cry is lost where the trap has taken the card off the field. The body is a new
    // arrival (R174, R83), and R1: Reborn never fires a Cry.
    s.expectHealth("p2", 30);
  });
});

/** p2's trap that asks p2 when the opponent plays a card, and then applies `after` to the played card. */
function askThenOnPlayed(s: Scenario, id: string, after: (playedId: string) => ReturnType<typeof destroy>): void {
  const trap: Script = {
    triggers: [
      {
        id,
        on: ["cardPlayed"],
        when: (ctx) => ctx.event.type === "cardPlayed" && ctx.event.player !== ctx.controller,
        run: (ctx) => [
          chooseMode({
            options: ["ok"],
            step: "ok",
            prompt: "a question",
            data: { played: ctx.event.type === "cardPlayed" ? ctx.event.instanceId : "" },
          }),
        ],
      },
    ],
    resume: { ok: (ctx) => [after(String(ctx.data.played))] },
  };
  fixtureFaces(s.state, id, "Trap", { base: trap, radiant: trap });
  placeFixture(s, id, "p2", "backrow", 1);
}


describe("R174, R17: Sheepish owed the play behind a trap that took the unit off the field transforms nothing", () => {
  it("R174 a unit the first trap's answer bounced to its owner's hand is not turned into a Sheep Token card there (R17, §8 #41)", () => {
    const s = scenario({
      p1: { hand: [TEMPO_TIMMY, RENO], mana: 4 },
      p2: { backrow: [{ def: SHEEPISH, lane: 2 }], hand: [RENO] },
    });
    askThenOnPlayed(s, "edge-r7-l7-bounce-on-play", (playedId) =>
      bounce({ target: { of: "instance", instanceId: playedId } }),
    );
    const timmy = s.card(TEMPO_TIMMY);

    s.play(TEMPO_TIMMY, { zone: 1 });
    expect(must(s.state.pending, "the first trap's question").playerId).toBe("p2");
    s.answer("ok");

    // The first trap resolved to completion (§10.3): Timmy is back in p1's hand.
    expect(s.state.pending).toBeNull();
    // R174: a trap answering a play meets it as no longer in play once an earlier trap answering the
    // same play has taken the card off the field. Sheepish transforms the unit the opponent played
    // (§8 #41), on the field; it never reaches into a hand to rewrite a card there.
    expect(s.hand("p1").some((card) => card.defId === SHEEP_TOKEN), "a Sheep Token card in p1's hand").toBe(false);
    s.expectInZone(timmy, "hand");
  });

  it("R174 a unit the first trap's answer killed and Reborn brought back is not transformed as the unit that was played (R17, R83)", () => {
    const s = scenario({
      p1: { hand: [RENO], mana: 4 },
      p2: { backrow: [{ def: SHEEPISH, lane: 2 }], hand: [RENO] },
    });
    const plain: Script = {};
    fixtureFaces(s.state, "edge-r7-l7-reborn-unit", "Unit", { base: plain, radiant: plain }, { keywords: [{ kind: "Reborn" }] });
    const unit = newInstance(s.state, "edge-r7-l7-reborn-unit", "p1", { z: "hand", player: "p1" });
    s.state.players.p1.hand.push(unit);
    askThenOnPlayed(s, "edge-r7-l7-destroy-on-play", (playedId) =>
      destroy({ target: { of: "instance", instanceId: playedId } }),
    );

    s.play(unit, { zone: 1 });
    must(s.state.pending, "the first trap's question");
    s.answer("ok");

    // The unit died and its Reborn body stands in lane 1: a new arrival nobody played (R83).
    expect(s.events.some((event) => event.type === "destroyed" && event.instanceId === unit.id)).toBe(true);
    // R174: the play Sheepish answers is no longer in play, so the body is not transformed.
    const lane1 = s.unit("p1", 1);
    expect(lane1?.defId, "lane 1 should hold the Reborn body, not a Sheep Token").toBe("edge-r7-l7-reborn-unit");
    expect(lane1?.id).toBe(unit.id);
    expect(lane1?.rebornSpent).toBe(true);
  });
});

const BEAR_HONEYPOT = "core-060";

describe("R122, §2.4: the answer to a cast's own choice finishes the draw chain before the traps answer the cast", () => {
  it("R122 the cast-on-draw card under a cast that asked for its target is cast before Bear Honeypot answers the first cast (R113, R70, §2.4)", () => {
    const s = scenario({
      p1: { hand: [RENO], library: [RENO, RENO] },
      p2: { backrow: [BEAR_HONEYPOT], hand: [RENO] },
    });
    // Top card: a cast-on-draw Spell that declares a target, so its cast asks for it (R70, R81).
    const targeted: Script = {
      staticFlags: { castOnDraw: true },
      targets: [{ kind: "target", min: 1, max: 1, filter: { side: "enemy", of: ["unit", "hero"] } }],
      cry: () => [damage({ to: { of: "chosen" }, amount: 1 })],
    };
    fixtureFaces(s.state, "edge-r7-l7-cod-targeted", "Spell", { base: targeted, radiant: targeted });
    // Under it: a cast-on-draw Spell that deals 1 damage to each enemy unit.
    const sweep: Script = {
      staticFlags: { castOnDraw: true },
      cry: () => [damageAll({ amount: 1, side: "enemy" })],
    };
    fixtureFaces(s.state, "edge-r7-l7-cod-sweep", "Spell", { base: sweep, radiant: sweep });
    const first = newInstance(s.state, "edge-r7-l7-cod-targeted", "p1", { z: "library", player: "p1" });
    const second = newInstance(s.state, "edge-r7-l7-cod-sweep", "p1", { z: "library", player: "p1" });
    s.state.players.p1.library.unshift(first, second);

    // p1's turn draw casts the first; its cast asks p1 for a target (R70, R81).
    s.startTurn();
    expect(must(s.state.pending, "the cast's target prompt").playerId).toBe("p1");
    s.answer([{ pick: "hero", player: "p2" }]);

    // §2.4: the draw repeats as soon as the cast has resolved, so the sweep is cast inside the same
    // draw, and the cast's events reach the traps with the rest of the draw's (a cast leaves them to
    // the effect that cast it, R70). R122: the answer finishes what the prompt interrupted before
    // the resolution loop moves. So Bear Honeypot's tokens arrive after the sweep: nothing hits them.
    const types = s.lastEvents.map((event) => event.type);
    const sweepDrawn = s.lastEvents.findIndex((event) => event.type === "drawn" && event.instanceId === second.id);
    const trapFired = types.indexOf("trapFired");
    expect(sweepDrawn, `events: ${types.join(", ")}`).toBeGreaterThanOrEqual(0);
    expect(trapFired, `events: ${types.join(", ")}`).toBeGreaterThan(sweepDrawn);
    const tokens = [1, 2, 3, 4, 5].flatMap((lane) => {
      const unit = s.unit("p2", lane);
      return unit !== null && unit.defId === RUSH_TOKEN ? [unit] : [];
    });
    expect(tokens).toHaveLength(2);
    for (const token of tokens) expect(token.damage).toBe(0);
  });
});

describe("R136, R113: a list a prompt split still reads the events its own head emitted", () => {
  it("R136 the Rush Token a trap's list summoned before its prompt is still one of \"they\" that attack after the answer (R113, §8 #60)", () => {
    const s = scenario({
      p1: { hand: [RENO, RENO], mana: 4 },
      p2: { hand: [RENO] },
    });
    // p2's trap, #60 Bear Honeypot's list with a question in the middle: when the opponent's card
    // resolves, summon a Rush Token, ask p2 something, then the tokens this list summoned attack it.
    const trap: Script = {
      triggers: [
        {
          id: "edge-r7-l7-honeypot-asks",
          on: ["cardResolved"],
          when: (ctx) => ctx.event.type === "cardResolved" && ctx.event.player !== ctx.controller && ctx.event.permanent,
          run: (ctx) => [
            summon({ defId: RUSH_TOKEN }),
            chooseMode({ options: ["ok"], step: "ok", prompt: "a question" }),
            forcedAttacks({
              attackers: { side: "self", defId: RUSH_TOKEN, summonedThisScript: true },
              target: { instanceId: ctx.event.type === "cardResolved" ? ctx.event.instanceId : "" },
            }),
          ],
        },
      ],
      resume: { ok: () => [] },
    };
    fixtureFaces(s.state, "edge-r7-l7-honeypot-asks", "Trap", { base: trap, radiant: trap });
    placeFixture(s, "edge-r7-l7-honeypot-asks", "p2", "backrow", 1);

    s.play(RENO, { zone: 1 });
    const reno = must(s.unit("p1", 1), "p1's Reno");
    must(s.state.pending, "the trap's question");
    const token = must(s.unit("p2", 1), "the Rush Token the trap summoned");
    expect(token.defId).toBe(RUSH_TOKEN);
    s.answer("ok");

    // R113: the list after the prompt is the same list, and R136's "the events its own script
    // emitted" include the summon before the prompt: the token attacks Reno (3 damage) and dies to
    // Reno's 4 strike back.
    expect(s.card(reno).damage).toBe(3);
    s.expectInZone(token, "gone");
  });
});

describe("R174, R113: \"this unit\" later in a list a prompt split is the stay the list began with", () => {
  it("R174 a Cry that sacrificed its own unit before its prompt does not buff the Reborn body after the answer (R83, R113)", () => {
    const s = scenario({
      p1: { hand: [RENO], mana: 4 },
      p2: { hand: [RENO] },
    });
    // A 0-cost 2/2 Reborn unit whose Cry sacrifices itself, asks something, then gives itself +5/+5.
    const cry: Script = {
      cry: () => [
        sacrifice({ target: { of: "self" } }),
        chooseMode({ options: ["ok"], step: "ok", prompt: "a question" }),
        buff({ target: { of: "self" }, attack: 5, health: 5 }),
      ],
      resume: { ok: () => [] },
    };
    fixtureFaces(s.state, "edge-r7-l7-self-sac", "Unit", { base: cry, radiant: cry }, { keywords: [{ kind: "Reborn" }] });
    const unit = newInstance(s.state, "edge-r7-l7-self-sac", "p1", { z: "hand", player: "p1" });
    s.state.players.p1.hand.push(unit);

    s.play(unit, { zone: 1 });
    must(s.state.pending, "the Cry's question");
    // The sacrifice is a death in full: Reborn has already put a new body in lane 1 (§4.5 step 4).
    expect(s.card(unit).rebornSpent).toBe(true);
    s.answer("ok");

    // R174: an effect later in the same list aimed at a card an earlier effect took off the field
    // fizzles even once the card is back, and a prompt between them changes none of this (R113). The
    // body is a new arrival (R83): it stays the printed 2/2 at 1 health.
    s.expectInZone(unit, "field");
    s.expectStats(unit, { attack: 2, maxHealth: 2, health: 1 });
  });
});

describe("R174, R113: the step a prompt's answer re-enters reads the stays the resolution began with", () => {
  it("R174 a delayed steal an answered step schedules on a unit its own list sacrificed before the prompt fizzles, Reborn body or not (R76, R83, R113)", () => {
    const s = scenario({
      p1: { hand: [RENO], mana: 4 },
      p2: { hand: [RENO] },
    });
    const plain: Script = {};
    fixtureFaces(s.state, "edge-r7-l7-enemy-reborn", "Unit", { base: plain, radiant: plain }, { keywords: [{ kind: "Reborn" }] });
    const victim = placeFixture(s, "edge-r7-l7-enemy-reborn", "p2", "units", 1);

    // A 0-cost Spell: sacrifice the chosen enemy unit, ask something, and on the answer schedule
    // "at the start of your next turn, steal it", watching it (#50 Kpop Fanatic's steal, R76).
    const spell: Script = {
      targets: [{ kind: "target", min: 1, max: 1, filter: { side: "enemy", of: ["unit"] } }],
      cry: (ctx) => {
        const chosen = ctx.targets[0];
        const id = chosen?.pick === "instance" ? chosen.instanceId : "";
        return [
          sacrifice({ target: { of: "chosen" }, allowEnemy: true }),
          chooseMode({ options: ["ok"], step: "ok", prompt: "a question", data: { victim: id } }),
        ];
      },
      resume: {
        ok: (ctx) => [
          delay({
            at: { phase: "start", player: "self" },
            step: "steal",
            hook: "resume",
            watch: String(ctx.data.victim),
            data: { victim: ctx.data.victim },
          }),
        ],
        steal: (ctx) => [steal({ instanceId: String(ctx.data.victim) })],
      },
    };
    fixtureFaces(s.state, "edge-r7-l7-sac-then-steal", "Spell", { base: spell, radiant: spell });
    const card = newInstance(s.state, "edge-r7-l7-sac-then-steal", "p1", { z: "hand", player: "p1" });
    s.state.players.p1.hand.push(card);

    s.play(card, { targets: [{ pick: "instance", instanceId: victim.id }] });
    must(s.state.pending, "the Spell's question");
    // The sacrifice is a death in full: the victim's Reborn body already stands in p2's lane 1.
    expect(s.card(victim).rebornSpent).toBe(true);
    s.answer("ok");

    // R174: the steal is aimed at the stay the play chose, which the sacrifice ended before the
    // question. The answer continues the same resolution (R113, §10.6), so it is never scheduled for
    // the body that came back, as it is not when a fused card's parts do the same (re-entry.test.ts).
    const scheduled = s.state.delayed.filter((effect) => effect.resume.defId === "edge-r7-l7-sac-then-steal");
    expect(scheduled).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Round 8 (lens L7): an Echo repeat's fresh picks, the traps a paused dispatch still owes and their
// order, a card named by id or picked at a prompt after the list's own sacrifice, a played card a
// Tribute's question discarded, and the check after a trigger that asked at step 4.
// ---------------------------------------------------------------------------

const FULLSEND = "core-078";

function same(script: Script): { base: Script; radiant: Script } {
  return { base: script, radiant: script };
}

function inHand(s: Scenario, defId: string, player: PlayerId): CardInstance {
  const card = newInstance(s.state, defId, player, { z: "hand", player });
  s.state.players[player].hand.push(card);
  return card;
}

function onLibraryTop(s: Scenario, defIds: readonly string[], player: PlayerId): CardInstance[] {
  const cards = defIds.map((defId) => newInstance(s.state, defId, player, { z: "library", player }));
  s.state.players[player].library.unshift(...cards);
  return cards;
}

// ---------------------------------------------------------------------------------------------
// 1. An Echo repeat's fresh choices and the stays they were made on (R174, §10.5 step 6)
// ---------------------------------------------------------------------------------------------

describe("R174, §10.5 step 6: an Echo repeat's fresh target is aimed at the stay it was chosen on", () => {
  /** p2's 5/5 Reborn unit in lane 1, a p1 Spell "deal 1 damage to target enemy unit", and /fullsend. */
  function board(echo: number): { s: Scenario; victim: CardInstance; spell: CardInstance } {
    const s = scenario({
      p1: { hand: [FULLSEND], library: [RENO, RENO, RENO], mana: 4 },
      p2: { hand: [RENO] },
    });
    fixtureFaces(s.state, "edge-r8-reborn-5-5", "Unit", same({}), {
      stats: { attack: 5, health: 5 },
      keywords: [{ kind: "Reborn" }],
    });
    const victim = placeFixture(s, "edge-r8-reborn-5-5", "p2", "units", 1);
    const id = `edge-r8-ping-echo-${echo}`;
    fixtureFaces(
      s.state,
      id,
      "Spell",
      same({
        staticFlags: { echo },
        targets: [{ kind: "target", min: 1, max: 1, filter: { side: "enemy", of: ["unit"] } }],
        cry: () => [damage({ to: { of: "chosen" }, amount: 1 })],
      }),
    );
    const spell = inHand(s, id, "p1");
    // A cast-on-draw Spell that destroys the victim.
    fixtureFaces(
      s.state,
      "edge-r8-cod-destroyer",
      "Spell",
      same({ staticFlags: { castOnDraw: true }, cry: () => [destroy({ target: { of: "instance", instanceId: victim.id } })] }),
    );
    return { s, victim, spell };
  }

  it("R174 a target chosen at the repeat's prompt that the repeat's Combo draw killed is gone for the repeat's script, Reborn body or not (R81, R83)", () => {
    // Control, no Echo: the play's own Combo draw (step 5, before the script) casts the destroyer, and
    // the script's damage, aimed at the stay step 1 checked, fizzles on the Reborn body.
    const control = board(0);
    onLibraryTop(control.s, ["edge-r8-cod-destroyer"], "p1");
    control.s.play(FULLSEND);
    control.s.play(control.spell, { targets: [{ pick: "instance", instanceId: control.victim.id }] });
    expect(control.s.card(control.victim).rebornSpent).toBe(true);
    control.s.expectInZone(control.victim, "field");
    control.s.expectStats(control.victim, { health: 1 });

    // Echo 1. The first resolution's Combo draw takes a Reno; the repeat's takes the destroyer.
    const { s, victim, spell } = board(1);
    onLibraryTop(s, [RENO, "edge-r8-cod-destroyer"], "p1");
    // /fullsend: "this turn your cards gain 'Combo: draw 1'", and it is the card played earlier.
    s.play(FULLSEND);
    s.play(spell, { targets: [{ pick: "instance", instanceId: victim.id }] });
    // The first resolution hit the 5/5 for 1; the repeat asks for a fresh target (R81).
    expect(s.card(victim).damage).toBe(1);
    const pending = must(s.state.pending, "the Echo repeat's target prompt");
    expect(pending.prompt).toContain("Echo");
    s.answer(victim.id);

    // The repeat is step 5 again: its Combo draw casts the destroyer, which kills the victim, and
    // Reborn puts a new body in lane 1 (§4.5 step 4, R83) before the repeat's script runs.
    const events = s.lastEvents;
    const reborn = events.findIndex((event) => event.type === "summoned" && event.instanceId === victim.id);
    expect(reborn, "the victim's Reborn body came back during the repeat").toBeGreaterThanOrEqual(0);
    // R174: the repeat's damage was aimed at the stay chosen at its prompt, which the cast ended, as
    // the control's was aimed at step 1's. The body is a new arrival and stands at 1 health; before
    // the fix the repeat's damage landed on it and it died a second time.
    s.expectInZone(victim, "field");
    s.expectStats(victim, { health: 1 });
  });
});

// ---------------------------------------------------------------------------------------------
// 2. The traps an event is still owed after a question are the ones not yet offered it (§10.3, R99)
// ---------------------------------------------------------------------------------------------

/** p2's trap in `lane`: when the opponent plays a card, and only once p1's hero is below 30, deal it 5. */
function conditionalTrap(s: Scenario, id: string, lane: number): CardInstance {
  fixtureFaces(
    s.state,
    id,
    "Trap",
    same({
      triggers: [
        {
          id: `${id}:hits`,
          on: ["cardPlayed"],
          when: (ctx) =>
            ctx.event.type === "cardPlayed" &&
            ctx.event.player !== ctx.controller &&
            ctx.state.players.p1.hero.health < 30,
          run: () => [damage({ to: { of: "enemyHero" }, amount: 5 })],
        },
      ],
    }),
  );
  return placeFixture(s, id, "p2", "backrow", lane);
}

describe("§10.3, R99: a trap that declined an event is not offered it again because a later trap asked", () => {
  it("R99 the lane-1 trap that declined the play is still armed after the lane-2 trap's question is answered, as it is with no question (R113, §10.3)", () => {
    // Control: the lane-2 trap pings p1 at once. The lane-1 trap met the play first, with p1 at 30,
    // declined it, and is not offered it again after the ping.
    const control = scenario({ p1: { hand: [TEMPO_TIMMY], mana: 4 }, p2: { hand: [RENO] } });
    const controlGuard = conditionalTrap(control, "edge-r8-guard-control", 1);
    fixtureFaces(
      control.state,
      "edge-r8-pinger-now",
      "Trap",
      same({
        triggers: [
          {
            id: "edge-r8-pinger-now:pings",
            on: ["cardPlayed"],
            when: (ctx) => ctx.event.type === "cardPlayed" && ctx.event.player !== ctx.controller,
            run: () => [damage({ to: { of: "enemyHero" }, amount: 1 })],
          },
        ],
      }),
    );
    placeFixture(control, "edge-r8-pinger-now", "p2", "backrow", 2);
    control.play(TEMPO_TIMMY, { zone: 1 });
    control.expectHealth("p1", 29);
    control.expectInZone(controlGuard, "field");

    // The same board, but the lane-2 trap asks p2 something before it pings.
    const s = scenario({ p1: { hand: [TEMPO_TIMMY], mana: 4 }, p2: { hand: [RENO] } });
    const guard = conditionalTrap(s, "edge-r8-guard", 1);
    fixtureFaces(
      s.state,
      "edge-r8-pinger-asks",
      "Trap",
      same({
        triggers: [
          {
            id: "edge-r8-pinger-asks:asks",
            on: ["cardPlayed"],
            when: (ctx) => ctx.event.type === "cardPlayed" && ctx.event.player !== ctx.controller,
            run: () => [chooseMode({ options: ["ok"], step: "ok", prompt: "a question" })],
          },
        ],
        resume: { ok: () => [damage({ to: { of: "enemyHero" }, amount: 1 })] },
      }),
    );
    placeFixture(s, "edge-r8-pinger-asks", "p2", "backrow", 2);
    s.play(TEMPO_TIMMY, { zone: 1 });
    expect(must(s.state.pending, "the lane-2 trap's question").playerId).toBe("p2");
    s.answer("ok");

    // §10.3: the traps check the event as it is dispatched, each once. The lane-1 trap was offered
    // the play before the lane-2 trap fired and declined it; the question only paused the dispatch
    // after that (R113 resumes where it stopped), so it does not get a second look at the same play.
    s.expectHealth("p1", 29);
    s.expectInZone(guard, "field");
    expect(s.card(guard).faceUp ?? false).toBe(false);
  });
});

describe("§10.3, R113: the traps still owed an event after a question meet it in the order the dispatch had", () => {
  /** A trap that answers every `cardPlayed` and does nothing else (R61: it fires and is consumed). */
  function silentTrap(s: Scenario, id: string, player: PlayerId, lane: number): CardInstance {
    fixtureFaces(s.state, id, "Trap", same({ triggers: [{ id: `${id}:fires`, on: ["cardPlayed"], run: () => [] }] }));
    return placeFixture(s, id, player, "backrow", lane);
  }

  /** p1's lane-1 trap: on any play, rotate the rings (p1's seat) — at once, or after a question. */
  function rotatingTrap(s: Scenario, asks: boolean): void {
    const turn = rotate({ direction: "left" });
    fixtureFaces(
      s.state,
      asks ? "edge-r8-rotor-asks" : "edge-r8-rotor-now",
      "Trap",
      same({
        triggers: [
          {
            id: asks ? "edge-r8-rotor-asks:fires" : "edge-r8-rotor-now:fires",
            on: ["cardPlayed"],
            run: () => (asks ? [chooseMode({ options: ["ok"], step: "ok", prompt: "a question" })] : [turn]),
          },
        ],
        resume: { ok: () => [turn] },
      }),
    );
    placeFixture(s, asks ? "edge-r8-rotor-asks" : "edge-r8-rotor-now", "p1", "backrow", 1);
  }

  function crossedToP1(s: Scenario, id: string): boolean {
    return s.events.some((event) => event.type === "controlChanged" && event.instanceId === id && event.controller === "p1");
  }

  function firedOrder(s: Scenario, ids: readonly string[]): string[] {
    return s.events.flatMap((event) => (event.type === "trapFired" && ids.includes(event.instanceId) ? [event.instanceId] : []));
  }

  it("R113 p2's lane-4 and lane-5 traps fire in the order the play's dispatch offered them, though the answer rotated the lane-5 one onto p1's side (§10.3, R68)", () => {
    // Control: the rotation happens at once. The dispatch offers the play to p1's rotor, then to
    // p2's lane-4 and lane-5 traps in the order it read as it began (R68), whichever side the
    // rotation has put them on by then.
    const control = scenario({ p1: { hand: [TEMPO_TIMMY], mana: 4 }, p2: { hand: [RENO] } });
    rotatingTrap(control, false);
    const a0 = silentTrap(control, "edge-r8-silent-a0", "p2", 4);
    const b0 = silentTrap(control, "edge-r8-silent-b0", "p2", 5);
    control.play(TEMPO_TIMMY, { zone: 2 });
    expect(crossedToP1(control, b0.id), "the rotation carried the lane-5 trap across to p1").toBe(true);
    expect(firedOrder(control, [a0.id, b0.id])).toEqual([a0.id, b0.id]);

    // The same, with the rotor asking p1 first and rotating on the answer.
    const s = scenario({ p1: { hand: [TEMPO_TIMMY], mana: 4 }, p2: { hand: [RENO] } });
    rotatingTrap(s, true);
    const a = silentTrap(s, "edge-r8-silent-a", "p2", 4);
    const b = silentTrap(s, "edge-r8-silent-b", "p2", 5);
    s.play(TEMPO_TIMMY, { zone: 2 });
    must(s.state.pending, "the rotor's question");
    s.answer("ok");
    expect(crossedToP1(s, b.id)).toBe(true);

    // R113: the dispatch the question paused resumes where it stopped — the traps it still owed, in
    // the order it had (as the end-of-turn window's remainder keeps its owed list's order). Before
    // the fix the remainder was re-read from a fresh scan in which p1's side comes first, so the
    // lane-5 trap the rotation moved fired ahead of the lane-4 one.
    expect(firedOrder(s, [a.id, b.id])).toEqual([a.id, b.id]);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. A card named by id later in a list a prompt split is still aimed at its stay (R174, R113)
// ---------------------------------------------------------------------------------------------

describe("R174, R113: an effect naming a card by id after a prompt meets the stay the run began with", () => {
  it("R174 the Rush Token a trap's list summoned does not attack the Reborn body of the played unit the answer sacrificed (R53, §8 #60)", () => {
    const s = scenario({
      p1: { hand: [RENO], mana: 4 },
      p2: { hand: [RENO] },
    });
    // p1's 0-cost 2/2 Reborn unit.
    fixtureFaces(s.state, "edge-r8-played-reborn", "Unit", same({}), { keywords: [{ kind: "Reborn" }] });
    const played = inHand(s, "edge-r8-played-reborn", "p1");
    // p2's trap, #60 Bear Honeypot's list with a question in it: when the opponent's permanent
    // resolves, summon a Rush Token and ask p2; the answer sacrifices the played unit; then the
    // tokens this list summoned attack the played unit.
    fixtureFaces(
      s.state,
      "edge-r8-honeypot-sacrifices",
      "Trap",
      same({
        triggers: [
          {
            id: "edge-r8-honeypot-sacrifices:fires",
            on: ["cardResolved"],
            when: (ctx) => ctx.event.type === "cardResolved" && ctx.event.player !== ctx.controller && ctx.event.permanent,
            run: (ctx) => {
              const id = ctx.event.type === "cardResolved" ? ctx.event.instanceId : "";
              return [
                summon({ defId: RUSH_TOKEN }),
                chooseMode({ options: ["ok"], step: "ok", prompt: "a question", data: { played: id } }),
                forcedAttacks({
                  attackers: { side: "self", defId: RUSH_TOKEN, summonedThisScript: true },
                  target: { instanceId: id },
                }),
              ];
            },
          },
        ],
        resume: {
          ok: (ctx) => [sacrifice({ target: { of: "instance", instanceId: String(ctx.data.played) }, allowEnemy: true })],
        },
      }),
    );
    placeFixture(s, "edge-r8-honeypot-sacrifices", "p2", "backrow", 1);

    s.play(played, { zone: 1 });
    must(s.state.pending, "the trap's question");
    const token = must(s.unit("p2", 1), "the Rush Token the trap summoned");
    s.answer("ok");

    // The answer's sacrifice is a death in full: the played unit's Reborn body came back in lane 1
    // (R83) before the tail ran.
    const events = s.lastEvents;
    const died = events.findIndex((event) => event.type === "destroyed" && event.instanceId === played.id);
    const reborn = events.findIndex((event) => event.type === "summoned" && event.instanceId === played.id);
    expect(died, "the answer sacrificed the played unit").toBeGreaterThanOrEqual(0);
    expect(reborn, "Reborn brought its body back").toBeGreaterThan(died);
    // R174: "they attack it" is aimed at the played unit's stay, which the answer ended before the
    // tail ran — the list is one run whether or not a prompt split it (R113), and the answered step
    // and the tail share its mark. #60's tokens do not attack a Reborn body; before the fix the
    // token attacked it and the 1-health body died a second time.
    const attacked = events.some(
      (event) => event.type === "attackDeclared" && event.forced && event.targetId === played.id,
    );
    expect(attacked, "the token was made to attack the Reborn body").toBe(false);
    expect(s.card(token).damage).toBe(0);
    s.expectInZone(played, "field");
    s.expectStats(played, { health: 1 });
  });

  it("R174 damage the answered step aims by id at a unit its own list sacrificed before the prompt misses the Reborn body (R83, R113)", () => {
    const s = scenario({
      p1: { hand: [RENO], mana: 4 },
      p2: { hand: [RENO] },
    });
    fixtureFaces(s.state, "edge-r8-enemy-reborn", "Unit", same({}), {
      stats: { attack: 2, health: 3 },
      keywords: [{ kind: "Reborn" }],
    });
    const victim = placeFixture(s, "edge-r8-enemy-reborn", "p2", "units", 1);
    // A 0-cost Spell: sacrifice the chosen enemy unit, ask something, then (the answered step) deal
    // 5 damage to that unit, named by the id the Cry carried into the prompt.
    fixtureFaces(
      s.state,
      "edge-r8-sac-ask-hit-by-id",
      "Spell",
      same({
        targets: [{ kind: "target", min: 1, max: 1, filter: { side: "enemy", of: ["unit"] } }],
        cry: (ctx) => {
          const chosen = ctx.targets[0];
          const id = chosen?.pick === "instance" ? chosen.instanceId : "";
          return [
            sacrifice({ target: { of: "chosen" }, allowEnemy: true }),
            chooseMode({ options: ["ok"], step: "ok", prompt: "a question", data: { victim: id } }),
          ];
        },
        resume: {
          ok: (ctx) => [damage({ to: { of: "instance", instanceId: String(ctx.data.victim) }, amount: 5 })],
        },
      }),
    );
    const spell = inHand(s, "edge-r8-sac-ask-hit-by-id", "p1");

    s.play(spell, { targets: [{ pick: "instance", instanceId: victim.id }] });
    must(s.state.pending, "the Spell's question");
    expect(s.card(victim).rebornSpent).toBe(true);
    s.answer("ok");

    // R174: the damage is aimed at the stay the play chose, which the sacrifice ended before the
    // question; the answered step continues the same resolution (R113), and naming the card by id
    // rather than as "the chosen one" does not make the Reborn body the card it was aimed at.
    s.expectInZone(victim, "field");
    s.expectStats(victim, { health: 1 });
  });
});

// ---------------------------------------------------------------------------------------------
// 4. A target picked at a prompt is aimed at the stay it was picked on (R174, §10.6)
// ---------------------------------------------------------------------------------------------

describe("R174, §10.6: a card picked at a prompt is aimed at the stay the prompt offered", () => {
  /** p2's 2/3 Reborn unit in lane 1 and Tempo Timmy in lane 2; p1's Spell: sacrifice the chosen
   * enemy unit, then ask for an enemy unit and deal it 5. */
  function board(): { s: Scenario; victim: CardInstance; spell: CardInstance } {
    const s = scenario({
      p1: { hand: [RENO], mana: 4 },
      p2: { field: [{ def: TEMPO_TIMMY, lane: 2 }], hand: [RENO] },
    });
    fixtureFaces(s.state, "edge-r8-enemy-reborn-2", "Unit", same({}), {
      stats: { attack: 2, health: 3 },
      keywords: [{ kind: "Reborn" }],
    });
    const victim = placeFixture(s, "edge-r8-enemy-reborn-2", "p2", "units", 1);
    fixtureFaces(
      s.state,
      "edge-r8-sac-then-pick",
      "Spell",
      same({
        targets: [{ kind: "target", min: 1, max: 1, filter: { side: "enemy", of: ["unit"] } }],
        cry: () => [
          sacrifice({ target: { of: "chosen" }, allowEnemy: true }),
          chooseTarget({ step: "hit", scope: { side: "enemy", of: ["unit"] }, prompt: "deal 5 to an enemy unit" }),
        ],
        resume: { hit: () => [damage({ to: { of: "chosen" }, amount: 5 })] },
      }),
    );
    return { s, victim, spell: inHand(s, "edge-r8-sac-then-pick", "p1") };
  }

  it("R174 the Reborn body a prompt offered after the list's own sacrifice takes the answered step's damage when it is picked (R83, R113)", () => {
    // Control: picking the unit that never left, the answered step's 5 lands and kills it.
    const control = board();
    control.s.play(control.spell, { targets: [{ pick: "instance", instanceId: control.victim.id }] });
    const timmy = must(control.s.unit("p2", 2), "p2's Tempo Timmy");
    control.s.answer(timmy.id);
    control.s.expectInZone(timmy, "graveyard");

    const { s, victim, spell } = board();
    s.play(spell, { targets: [{ pick: "instance", instanceId: victim.id }] });
    // The sacrifice is a death in full, and Reborn has put the body back before the prompt opened:
    // the prompt offers it, a unit on the field now (R83).
    expect(s.card(victim).rebornSpent).toBe(true);
    const pending = must(s.state.pending, "the Spell's target prompt");
    const offered = pending.options.some(
      (option) => option.selection.pick === "instance" && option.selection.instanceId === victim.id,
    );
    expect(offered, "the prompt offers the Reborn body").toBe(true);
    s.answer(victim.id);

    // §10.6: the answer re-invokes the script with the selection, and the selection is a card on
    // the field as the prompt offered it. R174 aims an effect at the stay it was chosen on — here,
    // the body's — so the 5 damage lands and kills it. Before the fix the answered step judged the
    // pick against the mark the Cry began with, before the sacrifice, called the body "gone", and
    // the offered option did nothing.
    const hit = s.lastEvents.some((event) => event.type === "damage" && event.targetId === victim.id);
    expect(hit, "the picked Reborn body takes the answered step's damage").toBe(true);
    s.expectInZone(victim, "graveyard");
  });
});

// ---------------------------------------------------------------------------------------------
// 5. A Tribute's Death that asks while the played card is between the hand and the field (§10.5)
// ---------------------------------------------------------------------------------------------

/** Every pile holding this id, in every zone of both sides (§10.1: a card is in exactly one). */
function pilesHolding(state: GameState, id: string): string[] {
  const out: string[] = [];
  for (const player of ["p1", "p2"] as const) {
    const side = state.players[player];
    const piles: [string, readonly (CardInstance | null)[]][] = [
      ["hand", side.hand],
      ["library", side.library],
      ["graveyard", side.graveyard],
      ["exile", side.exile],
      ["resolving", side.resolving],
      ["backrow", side.backrow],
      ["units", side.units.flatMap((pile) => pile ?? [])],
    ];
    for (const [name, cards] of piles) {
      if (cards.some((card) => card?.id === id)) out.push(`${player}.${name}`);
    }
  }
  return out;
}

describe("R226, §10.1: a card being played is never left in two zones by a question its Tribute asks", () => {
  it("R226 a Tribute whose Death has its controller discard the card being played does not also put that card on the field (§10.1, §10.5, R113)", () => {
    const s = scenario({
      p1: { hand: [RENO], mana: 4 },
      p2: { hand: [RENO] },
    });
    // p1's 1/1 in lane 1 whose Death asks its controller to discard a card.
    fixtureFaces(
      s.state,
      "edge-r8-discarding-death",
      "Unit",
      same({
        death: () => [chooseFromHand({ step: "gone", prompt: "discard a card" })],
        resume: { gone: () => [discard({ target: { of: "chosen" } })] },
      }),
      { stats: { attack: 1, health: 1 } },
    );
    const fodder = placeFixture(s, "edge-r8-discarding-death", "p1", "units", 1);
    // p1's 0-cost 3/3 with Tribute 1.
    fixtureFaces(s.state, "edge-r8-tribute-one", "Unit", same({ staticFlags: { tribute: 1 } }), { stats: { attack: 3, health: 3 } });
    const played = inHand(s, "edge-r8-tribute-one", "p1");

    s.play(played, { zone: 2, tributes: [fodder.id] });
    const pending = must(s.state.pending, "the tributed unit's Death question");
    const offersPlayed = pending.options.some(
      (option) => option.selection.pick === "instance" && option.selection.instanceId === played.id,
    );
    if (offersPlayed) s.answer(played.id);
    else s.answer(must(pending.options[0], "a hand card to discard").key);

    // §10.1: every card is in exactly one zone. Offered while it waits between step 2 and step 4 in
    // its owner's hand, the card being played is discarded to the graveyard by the answer; step 4
    // then puts it on the field too, so it stands in lane 2 and lies in the graveyard at once.
    // Either the question does not offer the card being played (it is leaving the hand, as R90 says
    // of the play's own choices), or a card discarded that way is not played.
    expect(pilesHolding(s.state, played.id), "the card being played is in exactly one pile").toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// 6. The step-4 loop a trigger's question interrupted still checks before the Cry (R59, R118)
// ---------------------------------------------------------------------------------------------

describe("R59, §10.5 step 4: a trigger that answered the play and asked is followed by the check before the Cry", () => {
  /** p1's 0-cost unit whose Cry deals the enemy hero 1 per enemy unit on the field. */
  function counter(s: Scenario): CardInstance {
    fixtureFaces(
      s.state,
      "edge-r8-counting-cry",
      "Unit",
      same({ cry: (ctx) => [damage({ to: { of: "enemyHero" }, amount: activeUnitsOf(ctx.state, "p2").length })] }),
    );
    return inHand(s, "edge-r8-counting-cry", "p1");
  }

  /** p1's lane-1 unit: whenever its controller plays another card, deal 5 to `victim` — at once, or on the answer to a question. */
  function striker(s: Scenario, victimId: string, asks: boolean): void {
    const id = asks ? "edge-r8-striker-asks" : "edge-r8-striker-now";
    const hit = damage({ to: { of: "instance", instanceId: victimId }, amount: 5 });
    fixtureFaces(
      s.state,
      id,
      "Unit",
      same({
        triggers: [
          {
            id: `${id}:fires`,
            on: ["cardPlayed"],
            run: (ctx) =>
              ctx.event.type === "cardPlayed" && ctx.event.player === ctx.controller && ctx.event.instanceId !== ctx.self?.id
                ? asks
                  ? [chooseMode({ options: ["ok"], step: "ok", prompt: "a question" })]
                  : [hit]
                : [],
          },
        ],
        resume: { ok: () => [hit] },
      }),
    );
    placeFixture(s, id, "p1", "units", 1);
  }

  it("R59 the unit the trigger's answer killed has died before the played card's Cry counts the board, as it has when nothing asks (R118, R113)", () => {
    // Control: the trigger deals its 5 at once. §10.5 step 4's loop runs it, then the check (R59),
    // and Tempo Timmy has died before the Cry counts the enemy's units: 0 damage.
    const control = scenario({ p1: { hand: [RENO], mana: 4 }, p2: { field: [TEMPO_TIMMY], hand: [RENO] } });
    const timmy0 = must(control.unit("p2", 1), "p2's Tempo Timmy");
    striker(control, timmy0.id, false);
    control.play(counter(control), { zone: 2 });
    control.expectInZone(timmy0, "graveyard");
    control.expectHealth("p2", 30);

    // The same trigger, asking p1 first and dealing its 5 on the answer.
    const s = scenario({ p1: { hand: [RENO], mana: 4 }, p2: { field: [TEMPO_TIMMY], hand: [RENO] } });
    const timmy = must(s.unit("p2", 1), "p2's Tempo Timmy");
    striker(s, timmy.id, true);
    s.play(counter(s), { zone: 2 });
    must(s.state.pending, "the trigger's question");
    s.answer("ok");

    // R59: the check follows the whole trigger, answered step included, and step 4's loop is where
    // the play left it (R113, R118) — so Timmy, at -2, dies before step 5. Before the fix the
    // re-entered loop held the check (`holdCheck`) because nothing had resolved inside it yet, and
    // the Cry counted a dead unit still on the field: p2 took 1.
    s.expectInZone(timmy, "graveyard");
    s.expectHealth("p2", 30);
  });
});
