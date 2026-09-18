// #75 Infinite Reserves — SPEC §8.3, BUILD M4-T4: "Empty-library draw yields a Rush Token card and
// no fatigue damage; radiant Cry draws 3".
//
// The empty-library draw is reached with `library: []` and `startTurn()`, which is where §2.2 puts
// the draw. Each test pairs the outcome with a control — the same draw with no Infinite Reserves on
// the field takes R3's fatigue — so the flag is what is being proved, not the harness.
//
// "The token is a 1-cost hand card" (§8.3 Engine cell): the assertions check the zone (hand, not a
// unit lane), the def (the catalog's own core-t-rush, so 3/3 Rush at cost 1 with no stat override —
// the contrast with #74's X/X token), and that it can then be played out of the hand.

import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

function rushTokensInHand(s: Scenario, player: "p1" | "p2" = "p1") {
  return s.pile(player, "hand").filter((card) => card.defId === "core-t-rush");
}

describe("#75 Infinite Reserves (base)", () => {
  it("an empty-library draw yields a Rush Token card in hand and no fatigue damage (R3)", () => {
    const s = scenario({
      seed: "core-075-empty-draw",
      p1: { backrow: ["core-075"], library: [], hand: ["core-005"] },
      p2: { hand: ["core-005"], library: ["core-035"] },
    });
    expect(s.backrow("p1", 1)?.defId).toBe("core-075");

    s.startTurn();

    const tokens = rushTokensInHand(s);
    expect(tokens).toHaveLength(1);
    s.expectInZone(tokens[0]!, "hand");
    // No fatigue: neither the counter nor the damage.
    s.expectHealth("p1", 30);
    expect(s.state.players.p1.fatigueCount).toBe(0);
    // It came in as a draw, through the normal add-to-hand path.
    s.expectEvents("turnStarted", "drawn", "addedToHand");
    // A hand card, never a summon.
    expect(s.unit("p1", 1)).toBeNull();
  });

  it("without Infinite Reserves the very same draw takes R3's fatigue damage (control)", () => {
    const s = scenario({
      seed: "core-075-control",
      p1: { library: [], hand: ["core-005"] },
      p2: { hand: ["core-005"], library: ["core-035"] },
    });

    s.startTurn();

    expect(rushTokensInHand(s)).toHaveLength(0);
    // The Nth empty draw deals N damage; this is the first.
    s.expectHealth("p1", 29);
    expect(s.state.players.p1.fatigueCount).toBe(1);
    expect(s.hand("p1")).toHaveLength(1);
  });

  it("the token is the catalog's own Rush Token — 3/3 with Rush, no stat override — and is playable from hand", () => {
    const s = scenario({
      seed: "core-075-token-identity",
      p1: { backrow: ["core-075"], library: [], hand: ["core-005"] },
      p2: { hand: ["core-005"], library: ["core-035"] },
    });

    s.startTurn();
    const token = rushTokensInHand(s)[0];
    expect(token?.statsOverride).toBeUndefined();

    s.play(token!);

    const summoned = s.unit("p1", 1);
    expect(summoned?.id).toBe(token?.id);
    s.expectStats(summoned!, { attack: 3, health: 3, maxHealth: 3 });
    s.expectEvents("cardPlayed", "summoned");
  });

  it("the replacement keeps working turn after turn, and never touches the opponent's draws", () => {
    const s = scenario({
      seed: "core-075-repeat",
      p1: { backrow: ["core-075"], library: [], hand: ["core-005"] },
      p2: { hand: ["core-005"], library: [] },
    });

    s.startTurn();
    s.startTurn();

    expect(rushTokensInHand(s)).toHaveLength(2);
    s.expectHealth("p1", 30);
    // p2 has its own empty library and no Infinite Reserves; nothing here reached across.
    expect(rushTokensInHand(s, "p2")).toHaveLength(0);
    expect(s.state.players.p2.fatigueCount).toBe(0);
  });

  it("the base face has no Cry: playing it draws nothing", () => {
    const s = scenario({
      seed: "core-075-no-cry",
      p1: { hand: ["core-075", "core-005"], library: ["core-035", "core-036"] },
      p2: { hand: ["core-005"] },
    });

    s.play("core-075");

    // One card played out of two and nothing drawn.
    expect(s.hand("p1")).toHaveLength(1);
    expect(s.pile("p1", "library")).toHaveLength(2);
    expect(s.lastEvents.map((event) => event.type)).not.toContain("drawn");
    // Cost 0, so the mana is untouched.
    s.expectMana("p1", 4);
    expect(s.backrow("p1", 1)?.defId).toBe("core-075");
  });
});

describe("#75 Infinite Reserves (radiant)", () => {
  it("radiant Cry: draw 3", () => {
    const s = scenario({
      seed: "core-075-radiant-cry",
      p1: {
        hand: [{ def: "core-075", radiant: true }, "core-005"],
        library: ["core-035", "core-036", "core-013", "core-019"],
      },
      p2: { hand: ["core-005"] },
    });
    expect(s.hand("p1")[0]?.radiant).toBe(true);

    s.play("core-075");

    // Two in hand, one played, three drawn.
    expect(s.hand("p1")).toHaveLength(4);
    expect(s.pile("p1", "library")).toHaveLength(1);
    s.expectEvents("cardPlayed", "summoned", "drawn", "drawn", "drawn");
    s.expectMana("p1", 4);
    expect(s.backrow("p1", 1)?.radiant).toBe(true);
  });

  it("\"same\" keeps the replacement on the radiant face too", () => {
    const s = scenario({
      seed: "core-075-radiant-same",
      p1: { backrow: [{ def: "core-075", radiant: true }], library: [], hand: ["core-005"] },
      p2: { hand: ["core-005"], library: ["core-035"] },
    });

    s.startTurn();

    expect(rushTokensInHand(s)).toHaveLength(1);
    s.expectHealth("p1", 30);
    expect(s.state.players.p1.fatigueCount).toBe(0);
  });

  it("a radiant Infinite Reserves played onto an empty library draws three Rush Token cards", () => {
    const s = scenario({
      seed: "core-075-radiant-empty-library",
      p1: { hand: [{ def: "core-075", radiant: true }, "core-005"], library: [] },
      p2: { hand: ["core-005"] },
    });

    // §10.5 puts the card on the field at step 4 and fires the Cry at step 5, so the flag is
    // already live for the Cry's own three draws.
    s.play("core-075");

    expect(rushTokensInHand(s)).toHaveLength(3);
    expect(s.hand("p1")).toHaveLength(4);
    s.expectHealth("p1", 30);
    expect(s.state.players.p1.fatigueCount).toBe(0);
  });
});
