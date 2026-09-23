// #96 My Pawn after it has fired: the window it leaves behind, and where the trap ends up (SPEC §3.2,
// §4.2 step 4, §5.1, §6.3 "Cancel an attack" and Exile, R44, R99, R152). Found by the polish-4
// edge-case hunt, round 2 (docs/polish/4-edge-cases.md, lenses L5 and L7); every case here failed
// before its fix.
//
//  - §4.2 step 4, §6.3: a cancelled attack resolves no combat, so it "would be lethal" to nobody and
//    a second My Pawn stays armed (R99) — the window no longer offers it the declaration, and it
//    reads the trap as the board holds it after the first one's AI turn, not as it was before.
//  - §3.2, §6.3 Exile: a My Pawn its own AI turn exiled stays in exile.
//  - R152, §3.2: its effect is the rest of the turn it took, so it is in the graveyard by the time
//    the next turn starts.

import type { CardInstance } from "@jackioh/engine";
import type { GameEvent } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

const STOCKPILE = "core-005";
const SEVEN_SEVEN = "core-025";
const GIGA = "core-029";
const COLLATERAL = "core-034";
const GRAVEDIGGER = "core-037";
const RENO = "core-053";
const SORCERER = "core-068";
const MY_PAWN = "core-096";

function count(s: Scenario, type: GameEvent["type"]): number {
  return s.events.filter((event) => event.type === type).length;
}

function backrowAt(s: Scenario, player: "p1" | "p2", lane: number): CardInstance {
  const card = s.backrow(player, lane);
  if (card === null) throw new Error(`setup: ${player} should hold a backrow card in lane ${lane}`);
  return card;
}

describe("§4.2 step 4: the window after a cancel", () => {
  it("§6.3 a second My Pawn does not fire on an attack the first one already cancelled (§4.2 step 4, R99)", () => {
    const s = scenario({
      seed: "hunt-cw2-two-pawns",
      p1: { field: [SORCERER], library: [GIGA, GIGA, GIGA] },
      p2: {
        health: 5,
        hand: [STOCKPILE],
        backrow: [
          { def: MY_PAWN, lane: 1, faceUp: false },
          { def: MY_PAWN, lane: 2, faceUp: false },
        ],
        library: [GIGA, GIGA],
      },
    });
    const first = backrowAt(s, "p2", 1);
    const second = backrowAt(s, "p2", 2);

    s.attack(SORCERER, "hero");

    const fired = s.events.flatMap((event) => (event.type === "trapFired" ? [event.instanceId] : []));
    expect(fired).toEqual([first.id]);
    s.expectInZone(first, "graveyard");
    expect(s.backrow("p2", 2)?.id).toBe(second.id);
    expect(s.backrow("p2", 2)?.faceUp).toBe(false);
    expect(count(s, "attackCancelled")).toBe(1);
  });

  it("R152 a second My Pawn does not hand the player's next turn to the AI after the first one's turn is over (R44)", () => {
    // p2 has nothing to do on turn 10, so R82 ends it inside the first My Pawn's AI turn and p1's
    // turn 11 begins. That turn is p1's own: nothing may play it for them.
    const s = scenario({
      seed: "hunt-cw2-two-pawns-next",
      p1: { field: [SORCERER], library: [GIGA, GIGA, GIGA] },
      p2: {
        health: 5,
        backrow: [
          { def: MY_PAWN, lane: 1, faceUp: false },
          { def: MY_PAWN, lane: 2, faceUp: false },
        ],
        library: [GIGA, GIGA],
      },
    });

    s.attack(SORCERER, "hero");

    expect(s.state.result).toBeNull();
    expect(s.state.turn).toBe(11);
    expect(s.state.active).toBe("p1");
    expect(s.state.players.p1.aiTurn).toBe(false);
    expect(count(s, "trapFired")).toBe(1);
    expect(s.backrow("p2", 2)?.faceUp).toBe(false);
  });
});

describe("§3.2, §5.1: where a fired My Pawn ends up", () => {
  it("§6.3 a My Pawn exiled during its own AI turn stays in exile, it is not pulled into the graveyard (§3.2, §5.1)", () => {
    // On this seed the AI turn My Pawn hands over plays p1's Collateral Damage on the face-up My
    // Pawn itself, which is still in the backrow while its effects run: it goes to p2's exile.
    const s = scenario({
      seed: "hunt-cw2-pawn-exiled-0",
      p1: { field: [SORCERER], hand: [COLLATERAL], library: [GIGA, GIGA, GIGA] },
      p2: {
        health: 5,
        hand: [STOCKPILE],
        backrow: [{ def: MY_PAWN, lane: 1, faceUp: false }],
        library: [GIGA, GIGA, GIGA],
      },
    });
    const pawn = backrowAt(s, "p2", 1);

    s.attack(SORCERER, "hero");

    // The seed's AI does exile it; without that this test proves nothing.
    expect(s.events.some((event) => event.type === "exiled" && event.instanceId === pawn.id)).toBe(true);
    s.expectInZone(pawn, "exile");
    expect(s.events.some((event) => event.type === "enteredGraveyard" && event.instanceId === pawn.id)).toBe(false);
  });

  it("R152 My Pawn is in its owner's graveyard once the AI turn it gave has ended, before the next turn starts (§3.2, §5.1)", () => {
    // My Pawn "fires … then goes to the graveyard" (§5.1), and its effect is the rest of p1's turn,
    // which ends at p1's cleanup (R152). So by p2's start of turn it is in p2's graveyard, and p2's
    // Gravedigger ("Start of turn: add a random card from your GY to your hand") finds it there — it
    // is the only card in that graveyard.
    const g = scenario({
      seed: "pawn-gravedigger",
      p1: { field: [{ def: SEVEN_SEVEN, lane: 1 }], library: [RENO, RENO] },
      p2: {
        health: 5,
        field: [{ def: GRAVEDIGGER, lane: 1 }],
        backrow: [MY_PAWN],
        library: [RENO, RENO, RENO],
      },
    });
    const pawn = backrowAt(g, "p2", 1);

    g.attack(SEVEN_SEVEN, "hero");

    expect(g.state.active).toBe("p2");
    g.expectHealth("p2", 5);
    g.expectInZone(pawn, "hand");
  });
});
