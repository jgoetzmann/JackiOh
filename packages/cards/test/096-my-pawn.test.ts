// #96 My Pawn — SPEC §8.5, §4.2 step 4, §6.3 "Cancel an attack", §10.7's AI bullet, R44, R84.
// BUILD M4-T4 row 96: "Lethal detection accounts for armor and the cap (R44); attack cancelled;
// AI finishes the turn deterministically from the seed; opponent's actions rejected until end of
// turn".
//
// WHY THE CONDITION IS TESTED THROUGH `when` AND NOT THROUGH `s.attack(...)`.
// `reduce`'s `attack` case is still the placeholder "combat arrives with M2", so the harness falls
// back to calling `combat.declareAttack` itself — which runs no resolution loop, so no event is
// ever offered to the traps and no trap can fire in a scenario yet. On top of that, §4.2 step 4's
// trap window does not exist in `declareAttack` at all: it pushes `attackDeclared` and calls
// `resolveCombat` on the next line, so even a wired `reduce` would dispatch the event after the
// damage. The card's OWN contribution — "would be lethal to your hero", the whole of the M4-T4
// row's first clause — is the `when` predicate, and that is a pure function of the state and the
// event, so it is called directly here with a context built the way `traps.fireTrap` builds it.
// Everything downstream of `when` is `it.todo` below, blocked on the engine, never weakened.

import { describe, expect, it } from "vitest";
import type { GameEvent } from "@jackioh/shared";
import type { TrapTrigger } from "@jackioh/engine";
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
function trigger(): TrapTrigger {
  const found = base.triggers?.[0] as TrapTrigger | undefined;
  if (found === undefined) throw new Error("#96 registers no trigger");
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

  it("§8.5: no radiant form, so the radiant face runs the base script", () => {
    expect(radiant).toBe(base);
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
