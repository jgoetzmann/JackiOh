// The coach's advice for a lesson's quiet turns (tutorial/advice.ts), on hand-built views: R292.
//
// Every move it names is one `legalActions` already offered, read off what the view shows: it plays
// the dearest card first, then a trade that kills and survives, then the hero, then a dent in a Taunt,
// then End turn — and it never aims a play at the human's own side.

import { describe, expect, it } from "vitest";

import type { ActionBody, PlayerView } from "@jackioh/shared";

import { baseView, card, emptySide, unit } from "../test/fixtures.ts";
import { COACH_START, activeStep, coachObserve, type CoachCtx, type LessonScript } from "./coach.ts";
import { moveAnchor, moveText, nextMove, yourMove } from "./advice.ts";

function ctx(view: PlayerView, legal: ActionBody[]): CoachCtx {
  return { view, legal, fresh: [], aiToAct: false, nameOf: (defId) => ({ "core-008": "Mr. Vanilla", "core-013": "Shredder" })[defId] };
}

const END: ActionBody = { type: "endTurn" };

describe("R292 the coach's advice", () => {
  it("R292 names the dearest legal play first, never one aimed at the human's own side", () => {
    const mine = unit("p1", { instanceId: "m1" });
    const view = baseView({
      you: emptySide("p1", {
        units: [mine, null, null, null, null],
        hand: [card({ instanceId: "h1", defId: "core-008", cost: 1 }), card({ instanceId: "h2", defId: "core-013", cost: 3 })],
      }),
    });
    const cheap: ActionBody = { type: "play", instanceId: "h1", zone: { row: "units", lane: 2 } };
    const dearAtOwn: ActionBody = { type: "play", instanceId: "h2", zone: { row: "units", lane: 2 }, targets: [{ pick: "instance", instanceId: "m1" }] };
    const dear: ActionBody = { type: "play", instanceId: "h2", zone: { row: "units", lane: 2 }, targets: [{ pick: "hero", player: "p2" }] };
    const move = nextMove(ctx(view, [cheap, dearAtOwn, dear, END]));
    expect(move?.action).toEqual(dear);
    expect(moveAnchor(ctx(view, []), move)).toEqual({ kind: "handCard", defId: "core-013" });
    expect(moveText(ctx(view, []), move)).toContain("Shredder");
    expect(nextMove(ctx(view, [cheap, dearAtOwn, END]))?.action).toEqual(cheap);
  });

  it("R292 prefers a trade that kills and survives, then the hero, then a dent in a Taunt, then End turn", () => {
    const big = unit("p1", { instanceId: "a1", defId: "core-013", attack: 8, health: 10, maxHealth: 10 });
    const small = unit("p2", { instanceId: "e1", defId: "core-008", attack: 3, health: 3, maxHealth: 3 });
    const wall = unit("p2", { instanceId: "e2", defId: "core-019", attack: 9, health: 20, maxHealth: 20, keywords: [{ kind: "Taunt" }] });
    const view = (enemy: PlayerView["opponent"]["units"]): PlayerView =>
      baseView({ you: emptySide("p1", { units: [big, null, null, null, null] }), opponent: emptySide("p2", { units: enemy, hand: { count: 2 } }) });

    const trade: ActionBody = { type: "attack", attackerId: "a1", targetId: "e1" };
    const face: ActionBody = { type: "attack", attackerId: "a1", targetId: "hero-p2" };
    const both = view([small, null, null, null, null]);
    expect(nextMove(ctx(both, [trade, face, END]))?.kind).toBe("trade");
    expect(moveAnchor(ctx(both, []), nextMove(ctx(both, [trade, face, END])))).toEqual({ kind: "zone", side: "opponent", row: "units", lane: 1 });
    expect(nextMove(ctx(both, [face, END]))?.kind).toBe("hero");

    const walled = view([wall, null, null, null, null]);
    const dent: ActionBody = { type: "attack", attackerId: "a1", targetId: "e2" };
    expect(nextMove(ctx(walled, [dent, END]))?.kind).toBe("chip");
    expect(nextMove(ctx(walled, [END]))?.kind).toBe("end");
    expect(nextMove(ctx(walled, []))).toBeUndefined();
  });

  it("R292 makes a step that names its move, is done when the turn passes, or with the game when final", () => {
    const view = baseView({ you: emptySide("p1", { hand: [card({ instanceId: "h1", defId: "core-008", cost: 1 })] }) });
    const play: ActionBody = { type: "play", instanceId: "h1", zone: { row: "units", lane: 1 } };
    const script: LessonScript = { lessonId: "t", steps: [yourMove({ id: "move", title: "Your move" }), yourMove({ id: "win", title: "Win", final: true })], tips: [] };
    let state = coachObserve(script, COACH_START, ctx(view, [play, END]));
    const step = activeStep(script, state);
    expect(step?.id).toBe("move");
    expect(step?.expect?.(play, ctx(view, [play, END]))).toBe(true);
    expect(step?.expect?.(END, ctx(view, [play, END]))).toBe(false);

    state = coachObserve(script, state, ctx(baseView({ turn: 4, active: "p2" }), []));
    expect(state.outcomes["move"]).toBe("done");
    expect(script.steps[1]?.final).toBe(true);
    state = coachObserve(script, state, ctx(baseView({ turn: 5 }), [END]));
    expect(activeStep(script, state)?.id).toBe("win");
  });
});
