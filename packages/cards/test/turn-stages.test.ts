// The stages of the turn loop, each settled before the next (SPEC §2.2, §6.2, §10.3, R44, R62, R68,
// R152). Found by the polish-4 edge-case hunt, round 6 (docs/polish/4-edge-cases.md, lens L8);
// every case here failed before its fix.
//
//  - R62, §10.3: a stage that emits events settles before the next one runs, so a trigger answering
//    the end-of-turn trap window resolves in that turn's end, and one answering a start-of-turn
//    delayed effect resolves before the start-of-turn triggers are queued behind it.
//  - R44, R152: the AI turn #96 My Pawn hands over goes on after the other player answers a question
//    one of its actions put to them.
//
// Round 7 (lens L8) added two: the traps answer each start-of-turn delayed effect before the next one
// resolves (R68, §10.3), and cleanup settles its own events — My Pawn reaching the graveyard at the
// end of the turn it took (R152) — before the turn-cap check and the next turn (R62).
//
// Round 8 (lens L8) added two more: the deaths the check after a delayed effect collects reach the
// traps before the next delayed effect resolves (R68, §4.5), and a "this turn" modifier made while
// cleanup's own events are answered ends with that turn rather than lasting for good (§2.2, R62).
//
// No Core card answers a summon or a change of control, and no Core trap asks its controller
// anything, so the card that makes each case observable is a fixture (a transient def, the way a
// fusion's is held, as paused-sequences.test.ts does); every other card is a real one.
//
// Round 9 (lens L8) added two: cleanup clears the return flags again once its own events are
// answered, so a return Spell cast then does not come back two turns later (R155, R62), and an
// end-of-turn clause a Spell arms on the other player's turn is not armed at all (R241, §6.2).
// Then, from the lens "engine invariants": the refresh's rider is a badge the view lists and the
// refresh reports spent (R169, §6.3 Mana), and a fatigue draw Armor absorbs is still reported (R240).

import { describe, expect, it } from "vitest";
import type { CardDef, CardType, PlayerId, Row } from "@jackioh/shared";
import {
  effectiveCost,
  legalActions,
  newInstance,
  placeOnField,
  reduce,
  registerScripts,
  registeredScripts,
  type CardInstance,
  type Script,
  wasPlayedThisTurn,
  RESUME_HOOK,
} from "@jackioh/engine";
import {
  addPlayerModifier,
  bounceAll,
  chooseMode,
  damage,
  bounce,
  delay,
  draw,
  exileHand,
} from "@jackioh/engine/effects";
import { scenario, type Scenario } from "./_harness";

const VANILLA = "core-008"; // Unit, cost 1, no Cry
const SUPPRESSIVE_AURA = "core-046"; // radiant: enemy units -4/-4
const LUNAR_ECLIPSE = "core-035"; // 3 damage; the next Spell you play this turn costs 1 less
const TEMPO_TIMMY = "core-011"; // 3/3 Rush, First Strike
const BREAD_AND_BUTTER = "core-018"; // Field Trap in the end-of-turn window (R62)
const ECHOES = "core-040"; // Start of your turn: damage to the enemy hero = cards in your exile
const KPOP_FANATIC = "core-050"; // Cry: at the start of your next turn, steal the chosen permanent
const RENO = "core-053";
const MASOCHISM_MASK = "core-065"; // Start of turn: a mode prompt
const MY_PAWN = "core-096";
const GARY = "core-004";
const SEVEN_SEVEN = "core-025";

/** The actions a player takes for themselves on their own turn (everything but concede and draws). */
const TURN_ACTIONS = ["play", "attack", "switchPosition", "activatePower", "offerDraw", "endTurn"];

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
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
  if (row === "units") card.position = "ATK";
  return card;
}

describe("R62, §10.3: a stage of the turn loop settles its events before the next stage", () => {
  it("R62 a trigger answering the end-of-turn trap window resolves in that turn's end, before the next turn starts (§10.3, R216)", () => {
    // p1 ends the turn with 1 mana unspent: p1's Bread and Butter summons a Bread Token for p1 in
    // the window, and p1's fixture unit answers that summon with 1 damage to p2's hero, which is at
    // 1. p2's Echoes of the Forgotten would deal p1 (at 2) 3 at the start of p2's turn.
    const s = scenario({
      p1: {
        hand: [RENO],
        backrow: [{ def: BREAD_AND_BUTTER, faceUp: false }],
        mana: 1,
        health: 2,
        library: [RENO, RENO],
      },
      p2: { hand: [RENO], backrow: [ECHOES], exile: [RENO, RENO, RENO], health: 1, library: [RENO, RENO] },
    });
    fixture(s, "edge-r6-juggler", "Unit", {
      triggers: [
        {
          id: "edge-r6-juggle",
          on: ["summoned"],
          run: (ctx) =>
            ctx.event.type === "summoned" && ctx.event.player === ctx.controller
              ? [damage({ to: { of: "enemyHero" }, amount: 1 })]
              : [],
        },
      ],
    });
    placeFixture(s, "edge-r6-juggler", "p1", "units", 3);

    s.endTurn();

    // §10.3: the window's firing is an effect like any other, so the trigger its summon wakes
    // resolves before R62 moves on to the delayed effects, cleanup and the turn cap; p2 is at 0 in
    // that check and loses (§4.5 step 2) at the end of p1's turn. p2's turn never starts, so
    // Echoes never fires (R216).
    expect(s.events.some((event) => event.type === "trapFired")).toBe(true);
    expect(s.state.result?.winner).toBe("p1");
    expect(s.events.some((event) => event.type === "turnStarted" && event.player === "p2")).toBe(false);
  });

  it("R62 a trigger answering a start-of-turn delayed effect resolves before the start-of-turn triggers (R68, §6.2)", () => {
    // p1's Kpop Fanatic steals p2's Tempo Timmy at the start of p1's next turn. p1's fixture unit
    // answers the change of control with 1 damage to p2's hero, which is at 1. p1's Masochism Mask
    // (backrow) asks p1 something at the start of the turn.
    const s = scenario({
      p1: { hand: [KPOP_FANATIC, RENO], backrow: [MASOCHISM_MASK], library: [RENO, RENO] },
      p2: { field: [TEMPO_TIMMY], hand: [RENO], health: 1, library: [RENO, RENO] },
    });
    fixture(s, "edge-r6-bounty", "Unit", {
      triggers: [
        {
          id: "edge-r6-bounty",
          on: ["controlChanged"],
          run: (ctx) =>
            ctx.event.type === "controlChanged" && ctx.event.controller === ctx.controller
              ? [damage({ to: { of: "enemyHero" }, amount: 1 })]
              : [],
        },
      ],
    });
    placeFixture(s, "edge-r6-bounty", "p1", "units", 4);
    const timmy = must(s.unit("p2", 1), "p2's Tempo Timmy");
    s.play(KPOP_FANATIC, { targets: [{ pick: "instance", instanceId: timmy.id }] });

    s.startTurn();

    // §6.2 and R62: the delayed effects first, then the trigger queue. The steal's trigger is queued
    // by the steal, before the start-of-turn stage begins, and by R68 a unit's trigger comes before a
    // backrow card's anyway: p2 is at 0 in the check after it and loses before the Mask asks.
    expect(s.events.some((event) => event.type === "controlChanged" && event.instanceId === timmy.id)).toBe(true);
    expect(s.state.result?.winner).toBe("p1");
    expect(s.state.pending).toBeNull();
  });
});

describe("R44, R152: My Pawn's AI plays the rest of the turn", () => {
  it("R44 the AI turn goes on after the other player answers a prompt one of its actions opened (§10.3, §8 #96, R152)", () => {
    // p1's 3/3 Timmy swings at p2's hero at 3: lethal, so p2's My Pawn cancels it and hands the
    // rest of p1's turn to the AI (R44). p2's fixture trap asks p2 something when p1 plays a card.
    const s = scenario({
      p1: { field: [TEMPO_TIMMY], hand: [VANILLA, VANILLA, VANILLA], mana: 4 },
      p2: { health: 3, backrow: [{ def: MY_PAWN, faceUp: false }], hand: [RENO], library: [RENO, RENO] },
    });
    fixture(s, "edge-r6-asker", "Trap", {
      triggers: [
        {
          id: "edge-r6-asks",
          on: ["cardPlayed"],
          when: (ctx) => ctx.event.type === "cardPlayed" && ctx.event.player !== ctx.controller,
          run: () => [chooseMode({ options: ["ok"], step: "asked", prompt: "edge-r6: asked" })],
        },
      ],
      resume: { asked: () => [] },
    });
    placeFixture(s, "edge-r6-asker", "p2", "backrow", 2);
    const turn = s.state.turn;

    s.attack(TEMPO_TIMMY, "hero");
    // The AI took p1's turn and played a card, and p2's trap is asking p2 about it.
    expect(s.state.players.p1.aiTurn).toBe(true);
    expect(s.lastEvents.some((event) => event.type === "cardPlayed" && event.player === "p1")).toBe(true);
    expect(s.state.pending?.prompt).toBe("edge-r6: asked");

    s.answer("ok");

    // §10.3: the trap resolves to completion, its prompt included, and then the action it
    // interrupted continues — here the AI turn (§8 #96: "an AI plays the rest of their turn"). The
    // AI goes on until it ends p1's turn, which is where R152 ends the lockout; p1's own client is
    // never handed the turn back.
    expect(s.state.turn).toBeGreaterThan(turn);
    expect(s.state.players.p1.aiTurn).toBe(false);
  });
});

describe("R44, R152: a locked-out player is never handed back the turn My Pawn gave the AI", () => {
  it("R44 once the other player answers a prompt the AI turn ran into, the rest of the turn is still the AI's (§8 #96, R152)", () => {
    // The seed only fixes which of p1's actions the AI draws: here it attacks the fixture unit with
    // one of its 1/1s early in the playout, with plays and switches still left to take.
    const s = scenario({
      seed: "edge-r6-pawn-1",
      p1: {
        field: [SEVEN_SEVEN, KPOP_FANATIC, GARY],
        hand: [VANILLA, VANILLA],
        library: [RENO, RENO, RENO],
      },
      p2: {
        health: 5,
        backrow: [{ def: MY_PAWN, faceUp: false }],
        hand: [RENO],
        library: [RENO, RENO, RENO],
      },
    });
    // p2's 1/1 whose Death asks its controller something.
    fixture(
      s,
      "edge-r6-asking-death",
      "Unit",
      { death: () => [chooseMode({ options: ["keep", "drop"], step: "picked" })], resume: { picked: () => [] } },
      { attack: 1, health: 1 },
    );
    placeFixture(s, "edge-r6-asking-death", "p2", "units", 3);

    // A lethal swing: My Pawn cancels it, and the AI plays out the rest of p1's turn (R44).
    s.attack("4-mana 7/7", "hero");
    expect(s.state.players.p1.aiTurn).toBe(true);
    // The AI killed the fixture unit, whose Death asks p2: the AI turn waits on p2's answer.
    expect(s.state.pending?.playerId).toBe("p2");

    s.answer("keep");

    // R44: "it plays out the turn while the opponent is locked out", and R152 ends the lockout only
    // at the cleanup of that turn. So p1 is never offered, and never allowed, an action of its own
    // on this turn: the AI finishes it, whatever p2 was asked on the way.
    const offered = legalActions(s.state, "p1").filter((action) => TURN_ACTIONS.includes(action.type));
    expect(offered, `p1 is locked out on turn ${s.state.turn}, yet offered its own turn`).toEqual([]);
    const own = reduce(s.state, { type: "endTurn", playerId: "p1", nonce: "edge-r6-locked-out" });
    expect(own.error, "reduce accepted an action from the locked-out player").toBeDefined();
  });
});

describe("§10.3, R68: a trap answers a delayed effect before the next delayed effect runs", () => {
  it("R68 a trap answering the first of two start-of-turn delayed steals fires before the second steal (§10.3, R59, R76)", () => {
    // p1 plays two Kpop Fanatics: one on p2's Mr. Vanilla, one on p2's Tempo Timmy. Both steals are
    // due at the start of p1's next turn, in that order (R68). p2's fixture trap answers the
    // opponent taking one of p2's permanents by returning all of p2's units to p2's hand.
    const s = scenario({
      p1: { hand: [KPOP_FANATIC, KPOP_FANATIC, RENO], library: [RENO, RENO, RENO] },
      p2: { field: [VANILLA, TEMPO_TIMMY], hand: [RENO], library: [RENO, RENO, RENO] },
    });
    fixture(s, "edge-r7-reclaimer", "Trap", {
      triggers: [
        {
          id: "edge-r7-reclaim",
          on: ["controlChanged"],
          when: (ctx) => ctx.event.type === "controlChanged" && ctx.event.controller !== ctx.controller,
          run: () => [bounceAll({ side: "self" })],
        },
      ],
    });
    placeFixture(s, "edge-r7-reclaimer", "p2", "backrow", 1);
    const vanilla = must(s.unit("p2", 1), "p2's Mr. Vanilla");
    const timmy = must(s.unit("p2", 2), "p2's Tempo Timmy");
    s.play(KPOP_FANATIC, { targets: [{ pick: "instance", instanceId: vanilla.id }] });
    s.play(KPOP_FANATIC, { targets: [{ pick: "instance", instanceId: timmy.id }] });

    // p1's turn ends, p2 passes, and p1's next turn starts with the two steals.
    s.endTurn();
    s.endTurn();
    expect(s.state.active).toBe("p1");

    // The first steal takes Mr. Vanilla. §10.3: its event goes to the traps, which fire at once —
    // a delayed effect is a whole effect like any other (R59), and a trap is a response — so p2's
    // trap returns Tempo Timmy to p2's hand before the second delayed effect runs, and that steal
    // fizzles on a target that has left the field (R76, R174).
    expect(s.events.some((event) => event.type === "trapFired")).toBe(true);
    s.expectInZone(timmy, "hand");
    expect(s.card(timmy).owner).toBe("p2");
    expect(
      s.events.some((event) => event.type === "controlChanged" && event.instanceId === timmy.id),
      "the second delayed steal ran before the trap answered the first",
    ).toBe(false);
  });
});

describe("R62, §10.3: cleanup's events are answered before the turn-cap check and the next turn", () => {
  it("R62 a trigger answering My Pawn reaching the graveyard at cleanup resolves before the next turn starts (R152, §10.3)", () => {
    // p1's Tempo Timmy (3/3) swings at p2's hero at 3: lethal, so p2's My Pawn cancels it and the AI
    // plays the rest of p1's turn (R44). p1 has nothing left to do, so the AI ends the turn, and
    // R152 sends My Pawn to p2's graveyard at that turn's cleanup. p2's fixture unit answers a card
    // entering p2's graveyard with 1 damage to the enemy hero, and p1 is at 1.
    const s = scenario({
      p1: { field: [TEMPO_TIMMY], health: 1, library: [RENO, RENO] },
      p2: { health: 3, backrow: [{ def: MY_PAWN, faceUp: false }], hand: [RENO], library: [RENO, RENO] },
    });
    fixture(s, "edge-r7-grave-watcher", "Unit", {
      triggers: [
        {
          id: "edge-r7-grave-watch",
          on: ["enteredGraveyard"],
          run: (ctx) =>
            ctx.event.type === "enteredGraveyard" && ctx.event.owner === ctx.controller
              ? [damage({ to: { of: "enemyHero" }, amount: 1 })]
              : [],
        },
      ],
    });
    placeFixture(s, "edge-r7-grave-watcher", "p2", "units", 3);
    const pawn = must(s.backrow("p2", 1), "p2's My Pawn");

    s.attack(TEMPO_TIMMY, "hero");

    // My Pawn reached p2's graveyard at p1's cleanup (R152), and the trigger answering it killed p1.
    expect(s.events.some((event) => event.type === "enteredGraveyard" && event.instanceId === pawn.id)).toBe(true);
    expect(s.state.result?.winner).toBe("p2");
    // §10.3, R62: cleanup is a stage of p1's turn like the window and the delayed effects, so what
    // its events wake resolves there — p1 loses at the end of p1's turn, and p2's turn never starts.
    expect(
      s.events.some((event) => event.type === "turnStarted" && event.player === "p2"),
      "p2's turn started before the trigger answering p1's cleanup resolved",
    ).toBe(false);
  });
});

describe("R68, §4.5: a delayed effect's check is answered before the next delayed effect", () => {
  it("R68 a trap answering a death the first start-of-turn delayed effect caused fires before the second delayed effect (§10.3, §4.5)", () => {
    // p2's radiant Suppressive Aura shrinks p2's enemies by -4/-4. p1's two Kpop Fanatics take p2's
    // Tempo Timmy and then p2's Mr. Vanilla at the start of p1's next turn, in that order (R68).
    // Timmy (3/3) stolen onto p1's side is -1 health there and dies in the check after the first
    // steal. p2's fixture trap answers one of p2's own units dying by returning p2's units to hand.
    const s = scenario({
      p1: { hand: [KPOP_FANATIC, KPOP_FANATIC, RENO], mana: 5, library: [RENO, RENO, RENO] },
      p2: {
        field: [TEMPO_TIMMY, VANILLA],
        backrow: [{ def: SUPPRESSIVE_AURA, radiant: true }],
        hand: [RENO],
        library: [RENO, RENO, RENO],
      },
    });
    fixture(s, "edge-r8-mourner", "Trap", {
      triggers: [
        {
          id: "edge-r8-mourn",
          on: ["destroyed"],
          when: (ctx) => ctx.event.type === "destroyed" && ctx.event.owner === ctx.controller,
          run: () => [bounceAll({ side: "self" })],
        },
      ],
    });
    placeFixture(s, "edge-r8-mourner", "p2", "backrow", 3);
    const timmy = must(s.unit("p2", 1), "p2's Tempo Timmy");
    const vanilla = must(s.unit("p2", 2), "p2's Mr. Vanilla");
    s.play(KPOP_FANATIC, { targets: [{ pick: "instance", instanceId: timmy.id }] });
    s.play(KPOP_FANATIC, { targets: [{ pick: "instance", instanceId: vanilla.id }] });

    // p1 keeps 3 mana for Reno, so the turn does not end by itself (R82); p2 passes.
    s.endTurn();
    s.endTurn();
    expect(s.state.active).toBe("p1");

    // The first steal takes Timmy, which dies in the check that follows that whole delayed effect
    // (§4.5, R59). §10.3: a trap is a response and fires at once, and R68 has each delayed effect's
    // consequences answered before the next delayed effect resolves, as settle dispatches a check's
    // deaths before anything else pops. So p2's trap returns Mr. Vanilla to p2's hand, and the
    // second steal fizzles on a target that has left the field (R76, R174).
    expect(s.events.some((event) => event.type === "destroyed" && event.instanceId === timmy.id)).toBe(true);
    expect(s.events.some((event) => event.type === "trapFired")).toBe(true);
    expect(
      s.events.some((event) => event.type === "controlChanged" && event.instanceId === vanilla.id),
      "the second delayed steal ran before the trap answered the death the first one caused",
    ).toBe(false);
    s.expectInZone(vanilla, "hand");
  });
});

describe("§2.2, R62: a 'this turn' effect made after cleanup ends with that turn", () => {
  it("R62 a 'this turn' discount made while cleanup's events are answered ends with that turn instead of lasting for good (§2.2)", () => {
    // p1 plays Lunar Eclipse on turn N and plays no Spell after it, so cleanup expires its discount
    // (§2.2) and reports the removal. p1's fixture unit answers one of p1's modifiers ending, on turn
    // N only, with "this turn your cards cost 1 less" (/fullsend's rider) for the turn that is ending.
    // Round 7 made cleanup's events answered at the end of turn N (R62), which is where it lands.
    const s = scenario({
      p1: { hand: [LUNAR_ECLIPSE, RENO, RENO], library: [RENO, RENO, RENO] },
      p2: { hand: [RENO], library: [RENO, RENO, RENO] },
    });
    const turnN = s.state.turn;
    fixture(s, "edge-r8-afterglow", "Unit", {
      triggers: [
        {
          id: "edge-r8-afterglow",
          on: ["modifierChanged"],
          run: (ctx) =>
            ctx.event.type === "modifierChanged" &&
            ctx.event.player === ctx.controller &&
            !ctx.event.added &&
            ctx.state.turn === turnN
              ? [
                  addPlayerModifier({
                    player: "self",
                    mod: { kind: "costDiscount", amount: 1, expiry: { until: "thisTurn", turn: ctx.state.turn } },
                  }),
                ]
              : [],
        },
      ],
    });
    placeFixture(s, "edge-r8-afterglow", "p1", "units", 3);

    s.play(LUNAR_ECLIPSE, { targets: [{ pick: "hero", player: "p2" }] });
    // p1 keeps 3 mana for Reno (no R82 auto-end), ends turn N; p2 ends turn N+1.
    s.endTurn();
    expect(s.state.turn).toBe(turnN + 1);
    s.endTurn();
    expect({ turn: s.state.turn, active: s.state.active }).toEqual({ turn: turnN + 2, active: "p1" });

    // §2.2: "Cleanup expires every 'this turn' effect". Whatever was made for turn N lasts at most
    // to the end of turn N — two turns on, p1's Reno costs its printed 3, and no turn-N rider is left.
    const leftover = s.state.players.p1.mods.filter(
      (mod) => mod.kind === "costDiscount" && mod.expiry.until === "thisTurn" && mod.expiry.turn === turnN,
    );
    expect(leftover, "a turn-N 'this turn' discount is still live on turn N+2").toEqual([]);
    const reno = must(s.hand("p1").find((card) => card.defId === RENO), "p1's Reno");
    expect(effectiveCost(s.state, reno)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Round 9: a Spell's clauses belong to the turn it was played on (R155, R241, §6.2, R62)
// ---------------------------------------------------------------------------

const PREM_PANTHER = "core-032"; // 5/4 Rush; whenever this destroys a unit, draw 2
const TIMMY = "core-011"; // Tempo Timmy, 3/3 Rush, First Strike




/** Put a fresh instance of `defId` on top of a player's library (index 0 is the top, §3). */
function onTopOfLibrary(s: Scenario, defId: string, player: PlayerId): CardInstance {
  const card = newInstance(s.state, defId, player, { z: "library", player });
  s.state.players[player].library.unshift(card);
  return card;
}

describe("R155: a return Spell cast after cleanup does not come back on a later turn", () => {
  it("R155 a Spell with an end-of-turn return cast while cleanup's events are answered stays in the graveyard at the end of its caster's next turn (§5.1, R62)", () => {
    // p1 plays Lunar Eclipse on turn N and no Spell after it, so cleanup expires its discount and
    // reports the removal (§2.2). p1's fixture unit answers that removal, on turn N only, by drawing
    // a card: p1's fixture Spell, cast on draw (§2.4, R70), whose text is #23's "End of turn: returns
    // from the GY to your hand". Round 7 made cleanup's events answered at the end of turn N (R62),
    // so the Spell is played on turn N, after that turn's end-of-turn triggers have run: it does not
    // come back at the end of turn N, and R155 says it "stays in the graveyard rather than coming
    // back at the end of a later turn it was not played on".
    const s = scenario({
      p1: { hand: [LUNAR_ECLIPSE, RENO, RENO], library: [RENO, RENO, RENO] },
      p2: { hand: [RENO], library: [RENO, RENO, RENO] },
    });
    const turnN = s.state.turn;

    // #23's return, verbatim in shape: the flag §10.5 step 7 writes, or a play this turn (R155).
    fixture(s, "edge-r9-boomerang", "Spell", {
      staticFlags: { castOnDraw: true },
      cry: () => [],
      endOfTurn: (ctx) => {
        const self = ctx.self;
        if (self === null) return [];
        const returns =
          self.returnToHandAtEndOfTurn === true || wasPlayedThisTurn(ctx.state, self.controller, self);
        return returns ? [bounce({ target: { of: "self" } })] : [];
      },
    });
    fixture(s, "edge-r9-cleanup-reader", "Unit", {
      triggers: [
        {
          id: "edge-r9-cleanup-reader",
          on: ["modifierChanged"],
          run: (ctx) =>
            ctx.event.type === "modifierChanged" &&
            ctx.event.player === ctx.controller &&
            !ctx.event.added &&
            ctx.state.turn === turnN
              ? [draw({ count: 1 })]
              : [],
        },
      ],
    });
    placeFixture(s, "edge-r9-cleanup-reader", "p1", "units", 3);
    const boomerang = onTopOfLibrary(s, "edge-r9-boomerang", "p1");

    s.play(LUNAR_ECLIPSE, { targets: [{ pick: "hero", player: "p2" }] });
    s.endTurn();
    expect(s.state.turn).toBe(turnN + 1);
    // Cast at cleanup on turn N: it is in p1's graveyard, not back in hand.
    s.expectInZone(boomerang, "graveyard");

    s.endTurn();
    expect({ turn: s.state.turn, active: s.state.active }).toEqual({ turn: turnN + 2, active: "p1" });
    // p2's turn end is not p1's (§6.2): the Spell is still in the graveyard as p1's turn N+2 begins.
    s.expectInZone(boomerang, "graveyard");
    s.endTurn();
    expect(s.state.turn).toBe(turnN + 3);

    // The end of turn N+2 is p1's own turn end, but the Spell was not played on it.
    expect(
      must(s.card(boomerang), "the fixture Spell").zone.z,
      "the Spell cast at turn N's cleanup came back at the end of turn N+2",
    ).toBe("graveyard");
  });
});

describe("R241: a Spell's end-of-turn clause belongs to the turn it was played on (§6.2, R155, R71)", () => {
  it("R241 a Spell cast on the opponent's turn with #78's 'at end of turn, exile your hand' does not exile its caster's hand at the end of the caster's next turn (§6.2, R155, R70)", () => {
    // p2's Tempo Timmy (3/3 First Strike) attacks p1's Prem Panther (5/4): the Panther survives the
    // first strike and kills Timmy, so p1 draws 2 on p2's turn (#32). The top card is a cast-on-draw
    // Spell carrying /fullsend's clause verbatim in shape — `delay({ at: { phase: "end", player:
    // "self" } })` re-entering an `exileHand` step — so p1 casts it on p2's turn (§2.4, R70).
    const s = scenario({
      active: "p2",
      p1: { field: [PREM_PANTHER], hand: [RENO], library: [RENO, RENO, RENO, RENO] },
      p2: { field: [TIMMY], hand: [RENO], library: [RENO, RENO, RENO, RENO] },
    });
    fixture(s, "edge-r9-late-exile", "Spell", {
      staticFlags: { castOnDraw: true },
      cry: () => [delay({ at: { phase: "end", player: "self" }, step: "exile", hook: RESUME_HOOK })],
      resume: { exile: () => [exileHand({ player: "self" })] },
    });
    const cod = onTopOfLibrary(s, "edge-r9-late-exile", "p1");

    s.attack(TIMMY, PREM_PANTHER);
    expect(s.events.some((event) => event.type === "cardPlayed" && event.instanceId === cod.id)).toBe(true);

    // p2's turn (the one the Spell was cast on) ends, and p1's next turn starts with its draw.
    s.endTurn();
    expect(s.state.active).toBe("p1");
    const drawnOnOwnTurn = must(s.hand("p1").at(-1), "the card p1 drew at the start of its turn");

    // p1's own turn ends. §6.2 makes "End of turn" the controller's turn end, and R155 reads it for
    // a Spell cast on the other player's turn: that turn's end is not its controller's, so nothing of
    // the clause happens "at the end of a later turn it was not played on". /fullsend's own riders
    // say the same: its "this turn" discount and Combo draw were p2's turn's and ended with it
    // (§2.2), so an exile at the end of p1's turn is an exile no "this turn" of the card ever
    // covered — and #39's "every other card you played this turn" would read a turn log the Spell
    // was never in (R71).
    s.endTurn();
    expect(s.state.active).toBe("p2");
    expect(
      must(s.card(drawnOnOwnTurn), "p1's card").zone.z,
      "the end-of-turn clause of a Spell cast on p2's turn exiled p1's hand at the end of p1's next turn",
    ).toBe("hand");
  });
});

// ---------------------------------------------------------------------------
// Round 9: the start of a turn reports what it changes (R169, R240, §10.3)
// ---------------------------------------------------------------------------

const HINDER = "core-021"; // Cast on draw: the opponent's next mana refresh is 1 lower
const HIT_JOB = "core-016"; // a Spell with no hand trigger
const STOCKPILE = "core-005"; // likewise
const GOING_LONG = "core-084"; // Field Spell: your hero has Armor 2

describe("R169, R240: what the start of a turn changes, it reports (§10.3)", () => {
  it("R169 every modifier a modifierChanged event announces is on the view's badge list, and is reported gone when Hinder's refresh spends it (§10.3, §6.3 Mana)", () => {
    const s = scenario({
      seed: "r9-inv-hinder",
      p1: { hand: [HIT_JOB], field: [TEMPO_TIMMY], library: [HINDER, TEMPO_TIMMY, TEMPO_TIMMY, TEMPO_TIMMY] },
      p2: { hand: [STOCKPILE], field: [TEMPO_TIMMY], library: [STOCKPILE, STOCKPILE, STOCKPILE] },
    });
    s.endTurn(); // p2's turn
    s.endTurn(); // p1's draw casts Hinder: p2's next refresh is 1 lower (§8 #21)

    // BUILD M5-T4: `modifierChanged` is the badge by the hero appearing or fading, and "badge list
    // equals the view's modifiers"; R169 puts that list on both seats under the id the event names.
    const announced = s.events.flatMap((e) =>
      e.type === "modifierChanged" && e.player === "p2" && e.added ? [e.modifierId] : [],
    );
    for (const id of announced) {
      expect(s.view("p2").you.modifiers.map((m) => m.id), `announced ${id}`).toContain(id);
      expect(s.view("p1").opponent.modifiers.map((m) => m.id), `announced ${id}`).toContain(id);
    }

    s.endTurn(); // p2's refresh spends the rider
    s.expectMana("p2", 3);
    // Whatever was announced as added and is not on the list any more was reported gone (§10.3).
    const listed = s.view("p2").you.modifiers.map((m) => m.id);
    for (const id of announced.filter((added) => !listed.includes(added))) {
      expect(
        s.events.some((e) => e.type === "modifierChanged" && e.player === "p2" && e.modifierId === id && !e.added),
        `removal of ${id}`,
      ).toBe(true);
    }
  });

  it("R240 a fatigue draw that Going Long's Armor absorbs still reports itself, since the public fatigue count moved (§10.3, R3)", () => {
    const s = scenario({
      seed: "r9-inv-fatigue",
      p1: { hand: [HIT_JOB], field: [TEMPO_TIMMY], library: [TEMPO_TIMMY, TEMPO_TIMMY] },
      p2: { hand: [STOCKPILE], field: [TEMPO_TIMMY], backrow: [GOING_LONG], library: [] },
    });
    expect(s.view("p1").opponent.hero.armor).toBe(2);
    expect(s.view("p1").opponent.fatigueCount).toBe(0);

    s.endTurn(); // p2's turn: its draw meets an empty library, and the 1st fatigue deals 1 (R3)

    // Armor 2 takes the whole 1 (§4.4 step 2), so the hero keeps 30, and the hit is no damage
    // instance (R63). The fatigue still happened: the count both seats read went from 0 to 1, and
    // the next one deals 2.
    expect(s.state.players.p2.hero.health).toBe(30);
    expect(s.state.players.p2.fatigueCount).toBe(1);
    expect(s.view("p1").opponent.fatigueCount).toBe(1);
    // §10.3: "every visible state change emits an event", so the draw reports itself — by a
    // `damage` of 0 from no source on p2's hero, once, and by nothing else: R3 draws no card, so
    // there is no `drawn` for p2.
    expect(s.lastEvents.filter((e) => e.type === "damage" && e.targetId === "hero-p2")).toEqual([
      { type: "damage", sourceId: null, targetId: "hero-p2", amount: 0, combat: false },
    ]);
    expect(s.lastEvents.some((e) => e.type === "drawn" && e.player === "p2")).toBe(false);
  });

  it("R240 the report of an absorbed fatigue draw is answered by no trigger and no trap (R63)", () => {
    const s = scenario({
      seed: "r11-fatigue-report",
      p1: { hand: [HIT_JOB], field: [TEMPO_TIMMY], library: [TEMPO_TIMMY, TEMPO_TIMMY] },
      p2: { hand: [STOCKPILE], field: [TEMPO_TIMMY], backrow: [GOING_LONG], library: [] },
    });
    // p1's unit and p1's face-down trap each answer any hit on a hero by dealing 1 to p2's hero.
    const onHeroHit = (ctx: { event: { type: string; targetId?: string } }): boolean =>
      ctx.event.type === "damage" && (ctx.event.targetId ?? "").startsWith("hero-");
    fixture(s, "fixture:r11-hero-hit-watcher", "Unit", {
      triggers: [
        {
          id: "on-hero-hit",
          on: ["damage"],
          run: (ctx) => (onHeroHit(ctx) ? [damage({ to: { of: "enemyHero" }, amount: 1 })] : []),
        },
      ],
    });
    fixture(s, "fixture:r11-hero-hit-trap", "Trap", {
      triggers: [
        {
          id: "on-hero-hit",
          on: ["damage"],
          when: onHeroHit,
          run: () => [damage({ to: { of: "enemyHero" }, amount: 1 })],
        },
      ],
    });
    const watcher = placeFixture(s, "fixture:r11-hero-hit-watcher", "p1", "units", 3);
    const trap = placeFixture(s, "fixture:r11-hero-hit-trap", "p1", "backrow", 3);
    trap.faceUp = false;

    s.endTurn(); // p2's draw meets an empty library; Going Long's Armor 2 takes the whole 1

    // The draw is reported by a `damage` of 0, and it is no damage instance (R63): the unit queues
    // nothing for it, the trap stays set, and p2's hero keeps its 30.
    expect(s.lastEvents.filter((e) => e.type === "damage" && e.targetId === "hero-p2")).toEqual([
      { type: "damage", sourceId: null, targetId: "hero-p2", amount: 0, combat: false },
    ]);
    expect(s.lastEvents.some((e) => e.type === "damage" && e.sourceId === watcher.id)).toBe(false);
    expect(s.lastEvents.some((e) => e.type === "trapFired")).toBe(false);
    expect(s.backrow("p1", 3)?.id).toBe(trap.id);
    expect(s.state.players.p2.hero.health).toBe(30);
  });
});
