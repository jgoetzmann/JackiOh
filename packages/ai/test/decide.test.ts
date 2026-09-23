// decide's short-circuits: forced moves, not its turn, the mulligan and draw offers
// (SPEC §9.9, R188; docs/polish/3-ai.md B16, B20, B21).
//
// B16: one candidate is played without searching (no node, no draw from the AI's rng), and a seat
// that owes nothing gets null. B20: the mulligan returns exactly the cards costing more than
// AI_MULLIGAN.keepMaxCost. B21 and R188: the AI answers an unanswered draw offer at once with a
// decline, and never concedes, offers a draw or accepts one.

import { describe, expect, it } from "vitest";
import type { ActionBody, PlayerId } from "@jackioh/shared";
import { createRng, defOf, legalActions, queryCost, subsystems, type GameState } from "@jackioh/engine";
import {
  AI_GATE_BUDGET,
  AI_MULLIGAN,
  aiToAct,
  decide,
  gameConfig,
  mulliganKeep,
  playMatch,
  unansweredDrawOffer,
} from "../src/index";
import { AI, HUMAN, act, clone, dealtGame, isLegal, scenario } from "./_support";

function mustDecide(state: GameState, seat: PlayerId, seed: string): NonNullable<ReturnType<typeof decide>> {
  const decision = decide(state, seat, { rng: createRng(seed) });
  if (decision === null) throw new Error(`decide returned null for ${seat}`);
  return decision;
}

/** The opponent's turn at turn 10, both sides with something to do. */
function humansTurn(seed: string): GameState {
  return scenario({
    seed,
    active: HUMAN,
    turn: 10,
    p1: { hand: ["core-008"], field: ["core-011"] },
    p2: { hand: ["core-011"], field: ["core-008"] },
  }).state;
}

// ---------------------------------------------------------------------------------------------
// B16
// ---------------------------------------------------------------------------------------------

describe("forced moves and nothing to do (B16)", () => {
  it("B16: a prompt with one option is answered with reason forced, no node spent and the rng untouched", () => {
    const s = scenario({
      seed: "decide-forced-prompt",
      p1: { hand: ["core-072"], graveyard: ["core-008"], library: ["core-011"] },
      p2: { hand: ["core-005"] },
    });
    s.play("core-072");
    const state = s.state;
    expect(state.pending?.playerId).toBe(AI);
    const legal = legalActions(state, AI);
    expect(legal).toHaveLength(1);

    const rng = createRng("decide-forced-prompt");
    const decision = decide(state, AI, { rng });
    expect(decision?.reason).toBe("forced");
    expect(decision?.action).toEqual(legal[0]);
    expect(decision?.stats.nodes).toBe(0);
    expect(rng.cursor).toBe(0);
    // The engine takes it.
    expect(() => act(state, AI, (decision as NonNullable<typeof decision>).action)).not.toThrow();
  });

  it("B16: a main phase whose only candidate is endTurn is forced, with no node and the rng untouched", () => {
    const state = scenario({ seed: "decide-forced-end", p1: {}, p2: { field: ["core-008"], hand: ["core-005"] } }).state;
    const rng = createRng("decide-forced-end");
    const decision = decide(state, AI, { rng });
    expect(decision?.reason).toBe("forced");
    expect(decision?.action).toEqual({ type: "endTurn" });
    expect(decision?.stats.nodes).toBe(0);
    expect(rng.cursor).toBe(0);
  });

  it("B16: the seat's own prompt with several options is not forced: it is searched and answered legally", { timeout: 60_000 }, () => {
    const s = scenario({
      seed: "decide-not-forced",
      p1: { hand: ["core-072"], graveyard: ["core-008", "core-044", "core-005"], library: ["core-011"] },
      p2: { hand: ["core-005"], field: ["core-008"] },
    });
    s.play("core-072");
    const state = s.state;
    expect(legalActions(state, AI).length).toBeGreaterThan(1);

    const decision = decide(state, AI, { rng: createRng("decide-not-forced"), budget: AI_GATE_BUDGET });
    expect(decision?.reason).not.toBe("forced");
    expect(decision?.action.type).toBe("answer");
    expect(decision?.stats.nodes).toBeGreaterThan(0);
    expect(isLegal(state, AI, (decision as NonNullable<typeof decision>).action)).toBe(true);
  });

  it("B16: aiToAct is true in the seat's main phase and at its own prompt", () => {
    const main = scenario({ seed: "decide-owes", p1: { hand: ["core-008"] }, p2: { hand: ["core-005"] } }).state;
    expect(aiToAct(main, AI)).toBe(true);
    expect(aiToAct(main, HUMAN)).toBe(false);

    const s = scenario({
      seed: "decide-owes-prompt",
      p1: { hand: ["core-072"], graveyard: ["core-008", "core-044"], library: ["core-011"] },
      p2: { hand: ["core-005"] },
    });
    s.play("core-072");
    expect(aiToAct(s.state, AI)).toBe(true);
  });

  it("B16: on the opponent's turn, with nothing to answer, decide returns null", () => {
    const state = humansTurn("decide-null-turn");
    expect(aiToAct(state, AI)).toBe(false);
    expect(decide(state, AI, { rng: createRng("decide-null-turn") })).toBeNull();
  });

  it("B16: while the opponent's prompt is open, decide returns null for the seat that does not hold it", () => {
    const s = scenario({
      seed: "decide-null-prompt",
      active: HUMAN,
      turn: 10,
      p1: { hand: ["core-008"] },
      p2: { hand: ["core-072"], graveyard: ["core-008", "core-044"], library: ["core-011"] },
    });
    s.play("core-072");
    expect(s.state.pending?.playerId).toBe(HUMAN);
    expect(aiToAct(s.state, AI)).toBe(false);
    expect(aiToAct(s.state, HUMAN)).toBe(true);
    expect(decide(s.state, AI, { rng: createRng("decide-null-prompt") })).toBeNull();
  });

  it("B16: during the other seat's mulligan decide returns null", () => {
    const state = dealtGame("decide-null-mulligan");
    expect(state.pending?.playerId).toBe("p1");
    expect(aiToAct(state, "p2")).toBe(false);
    expect(decide(state, "p2", { rng: createRng("decide-null-mulligan") })).toBeNull();
  });

  it("B16: once the game is over decide returns null for both seats", () => {
    const s = scenario({ seed: "decide-null-over", p1: { field: ["core-011"], hand: ["core-008"] }, p2: { health: 3, hand: ["core-005"] } });
    s.attack("core-011", "hero");
    expect(s.state.result?.winner).toBe(AI);
    for (const seat of [AI, HUMAN]) {
      expect(aiToAct(s.state, seat)).toBe(false);
      expect(decide(s.state, seat, { rng: createRng("decide-null-over") })).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// B20
// ---------------------------------------------------------------------------------------------

describe("the mulligan (B20)", () => {
  it("B20: the AI returns exactly the cards costing more than keepMaxCost, with reason mulligan, and reduce takes it", () => {
    let returnedTotal = 0;
    let keptTotal = 0;
    for (let n = 1; n <= 8; n += 1) {
      const seed = `decide-mulligan-${n}`;
      let state = dealtGame(seed);
      for (const seat of ["p1", "p2"] as const) {
        expect(state.pending?.kind, `${seed} ${seat}`).toBe("mulligan");
        expect(state.pending?.playerId, `${seed} ${seat}`).toBe(seat);

        const hand = state.players[seat].hand;
        const keep = hand
          .filter((card) => queryCost(defOf(state, card.defId)) <= AI_MULLIGAN.keepMaxCost)
          .map((card) => card.id)
          .sort();
        const returned = hand.map((card) => card.id).filter((id) => !keep.includes(id));

        const rng = createRng(`${seed}:${seat}`);
        const decision = decide(state, seat, { rng });
        expect(decision?.reason, `${seed} ${seat}`).toBe("mulligan");
        const action = (decision as NonNullable<typeof decision>).action;
        expect(action.type).toBe("mulligan");
        expect(action.type === "mulligan" ? [...action.keep].sort() : null, `${seed} ${seat}`).toEqual(keep);
        expect([...mulliganKeep(state, seat)].sort(), `${seed} ${seat}`).toEqual(keep);
        expect(rng.cursor, `${seed} ${seat}`).toBe(0);
        expect(decision?.stats.score).toBe(0);

        state = act(state, seat, action);
        // R9: the replacements were drawn before the returned cards went back, so none came back.
        for (const id of returned) {
          expect(state.players[seat].hand.some((card) => card.id === id), `${seed} ${seat} ${id}`).toBe(false);
        }
        returnedTotal += returned.length;
        keptTotal += keep.length;
      }
    }
    // Not vacuous: the seeds dealt both kinds of card.
    expect(returnedTotal).toBeGreaterThan(0);
    expect(keptTotal).toBeGreaterThan(0);
  });
});

/** p1's mulligan with its hand's defs replaced, so the costs are chosen by the test. */
function mulliganWith(seed: string, defIds: readonly string[]): GameState {
  const state = clone(dealtGame(seed));
  state.players.p1.hand.forEach((card, at) => {
    card.defId = defIds[at % defIds.length] as string;
  });
  return state;
}

describe("the mulligan at its bounds (B20)", () => {
  it("B20: a hand of cards costing exactly keepMaxCost is kept whole", { timeout: 60_000 }, () => {
    const three = "core-019"; // Midrange Menace, 3
    expect(queryCost(defOf(null, three))).toBe(AI_MULLIGAN.keepMaxCost);
    const state = mulliganWith("decide-mulligan-keep-all", [three]);
    const decision = mustDecide(state, "p1", "decide-mulligan-keep-all");
    expect(decision.action.type === "mulligan" ? [...decision.action.keep].sort() : null).toEqual(
      state.players.p1.hand.map((card) => card.id).sort(),
    );
    expect(() => act(state, "p1", decision.action)).not.toThrow();
  });

  it("B20: a hand of cards costing more than keepMaxCost is returned whole", { timeout: 60_000 }, () => {
    const four = "core-025"; // 4-mana 7/7
    expect(queryCost(defOf(null, four))).toBeGreaterThan(AI_MULLIGAN.keepMaxCost);
    const state = mulliganWith("decide-mulligan-return-all", [four]);
    const decision = mustDecide(state, "p1", "decide-mulligan-return-all");
    expect(decision.reason).toBe("mulligan");
    expect(decision.action).toEqual({ type: "mulligan", keep: [] });
    const after = act(state, "p1", decision.action);
    for (const card of state.players.p1.hand) {
      expect(after.players.p1.hand.some((kept) => kept.id === card.id)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// B21, R188
// ---------------------------------------------------------------------------------------------

describe("draw offers (B21)", () => {
  it("R188 B21: with the opponent's offer unanswered the AI owes an action and declines it at once", () => {
    const before = humansTurn("decide-offer");
    expect(unansweredDrawOffer(before, AI)).toBe(false);
    expect(aiToAct(before, AI)).toBe(false);

    const offered = act(before, HUMAN, { type: "offerDraw" });
    expect(unansweredDrawOffer(offered, AI)).toBe(true);
    expect(unansweredDrawOffer(offered, HUMAN)).toBe(false);
    expect(aiToAct(offered, AI)).toBe(true);

    const rng = createRng("decide-offer");
    const decision = decide(offered, AI, { rng });
    expect(decision?.action).toEqual({ type: "answerDraw", accept: false });
    expect(decision?.reason).toBe("draw-offer");
    expect(decision?.stats.score).toBe(0);
    expect(rng.cursor).toBe(0);

    const answered = act(offered, AI, (decision as NonNullable<typeof decision>).action);
    expect(answered.result).toBeNull();
    expect(answered.active).toBe(HUMAN);
    // Answered once: the AI owes nothing more, so it cannot loop on the same offer.
    expect(unansweredDrawOffer(answered, AI)).toBe(false);
    expect(aiToAct(answered, AI)).toBe(false);
    expect(decide(answered, AI, { rng: createRng("decide-offer-after") })).toBeNull();
  });

  it("R188 B21: once declined, the human cannot offer again at once (R36), so the AI is not asked twice", { timeout: 60_000 }, () => {
    const offered = act(humansTurn("decide-offer-block"), HUMAN, { type: "offerDraw" });
    const declined = act(offered, AI, mustDecide(offered, AI, "decide-offer-block").action);
    expect(legalActions(declined, HUMAN).some((action) => action.type === "offerDraw")).toBe(false);
    expect(unansweredDrawOffer(declined, AI)).toBe(false);
  });

  it("R188 B21: an offer from an earlier turn is not unanswered on this one", { timeout: 60_000 }, () => {
    const offered = act(humansTurn("decide-offer-stale"), HUMAN, { type: "offerDraw" });
    const next = act(offered, HUMAN, { type: "endTurn" });
    expect(next.active).toBe(AI);
    expect(unansweredDrawOffer(next, AI)).toBe(false);
    const decision = mustDecide(next, AI, "decide-offer-stale");
    expect(decision.action.type).not.toBe("answerDraw");
    expect(decision.reason).not.toBe("draw-offer");
  });

  it("R188 B21: while the offering player's own prompt is open, the offer does not yet ask the AI", () => {
    const s = scenario({
      seed: "decide-offer-prompt",
      active: HUMAN,
      turn: 10,
      p1: { hand: ["core-008"], field: ["core-011"] },
      p2: { hand: ["core-072", "core-011"], graveyard: ["core-008", "core-044"], library: ["core-005"] },
    });
    const offered = act(s.state, HUMAN, { type: "offerDraw" });
    const prompted = act(offered, HUMAN, legalActions(offered, HUMAN).find(
      (action) => action.type === "play" && s.card("core-072").id === action.instanceId,
    ) as ActionBody);
    expect(prompted.pending?.playerId).toBe(HUMAN);
    expect(unansweredDrawOffer(prompted, AI)).toBe(false);
    expect(aiToAct(prompted, AI)).toBe(false);
    expect(decide(prompted, AI, { rng: createRng("decide-offer-prompt") })).toBeNull();
  });

  it("R188 B21: the player who offered never answers their own offer", { timeout: 60_000 }, () => {
    const offered = act(humansTurn("decide-offer-self"), HUMAN, { type: "offerDraw" });
    expect(unansweredDrawOffer(offered, HUMAN)).toBe(false);
    const decision = mustDecide(offered, HUMAN, "decide-offer-self");
    expect(decision.action.type).not.toBe("answerDraw");
    expect(decision.reason).not.toBe("draw-offer");
  });

  it("R188 B21: the decline is legal for the AI and an accept is never chosen, whatever the AI's rng", { timeout: 60_000 }, () => {
    const offered = act(humansTurn("decide-offer-many"), HUMAN, { type: "offerDraw" });
    for (let k = 0; k < 5; k += 1) {
      const decision = mustDecide(offered, AI, `decide-offer-many:${k}`);
      expect(decision.action).toEqual({ type: "answerDraw", accept: false });
      expect(isLegal(offered, AI, decision.action)).toBe(true);
    }
  });

  it(
    "R188 B21: across a game against a player who offers a draw at every chance, the AI declines each once and never concedes or offers",
    { timeout: 300_000 },
    () => {
      const seed = "decide-offerer";
      let state = dealtGame(seed);
      const aiRng = createRng(`${seed}:ai`);
      const policy = createRng(`${seed}:human`);
      const aiActions: ActionBody[] = [];
      let offers = 0;

      for (let n = 0; state.result === null && n < 300; n += 1) {
        const actor: PlayerId = aiToAct(state, AI) ? AI : (state.pending?.playerId ?? state.active);
        let body: ActionBody | null;
        if (actor === AI) {
          const decision = decide(state, AI, { rng: aiRng, budget: AI_GATE_BUDGET });
          expect(decision, `action ${n}`).not.toBeNull();
          body = (decision as NonNullable<typeof decision>).action;
          aiActions.push(body);
        } else {
          const offer = legalActions(state, HUMAN).find((action) => action.type === "offerDraw");
          if (offer !== undefined) offers += 1;
          body = offer ?? subsystems.chooseAction(state, HUMAN, policy);
        }
        if (body === null) break;
        state = act(state, actor, body, `offerer-${n}`);
      }

      expect(offers).toBeGreaterThan(0);
      const stillOpen = unansweredDrawOffer(state, AI) ? 1 : 0;
      const answers = aiActions.filter((action) => action.type === "answerDraw");
      expect(answers).toHaveLength(offers - stillOpen);
      for (const answer of answers) expect(answer).toEqual({ type: "answerDraw", accept: false });
      expect(aiActions.filter((action) => action.type === "concede" || action.type === "offerDraw")).toEqual([]);
    },
  );

  it("R188 B21: in gate games the AI's log holds no concede, no offerDraw and no accepting answerDraw", { timeout: 300_000 }, () => {
    for (const n of [1, 2]) {
      const config = gameConfig("ai-vs-random", n, AI_GATE_BUDGET);
      const subject = (["p1", "p2"] as const).find((seat) => config.controllers[seat].kind === "ai");
      if (subject === undefined) throw new Error("gameConfig seated no AI");
      const record = playMatch(config);
      const aiActions = record.log.filter((action) => action.playerId === subject);
      expect(aiActions.length, `game ${n}`).toBeGreaterThan(0);
      for (const action of aiActions) {
        expect(action.type, `game ${n}`).not.toBe("concede");
        expect(action.type, `game ${n}`).not.toBe("offerDraw");
        if (action.type === "answerDraw") expect(action.accept, `game ${n}`).toBe(false);
      }
    }
  });
});
