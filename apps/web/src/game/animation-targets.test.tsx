// BUILD M5-T4, the assertion that matters: **every row of the animation table names an element the
// client actually renders.**
//
// `animations.test.ts` already pins the table's durations, its keyframes and the testid each row
// resolves to. What it could not do is check that the testid is a real element, because it renders
// nothing — its "resolves a target for every event type without throwing" only ever proved that a
// *string* came back. A row can therefore point at a name no component has ever rendered and stay
// green forever, which is exactly what `modifierChanged` did: it animated `modifiers-<side>`, no
// component rendered it, `SideView` carried no modifier list at all, and so a player could not see
// that #77 Professor Curvature or #78 /fullsend was active on them. R169 put the list in the view
// and `Hero.tsx` renders it; this file is the test that would have caught the gap.
//
// The proof is the whole client (`Game`, so the shell's banner, toast, overlay and modal are in the
// tree alongside the board) rendered from one `PlayerView`, and then, for every member of
// `GameEvent["type"]`, one sample event built against THAT view: the target must resolve, and the
// element must be in the document.
//
// Three rows resolve to `null` by design, and the test knows the difference rather than excusing
// it: `promptOpened` and `promptAnswered` on the seat that is not holding the prompt, and
// `drawOffered` on the seat that made the offer. Each shows nothing at all — §10.6 gives the other
// player no modal, and the offerer no toast — so `null` is the right answer and the table says so.
// Every other row must produce an element on every sample, and the null-able set is asserted to be
// exactly those three, so a new row cannot join them by accident.

import { GAME_EVENT_TYPES, type GameEvent, type GameEventType, type PlayerView } from "@jackioh/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { targetFor } from "./animations.ts";
import Game from "./Game.tsx";
import { fullBoardView, pendingFor } from "../test/fixtures.ts";

afterEach(cleanup);

/* --------------------------------------------------------------------------------------------- *
 * The view: a full board, plus the three pieces of chrome that only appear on a condition.
 * --------------------------------------------------------------------------------------------- */

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`the fixture is missing ${what}`);
  return value;
}

function handIds(view: PlayerView): string[] {
  const hand = view.you.hand;
  if (!Array.isArray(hand)) throw new Error("the viewer's own hand should be full cards (SPEC §10.8)");
  return hand.map((card) => card.instanceId);
}

function faceUpBackrowIds(view: PlayerView): string[] {
  return view.you.backrow.flatMap((slot) => (slot !== null && slot.faceDown === false ? [slot.instanceId] : []));
}

/**
 * `Game` renders the banner unconditionally, but the prompt modal, the draw toast and the result
 * overlay each wait on something: an open prompt, a standing draw offer (R269's `drawOffer`), and a
 * result. All three are in the view at once here — they are chrome, a single tree lets one render
 * prove every row — though the engine never sends an offer with a result (R216).
 */
function chromeView(): PlayerView {
  return fullBoardView({
    pending: pendingFor("target", [{ key: "hero:p2", label: "Opponent hero", player: "p2" }]),
    // The toast belongs to the seat that must ANSWER, so the offer is the opponent's (Game.tsx).
    drawOffer: { by: "p2" },
    events: [{ type: "drawOffered", player: "p2" }],
    result: { winner: "p1", reason: "concede" },
  });
}

/* --------------------------------------------------------------------------------------------- *
 * One sample per event type, every id taken from the view above.
 * --------------------------------------------------------------------------------------------- */

function samplesFor(view: PlayerView): { [K in GameEventType]: Extract<GameEvent, { type: K }> } {
  const unit = must(view.you.units[0], "your unit in lane 1").instanceId;
  const enemy = must(view.opponent.units[0], "the opponent's unit in lane 1").instanceId;
  const hand = must(handIds(view)[0], "a card in the viewer's hand");
  const trap = must(faceUpBackrowIds(view).at(-1), "a face-up trap in the viewer's backrow");
  const modifier = must(view.you.modifiers[0], "a modifier on the viewer's own seat").id;

  return {
    cardPlayed: { type: "cardPlayed", player: "p1", instanceId: hand, defId: "core-002", costPaid: 1 },
    cardResolved: { type: "cardResolved", player: "p1", instanceId: unit, defId: "core-004", permanent: true, costPaid: 1 },
    summoned: { type: "summoned", player: "p1", instanceId: unit, defId: "core-004", row: "units", lane: 2 },
    damage: { type: "damage", sourceId: enemy, targetId: "hero-p1", amount: 4, combat: true },
    healthLost: { type: "healthLost", player: "p1", amount: 3 },
    healed: { type: "healed", targetId: unit, amount: 2 },
    divineShieldLost: { type: "divineShieldLost", instanceId: enemy },
    destroyed: { type: "destroyed", instanceId: unit, defId: "core-004", owner: "p1", attack: 2, maxHealth: 3, killerId: enemy },
    enteredGraveyard: { type: "enteredGraveyard", instanceId: unit, defId: "core-004", owner: "p1" },
    exiled: { type: "exiled", instanceId: unit, defId: "core-004", owner: "p1" },
    bounced: { type: "bounced", instanceId: unit, defId: "core-004", owner: "p1" },
    burned: { type: "burned", instanceId: "gone", defId: "core-041", owner: "p2" },
    discarded: { type: "discarded", instanceId: hand, defId: "core-002", owner: "p1" },
    drawn: { type: "drawn", player: "p1", instanceId: "gone", defId: "core-055" },
    addedToHand: { type: "addedToHand", player: "p2", instanceId: "gone", defId: "core-060" },
    shuffledIn: { type: "shuffledIn", player: "p1", instanceId: "gone", defId: "core-070", position: -1 },
    buffed: { type: "buffed", instanceId: unit, attack: 1, health: 1 },
    keywordGranted: { type: "keywordGranted", instanceId: unit, keyword: { kind: "Taunt" } },
    counterChanged: { type: "counterChanged", instanceId: unit, counter: "plague", value: 3 },
    costChanged: { type: "costChanged", instanceId: hand, cost: 0 },
    // The row this file exists for: the badge list beside the hero (R169, BUILD M5-T4).
    modifierChanged: { type: "modifierChanged", player: "p1", modifierId: modifier, added: true },
    radiantSet: { type: "radiantSet", instanceId: unit, defId: "core-004", zone: { z: "field", player: "p1", row: "units", lane: 1 } },
    transformed: { type: "transformed", instanceId: unit, fromDefId: "core-004", toDefId: "token-sheep", newInstanceId: "gone" },
    fused: { type: "fused", instanceIds: [unit, enemy], resultInstanceId: "gone", defId: "core-088" },
    positionSwitched: { type: "positionSwitched", instanceId: unit, position: "DEF" },
    controlChanged: { type: "controlChanged", instanceId: enemy, controller: "p1", row: "units", lane: 4 },
    rotated: { type: "rotated", direction: "left" },
    swapped: { type: "swapped", what: "health" },
    locked: { type: "locked", player: "p2", row: "backrow", lane: 1 },
    trapFired: { type: "trapFired", instanceId: trap, defId: "core-084", controller: "p1", row: "backrow", lane: 5 },
    attackDeclared: { type: "attackDeclared", attackerId: unit, targetId: enemy, forced: false },
    attackCancelled: { type: "attackCancelled", attackerId: unit, targetId: enemy, byInstanceId: trap },
    manaChanged: { type: "manaChanged", player: "p1", current: 2, max: 4 },
    turnStarted: { type: "turnStarted", player: "p1", turn: 3 },
    turnEnded: { type: "turnEnded", player: "p1", turn: 3, unspentMana: 2 },
    turnAutoEnded: { type: "turnAutoEnded", player: "p1", turn: 3 },
    promptOpened: { type: "promptOpened", player: "p1", choiceId: "ch1", kind: "target" },
    promptAnswered: { type: "promptAnswered", player: "p1", choiceId: "ch1" },
    drawOffered: { type: "drawOffered", player: "p2" },
    drawAnswered: { type: "drawAnswered", player: "p1", accept: false },
    gameOver: { type: "gameOver", winner: "p1", reason: "concede" },
  };
}

/**
 * The rows that show nothing on one of the two seats (§10.6's "the opponent's view shows only that
 * a prompt is open", and the toast that belongs to the seat which owes the answer). These are the
 * only legitimate `null`s — and the set is not merely declared here: the third test swaps the
 * player on every sample and proves that every OTHER row still lands on a rendered element, so a
 * row that starts going dark joins this list by failing, not by being added to it.
 */
const SEAT_CONDITIONAL: readonly GameEventType[] = ["promptOpened", "promptAnswered", "drawOffered"];

/** The same event aimed at the other seat, for the rows whose target depends on whose it is. */
function forOtherPlayer<E extends GameEvent>(event: E): E {
  return "player" in event ? { ...event, player: event.player === "p1" ? "p2" : "p1" } : event;
}

function renderClient(view: PlayerView): void {
  render(<Game view={view} legal={[]} onAction={() => undefined} />);
}

function rendered(testId: string): Element | null {
  return screen.queryByTestId(testId);
}

describe("every animation target is an element the client renders (BUILD M5-T4, R169)", () => {
  it("resolves every event type to a data-testid that is in the document", () => {
    const view = chromeView();
    const samples = samplesFor(view);
    renderClient(view);

    const missing: string[] = [];
    for (const type of GAME_EVENT_TYPES) {
      const target = targetFor(samples[type], view);
      if (target === null) {
        missing.push(`${type}: the table resolved no element at all`);
        continue;
      }
      if (rendered(target) === null) missing.push(`${type} → [data-testid="${target}"] is not rendered`);
    }

    expect(missing, "BUILD M5-T4: every row animates an element some component draws").toEqual([]);
  });

  it("modifierChanged animates the badge list on whichever seat changed", () => {
    const view = chromeView();
    renderClient(view);

    for (const [player, side] of [
      ["p1", "you"],
      ["p2", "opponent"],
    ] as const) {
      const target = targetFor({ type: "modifierChanged", player, modifierId: "m1", added: false }, view);
      expect(target, `${player} has a modifier target`).toBe(`modifiers-${side}`);
      expect(rendered(must(target, "the modifier target")), `modifiers-${side} is rendered`).not.toBeNull();
    }
  });

  it("only the three seat-conditional rows resolve to nothing, and only on the seat that shows nothing", () => {
    const view = chromeView();
    const samples = samplesFor(view);
    renderClient(view);

    const wrong: string[] = [];
    for (const type of GAME_EVENT_TYPES) {
      const target = targetFor(forOtherPlayer(samples[type]), view);
      if (SEAT_CONDITIONAL.includes(type)) {
        // §10.6: the other seat has no modal, and the offerer has no toast. Nothing to animate.
        if (target !== null) wrong.push(`${type} should show nothing on the other seat, got ${target}`);
        continue;
      }
      // Every other row is two-sided: swapping whose event it is must still land somewhere real.
      if (target === null) {
        wrong.push(`${type} went dark when the event was the other seat's — is it seat-conditional?`);
        continue;
      }
      if (rendered(target) === null) wrong.push(`${type} → [data-testid="${target}"] is not rendered`);
    }

    expect(wrong, "the null rows are exactly promptOpened, promptAnswered and drawOffered").toEqual([]);
  });
});
