// The clock, the draw offer, Heroic Power's action, and "this turn" on the opponent's turn: what
// `legalActions` offers and `reduce` accepts must agree with SPEC and with each other (§2.3, §2.5,
// §9.3, §10.2, R36, R43, R79, R103). Found by the polish-4 edge-case hunt
// (docs/polish/4-edge-cases.md, lenses L8 and L9, and in round 4 the engine-invariants lens, which
// found two target options sharing one key, and in round 5 a play naming a lane between two lanes);
// every case here but the known gap failed before its fix.

import { describe, expect, it } from "vitest";
import type { Action, ActionInput, GameEvent, Selection } from "@jackioh/shared";
import { legalActions, reduce, subsystems, type CardInstance, type GameState } from "@jackioh/engine";
import { scenario } from "./_harness";

const SCARAB = "core-007"; // Cry: Discover a 2-cost card — one prompt
const VANILLA = "core-008";
const STOCKPILE = "core-005";
const GARY = "core-004"; // Unit, cost 1
const HINDER = "core-021"; // cast on draw
const PANTHER = "core-032";
const MAGIC_JAMMED = "core-036";
const QUICKSTRIKER = "core-038";
const SHEEPISH = "core-041";
const BIG_FELINOR = "core-043";
const TUTOR = "core-051"; // three chained prompts
const MENACE = "core-019";
const RENO = "core-053";
const REMINISCE = "core-072";
const FIENDER = "core-092";
const HEROIC = "core-098";
const CRAFT = "core-099"; // two chained Discovers
const FELINORS = "core-012";
const CHAOS_GOLEM = "core-095-1"; // a Token: no random pool or Discover may ever offer it (§5.1)
const LIBRARY = [VANILLA, VANILLA, VANILLA, VANILLA, VANILLA];

let nonce = 0;
function act(state: GameState, body: ActionInput): { state: GameState; events: GameEvent[]; error?: string } {
  nonce += 1;
  return reduce(state, { ...body, nonce: `turn-clock-${nonce}` } as Action);
}

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

/** R103: the seven power names are state, so pinning one is writing what `ensurePower` writes. */
function withPower(card: CardInstance, name: string): CardInstance {
  card.memory[subsystems.POWER_KEY] = name;
  return card;
}

describe("R79: a timeout acts only for the player whose clock ran out", () => {
  it("R79 the non-active player's timeout with nothing of theirs open does not end the active player's turn", () => {
    const g = scenario({
      p1: { hand: [VANILLA], field: [VANILLA], library: LIBRARY },
      p2: { hand: [VANILLA], field: [VANILLA], library: LIBRARY },
    });
    const result = act(g.state, { type: "timeout", playerId: "p2" });

    expect(result.error).toBeUndefined();
    expect({ active: result.state.active, turn: result.state.turn }).toEqual({ active: "p1", turn: g.state.turn });
    expect(result.events.map((event) => event.type)).not.toContain("turnEnded");
  });

  it("R79 the non-active player's timeout does not answer the active player's prompt or end their turn", () => {
    const g = scenario({ p1: { hand: [SCARAB, RENO], mana: 4 }, p2: { hand: [RENO] } });
    g.play(SCARAB);
    const pending = must(g.state.pending, "the Scarab's Discover");
    expect(pending.playerId).toBe("p1");

    const result = act(g.state, { type: "timeout", playerId: "p2" });
    expect({ active: result.state.active, turn: result.state.turn, pending: result.state.pending?.id ?? null }).toEqual({
      active: "p1",
      turn: g.state.turn,
      pending: pending.id,
    });
  });

  it("R79 the active player's timeout answers every prompt of theirs a chain opens, then ends the turn (§2.5)", () => {
    // KY's Private Tutor opens three chained prompts and Craft a Card two: one timeout answers them
    // all and the turn passes.
    for (const [card, library] of [
      [TUTOR, [MENACE, "core-020", STOCKPILE, "core-006", "core-035"]],
      [CRAFT, LIBRARY],
    ] as const) {
      const g = scenario({ p1: { hand: [card, RENO], mana: 4, library: [...library] }, p2: { hand: [RENO] } });
      g.play(card);
      expect(must(g.state.pending, "the first prompt").playerId).toBe("p1");
      const turn = g.state.turn;

      const result = act(g.state, { type: "timeout", playerId: "p1" });
      expect(result.error).toBeUndefined();
      expect({
        active: result.state.active,
        turn: result.state.turn,
        p1PromptOpen: result.state.pending?.playerId === "p1",
      }).toEqual({ active: "p2", turn: turn + 1, p1PromptOpen: false });
    }
  });
});

describe("R36: a draw offer is answered once", () => {
  it("R36 a declined draw offer is closed: it is no longer offered and cannot then be accepted", () => {
    const g = scenario({ p1: { hand: [RENO] }, p2: { hand: [RENO] } });
    const offered = act(g.state, { type: "offerDraw", playerId: "p1" });
    expect(offered.error).toBeUndefined();
    expect(legalActions(offered.state, "p2").filter((a) => a.type === "answerDraw")).toHaveLength(2);

    const declined = act(offered.state, { type: "answerDraw", playerId: "p2", accept: false });
    expect(declined.error).toBeUndefined();
    expect(legalActions(declined.state, "p2").filter((a) => a.type === "answerDraw")).toEqual([]);

    const accepted = act(declined.state, { type: "answerDraw", playerId: "p2", accept: true });
    expect(accepted.error).toBeDefined();
    expect(accepted.state.result).toBeNull();
    // And the offerer is blocked, so the offer cannot simply be made again this turn.
    expect(legalActions(declined.state, "p1").some((a) => a.type === "offerDraw")).toBe(false);
  });
});

describe("R43 and R103: what an activatePower or a Heroic Power play may carry", () => {
  it("R103 activatePower refuses a ping target the power cannot reach: a dormant card, a hand card, a backrow card (R13)", () => {
    const g = scenario({
      p1: { hand: [RENO], mana: 8, backrow: [HEROIC] },
      p2: {
        hand: [MENACE],
        field: [BIG_FELINOR, { def: FIENDER, stack: true }],
        backrow: [{ def: SHEEPISH, faceUp: false }],
      },
    });
    const power = withPower(must(g.backrow("p1", 1), "the Heroic Power"), "ping");
    const pile = must(g.state.players.p2.units[0], "p2's lane-1 pile");
    const dormant = must(pile.find((card) => card.defId === BIG_FELINOR), "the dormant Big Felinor");
    const top = must(pile.find((card) => card.defId === FIENDER), "the Fiender on top");
    const inHand = must(g.state.players.p2.hand[0], "p2's hand card");
    const trap = must(g.backrow("p2", 1), "p2's face-down trap");

    for (const target of [dormant, inHand, trap]) {
      const result = act(g.state, {
        type: "activatePower",
        playerId: "p1",
        instanceId: power.id,
        targets: [{ pick: "instance", instanceId: target.id }],
      });
      expect(result.error, `a ping at ${target.defId} in ${target.zone.z}`).toBeDefined();
    }

    // The top of the pile and a hero are what the ping reaches, as the prompt would offer them.
    const onTop = act(g.state, {
      type: "activatePower",
      playerId: "p1",
      instanceId: power.id,
      targets: [{ pick: "instance", instanceId: top.id }],
    });
    expect(onTop.error).toBeUndefined();
    expect(onTop.events.filter((event) => event.type === "damage")).toHaveLength(1);
  });

  it("R103 activatePower cannot carry the Discover's answer, so no card of the client's naming reaches the hand (§6.3, §5.1)", () => {
    const g = scenario({ p1: { hand: [RENO], mana: 8, backrow: [HEROIC] } });
    const power = withPower(must(g.backrow("p1", 1), "the Heroic Power"), "discover");
    const handBefore = g.state.players.p1.hand.map((card) => card.defId);

    const result = act(g.state, {
      type: "activatePower",
      playerId: "p1",
      instanceId: power.id,
      targets: [{ pick: "mode", option: CHAOS_GOLEM } as Selection],
    });

    expect(result.error).toBeDefined();
    expect(result.state.players.p1.hand.map((card) => card.defId)).toEqual(handBefore);
  });

  it("R43 Heroic Power's X is its power's X: legalActions offers no X choice and a play records none (§2.3, R65)", () => {
    const g = scenario({ p1: { hand: [HEROIC, RENO], mana: 4 } });
    const card = withPower(must(g.state.players.p1.hand[0], "the Heroic Power in hand"), "ping");

    const plays = legalActions(g.state, "p1").filter(
      (a): a is Extract<typeof a, { type: "play" }> => a.type === "play" && a.instanceId === card.id,
    );
    const perZone = new Set(plays.map((play) => JSON.stringify(play.zone)));
    expect(plays.length).toBe(perZone.size);
    expect(plays.filter((play) => play.x !== undefined)).toEqual([]);

    const result = act(g.state, {
      type: "play",
      playerId: "p1",
      instanceId: card.id,
      zone: { row: "backrow", lane: 2 },
      x: 4,
    });
    expect(result.error).toBeUndefined();
    const played = result.events.find((e) => e.type === "cardPlayed");
    expect(played !== undefined && "x" in played ? played.x : undefined).toBeUndefined();
  });
});

describe("§6.2: 'this turn' on the opponent's turn", () => {
  it("§6.2 a card cast on the opponent's turn counts only the plays of that turn, so Quickstriker's X is 0 (R40, R70)", () => {
    const g = scenario({
      seed: "hunt-l8-stale-log",
      p1: { hand: [QUICKSTRIKER, VANILLA], field: [PANTHER], library: [HINDER, VANILLA, VANILLA, VANILLA, VANILLA] },
      p2: { hand: [VANILLA], field: [VANILLA], library: LIBRARY },
    });
    // p1's own turn: Quickstriker, then a second card (X = 1 on p2's hero).
    g.play(QUICKSTRIKER);
    g.play(VANILLA);
    expect(g.state.players.p2.hero.health).toBe(29);
    g.endTurn();
    expect(g.state.active).toBe("p2");
    const turn = g.state.turn;

    // p2's 3/3 attacks the 5/4 Panther and dies, so the Panther draws 2 for p1 — Hinder first,
    // which casts itself and counts as a card p1 played this turn.
    const attacker = must(g.unit("p2", 1), "p2's unit");
    const panther = must(g.unit("p1", 1), "the Panther");
    g.attack(attacker, panther);
    expect(g.state.turn).toBe(turn);
    expect(g.events.some((e) => e.type === "cardPlayed" && e.defId === HINDER)).toBe(true);

    // p1 played nothing earlier on this turn, so the cast deals 0.
    expect(g.state.players.p2.hero.health).toBe(29);
  });
});

describe("§10.6: a prompt's options can each be picked through the view", () => {
  it("§10.6 a target prompt's options have distinct keys, so each of two same-named units can be picked (§10.8, R81, R103)", () => {
    // Two Duplicating Felinors — #12's own copy makes this an ordinary board — and #98's ping power
    // with no target named, which opens the power's target prompt (R81, R103).
    const s = scenario({
      seed: "inv-r4-prompt-keys",
      p1: { hand: [RENO], mana: 8, backrow: [HEROIC] },
      p2: { field: [FELINORS, FELINORS] },
    });
    const power = must(s.backrow("p1", 1), "p1's Heroic Power");
    withPower(power, "ping");
    s.activate(power);

    const pending = must(s.view("p1").pending, "the ping's target prompt");
    if (!pending.forYou) throw new Error("the prompt should be p1's");
    expect(pending.options.filter((option) => option.defId === FELINORS)).toHaveLength(2);
    // The view's contract (`PendingOption.key` in packages/shared/src/view.ts) is that the key is
    // what the client sends back, so one key names one option; two options sharing a key leave one
    // of them unpickable (the web client maps picked keys back to options through a Map).
    const keys = pending.options.map((option) => option.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("§9.1: legalActions and a face-down trap's instance id", () => {
  // KNOWN GAP, kept as an expected failure (R177's last sentences): an instance id is the only
  // handle the action protocol has for a face-down target (the play action's targets, a prompt
  // option, `activatePower`), so `legalActions` names one whenever a card may target a face-down
  // trap. The id itself says nothing — but a card keeps its id across zones, so a player who saw
  // the id while the card was public (here, in p2's graveyard) can read the face-down card off it.
  // Closing that needs a handle the viewer cannot link — a per-viewer alias for a face-down zone,
  // or a fresh id whenever a card enters a hidden zone — which changes the action protocol the
  // server, the client and the e2e specs share: a design change of its own, not an edge-case fix.
  // R97 and R177 keep every other channel (events, prompt labels and definitions) closed. The
  // change that closes it makes this test pass, which `it.fails` reports, so it cannot go unnoticed.
  it.fails("R177 known limit: legalActions never names a face-down trap by an id its viewer saw while the card was public", () => {
    const g = scenario({
      active: "p2",
      p1: { hand: [MAGIC_JAMMED, RENO], mana: 4 },
      p2: { hand: [REMINISCE, RENO], graveyard: [SHEEPISH], mana: 4 },
    });
    const trapId = must(g.state.players.p2.graveyard[0], "Sheepish in p2's graveyard").id;
    expect(JSON.stringify(g.view("p1"))).toContain(`"${trapId}"`);

    g.play(REMINISCE);
    g.answer(SHEEPISH);
    g.play(must(g.state.players.p2.hand.find((card) => card.defId === SHEEPISH), "Sheepish back in hand"));
    g.endTurn();
    expect(g.state.active).toBe("p1");
    expect(g.backrow("p2", 1)?.id).toBe(trapId);
    expect(JSON.stringify(g.view("p1"))).not.toContain(`"${trapId}"`);

    const naming = legalActions(g.state, "p1").filter((a) => JSON.stringify(a).includes(`"${trapId}"`));
    expect(naming).toEqual([]);
  });
});

describe("§3.2, §9.3: a play's zone is one of the row's lanes", () => {
  it("§9.3 a play naming a zone between two lanes is refused, not accepted with the card lost and its mana spent", () => {
    const s = scenario({ p1: { hand: [GARY, STOCKPILE] }, p2: { hand: [STOCKPILE] } });
    const gary = must(s.hand("p1").find((card) => card.defId === GARY), "Gary in hand");
    const mana = s.state.players.p1.mana.current;

    // `legalActions` offers lanes 1 to 5 only…
    const offered = legalActions(s.state, "p1").some(
      (action) => action.type === "play" && action.instanceId === gary.id && action.zone?.lane === 2.5,
    );
    expect(offered).toBe(false);

    // …and §9.3 has `reduce` refuse what is illegal itself. Lane 2.5 passed the range check and read
    // as an empty, unlocked zone, so the play was accepted: the mana was spent and the card written to
    // `units[1.5]`, a property no lane reads, which the next JSON clone dropped — in no zone at all.
    const result = reduce(s.state, {
      type: "play",
      playerId: "p1",
      nonce: "lane-2.5",
      instanceId: gary.id,
      zone: { row: "units", lane: 2.5 },
    });
    expect(result.error).toBeDefined();
    expect(result.state.players.p1.mana.current).toBe(mana);
  });
});
