// The green glow (docs/polish/7-mobile-ux.md, S5): `highlightFor(...).glow` is Hearthstone's "can
// act" border, derived from `legalActions` and the open prompt's options alone. Every test feeds a
// hand-written `ActionBody[]` and checks the glow came out of that array, and every test also checks
// the invariant `glow ⊆ legal`.
//
// The two pure attribute helpers of `glow.ts` (`glowAttr`, `conditionAttr`) are here too: they are
// the half of B16/B17 that needs no DOM.

import type { ActionBody, PlayerView, Selection } from "@jackioh/shared";
import { describe, expect, it } from "vitest";

import { IDLE, highlightFor, onClickTarget, pendingHighlight, pickInPlay, type Interaction } from "../../game/actions.ts";
import { NO_HIGHLIGHT, testid, type Highlight } from "../../game/contract.ts";
import { conditionAttr, glowAttr } from "../../game/glow.ts";
import { baseView, card, emptySide, heroPower, pendingFor, unit, waitingPending } from "../fixtures.ts";

/** Three cards in hand, two of your units, one of theirs, and a hero power. */
function seatedView(over: Partial<PlayerView> = {}): PlayerView {
  return baseView({
    you: emptySide("p1", {
      hero: { health: 30, armor: 0, powers: [heroPower], power: heroPower },
      hand: [
        card({ instanceId: "h1", defId: "core-002", cost: 1 }),
        card({ instanceId: "h2", defId: "core-019", cost: 3 }),
        card({ instanceId: "h3", defId: "core-077", cost: 6 }),
      ],
      units: [unit("p1", { instanceId: "u1" }), unit("p1", { instanceId: "u2" }), null, null, null],
    }),
    opponent: emptySide("p2", {
      hand: { count: 4 },
      units: [unit("p2", { instanceId: "e1" }), unit("p2", { instanceId: "e2" }), null, null, null],
    }),
    ...over,
  });
}

const playZone = (instanceId: string, lane: number): ActionBody => ({
  type: "play",
  instanceId,
  zone: { row: "units", lane },
});

const onEnemy: Selection = { pick: "instance", instanceId: "e1" };
const onEnemyHero: Selection = { pick: "hero", player: "p2" };

/** The glow as a sorted list; an absent glow is an empty one. */
function glowOf(highlight: Highlight): string[] {
  return [...(highlight.glow ?? new Set<string>())].sort();
}

function sorted(ids: string[]): string[] {
  return [...ids].sort();
}

/** The invariant of S5: nothing glows that is not already legal. */
function expectGlowWithinLegal(highlight: Highlight): void {
  for (const id of highlight.glow ?? []) expect(highlight.legal.has(id), `${id} glows but is not legal`).toBe(true);
}

function selectHand(view: PlayerView, legal: ActionBody[], instanceId: string): Interaction {
  const interaction = onClickTarget(view, legal, IDLE, { on: "hand", instanceId }).interaction;
  expect(interaction.stage).toBe("playing");
  return interaction;
}

function selectAttacker(view: PlayerView, legal: ActionBody[], instanceId: string, lane: number): Interaction {
  const interaction = onClickTarget(view, legal, IDLE, { on: "unit", instanceId, side: "you", lane }).interaction;
  expect(interaction.stage).toBe("attacking");
  return interaction;
}

/** A turn with a bit of everything on offer. */
const EVERYTHING: ActionBody[] = [
  playZone("h1", 3),
  playZone("h1", 4),
  { type: "play", instanceId: "h2", targets: [onEnemy] },
  { type: "play", instanceId: "h2", targets: [onEnemyHero] },
  { type: "attack", attackerId: "u1", targetId: "e1" },
  { type: "attack", attackerId: "u1", targetId: "hero-p2" },
  { type: "switchPosition", instanceId: "u2" },
  { type: "activatePower", instanceId: "power-1" },
  { type: "endTurn" },
  { type: "offerDraw" },
  { type: "concede" },
];

// ---------------------------------------------------------------------------------------------
// B11: idle
// ---------------------------------------------------------------------------------------------

describe("B11 the idle glow: playable cards, ready attackers and the power", () => {
  it("B11 holds every hand card a play names, every unit an attack names, and power", () => {
    const view = seatedView();
    const highlight = highlightFor(view, EVERYTHING, IDLE);

    expect(glowOf(highlight)).toEqual(
      sorted([testid.handCard("h1"), testid.handCard("h2"), testid.card("u1"), testid.power]),
    );
    expectGlowWithinLegal(highlight);
  });

  it("B11 never holds a unit whose only action is switchPosition, though it stays legal", () => {
    const view = seatedView();
    const legal: ActionBody[] = [{ type: "switchPosition", instanceId: "u2" }, { type: "attack", attackerId: "u1", targetId: "e1" }];
    const highlight = highlightFor(view, legal, IDLE);

    expect(highlight.legal.has(testid.card("u2"))).toBe(true);
    expect(highlight.glow?.has(testid.card("u2")) ?? false).toBe(false);
    expect(highlight.glow?.has(testid.switchPosition("u2")) ?? false).toBe(false);
    expect(highlight.glow?.has(testid.card("u1"))).toBe(true);
    expectGlowWithinLegal(highlight);
  });

  it("B11 never holds offer-draw or concede, though both are legal", () => {
    const view = seatedView();
    const highlight = highlightFor(view, EVERYTHING, IDLE);

    expect(highlight.legal.has(testid.offerDraw)).toBe(true);
    expect(highlight.legal.has(testid.concede)).toBe(true);
    expect(highlight.glow?.has(testid.offerDraw) ?? false).toBe(false);
    expect(highlight.glow?.has(testid.concede) ?? false).toBe(false);
  });

  it("B11 holds no hand card the engine did not list, and no power it did not list", () => {
    const view = seatedView();
    const legal: ActionBody[] = [playZone("h1", 1), { type: "endTurn" }, { type: "concede" }];
    const highlight = highlightFor(view, legal, IDLE);

    expect(glowOf(highlight)).toEqual([testid.handCard("h1")]);
    expect(highlight.glow?.has(testid.handCard("h3")) ?? false).toBe(false);
    expect(highlight.glow?.has(testid.power) ?? false).toBe(false);
    expectGlowWithinLegal(highlight);
  });

  it("B11 an enemy unit never glows at rest, even when it is an attack target", () => {
    const view = seatedView();
    const highlight = highlightFor(view, EVERYTHING, IDLE);

    expect(highlight.glow?.has(testid.card("e1")) ?? false).toBe(false);
    expect(highlight.glow?.has(testid.hero("opponent")) ?? false).toBe(false);
    expect(highlight.glow?.has(testid.hero("you")) ?? false).toBe(false);
  });

  it("B11 an empty legal array lights nothing", () => {
    const highlight = highlightFor(seatedView(), [], IDLE);

    expect(glowOf(highlight)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// B12: playing
// ---------------------------------------------------------------------------------------------

describe("B12 the playing glow: the remaining candidates' zones, tributes and declared targets", () => {
  it("B12 is exactly the candidate zones, never the selected card or the other playable cards", () => {
    const view = seatedView();
    const playing = selectHand(view, EVERYTHING, "h1");
    const highlight = highlightFor(view, EVERYTHING, playing);

    expect(glowOf(highlight)).toEqual(sorted([testid.zone("you", "units", 3), testid.zone("you", "units", 4)]));
    expect(highlight.glow?.has(testid.handCard("h1")) ?? false).toBe(false);
    expect(highlight.glow?.has(testid.handCard("h2")) ?? false).toBe(false);
    expect(highlight.glow?.has(testid.card("u1")) ?? false).toBe(false);
    expect(highlight.glow?.has(testid.power) ?? false).toBe(false);
    expect(highlight.glow?.has(testid.endTurn) ?? false).toBe(false);
    // The selected card is still marked as selected; it just does not glow.
    expect(highlight.selected.has(testid.handCard("h1"))).toBe(true);
    expectGlowWithinLegal(highlight);
  });

  it("B12 is exactly the declared targets of a targeted play, hero included", () => {
    const view = seatedView();
    const playing = selectHand(view, EVERYTHING, "h2");
    const highlight = highlightFor(view, EVERYTHING, playing);

    expect(glowOf(highlight)).toEqual(sorted([testid.card("e1"), testid.hero("opponent")]));
    expect(highlight.glow?.has(testid.handCard("h1")) ?? false).toBe(false);
    expect(highlight.glow?.has(testid.handCard("h2")) ?? false).toBe(false);
    expectGlowWithinLegal(highlight);
  });

  it("B12 is exactly the zone and the tribute units of a tribute play", () => {
    const view = seatedView();
    const legal: ActionBody[] = [
      { type: "play", instanceId: "h3", zone: { row: "units", lane: 3 }, tributes: ["u1"] },
      { type: "play", instanceId: "h3", zone: { row: "units", lane: 3 }, tributes: ["u2"] },
      playZone("h1", 4),
      { type: "endTurn" },
    ];
    const playing = selectHand(view, legal, "h3");
    const highlight = highlightFor(view, legal, playing);

    expect(glowOf(highlight)).toEqual(
      sorted([testid.zone("you", "units", 3), testid.card("u1"), testid.card("u2")]),
    );
    expect(highlight.glow?.has(testid.handCard("h1")) ?? false).toBe(false);
    expect(highlight.glow?.has(testid.zone("you", "units", 4)) ?? false).toBe(false);
    expectGlowWithinLegal(highlight);
  });

  it("B12 narrows to the candidates that remain once a picker has chosen", () => {
    const view = seatedView();
    // X narrows the zones here: choosing X = 1 drops lane 3 and leaves lanes 4 and 5. Two
    // candidates stay, so the play is still in flight (one would be sent at once, as a click
    // with one candidate left always is).
    const legal: ActionBody[] = [
      { type: "play", instanceId: "h1", x: 0, zone: { row: "units", lane: 3 } },
      { type: "play", instanceId: "h1", x: 1, zone: { row: "units", lane: 4 } },
      { type: "play", instanceId: "h1", x: 1, zone: { row: "units", lane: 5 } },
    ];
    const playing = selectHand(view, legal, "h1");

    const picked = pickInPlay(playing, { x: 1 });
    expect(picked.action).toBeUndefined();
    const after = highlightFor(view, legal, picked.interaction);

    expect(glowOf(after)).toEqual(sorted([testid.zone("you", "units", 4), testid.zone("you", "units", 5)]));
    expect(after.glow?.has(testid.zone("you", "units", 3)) ?? false).toBe(false);
    expectGlowWithinLegal(after);
  });
});

// ---------------------------------------------------------------------------------------------
// B13: attacking
// ---------------------------------------------------------------------------------------------

describe("B13 the attacking glow: the selected attacker's targets only", () => {
  it("B13 is exactly the enemy unit and the hero the attacker may hit, never another attacker", () => {
    const view = seatedView();
    const legal: ActionBody[] = [
      { type: "attack", attackerId: "u1", targetId: "e1" },
      { type: "attack", attackerId: "u1", targetId: "hero-p2" },
      { type: "attack", attackerId: "u2", targetId: "e2" },
      playZone("h1", 3),
      { type: "endTurn" },
    ];
    const attacking = selectAttacker(view, legal, "u1", 1);
    const highlight = highlightFor(view, legal, attacking);

    expect(glowOf(highlight)).toEqual(sorted([testid.card("e1"), testid.hero("opponent")]));
    expect(highlight.glow?.has(testid.card("u2")) ?? false).toBe(false);
    expect(highlight.glow?.has(testid.card("u1")) ?? false).toBe(false);
    // u2's own target is not u1's.
    expect(highlight.glow?.has(testid.card("e2")) ?? false).toBe(false);
    expect(highlight.glow?.has(testid.handCard("h1")) ?? false).toBe(false);
    expectGlowWithinLegal(highlight);
  });

  it("B13 a hero-only attacker lights only the enemy hero", () => {
    const view = seatedView();
    const legal: ActionBody[] = [
      { type: "attack", attackerId: "u2", targetId: "hero-p2" },
      { type: "attack", attackerId: "u1", targetId: "e1" },
    ];
    const attacking = selectAttacker(view, legal, "u2", 2);
    const highlight = highlightFor(view, legal, attacking);

    expect(glowOf(highlight)).toEqual([testid.hero("opponent")]);
    expect(highlight.glow?.has(testid.card("e1")) ?? false).toBe(false);
    expectGlowWithinLegal(highlight);
  });
});

// ---------------------------------------------------------------------------------------------
// B14: an open prompt, and the stale-interaction fallback
// ---------------------------------------------------------------------------------------------

describe("B14 the prompt glow and the empty-legal fallback", () => {
  const targetPrompt = pendingFor("target", [
    { key: "instance:e1", label: "Enemy", instanceId: "e1" },
    { key: "hero:p2", label: "Enemy hero", player: "p2" },
  ]);

  it("B14 with the viewer's prompt open, the glow is exactly the board cells its options name", () => {
    const view = seatedView({ pending: targetPrompt });
    const highlight = highlightFor(view, [], IDLE);

    expect(glowOf(highlight)).toEqual(sorted([testid.card("e1"), testid.hero("opponent")]));
    expect(glowOf(highlight)).toEqual([...pendingHighlight(view, view.pending)].sort());
    expectGlowWithinLegal(highlight);
  });

  it("B14 the prompt's answers and a concede in the legal array change nothing: concede never glows", () => {
    const view = seatedView({ pending: targetPrompt });
    const legal: ActionBody[] = [
      { type: "answer", choiceId: "ch1", selection: [onEnemy] },
      { type: "answer", choiceId: "ch1", selection: [onEnemyHero] },
      { type: "concede" },
    ];
    const highlight = highlightFor(view, legal, IDLE);

    expect(glowOf(highlight)).toEqual(sorted([testid.card("e1"), testid.hero("opponent")]));
    expect(highlight.glow?.has(testid.concede) ?? false).toBe(false);
    expectGlowWithinLegal(highlight);
  });

  it("B14 the opponent's prompt lights nothing on the waiting seat", () => {
    const view = seatedView({ pending: waitingPending });
    const highlight = highlightFor(view, [], IDLE);

    expect(glowOf(highlight)).toEqual([]);
  });

  it("B14 an empty legal array with a stale playing interaction returns NO_HIGHLIGHT", () => {
    const view = seatedView();
    const stale: Interaction = { stage: "playing", instanceId: "h1", candidates: [playZone("h1", 3)], picked: {} };

    expect(highlightFor(view, [], stale)).toBe(NO_HIGHLIGHT);
  });

  it("B14 an empty legal array with a stale attacking interaction returns NO_HIGHLIGHT", () => {
    const view = seatedView();
    const stale: Interaction = { stage: "attacking", attackerId: "u1", candidates: [] };
    const highlight = highlightFor(view, [], stale);

    expect(highlight).toBe(NO_HIGHLIGHT);
    expect(highlight.glow).toBeUndefined();
  });

  it("B14 a stale interaction over an open prompt with an empty legal array still returns NO_HIGHLIGHT", () => {
    const view = seatedView({ pending: targetPrompt });
    const stale: Interaction = { stage: "attacking", attackerId: "u1", candidates: [] };

    expect(highlightFor(view, [], stale)).toBe(NO_HIGHLIGHT);
  });
});

// ---------------------------------------------------------------------------------------------
// B15: end-turn
// ---------------------------------------------------------------------------------------------

describe("B15 end-turn glows only when nothing else can act", () => {
  it("B15 glows when endTurn is legal and nothing else is playable, attack-ready or activatable", () => {
    const view = seatedView();
    const legal: ActionBody[] = [{ type: "endTurn" }, { type: "offerDraw" }, { type: "concede" }];
    const highlight = highlightFor(view, legal, IDLE);

    expect(glowOf(highlight)).toEqual([testid.endTurn]);
    expectGlowWithinLegal(highlight);
  });

  it("B15 a switchPosition left on offer does not stop end-turn glowing", () => {
    const view = seatedView();
    const legal: ActionBody[] = [{ type: "switchPosition", instanceId: "u2" }, { type: "endTurn" }];
    const highlight = highlightFor(view, legal, IDLE);

    expect(glowOf(highlight)).toEqual([testid.endTurn]);
  });

  it("B15 does not glow while a play is legal", () => {
    const highlight = highlightFor(seatedView(), [playZone("h1", 3), { type: "endTurn" }], IDLE);

    expect(highlight.glow?.has(testid.endTurn) ?? false).toBe(false);
  });

  it("B15 does not glow while an attack is legal", () => {
    const highlight = highlightFor(
      seatedView(),
      [{ type: "attack", attackerId: "u1", targetId: "e1" }, { type: "endTurn" }],
      IDLE,
    );

    expect(highlight.glow?.has(testid.endTurn) ?? false).toBe(false);
  });

  it("B15 does not glow while the hero power is legal", () => {
    const highlight = highlightFor(
      seatedView(),
      [{ type: "activatePower", instanceId: "power-1" }, { type: "endTurn" }],
      IDLE,
    );

    expect(highlight.glow?.has(testid.endTurn) ?? false).toBe(false);
    expect(highlight.glow?.has(testid.power)).toBe(true);
  });

  it("B15 does not glow while a prompt is open, the viewer's or the opponent's", () => {
    const legal: ActionBody[] = [{ type: "endTurn" }, { type: "concede" }];
    const own = seatedView({
      pending: pendingFor("mode", [
        { key: "mode:left", label: "left" },
        { key: "mode:right", label: "right" },
      ]),
    });
    const theirs = seatedView({ pending: waitingPending });

    expect(highlightFor(own, legal, IDLE).glow?.has(testid.endTurn) ?? false).toBe(false);
    expect(highlightFor(theirs, legal, IDLE).glow?.has(testid.endTurn) ?? false).toBe(false);
  });

  it("B15 does not glow while a play is in flight, even with only end-turn otherwise on offer", () => {
    const view = seatedView();
    // Two zones, so the click leaves the play in flight (a one-zone card would be sent at once).
    const legal: ActionBody[] = [playZone("h1", 3), playZone("h1", 4), { type: "endTurn" }];
    const playing = selectHand(view, legal, "h1");
    const highlight = highlightFor(view, legal, playing);

    expect(glowOf(highlight)).toEqual(sorted([testid.zone("you", "units", 3), testid.zone("you", "units", 4)]));
    expect(highlight.glow?.has(testid.endTurn) ?? false).toBe(false);
  });

  it("B15 does not glow when endTurn itself is not legal", () => {
    const highlight = highlightFor(seatedView(), [{ type: "concede" }, { type: "offerDraw" }], IDLE);

    expect(glowOf(highlight)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// glow.ts's pure attribute helpers (the DOM half is glow-render.test.tsx)
// ---------------------------------------------------------------------------------------------

describe("B16 glowAttr: data-glow is 'ready' exactly for a testid in highlight.glow", () => {
  const highlight: Highlight = {
    legal: new Set([testid.card("u1"), testid.card("u2")]),
    selected: new Set(),
    glow: new Set([testid.card("u1")]),
  };

  it("B16 returns 'ready' for a glowing testid", () => {
    expect(glowAttr(highlight, testid.card("u1"))).toBe("ready");
  });

  it("B16 returns undefined for a testid that is legal but not glowing", () => {
    expect(glowAttr(highlight, testid.card("u2"))).toBeUndefined();
  });

  it("B16 returns undefined for a testid that is neither", () => {
    expect(glowAttr(highlight, testid.card("zz"))).toBeUndefined();
  });

  it("B16 returns undefined with no highlight, no glow set, or no testid", () => {
    expect(glowAttr(undefined, testid.card("u1"))).toBeUndefined();
    expect(glowAttr(NO_HIGHLIGHT, testid.card("u1"))).toBeUndefined();
    expect(glowAttr({ legal: new Set([testid.card("u1")]), selected: new Set() }, testid.card("u1"))).toBeUndefined();
    expect(glowAttr(highlight, undefined)).toBeUndefined();
  });
});

describe("B17 conditionAttr: data-condition-active is 'true' exactly when the view says so", () => {
  it("B17 returns 'true' for a card carrying conditionActive: true", () => {
    expect(conditionAttr(card({ conditionActive: true }))).toBe("true");
    expect(conditionAttr(unit("p1", { conditionActive: true }))).toBe("true");
  });

  it("B17 returns undefined for a card without the key", () => {
    expect(conditionAttr(card())).toBeUndefined();
    expect(conditionAttr({})).toBeUndefined();
  });

  it("B17 returns undefined for no card at all", () => {
    expect(conditionAttr(null)).toBeUndefined();
    expect(conditionAttr(undefined)).toBeUndefined();
  });
});
