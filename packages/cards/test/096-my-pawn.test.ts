// #96 My Pawn — SPEC §8.5, §4.2 step 4, §6.3 "Cancel an attack", §10.7's AI bullet, R44, R84, R283.
// BUILD M4-T4 row 96: "Lethal detection accounts for armor and the cap (R44); attack cancelled;
// AI finishes the turn deterministically from the seed; opponent's actions rejected until end of
// turn". R276 gave it a Radiant face, "… cancel it, destroy the attacker, and an AI plays the rest
// of their turn …", and R283 orders it: the destroy lands after the cancel and is collected by a
// state check before the AI takes the turn. Those cases play real attacks through the harness (the
// base face's played-out behaviour is proved the same way in my-pawn.test.ts).
//
// WHY THE CONDITION IS TESTED THROUGH `when`. The card's OWN contribution to "would be lethal to
// your hero" — the whole of the M4-T4 row's first clause — is the `when` predicate, a pure function
// of the state and the event, so it is called directly here with a context built the way
// `traps.fireTrap` builds it, which pins each lethal boundary without an AI turn in the way. (This
// file was written while `reduce` could not yet fire a trap; the `it.todo`s below date from then,
// and my-pawn.test.ts now plays the base face's cancel, lockout and AI turn through real attacks.)

import { describe, expect, it } from "vitest";
import type { GameEvent, PlayerId } from "@jackioh/shared";
import type { CardInstance, TrapTrigger } from "@jackioh/engine";
import { createRng, makeContext } from "@jackioh/engine";
import { scenario, type Scenario } from "./_harness";
import { base, radiant } from "../src/scripts/096-my-pawn";

const MY_PAWN = "core-096";
/** #13 Jlockeed Shredder-10, 8/10 with no keywords: a plain 8-damage swing. */
const ATTACKER = "core-013";
/** #73 Anti-oneshot Armor: `staticFlags.antiOneshot`, so §4.4 step 3 clamps to 5 (radiant 3). */
const ANTI_ONESHOT = "core-073";
/** A 1/1 body to be attacked, so Trample excess has something to spill past (§4.4 step 9). */
const SMALL = "core-t-felinor";

/** The only trigger the card registers; `when` is where every arming condition lives (R61). */
function trigger(face: "base" | "radiant" = "base"): TrapTrigger {
  const found = (face === "base" ? base : radiant).triggers?.[0] as TrapTrigger | undefined;
  if (found === undefined) throw new Error(`#96's ${face} face registers no trigger`);
  return found;
}

function attackDeclared(attackerId: string, targetId: string, forced = false): GameEvent {
  return { type: "attackDeclared", attackerId, targetId, forced };
}

/**
 * `when` with the context `traps.fireTrap` would hand it: the trap as `self`, its controller as the
 * controller, and the event under test. Nothing is mutated — the predicate only reads.
 */
function arms(s: Scenario, event: GameEvent): boolean {
  const trap = s.card(MY_PAWN);
  const sink = { state: s.state, events: [], rng: createRng(s.state.seed, s.state.rngCursor) };
  const ctx = { ...makeContext(sink, trap, { controller: trap.controller }), event };
  const when = trigger().when;
  if (when === undefined) throw new Error("#96's trigger has no `when` predicate");
  return when(ctx);
}

/** p1 holds the trap; p2 is active and swings at p1's hero for 8. */
function swing(p1: { health: number; armor?: number; backrow?: string[]; field?: string[] }): Scenario {
  return scenario({
    seed: "my-pawn",
    active: "p2",
    p1: {
      health: p1.health,
      ...(p1.armor === undefined ? {} : { armor: p1.armor }),
      backrow: [MY_PAWN, ...(p1.backrow ?? [])],
      ...(p1.field === undefined ? {} : { field: p1.field }),
    },
    p2: { field: [ATTACKER] },
  });
}

describe("#96 My Pawn — the trigger it registers", () => {
  it("§4.2 step 4: it watches `attackDeclared`, and nothing else", () => {
    expect(trigger().on).toEqual(["attackDeclared"]);
  });

  it("R61: the arming condition is a `when` predicate, not an empty `run`", () => {
    // `traps.ts`: "`run` returning `[]` is a trap that fired for nothing — it can never mean
    // 'this event was not mine'", so a non-lethal swing must be refused before `run`.
    expect(typeof trigger().when).toBe("function");
  });

  it("R276: the radiant face registers its own trigger, on the same event and the same condition", () => {
    expect(radiant).not.toBe(base);
    expect(radiant.triggers).toHaveLength(1);
    expect(trigger("radiant").on).toEqual(trigger("base").on);
    expect(trigger("radiant").when).toBe(trigger("base").when);
  });
});

describe("#96 My Pawn — lethal detection (R44)", () => {
  it("R44 fires when the projected damage is at least the hero's health", () => {
    const s = swing({ health: 8 });
    expect(arms(s, attackDeclared(s.card(ATTACKER).id, "hero-p1"))).toBe(true);
  });

  it("R44 does not fire when the hero would survive by one", () => {
    const s = swing({ health: 9 });
    expect(arms(s, attackDeclared(s.card(ATTACKER).id, "hero-p1"))).toBe(false);
  });

  it("R44 counts Armor: 1 Armor makes the same 8-damage swing survivable at 8 health", () => {
    const armored = swing({ health: 8, armor: 1 });
    expect(arms(armored, attackDeclared(armored.card(ATTACKER).id, "hero-p1"))).toBe(false);

    // 8 − 1 Armor = 7, which is exactly lethal at 7 (§4.4 step 2, §4.5 step 2).
    const exact = swing({ health: 7, armor: 1 });
    expect(arms(exact, attackDeclared(exact.card(ATTACKER).id, "hero-p1"))).toBe(true);
  });

  it("R44 counts the Anti-oneshot cap: an 8-damage swing projects 5", () => {
    const capped = swing({ health: 8, backrow: [ANTI_ONESHOT] });
    expect(arms(capped, attackDeclared(capped.card(ATTACKER).id, "hero-p1"))).toBe(false);

    const exact = swing({ health: 5, backrow: [ANTI_ONESHOT] });
    expect(arms(exact, attackDeclared(exact.card(ATTACKER).id, "hero-p1"))).toBe(true);
  });

  it("R44 counts the radiant Anti-oneshot cap of 3", () => {
    const s = scenario({
      seed: "my-pawn-cap-3",
      active: "p2",
      p1: { health: 4, backrow: [MY_PAWN, { def: ANTI_ONESHOT, radiant: true }] },
      p2: { field: [ATTACKER] },
    });
    expect(arms(s, attackDeclared(s.card(ATTACKER).id, "hero-p1"))).toBe(false);

    const exact = scenario({
      seed: "my-pawn-cap-3",
      active: "p2",
      p1: { health: 3, backrow: [MY_PAWN, { def: ANTI_ONESHOT, radiant: true }] },
      p2: { field: [ATTACKER] },
    });
    // ANTI_ONESHOT_CAP.radiant is 3, so 3 is exactly lethal and 4 is not.
    expect(arms(exact, attackDeclared(exact.card(ATTACKER).id, "hero-p1"))).toBe(true);
  });

  it("R44 counts Trample excess from an attack on a unit, and nothing without Trample", () => {
    const s = swing({ health: 7, field: [SMALL] });
    const attacker = s.card(ATTACKER).id;
    const victim = s.card(SMALL).id;

    // §4.4 step 9 sends only the excess on: 8 − the 1/1's 1 health = 7, exactly lethal at 7.
    // Granting the keyword on a fixture is a test's business, not a card's (CLAUDE.md rule 5).
    s.card(ATTACKER).grantedKeywords = [{ kind: "Trample" }];
    expect(arms(s, attackDeclared(attacker, victim))).toBe(true);

    const plain = swing({ health: 7, field: [SMALL] });
    // No Trample: the hit stops on the unit, so no hero damage is projected at all.
    expect(arms(plain, attackDeclared(plain.card(ATTACKER).id, plain.card(SMALL).id))).toBe(false);
  });
});

describe("#96 My Pawn — whose attack it answers", () => {
  it("§8.5 'the opponent declares': it never answers its own controller's attack", () => {
    const s = scenario({
      seed: "my-pawn-own",
      active: "p1",
      p1: { health: 8, backrow: [MY_PAWN], field: [ATTACKER] },
      p2: { health: 8 },
    });
    // p1's own 8-damage swing would be lethal to p2, and p1's trap is not interested.
    expect(arms(s, attackDeclared(s.card(ATTACKER).id, "hero-p2"))).toBe(false);
  });

  it("R121 a forced attack is declared by the effect, not the player, so a trigger keyed to an opponent's declaration does not arm", () => {
    const s = swing({ health: 8 });
    // §4.2's last paragraph and R53: a forced attack skips steps 1 to 3 and spends no exertion, and
    // it can happen on the trap owner's own turn, where "an AI plays the rest of their turn" names
    // nobody. `forced` is on the event for exactly this distinction.
    expect(arms(s, attackDeclared(s.card(ATTACKER).id, "hero-p1", true))).toBe(false);
  });

  it("R44 'lethal to YOUR hero': the hero the projection reaches is the one that matters", () => {
    const s = scenario({
      seed: "my-pawn-other-hero",
      active: "p2",
      // p1 holds the trap at 1 health, so anything reaching it would be lethal.
      p1: { health: 1, backrow: [MY_PAWN] },
      // p2's Trample attacker aimed at a unit of p2's OWN: §4.4 step 9 sends the excess to "the
      // target's controller's hero", which is p2's, so p1's trap has nothing to answer.
      p2: { health: 30, field: [ATTACKER, SMALL] },
    });
    const attacker = s.unit("p2", 1);
    const victim = s.unit("p2", 2);
    expect(attacker).not.toBeNull();
    expect(victim).not.toBeNull();
    if (attacker !== null) attacker.grantedKeywords = [{ kind: "Trample" }];

    expect(arms(s, attackDeclared(attacker?.id ?? "", victim?.id ?? ""))).toBe(false);
  });
});

describe("#96 My Pawn — the body of the trap", () => {
  it.todo(
    "R44 cancels the declared attack so no combat resolves and `attackCancelled` is emitted — " +
      "blocked on a `cancelAttack()` effect, on `GameState.declaredAttack` (§10.1), and on " +
      "`combat.declareAttack` opening §4.2 step 4's trap window before `resolveCombat`",
  );

  it.todo(
    "R44 the attacker's exertion is not given back, so the attack is gone either way — " +
      "blocked on the same trap window",
  );

  it.todo(
    "R44, R84 an AI plays the rest of the opponent's turn with random legal actions, the same " +
      "actions for the same seed, never `concede`/`offerDraw`/`answerDraw` (AI_SKIPPED_ACTIONS) — " +
      "blocked on an `aiPlaysOutTurn()` effect over `subsystems/aiPolicy.playOutTurn`",
  );

  it.todo(
    "R44 the opponent's client is locked out until end of turn (`aiTurn` on their PlayerState) — " +
      "blocked on nothing in the engine ever setting `aiTurn` true (`turn.ts` only clears it)",
  );

  it.todo(
    "§3.2, R33 the trap is consumed and face-up once it fires, and a non-lethal declaration leaves " +
      "it armed and face-down — blocked on `reduce`'s `attack` case, which still answers 'combat " +
      "arrives with M2', so no `attackDeclared` event reaches `traps.fireTrapsFor` in a scenario",
  );
});

// ---------------------------------------------------------------------------------------------
// Radiant: "cancel it, destroy the attacker, and an AI plays the rest of their turn" (R283)
// ---------------------------------------------------------------------------------------------

/** #68, a 5/5 with nothing that fires in combat: the plain lethal swing at a 5-health hero. */
const SORCERER = "core-068";
/** #81 Radiant Saintess, 2/2 Reborn: lethal at 2 health, and back at 1 health when destroyed. */
const SAINTESS = "core-081";
/** #56 Jilliax: its radiant face is a 6/4 with Charge, Taunt, Lifesteal and Indestructible. */
const JILLIAX = "core-056";
/** Cards for the AI's turn, as the other My Pawn tests give it (my-pawn.test.ts). */
const STOCKPILE = "core-005";
const TIMMY = "core-011";
const GIGA = "core-029";

/**
 * p1 swings `attacker` from lane 1 at p2's hero, which is at `health` behind a face-down My Pawn of
 * the given face. p1 holds cards for the AI turn the trap hands over.
 */
function pawnGame(
  attacker: string | { def: string; radiant: true },
  health: number,
  face: "base" | "radiant" = "radiant",
): { s: Scenario; attacker: CardInstance } {
  const s = scenario({
    seed: "my-pawn-r283",
    p1: { field: [attacker], hand: [STOCKPILE, TIMMY], library: [GIGA, GIGA, GIGA] },
    p2: {
      health,
      hand: [STOCKPILE],
      backrow: [{ def: MY_PAWN, lane: 1, faceUp: false, radiant: face === "radiant" }],
      library: [GIGA, GIGA],
    },
  });
  const unit = s.unit("p1", 1);
  if (unit === null) throw new Error("p1 should have an attacker in lane 1");
  s.attack(unit, "hero");
  return { s, attacker: unit };
}

/** The event types from the trap's cancel on, `count` of them: what the trap's list did first. */
function fromCancel(s: Scenario, count: number): string[] {
  const at = s.events.findIndex((event) => event.type === "attackCancelled");
  if (at < 0) throw new Error("no attack was cancelled");
  return s.events.slice(at, at + count).map((event) => event.type);
}

function eventsOn(s: Scenario, id: string, type: GameEvent["type"]): number {
  return s.events.filter((event) => event.type === type && "instanceId" in event && event.instanceId === id).length;
}

function turnWentOn(s: Scenario, from: PlayerId): void {
  // The AI played the rest of the turn out and ended it (R44, R152).
  expect(s.events.some((event) => event.type === "turnEnded")).toBe(true);
  expect(s.state.active).not.toBe(from);
  expect(s.state.players[from].aiTurn).toBe(false);
}

describe("#96 My Pawn — radiant (R283)", () => {
  it("R283 cancels the lethal attack, then destroys the attacker, and the check collects it before the AI takes the turn", () => {
    const { s, attacker } = pawnGame(SORCERER, 5);

    // Cancelled: no combat, so the hero took nothing (R44).
    s.expectHealth("p2", 5);
    expect(s.events.filter((event) => event.type === "attackCancelled")).toHaveLength(1);
    expect(s.events.some((event) => event.type === "damage")).toBe(false);

    // The attacker is destroyed, after the cancel, and collected right then — before any event of
    // the AI's turn.
    expect(fromCancel(s, 3)).toEqual(["attackCancelled", "destroyed", "enteredGraveyard"]);
    expect(eventsOn(s, attacker.id, "destroyed")).toBe(1);
    s.expectInZone(attacker, "graveyard");

    // …and the AI still plays out the rest of the turn.
    turnWentOn(s, "p1");
  });

  it("R283 the destroy is ordinary: a Reborn attacker comes back, before the AI takes the turn", () => {
    const { s, attacker } = pawnGame(SAINTESS, 2);

    s.expectHealth("p2", 2);
    // §4.5 step 4: Reborn returns it to the zone it reserved (R64), at 1 health, straight after the
    // collection and ahead of the AI turn.
    expect(fromCancel(s, 3)).toEqual(["attackCancelled", "destroyed", "summoned"]);
    expect(s.card(attacker).rebornSpent).toBe(true);
    s.expectInZone(attacker, "field");
    turnWentOn(s, "p1");
  });

  it("R283, R46 an Indestructible attacker is knocked down instead, and the attack is cancelled either way", () => {
    const { s, attacker } = pawnGame({ def: JILLIAX, radiant: true }, 6);

    // Cancelled: the 6 never landed, so its Lifesteal had nothing to heal off.
    s.expectHealth("p2", 6);
    expect(s.events.some((event) => event.type === "damage" && event.sourceId === attacker.id)).toBe(false);

    // R46: the mark does not kill it. It is in Attack Position already, so the knock-down reports
    // only the Taunt it loses, and it does so before the AI takes the turn.
    expect(fromCancel(s, 2)).toEqual(["attackCancelled", "keywordGranted"]);
    const lost = s.events.find(
      (event) => event.type === "keywordGranted" && event.instanceId === attacker.id,
    );
    expect(lost?.type === "keywordGranted" && lost.keyword.kind === "Taunt" && lost.lost === true).toBe(true);
    expect(eventsOn(s, attacker.id, "destroyed")).toBe(0);
    s.expectInZone(attacker, "field");
    turnWentOn(s, "p1");
  });

  it("the base face does not destroy the attacker: it only cancels and hands the turn over", () => {
    const { s, attacker } = pawnGame(SORCERER, 5, "base");

    s.expectHealth("p2", 5);
    expect(eventsOn(s, attacker.id, "destroyed")).toBe(0);
    s.expectInZone(attacker, "field");
    turnWentOn(s, "p1");
  });

  it("R61 a non-lethal swing leaves the radiant trap armed and the attacker standing", () => {
    const { s, attacker } = pawnGame(SORCERER, 30);

    s.expectHealth("p2", 25);
    expect(s.events.some((event) => event.type === "trapFired")).toBe(false);
    expect(s.backrow("p2", 1)?.faceUp).toBe(false);
    s.expectInZone(attacker, "field");
  });
});
