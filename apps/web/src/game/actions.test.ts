// M5-T2: the client asks `legalActions` and narrows. These tests exist to prove that it never
// computes legality itself — every one of them feeds a hand-built `ActionBody[]` and checks that
// what comes out was derived from that array and nothing else.

import type { ActionBody, PlayerView, Selection } from "@jackioh/shared";
import { describe, expect, it } from "vitest";

import {
  IDLE,
  answerAction,
  attackTargetTestid,
  heroTargetId,
  highlightFor,
  onClickTarget,
  onControl,
  outstandingNeed,
  pendingHighlight,
  pickInPlay,
  selectionForOption,
  withNonce,
  type Interaction,
} from "./actions.ts";
import { testid } from "./contract.ts";
import { baseView, card, emptySide, pendingFor, unit, waitingPending } from "../test/fixtures.ts";

/** A seat with three cards in hand, two of your units and one of theirs. */
function seatedView(over: Partial<PlayerView> = {}): PlayerView {
  return baseView({
    you: emptySide("p1", {
      hand: [
        card({ instanceId: "h1", defId: "core-002", cost: 1 }),
        card({ instanceId: "h2", defId: "core-019", cost: 3 }),
        card({ instanceId: "h3", defId: "core-077", cost: 6 }),
      ],
      units: [
        unit("p1", { instanceId: "u1" }),
        unit("p1", { instanceId: "u2" }),
        null,
        null,
        null,
      ],
    }),
    opponent: emptySide("p2", {
      hand: { count: 4 },
      units: [unit("p2", { instanceId: "e1" }), null, null, null, null],
    }),
    ...over,
  });
}

const playZone = (instanceId: string, lane: number): ActionBody => ({
  type: "play",
  instanceId,
  zone: { row: "units", lane },
});

describe("highlightFor: every lit testid came out of the legal array (M5-T2)", () => {
  it("lights the hand cards, units, switches and controls the engine listed, and nothing else", () => {
    const view = seatedView();
    const legal: ActionBody[] = [
      playZone("h1", 3),
      { type: "play", instanceId: "h2" },
      { type: "attack", attackerId: "u1", targetId: "e1" },
      { type: "switchPosition", instanceId: "u2" },
      { type: "endTurn" },
      { type: "concede" },
    ];

    const { legal: lit, selected } = highlightFor(view, legal, IDLE);

    expect(lit.has(testid.handCard("h1"))).toBe(true);
    expect(lit.has(testid.handCard("h2"))).toBe(true);
    expect(lit.has(testid.card("u1"))).toBe(true);
    expect(lit.has(testid.card("u2"))).toBe(true);
    expect(lit.has(testid.switchPosition("u2"))).toBe(true);
    expect(lit.has(testid.endTurn)).toBe(true);
    expect(lit.has(testid.concede)).toBe(true);

    // Absent from the array, so absent from the highlight: the board greys these out.
    expect(lit.has(testid.handCard("h3"))).toBe(false);
    expect(lit.has(testid.switchPosition("u1"))).toBe(false);
    expect(lit.has(testid.offerDraw)).toBe(false);
    expect(lit.has(testid.power)).toBe(false);
    expect(selected.size).toBe(0);
  });

  it("greys out a card the player cannot afford, because the engine did not list it", () => {
    // The 6-cost card is missing from `legalActions` for exactly one reason — the engine decided
    // it. The client holds no cost arithmetic; it just fails to find a `play` naming it.
    const view = seatedView({
      you: emptySide("p1", {
        mana: { current: 1, max: 6 },
        hand: [card({ instanceId: "h1", cost: 1 }), card({ instanceId: "h3", cost: 6 })],
      }),
    });
    const legal: ActionBody[] = [playZone("h1", 1), { type: "endTurn" }];

    const { legal: lit } = highlightFor(view, legal, IDLE);

    expect(lit.has(testid.handCard("h1"))).toBe(true);
    expect(lit.has(testid.handCard("h3"))).toBe(false);
  });

  it("lights only the zones the remaining candidates name while a play is in flight", () => {
    const view = seatedView();
    const legal: ActionBody[] = [playZone("h1", 3), playZone("h1", 5), { type: "endTurn" }];
    const after = onClickTarget(view, legal, IDLE, { on: "hand", instanceId: "h1" });

    const { legal: lit, selected } = highlightFor(view, legal, after.interaction);

    expect(lit.has(testid.zone("you", "units", 3))).toBe(true);
    expect(lit.has(testid.zone("you", "units", 5))).toBe(true);
    expect(lit.has(testid.zone("you", "units", 1))).toBe(false);
    expect(lit.has(testid.zone("you", "backrow", 3))).toBe(false);
    expect(selected.has(testid.handCard("h1"))).toBe(true);
  });

  it("lights the attack targets the candidates name, hero included", () => {
    const view = seatedView();
    const legal: ActionBody[] = [
      { type: "attack", attackerId: "u1", targetId: "e1" },
      { type: "attack", attackerId: "u1", targetId: heroTargetId("p2") },
      { type: "attack", attackerId: "u2", targetId: "e1" },
    ];
    const after = onClickTarget(view, legal, IDLE, { on: "unit", instanceId: "u1", side: "you", lane: 1 });

    const { legal: lit, selected } = highlightFor(view, legal, after.interaction);

    expect(lit.has(testid.card("e1"))).toBe(true);
    expect(lit.has(testid.hero("opponent"))).toBe(true);
    expect(lit.has(testid.hero("you"))).toBe(false);
    expect(selected.has(testid.card("u1"))).toBe(true);
  });

  it("falls back to the open prompt's own options when legalActions offers only answers", () => {
    const view = seatedView({
      pending: pendingFor("target", [
        { key: "instance:e1", label: "Enemy", instanceId: "e1" },
        { key: "hero:p2", label: "Enemy hero", player: "p2" },
      ]),
    });

    const { legal: lit } = highlightFor(view, [], IDLE);

    expect(lit.has(testid.card("e1"))).toBe(true);
    expect(lit.has(testid.hero("opponent"))).toBe(true);
    expect(pendingHighlight(view, waitingPending).size).toBe(0);
  });
});

describe("a hero as an attack target", () => {
  it("is addressed as hero-<playerId> and maps to the hero testid", () => {
    const view = seatedView();
    expect(heroTargetId("p2")).toBe("hero-p2");
    expect(attackTargetTestid(view, "hero-p2")).toBe(testid.hero("opponent"));
    expect(attackTargetTestid(view, "hero-p1")).toBe(testid.hero("you"));
    expect(attackTargetTestid(view, "e1")).toBe(testid.card("e1"));
  });
});

describe("onClickTarget: illegal clicks change nothing", () => {
  it("ignores a hand card with no play in the legal array", () => {
    const view = seatedView();
    const legal: ActionBody[] = [playZone("h1", 1), { type: "endTurn" }];

    const result = onClickTarget(view, legal, IDLE, { on: "hand", instanceId: "h3" });

    expect(result.action).toBeUndefined();
    expect(result.interaction).toBe(IDLE);
  });

  it("ignores a zone no candidate names", () => {
    const view = seatedView();
    const legal: ActionBody[] = [playZone("h1", 3), playZone("h1", 5)];
    const playing = onClickTarget(view, legal, IDLE, { on: "hand", instanceId: "h1" }).interaction;

    const result = onClickTarget(view, legal, playing, { on: "zone", side: "you", row: "units", lane: 1 });

    expect(result.action).toBeUndefined();
    expect(result.interaction).toBe(playing);
  });

  it("ignores a unit with no attack in the legal array", () => {
    const view = seatedView();
    const legal: ActionBody[] = [{ type: "attack", attackerId: "u1", targetId: "e1" }];

    const result = onClickTarget(view, legal, IDLE, { on: "unit", instanceId: "u2", side: "you", lane: 2 });

    expect(result.action).toBeUndefined();
    expect(result.interaction).toBe(IDLE);
  });

  it("ignores an attack target no candidate names", () => {
    const view = seatedView();
    const legal: ActionBody[] = [{ type: "attack", attackerId: "u1", targetId: "e1" }];
    const attacking = onClickTarget(view, legal, IDLE, { on: "unit", instanceId: "u1", side: "you", lane: 1 })
      .interaction;

    const result = onClickTarget(view, legal, attacking, { on: "hero", side: "opponent" });

    expect(result.action).toBeUndefined();
    expect(result.interaction).toBe(attacking);
  });

  it("ignores a switch with no switchPosition in the legal array", () => {
    const view = seatedView();
    const result = onClickTarget(view, [{ type: "endTurn" }], IDLE, { on: "switch", instanceId: "u1" });

    expect(result.action).toBeUndefined();
    expect(result.interaction).toBe(IDLE);
  });
});

describe("the click reducer builds a play out of the candidates (R81)", () => {
  const view = seatedView();

  it("sends a spell the moment it is the only candidate", () => {
    const legal: ActionBody[] = [{ type: "play", instanceId: "h2" }, { type: "endTurn" }];

    const result = onClickTarget(view, legal, IDLE, { on: "hand", instanceId: "h2" });

    expect(result.action).toEqual({ type: "play", instanceId: "h2" });
    expect(result.interaction).toEqual(IDLE);
  });

  it("… with a zone", () => {
    const legal: ActionBody[] = [playZone("h1", 3), playZone("h1", 4), playZone("h1", 5)];
    const playing = onClickTarget(view, legal, IDLE, { on: "hand", instanceId: "h1" });

    expect(playing.action).toBeUndefined();
    expect(outstandingNeed(playing.interaction)).toEqual({
      kind: "zone",
      min: 1,
      max: 1,
      zones: [
        { row: "units", lane: 3 },
        { row: "units", lane: 4 },
        { row: "units", lane: 5 },
      ],
    });

    const result = onClickTarget(view, legal, playing.interaction, {
      on: "zone",
      side: "you",
      row: "units",
      lane: 4,
    });

    expect(result.action).toEqual({ type: "play", instanceId: "h1", zone: { row: "units", lane: 4 } });
    expect(result.interaction).toEqual(IDLE);
  });

  it("… with x, which the picker supplies rather than the board", () => {
    const legal: ActionBody[] = [
      { type: "play", instanceId: "h2", x: 0 },
      { type: "play", instanceId: "h2", x: 1 },
      { type: "play", instanceId: "h2", x: 2 },
    ];
    const playing = onClickTarget(view, legal, IDLE, { on: "hand", instanceId: "h2" });

    expect(playing.action).toBeUndefined();
    expect(outstandingNeed(playing.interaction)).toEqual({ kind: "x", min: 1, max: 1, values: [0, 1, 2] });

    const result = pickInPlay(playing.interaction, { x: 2 });

    expect(result.action).toEqual({ type: "play", instanceId: "h2", x: 2 });
  });

  it("… with embiggen", () => {
    const legal: ActionBody[] = [
      { type: "play", instanceId: "h1", zone: { row: "units", lane: 1 }, embiggen: false },
      { type: "play", instanceId: "h1", zone: { row: "units", lane: 1 }, embiggen: true },
    ];
    const playing = onClickTarget(view, legal, IDLE, { on: "hand", instanceId: "h1" });

    expect(outstandingNeed(playing.interaction)).toEqual({
      kind: "embiggen",
      min: 1,
      max: 1,
      values: [false, true],
    });

    const result = pickInPlay(playing.interaction, { embiggen: true });

    expect(result.action).toEqual({
      type: "play",
      instanceId: "h1",
      zone: { row: "units", lane: 1 },
      embiggen: true,
    });
  });

  it("… with tributes, clicked on the board", () => {
    const legal: ActionBody[] = [
      { type: "play", instanceId: "h3", zone: { row: "units", lane: 3 }, tributes: ["u1"] },
      { type: "play", instanceId: "h3", zone: { row: "units", lane: 3 }, tributes: ["u2"] },
    ];
    const playing = onClickTarget(view, legal, IDLE, { on: "hand", instanceId: "h3" });

    expect(outstandingNeed(playing.interaction)).toEqual({
      kind: "tribute",
      min: 1,
      max: 1,
      instanceIds: ["u1", "u2"],
    });
    expect(highlightFor(view, legal, playing.interaction).legal.has(testid.card("u1"))).toBe(true);

    const result = onClickTarget(view, legal, playing.interaction, {
      on: "unit",
      instanceId: "u2",
      side: "you",
      lane: 2,
    });

    expect(result.action).toEqual({
      type: "play",
      instanceId: "h3",
      zone: { row: "units", lane: 3 },
      tributes: ["u2"],
    });
  });

  it("… with targets, on a unit and on a hero", () => {
    const onEnemy: Selection = { pick: "instance", instanceId: "e1" };
    const onHero: Selection = { pick: "hero", player: "p2" };
    const legal: ActionBody[] = [
      { type: "play", instanceId: "h2", targets: [onEnemy] },
      { type: "play", instanceId: "h2", targets: [onHero] },
    ];
    const playing = onClickTarget(view, legal, IDLE, { on: "hand", instanceId: "h2" });

    expect(outstandingNeed(playing.interaction)).toEqual({
      kind: "target",
      min: 1,
      max: 1,
      selections: [onEnemy, onHero],
    });

    const onUnit = onClickTarget(view, legal, playing.interaction, {
      on: "unit",
      instanceId: "e1",
      side: "opponent",
      lane: 1,
    });
    expect(onUnit.action).toEqual({ type: "play", instanceId: "h2", targets: [onEnemy] });

    const onFace = onClickTarget(view, legal, playing.interaction, { on: "hero", side: "opponent" });
    expect(onFace.action).toEqual({ type: "play", instanceId: "h2", targets: [onHero] });
  });

  it("… with a declared hand pick, which travels in targets (R81)", () => {
    const pick: Selection = { pick: "instance", instanceId: "h3" };
    const legal: ActionBody[] = [
      { type: "play", instanceId: "h1", zone: { row: "units", lane: 1 }, targets: [pick] },
      {
        type: "play",
        instanceId: "h1",
        zone: { row: "units", lane: 1 },
        targets: [{ pick: "instance", instanceId: "h2" }],
      },
    ];
    const playing = onClickTarget(view, legal, IDLE, { on: "hand", instanceId: "h1" });

    const result = onClickTarget(view, legal, playing.interaction, { on: "hand", instanceId: "h3" });

    expect(result.action).toEqual({
      type: "play",
      instanceId: "h1",
      zone: { row: "units", lane: 1 },
      targets: [pick],
    });
  });

  it("… with a declared zone pick, which also travels in targets (R81)", () => {
    const mine: Selection = { pick: "zone", player: "p1", row: "backrow", lane: 2 };
    const theirs: Selection = { pick: "zone", player: "p2", row: "backrow", lane: 2 };
    const legal: ActionBody[] = [
      { type: "play", instanceId: "h2", targets: [mine] },
      { type: "play", instanceId: "h2", targets: [theirs] },
    ];
    const playing = onClickTarget(view, legal, IDLE, { on: "hand", instanceId: "h2" });

    const result = onClickTarget(view, legal, playing.interaction, {
      on: "zone",
      side: "opponent",
      row: "backrow",
      lane: 2,
    });

    expect(result.action).toEqual({ type: "play", instanceId: "h2", targets: [theirs] });
  });

  it("… with modes, which the direction picker supplies (R81)", () => {
    const legal: ActionBody[] = [
      { type: "play", instanceId: "h1", zone: { row: "units", lane: 2 }, modes: ["left"] },
      { type: "play", instanceId: "h1", zone: { row: "units", lane: 2 }, modes: ["right"] },
    ];
    const playing = onClickTarget(view, legal, IDLE, { on: "hand", instanceId: "h1" });

    expect(outstandingNeed(playing.interaction)).toEqual({
      kind: "mode",
      min: 1,
      max: 1,
      options: ["left", "right"],
    });

    const result = pickInPlay(playing.interaction, { modes: ["right"] });

    expect(result.action).toEqual({
      type: "play",
      instanceId: "h1",
      zone: { row: "units", lane: 2 },
      modes: ["right"],
    });
  });

  it("asks for x before the zone, because X changes the cost", () => {
    const legal: ActionBody[] = [0, 1].flatMap((x) =>
      [3, 4].map((lane): ActionBody => ({ type: "play", instanceId: "h1", x, zone: { row: "units", lane } })),
    );
    const playing = onClickTarget(view, legal, IDLE, { on: "hand", instanceId: "h1" });
    expect(outstandingNeed(playing.interaction)).toMatchObject({ kind: "x" });

    const withX = pickInPlay(playing.interaction, { x: 1 });
    expect(withX.action).toBeUndefined();
    expect(outstandingNeed(withX.interaction)).toMatchObject({ kind: "zone" });

    const done = onClickTarget(view, legal, withX.interaction, {
      on: "zone",
      side: "you",
      row: "units",
      lane: 4,
    });
    expect(done.action).toEqual({ type: "play", instanceId: "h1", x: 1, zone: { row: "units", lane: 4 } });
  });

  it("puts a selected card back down when it is clicked again", () => {
    const legal: ActionBody[] = [playZone("h1", 3), playZone("h1", 4)];
    const playing = onClickTarget(view, legal, IDLE, { on: "hand", instanceId: "h1" }).interaction;

    const result = onClickTarget(view, legal, playing, { on: "hand", instanceId: "h1" });

    expect(result.action).toBeUndefined();
    expect(result.interaction).toEqual(IDLE);
  });

  it("carries a picker choice the engine has not enumerated into the play, for R90 to judge", () => {
    // `legalActions` does not enumerate `modes` yet (its own comment: M3-T3). A choice made in a
    // picker is reported, not ruled on; a board click for the same thing stays inert.
    const legal: ActionBody[] = [{ type: "play", instanceId: "h2" }];
    const playing: Interaction = { stage: "playing", instanceId: "h2", candidates: legal, picked: {} };

    expect(outstandingNeed(playing)).toBeNull();
    expect(pickInPlay(playing, { modes: ["left"] }).action).toEqual({
      type: "play",
      instanceId: "h2",
      modes: ["left"],
    });
    expect(
      onClickTarget(view, legal, playing, { on: "unit", instanceId: "e1", side: "opponent", lane: 1 }).action,
    ).toBeUndefined();
  });
});

describe("the attack flow", () => {
  const view = seatedView();

  it("click-click: attacker, then an enemy unit", () => {
    const legal: ActionBody[] = [
      { type: "attack", attackerId: "u1", targetId: "e1" },
      { type: "attack", attackerId: "u1", targetId: heroTargetId("p2") },
    ];

    const attacking = onClickTarget(view, legal, IDLE, { on: "unit", instanceId: "u1", side: "you", lane: 1 });
    expect(attacking.action).toBeUndefined();
    expect(attacking.interaction).toEqual({
      stage: "attacking",
      attackerId: "u1",
      candidates: legal,
    });

    const result = onClickTarget(view, legal, attacking.interaction, {
      on: "unit",
      instanceId: "e1",
      side: "opponent",
      lane: 1,
    });
    expect(result.action).toEqual({ type: "attack", attackerId: "u1", targetId: "e1" });
    expect(result.interaction).toEqual(IDLE);
  });

  it("goes face when the hero is clicked", () => {
    const legal: ActionBody[] = [{ type: "attack", attackerId: "u1", targetId: heroTargetId("p2") }];
    const attacking = onClickTarget(view, legal, IDLE, { on: "unit", instanceId: "u1", side: "you", lane: 1 })
      .interaction;

    const result = onClickTarget(view, legal, attacking, { on: "hero", side: "opponent" });

    expect(result.action).toEqual({ type: "attack", attackerId: "u1", targetId: "hero-p2" });
  });

  it("deselects the attacker when it is clicked again", () => {
    const legal: ActionBody[] = [{ type: "attack", attackerId: "u1", targetId: "e1" }];
    const attacking = onClickTarget(view, legal, IDLE, { on: "unit", instanceId: "u1", side: "you", lane: 1 })
      .interaction;

    expect(
      onClickTarget(view, legal, attacking, { on: "unit", instanceId: "u1", side: "you", lane: 1 }).interaction,
    ).toEqual(IDLE);
  });

  it("emits the switchPosition the engine listed", () => {
    const legal: ActionBody[] = [{ type: "switchPosition", instanceId: "u2" }, { type: "endTurn" }];

    const result = onClickTarget(view, legal, IDLE, { on: "switch", instanceId: "u2" });

    expect(result.action).toEqual({ type: "switchPosition", instanceId: "u2" });
    expect(result.interaction).toEqual(IDLE);
  });
});

describe("onControl", () => {
  const legal: ActionBody[] = [
    { type: "endTurn" },
    { type: "concede" },
    { type: "activatePower", instanceId: "hp1" },
  ];

  it("returns the matching legal action", () => {
    expect(onControl(legal, "end-turn")).toEqual({ type: "endTurn" });
    expect(onControl(legal, "concede")).toEqual({ type: "concede" });
    expect(onControl(legal, "power")).toEqual({ type: "activatePower", instanceId: "hp1" });
  });

  it("returns undefined for a control the engine did not list", () => {
    expect(onControl(legal, "offer-draw")).toBeUndefined();
  });
});

describe("answerAction: one case per PromptKind (§10.6)", () => {
  const view = seatedView();

  it("discover → a mode selection carrying the def id", () => {
    const pending = pendingFor("discover", [
      { key: "mode:core-043", label: "Flood", defId: "core-043" },
      { key: "mode:core-055", label: "Archivist", defId: "core-055" },
      { key: "mode:core-066", label: "Lava Golem", defId: "core-066" },
    ]);
    if (!pending.forYou) throw new Error("fixture");

    expect(answerAction(pending, ["mode:core-055"], view)).toEqual({
      type: "answer",
      choiceId: "ch1",
      selection: [{ pick: "mode", option: "core-055" }],
    });
  });

  it("target → an instance or a hero", () => {
    const pending = pendingFor("target", [
      { key: "instance:e1", label: "Enemy", instanceId: "e1" },
      { key: "hero:p2", label: "Enemy hero", player: "p2" },
    ]);
    if (!pending.forYou) throw new Error("fixture");

    expect(answerAction(pending, ["instance:e1"], view)).toEqual({
      type: "answer",
      choiceId: "ch1",
      selection: [{ pick: "instance", instanceId: "e1" }],
    });
    expect(answerAction(pending, ["hero:p2"], view)).toEqual({
      type: "answer",
      choiceId: "ch1",
      selection: [{ pick: "hero", player: "p2" }],
    });
  });

  it("mode → the option string, prefix stripped", () => {
    const pending = pendingFor("mode", [
      { key: "mode:Deal 3 damage", label: "Deal 3 damage" },
      { key: "mode:Draw a card", label: "Draw a card" },
    ]);
    if (!pending.forYou) throw new Error("fixture");

    expect(answerAction(pending, ["mode:Draw a card"], view)).toEqual({
      type: "answer",
      choiceId: "ch1",
      selection: [{ pick: "mode", option: "Draw a card" }],
    });
  });

  it("mulligan → its own action type, in hand order (§10.2)", () => {
    const pending = pendingFor(
      "mulligan",
      [
        { key: "h1", label: "One", instanceId: "h1" },
        { key: "h2", label: "Two", instanceId: "h2" },
        { key: "h3", label: "Three", instanceId: "h3" },
      ],
      { min: 0, max: 3 },
    );
    if (!pending.forYou) throw new Error("fixture");

    expect(answerAction(pending, ["h3", "h1"], view)).toEqual({ type: "mulligan", keep: ["h1", "h3"] });
    expect(answerAction(pending, [], view)).toEqual({ type: "mulligan", keep: [] });
  });

  it("hand → the chosen card in hand", () => {
    const pending = pendingFor("hand", [
      { key: "instance:h1", label: "One", instanceId: "h1" },
      { key: "instance:h2", label: "Two", instanceId: "h2" },
    ]);
    if (!pending.forYou) throw new Error("fixture");

    expect(answerAction(pending, ["instance:h2"], view)).toEqual({
      type: "answer",
      choiceId: "ch1",
      selection: [{ pick: "instance", instanceId: "h2" }],
    });
  });

  it("zone → a zone selection", () => {
    const pending = pendingFor("zone", [
      { key: "zone:p1:units:1", label: "Unit lane 1", player: "p1", row: "units", lane: 1 },
      { key: "zone:p1:backrow:4", label: "Backrow lane 4", player: "p1", row: "backrow", lane: 4 },
    ]);
    if (!pending.forYou) throw new Error("fixture");

    expect(answerAction(pending, ["zone:p1:units:1"], view)).toEqual({
      type: "answer",
      choiceId: "ch1",
      selection: [{ pick: "zone", player: "p1", row: "units", lane: 1 }],
    });
  });

  it("tribute → one instance selection per sacrificed unit", () => {
    const pending = pendingFor(
      "tribute",
      [
        { key: "instance:u1", label: "One", instanceId: "u1" },
        { key: "instance:u2", label: "Two", instanceId: "u2" },
      ],
      { min: 2, max: 2 },
    );
    if (!pending.forYou) throw new Error("fixture");

    expect(answerAction(pending, ["instance:u1", "instance:u2"], view)).toEqual({
      type: "answer",
      choiceId: "ch1",
      selection: [
        { pick: "instance", instanceId: "u1" },
        { pick: "instance", instanceId: "u2" },
      ],
    });
  });

  it("direction → left or right as a mode", () => {
    const pending = pendingFor("direction", [
      { key: "mode:left", label: "left" },
      { key: "mode:right", label: "right" },
    ]);
    if (!pending.forYou) throw new Error("fixture");

    expect(answerAction(pending, ["mode:left"], view)).toEqual({
      type: "answer",
      choiceId: "ch1",
      selection: [{ pick: "mode", option: "left" }],
    });
  });

  it("x → the number as a mode option, the only Selection member that can carry it", () => {
    const pending = pendingFor("x", [
      { key: "0", label: "0" },
      { key: "1", label: "1" },
      { key: "2", label: "2" },
    ]);
    if (!pending.forYou) throw new Error("fixture");

    expect(answerAction(pending, ["2"], view)).toEqual({
      type: "answer",
      choiceId: "ch1",
      selection: [{ pick: "mode", option: "2" }],
    });
  });

  it("embiggen → the flag as a mode option", () => {
    const pending = pendingFor("embiggen", [
      { key: "false", label: "Normal" },
      { key: "true", label: "Embiggened" },
    ]);
    if (!pending.forYou) throw new Error("fixture");

    expect(answerAction(pending, ["true"], view)).toEqual({
      type: "answer",
      choiceId: "ch1",
      selection: [{ pick: "mode", option: "true" }],
    });
  });

  it("maps a no-op option to { pick: 'none' }", () => {
    expect(selectionForOption({ key: "none", label: "Nothing" })).toEqual({ pick: "none" });
    expect(selectionForOption({ key: "none:nothing", label: "Nothing" })).toEqual({ pick: "none" });
  });

  it("sends the engine's own enumerated answer when the legal array is handed over", () => {
    // `prompts.promptAnswers` lists every answer the open prompt accepts, in option order. Given
    // that array the client sends one of ITS bodies rather than its own reconstruction, so the
    // order the player happened to click in cannot produce an action the engine never listed.
    const pending = pendingFor(
      "tribute",
      [
        { key: "instance:u1", label: "One", instanceId: "u1" },
        { key: "instance:u2", label: "Two", instanceId: "u2" },
      ],
      { min: 2, max: 2 },
    );
    if (!pending.forYou) throw new Error("fixture");
    const enumerated: ActionBody = {
      type: "answer",
      choiceId: "ch1",
      selection: [
        { pick: "instance", instanceId: "u1" },
        { pick: "instance", instanceId: "u2" },
      ],
    };

    const built = answerAction(pending, ["instance:u2", "instance:u1"], view, [enumerated]);

    expect(built).toBe(enumerated);
  });

  it("falls back to its own reconstruction when no legal array is available", () => {
    const pending = pendingFor("mode", [{ key: "mode:Draw a card", label: "Draw a card" }]);
    if (!pending.forYou) throw new Error("fixture");

    expect(answerAction(pending, ["mode:Draw a card"], view, [])).toEqual({
      type: "answer",
      choiceId: "ch1",
      selection: [{ pick: "mode", option: "Draw a card" }],
    });
  });

  it("picks the enumerated mulligan subset over its own", () => {
    const pending = pendingFor(
      "mulligan",
      [
        { key: "h1", label: "One", instanceId: "h1" },
        { key: "h2", label: "Two", instanceId: "h2" },
      ],
      { min: 0, max: 2 },
    );
    if (!pending.forYou) throw new Error("fixture");
    const enumerated: ActionBody = { type: "mulligan", keep: ["h2", "h1"] };

    expect(answerAction(pending, ["h1", "h2"], view, [enumerated])).toBe(enumerated);
  });
});

describe("withNonce", () => {
  it("attaches the player and the nonce it was handed, and generates nothing", () => {
    expect(withNonce({ type: "endTurn" }, "p1", "n7")).toEqual({ type: "endTurn", playerId: "p1", nonce: "n7" });
    expect(withNonce({ type: "play", instanceId: "h1" }, "p2", "n8")).toEqual({
      type: "play",
      instanceId: "h1",
      playerId: "p2",
      nonce: "n8",
    });
  });
});

describe("an empty legal array offers nothing", () => {
  it("lights nothing when the engine lists nothing — the client never reads view.result itself", () => {
    // `legalActions` returns [] once `state.result` is set, or when it is not your turn. The
    // client does not repeat either test; it just gets an empty array.
    const view = seatedView({ result: { winner: "p1", reason: "hero-death" } });
    const idle = highlightFor(view, [], IDLE);
    expect(idle.legal.size).toBe(0);
    expect(idle.selected.size).toBe(0);
  });

  it("drops a selection that was in flight when the engine's answer went empty", () => {
    const view = seatedView();
    const stale: Interaction = { stage: "attacking", attackerId: "u1", candidates: [] };
    expect(highlightFor(view, [], stale).legal.size).toBe(0);
  });
});

describe("a selection keeps the rest of the board's affordances", () => {
  it("leaves the other playable cards and the controls live while a play is in flight", () => {
    const view = seatedView();
    const legal: ActionBody[] = [
      playZone("h1", 3),
      playZone("h1", 4),
      { type: "play", instanceId: "h2" },
      { type: "endTurn" },
      { type: "concede" },
    ];
    const playing = onClickTarget(view, legal, IDLE, { on: "hand", instanceId: "h1" }).interaction;

    const { legal: lit } = highlightFor(view, legal, playing);

    expect(lit.has(testid.handCard("h2"))).toBe(true);
    expect(lit.has(testid.endTurn)).toBe(true);
    expect(lit.has(testid.concede)).toBe(true);
    expect(lit.has(testid.handCard("h3"))).toBe(false);
  });

  it("leaves the other attackers live while an attack is in flight", () => {
    const view = seatedView();
    const legal: ActionBody[] = [
      { type: "attack", attackerId: "u1", targetId: "e1" },
      { type: "attack", attackerId: "u2", targetId: "e1" },
      { type: "endTurn" },
    ];
    const attacking = onClickTarget(view, legal, IDLE, { on: "unit", instanceId: "u1", side: "you", lane: 1 })
      .interaction;

    const { legal: lit } = highlightFor(view, legal, attacking);

    expect(lit.has(testid.card("u2"))).toBe(true);
    expect(lit.has(testid.endTurn)).toBe(true);
  });
});
