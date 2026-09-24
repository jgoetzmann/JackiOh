// The showcase's trigger rules, from the redacted event stream alone (plan.ts; CLAUDE.md rule 7,
// R97, R227): the opponent's plays are held up, the viewer's own never are, and a card the view
// hides is a back that names nothing.

import type { GameEvent } from "@jackioh/shared";
import { describe, expect, it } from "vitest";

import { baseView, card } from "../../test/fixtures.ts";
import { capQueue, eventsSince, opponentPlays, sameOccurrence } from "./plan.ts";

const TURN: GameEvent = { type: "turnStarted", player: "p2", turn: 4 };
const MANA: GameEvent = { type: "manaChanged", player: "p2", current: 3, max: 3 };

function played(player: "p1" | "p2", instanceId: string, defId: string, extra: Partial<GameEvent> = {}): GameEvent {
  return { type: "cardPlayed", player, instanceId, defId, costPaid: 1, ...extra } as GameEvent;
}

function summoned(player: "p1" | "p2", instanceId: string, defId: string, row: "units" | "backrow", lane = 2): GameEvent {
  return { type: "summoned", player, instanceId, defId, row, lane };
}

/** The viewer is p1 (`baseView`), so p2 is the opponent. */
const view = baseView();

describe("which plays are held up", () => {
  it("holds up the opponent's play, by its definition, its instance and what it cost", () => {
    const plays = opponentPlays([MANA, played("p2", "c7", "core-032"), summoned("p2", "c7", "core-032", "units")], view);
    // The instance and the price paid let the showcase draw the card in play (SPEC §10.10).
    expect(plays).toEqual([
      { player: "p2", defId: "core-032", instanceId: "c7", costPaid: 1, radiant: false, set: false },
    ]);
  });

  it("never holds up the viewer's own play", () => {
    expect(opponentPlays([played("p1", "c3", "core-011"), summoned("p1", "c3", "core-011", "units")], view)).toEqual([]);
  });

  it("holds up every opponent play in order, a cast (R70) included", () => {
    const plays = opponentPlays([played("p2", "c7", "core-005"), played("p2", "c8", "core-010", { costPaid: 0 })], view);
    expect(plays.map((play) => play.defId)).toEqual(["core-005", "core-010"]);
  });

  it("R97 / R227 a card set face down is a back that says it was set, with no definition", () => {
    const plays = opponentPlays([played("p2", "hidden", "hidden"), summoned("p2", "hidden", "hidden", "backrow", 3)], view);
    expect(plays).toEqual([{ player: "p2", defId: null, radiant: false, set: true }]);
    expect(JSON.stringify(plays)).not.toMatch(/core-\d+/);
  });

  it("R97 a hidden play that set nothing is a back that says a card was played", () => {
    expect(opponentPlays([played("p2", "hidden", "hidden")], view)).toEqual([
      { player: "p2", defId: null, radiant: false, set: false },
    ]);
  });

  it("takes the face that resolved from cardResolved, else the one the view shows", () => {
    const resolved: GameEvent = {
      type: "cardResolved",
      player: "p2",
      instanceId: "c7",
      defId: "core-032",
      permanent: true,
      costPaid: 1,
      radiant: true,
    };
    expect(opponentPlays([played("p2", "c7", "core-032"), resolved], view)[0]?.radiant).toBe(true);

    const onBoard = baseView({
      opponent: { ...baseView().opponent, graveyard: [card({ instanceId: "c9", defId: "core-005", radiant: true })] },
    });
    expect(opponentPlays([played("p2", "c9", "core-005")], onBoard)[0]?.radiant).toBe(true);
  });

  it("a hotseat viewer seated p2 reads p1 as the opponent", () => {
    const asP2 = baseView({ viewer: "p2", you: baseView().opponent, opponent: baseView().you });
    expect(opponentPlays([played("p1", "c3", "core-011")], asP2).map((play) => play.defId)).toEqual(["core-011"]);
    expect(opponentPlays([played("p2", "c4", "core-011")], asP2)).toEqual([]);
  });
});

describe("which events are new", () => {
  it("finds the events after the overlap of two windows", () => {
    const a: GameEvent = { type: "drawn", player: "p2", instanceId: "c1", defId: "core-001" };
    const prev = [TURN, MANA, a];
    const next = [MANA, a, played("p2", "c1", "core-001")];
    expect(eventsSince(prev, next)).toEqual([played("p2", "c1", "core-001")]);
  });

  it("R97 a draw that read as the sentinel and now names the card played is the same event", () => {
    const hiddenDraw: GameEvent = { type: "drawn", player: "p2", instanceId: "hidden", defId: "hidden" };
    const openDraw: GameEvent = { type: "drawn", player: "p2", instanceId: "c1", defId: "core-032" };
    const prev = [TURN, hiddenDraw, MANA];
    const next = [TURN, openDraw, MANA, played("p2", "c1", "core-032")];
    // A plain comparison finds no overlap and would call the whole window new, the old plays too.
    expect(eventsSince(prev, next)).toEqual([played("p2", "c1", "core-032")]);
  });

  it("R97 a play hidden before and readable now is not played again", () => {
    const hiddenPlay = played("p2", "hidden", "hidden");
    const openPlay = played("p2", "c5", "core-041");
    const prev = [TURN, hiddenPlay];
    const next = [TURN, openPlay, MANA];
    expect(eventsSince(prev, next)).toEqual([MANA]);
  });

  it("two windows with nothing in common make the whole newer one new", () => {
    expect(eventsSince([MANA], [TURN])).toEqual([TURN]);
    expect(eventsSince([], [TURN])).toEqual([TURN]);
  });

  it("the same occurrence: identical events, or a sentinel against a reading about the same seats", () => {
    expect(sameOccurrence(MANA, { ...MANA })).toBe(true);
    expect(sameOccurrence(MANA, { ...MANA, current: 2 } as GameEvent)).toBe(false);
    expect(sameOccurrence(played("p2", "hidden", "hidden"), played("p2", "c5", "core-041"))).toBe(true);
    expect(sameOccurrence(played("p2", "hidden", "hidden"), played("p1", "c5", "core-041"))).toBe(false);
    expect(sameOccurrence(played("p2", "c4", "core-001"), played("p2", "c5", "core-041"))).toBe(false);
    expect(sameOccurrence(MANA, TURN)).toBe(false);
    expect(sameOccurrence(undefined, MANA)).toBe(false);
  });
});

describe("the queue", () => {
  it("keeps the newest plays", () => {
    expect(capQueue([1, 2, 3, 4, 5], 3)).toEqual([3, 4, 5]);
    expect(capQueue([1, 2], 3)).toEqual([1, 2]);
  });
});
