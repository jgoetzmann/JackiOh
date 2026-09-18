// BUILD M8 `12-rotation-and-swaps.cy.ts` — "Silly Silas, Pocket Chaos board swap".
//
// Key assertions (BUILD M8's table, verbatim):
//
//   "every card testid moves one lane; board swap flips sides"
//
// "One lane" is not an array shift. R14 and §3.1 make the ten unit zones ONE RING, read from the
// rotating player's seat: "your lane 1→5, then the opponent's lane 5 down to 1, and back to your
// lane 1; the backrow forms a second ring the same way". So the step out of your lane 5 is the
// opponent's lane 5 and the step out of the opponent's lane 1 is your lane 1, and those two moves
// change control (§3.2: "Steal and rotation change the controller of a card on the field";
// ownership does not move, R12). `RING` below is that order, and every expected destination in
// this spec is one step along it — a naive per-side shift would put four of the six cards in the
// wrong zone and is exactly what this spec is meant to catch.
//
// R33 is the other half. "Only the current controller sees a face-down trap's identity: after a
// steal, board swap or rotation the new controller sees it and the previous one stops seeing it,
// even though ownership is unchanged." Each seat sets one trap, and the board swap moves both
// across the centre line, so the spec reads the same two cards twice: seat 1's own My Pawn stops
// being readable although seat 1 still OWNS it, and seat 2's Bear Honeypot starts being readable
// although seat 1 will never own it. `Backrow.tsx` makes that assertable without a peek at the
// state: a `{ faceDown: true }` entry carries no instance id, so a trap seat 1 may not read has
// no `card-<instanceId>` element at all and its name is nowhere in the DOM (§10.8).
//
// R73 fixes what "swap boards" does: "zone contents swap lane by lane, locks stay with their
// zones, control changes, ownership doesn't, and a face-down trap stays face-down but is now
// readable by its new controller only (R33)". Lane-preserving is asserted per card: same row,
// same lane, other side.
//
// R81 is why neither choice is a `PendingChoice`: Silas's direction is a declared `direction`
// pick and Pocket Chaos's swap is a declared `mode`, so both travel inside the `play` action and
// the client builds them with its pickers. §10.6: "No Core card opens an `x`, `embiggen`, `zone`,
// `tribute` or `direction` prompt".
//
// House rules (BUILD M8): the seed is set here and overridable with `--expose seed=…`; there is
// no fixed `cy.wait(ms)` — every wait is `cy.settled()` or a retried assertion; every selector
// comes from `e2e/support/testids.ts`.
//
// Blocked today (2026-09-18), reported and not worked around: nothing in `apps/web` registers the
// card catalog with the engine — it has no dependency on `@jackioh/cards` at all — so
// `registeredCatalog()` is empty, `/dev/hotseat` answers every deck with "not in the catalog
// (§9.4 L6)" and `window.__jackioh` is never exposed. Every hotseat spec fails in `cy.seedGame`
// until that is fixed. The three cards this spec steers are further along than most: `rotate`
// (#52), `swap` (#87) and #60's `forcedAttacks` are all in the effects barrel now, and #96 is
// only ever set face-down here, never fired.
//
// Not asserted here, and reported rather than worked around: the `rotated` and `swapped`
// animations. Both are 500 ms on the `board` element (BUILD M5-T4), and both plays go through
// `cy.playCard`, which ends with `cy.settled()` — so the `data-animating` window is gone before a
// spec could look. BUILD M5-T4's own acceptance for `rotated` is "every card's zone testid changed
// by one step", which is the assertion this spec makes.

import { CARDS, CARD_NAMES, cardId as catalogId } from "../../support/cards.ts";
import type { PlayCardOptions } from "../../support/commands.ts";
import { seedFor } from "../../support/config.ts";
import { cardId, ts, zoneId } from "../../support/testids.ts";
import type { GameStateLike, Lane, PlayerId, Side, ZoneRef } from "../../support/types.ts";

/** Every spec sets a seed (BUILD M8); `--expose seed=…` overrides it. */
const SEED = seedFor("12-rotation");

const TURN_BUDGET = 34;

const BEAR_HONEYPOT = catalogId(60);

/**
 * The six units 12-rotation-a/b hold that need nothing but a zone: no Cry, no target, no mode, so
 * a play is one card click and one zone click (SPEC §8 #1, #20, #32, #45, #56, #91). All cost 2,
 * which also keeps them above Bear Honeypot's "costing 1 or less" trigger.
 */
const PLAIN_UNITS: readonly string[] = [
  catalogId(1),
  catalogId(20),
  catalogId(32),
  catalogId(45),
  catalogId(56),
  catalogId(91),
];
const PLAIN_UNIT_COST = 2;

/** Costs from SPEC §8. §2.3 caps max mana at 4, so each play waits for a turn that can pay. */
const COSTS: Record<string, number> = {
  [CARDS.myPawn]: 1,
  [BEAR_HONEYPOT]: 1,
  [CARDS.sillySilas]: 3,
  [CARDS.pocketChaos]: 2,
};

/**
 * R14 / §3.1, read from the ROTATING player's seat — which is seat 1 here, and seat 1 is "you"
 * in the view the assertions are made against (ASSUMPTION A3). One ring per row, and both rings
 * turn together; "right" is one step forward along this order.
 */
const RING: readonly { side: Side; lane: Lane }[] = [
  { side: "you", lane: 1 },
  { side: "you", lane: 2 },
  { side: "you", lane: 3 },
  { side: "you", lane: 4 },
  { side: "you", lane: 5 },
  { side: "opponent", lane: 5 },
  { side: "opponent", lane: 4 },
  { side: "opponent", lane: 3 },
  { side: "opponent", lane: 2 },
  { side: "opponent", lane: 1 },
];

/** One step "right" around the ring of `zone.row`, staying in that row (R14: two rings). */
function rotateRight(zone: ZoneRef): ZoneRef {
  const at = RING.findIndex((slot) => slot.side === zone.side && slot.lane === zone.lane);
  expect(at, `${zone.side} lane ${zone.lane} is on the ring`).to.be.at.least(0);
  const next = RING[(at + 1) % RING.length];
  if (next === undefined) throw new Error("the ring is empty");
  return { side: next.side, row: zone.row, lane: next.lane };
}

/** R73: the board swap is lane-preserving, so a card only crosses the centre line. */
function acrossTheLine(zone: ZoneRef): ZoneRef {
  return { side: zone.side === "you" ? "opponent" : "you", row: zone.row, lane: zone.lane };
}

/** The seat that owns a side of the board seat 1 is looking at (ASSUMPTION A3). */
function seatOf(side: Side): PlayerId {
  return side === "you" ? "p1" : "p2";
}

/** SPEC §8's name for card #index, which is what the client prints on a card (BUILD M5-T1). */
function nameOf(index: number): string {
  const name = CARD_NAMES[index];
  if (name === undefined) throw new Error(`no SPEC §8 card #${index}`);
  return name;
}

type Held = { id: string; defId: string };
type SidePeek = {
  mana?: { current: number };
  hand?: Held[];
  units?: ({ id: string }[] | null)[];
  backrow?: ({ id: string } | null)[];
};

function peek(state: GameStateLike, player: PlayerId): SidePeek {
  return state.players[player] as SidePeek;
}

function handOf(state: GameStateLike, player: PlayerId): Held[] {
  return peek(state, player).hand ?? [];
}

/** BUILD M5-T3: a hotseat device is handed over, so make sure it is on the seat that has to act. */
function ensureSeat(player: PlayerId): void {
  cy.jackioh().then((handle) => {
    expect(handle.seat, "window.__jackioh.seat names the seat holding the device").to.not.eq(undefined);
    if (handle.seat !== player) cy.handOver();
  });
}

function passTurn(): void {
  cy.gameState().then((state) => {
    if (state.result !== null) return;
    ensureSeat(state.active);
    cy.endTurn();
  });
}

/** Take turns until `ready` holds, then leave the device on the seat that has to act. */
function advanceUntil(label: string, ready: (state: GameStateLike) => boolean): void {
  const step = (left: number): void => {
    cy.gameState().then((state) => {
      expect(state.result, `${label}: the game ended first`).to.eq(null);
      if (ready(state)) return;
      expect(left, `${label}: not reached inside ${TURN_BUDGET} player-turns`).to.be.greaterThan(0);
      passTurn();
      step(left - 1);
    });
  };
  step(TURN_BUDGET);
}

function canPay(state: GameStateLike, player: PlayerId, cost: number): boolean {
  return (peek(state, player).mana?.current ?? 0) >= cost;
}

/**
 * Wait until `player` holds `defId` on their own turn with the mana SPEC §8 prices it at, then
 * play it and hand back the instance id. By def id rather than `cy.playByName` because the
 * instance is chosen by what the card IS, not by what the client prints on it — and the id is
 * read out of the hand BEFORE the play, so a later "it is in this zone" assertion is a real
 * check rather than a restatement of where the spec just looked.
 */
function playWhenDrawn(
  player: PlayerId,
  defId: string,
  options: PlayCardOptions = {},
): Cypress.Chainable<string> {
  const cost = COSTS[defId] ?? 0;
  advanceUntil(`${player} can pay ${cost} for ${defId}`, (state) => {
    if (state.active !== player) return false;
    if (!canPay(state, player, cost)) return false;
    return handOf(state, player).some((card) => card.defId === defId);
  });
  ensureSeat(player);
  return cy.instanceInHand(player, defId).then((instanceId) => {
    cy.playCard(instanceId, options);
    return cy.wrap(instanceId, { log: false });
  });
}

/** Narrow an id captured in an earlier step; a missing one is a spec bug, not a rules failure. */
function need(value: string | undefined, what: string): string {
  if (value === undefined) throw new Error(`${what} was never captured`);
  return value;
}

/**
 * Put one of the choice-free units into a lane of the playing seat's own row and hand back its
 * instance id. Which of the six it is does not matter to any assertion in this spec: it is a card
 * in a zone, and the rotation and the swap have to move it.
 */
function summonPlainUnit(player: PlayerId, lane: Lane): Cypress.Chainable<string> {
  advanceUntil(`${player} can summon a plain unit into lane ${lane}`, (state) => {
    if (state.active !== player) return false;
    if (!canPay(state, player, PLAIN_UNIT_COST)) return false;
    return handOf(state, player).some((card) => PLAIN_UNITS.includes(card.defId));
  });
  ensureSeat(player);
  return cy.gameState().then((state) => {
    const unit = handOf(state, player).find((card) => PLAIN_UNITS.includes(card.defId));
    expect(unit, `${player} holds one of the choice-free units`).to.not.eq(undefined);
    const instanceId = unit?.id ?? "";
    // The zone is always on the playing seat's own side: `viewFor` orients the view, so the seat
    // holding the device is "you" (ASSUMPTION A3).
    cy.playCard(instanceId, { zone: { side: "you", row: "units", lane } });
    return cy.wrap(instanceId, { log: false });
  });
}

/** The card element is inside the zone element the view drew it in (BUILD M5-T1's nesting). */
function expectCardAt(instanceId: string, zone: ZoneRef): void {
  cy.get(ts(cardId(instanceId)))
    .closest(ts(zoneId(zone.side, zone.row, zone.lane)))
    .should("exist");
}

/** The engine agrees about the zone, which is what `controlChanged` means for a crossed card. */
function expectEngineAt(instanceId: string, zone: ZoneRef): void {
  cy.instanceAt(seatOf(zone.side), zone.row, zone.lane).should("eq", instanceId);
}

/** R33: this seat is the controller, so the trap's face is theirs to read. */
function expectTrapReadable(instanceId: string, zone: ZoneRef, name: string): void {
  expectCardAt(instanceId, zone);
  cy.get(ts(zoneId(zone.side, zone.row, zone.lane))).should("contain.text", name);
}

/**
 * R33: this seat is not the controller, so the trap is a back — and `Backrow.tsx` gives a
 * face-down entry no instance id at all, so there is no element to find and no name to read
 * anywhere on the board (§10.8). The engine is asked separately that the card is still standing
 * in that zone, because the DOM is not allowed to say so.
 */
function expectTrapHidden(instanceId: string, zone: ZoneRef, name: string): void {
  cy.get(ts(cardId(instanceId))).should("not.exist");
  cy.get(ts(zoneId(zone.side, zone.row, zone.lane))).should("not.contain.text", name);
  expectEngineAt(instanceId, zone);
}

/** Where each tracked card stands, in the view seat 1 is looking at. */
type Board = {
  yourLane1: ZoneRef;
  silas: ZoneRef;
  yourLane5: ZoneRef;
  theirLane1: ZoneRef;
  myPawn: ZoneRef;
  honeypot: ZoneRef;
};

function mapBoard(board: Board, move: (zone: ZoneRef) => ZoneRef): Board {
  return {
    yourLane1: move(board.yourLane1),
    silas: move(board.silas),
    yourLane5: move(board.yourLane5),
    theirLane1: move(board.theirLane1),
    myPawn: move(board.myPawn),
    honeypot: move(board.honeypot),
  };
}

describe("BUILD M8 12 — Silly Silas rotates one step around the ring and Pocket Chaos swaps the boards", () => {
  beforeEach(() => {
    cy.seedGame({ seed: SEED, a: "12-rotation-a", b: "12-rotation-b" });
  });

  it("R14/R33/R73 moves every card one lane, then flips both sides of the board", () => {
    // Filled in by the steps below and read back inside `cy.then`, which runs at command time.
    const ids: {
      myPawn?: string;
      honeypot?: string;
      yourLane1?: string;
      yourLane5?: string;
      theirLane1?: string;
      silas?: string;
    } = {};

    // The board this spec builds, in the view seat 1 is looking at. Seat 1's lane 5 and seat 2's
    // lane 1 are the two zones whose next step around R14's ring is on the other side of the
    // centre line, so putting a unit in each is what makes the rotation's control change visible.
    const built: Board = {
      yourLane1: { side: "you", row: "units", lane: 1 },
      silas: { side: "you", row: "units", lane: 3 },
      yourLane5: { side: "you", row: "units", lane: 5 },
      theirLane1: { side: "opponent", row: "units", lane: 1 },
      myPawn: { side: "you", row: "backrow", lane: 2 },
      honeypot: { side: "opponent", row: "backrow", lane: 2 },
    };

    // -----------------------------------------------------------------------------------------
    // 1. Seat 1 sets My Pawn first, before seat 2's Bear Honeypot is armed: #60 fires "when the
    //    opponent plays a card costing 1 or less", and a 1-cost trap is exactly that. Nothing
    //    seat 1 plays after this costs less than 2.
    // -----------------------------------------------------------------------------------------
    playWhenDrawn("p1", CARDS.myPawn, { zone: { side: "you", row: "backrow", lane: 2 } }).then((id) => {
      ids.myPawn = id;
    });

    playWhenDrawn("p2", BEAR_HONEYPOT, { zone: { side: "you", row: "backrow", lane: 2 } }).then((id) => {
      ids.honeypot = id;
    });

    // -----------------------------------------------------------------------------------------
    // 2. Three units: two of seat 1's and one of seat 2's, in the lanes `built` names.
    // -----------------------------------------------------------------------------------------
    summonPlainUnit("p1", 1).then((id) => {
      ids.yourLane1 = id;
    });
    summonPlainUnit("p1", 5).then((id) => {
      ids.yourLane5 = id;
    });
    summonPlainUnit("p2", 1).then((id) => {
      ids.theirLane1 = id;
    });

    // The board as built, and R33 before anything has moved: seat 1 reads its own face-down trap
    // and cannot read seat 2's.
    ensureSeat("p1");
    cy.then(() => {
      expectCardAt(need(ids.yourLane1, "seat 1's lane-1 unit"), built.yourLane1);
      expectCardAt(need(ids.yourLane5, "seat 1's lane-5 unit"), built.yourLane5);
      expectCardAt(need(ids.theirLane1, "seat 2's lane-1 unit"), built.theirLane1);
      expectTrapReadable(need(ids.myPawn, "seat 1's My Pawn"), built.myPawn, nameOf(96));
      expectTrapHidden(need(ids.honeypot, "seat 2's Bear Honeypot"), built.honeypot, nameOf(60));
    });

    // -----------------------------------------------------------------------------------------
    // 3. Silly Silas lands in seat 1's lane 3 and rotates right. §10.5 step 4 precedes step 5, so
    //    Silas is on the field when his own Cry resolves and rotates with everything else (SPEC
    //    §8 #52's Engine column: "Silas rotates too").
    // -----------------------------------------------------------------------------------------
    playWhenDrawn("p1", CARDS.sillySilas, {
      zone: { side: "you", row: "units", lane: 3 },
      // R81: a declared `direction` pick travels in the play action's `modes`.
      answers: [{ kind: "direction", options: ["right"] }],
    }).then((id) => {
      ids.silas = id;
    });

    const rotated = mapBoard(built, rotateRight);

    // "every card testid moves one lane" — one step along R14's ring, which for seat 1's lane 5
    // and seat 2's lane 1 means crossing the centre line and changing controller (BUILD M5-T4
    // `controlChanged`: "card testid now under the other side's zone").
    ensureSeat("p1");
    cy.then(() => {
      expectCardAt(need(ids.yourLane1, "seat 1's lane-1 unit"), rotated.yourLane1);
      expectEngineAt(need(ids.yourLane1, "seat 1's lane-1 unit"), rotated.yourLane1);
      expectCardAt(need(ids.silas, "Silly Silas"), rotated.silas);
      expectEngineAt(need(ids.silas, "Silly Silas"), rotated.silas);
      // Crossed the line: seat 2 controls it now, and it is drawn under their zone.
      expectCardAt(need(ids.yourLane5, "seat 1's lane-5 unit"), rotated.yourLane5);
      expectEngineAt(need(ids.yourLane5, "seat 1's lane-5 unit"), rotated.yourLane5);
      // Crossed the other way, into seat 1's lane 1.
      expectCardAt(need(ids.theirLane1, "seat 2's lane-1 unit"), rotated.theirLane1);
      expectEngineAt(need(ids.theirLane1, "seat 2's lane-1 unit"), rotated.theirLane1);
      // The backrow is its own ring (R14) and turns with the units. Neither trap crossed here, so
      // R33 reads exactly as it did before.
      expectTrapReadable(need(ids.myPawn, "seat 1's My Pawn"), rotated.myPawn, nameOf(96));
      expectTrapHidden(need(ids.honeypot, "seat 2's Bear Honeypot"), rotated.honeypot, nameOf(60));
    });

    // -----------------------------------------------------------------------------------------
    // 4. "board swap flips sides" — #87's second mode. R73: zone contents swap lane by lane,
    //    control changes, ownership does not.
    // -----------------------------------------------------------------------------------------
    playWhenDrawn("p1", CARDS.pocketChaos, {
      // R81: a declared `mode`, one of "health" | "board" | "library".
      answers: [{ kind: "mode", options: ["board"] }],
    });

    const swapped = mapBoard(rotated, acrossTheLine);
    ensureSeat("p1");
    cy.then(() => {
      expectCardAt(need(ids.yourLane1, "seat 1's lane-1 unit"), swapped.yourLane1);
      expectEngineAt(need(ids.yourLane1, "seat 1's lane-1 unit"), swapped.yourLane1);
      expectCardAt(need(ids.silas, "Silly Silas"), swapped.silas);
      expectEngineAt(need(ids.silas, "Silly Silas"), swapped.silas);
      expectCardAt(need(ids.yourLane5, "seat 1's lane-5 unit"), swapped.yourLane5);
      expectEngineAt(need(ids.yourLane5, "seat 1's lane-5 unit"), swapped.yourLane5);
      expectCardAt(need(ids.theirLane1, "seat 2's lane-1 unit"), swapped.theirLane1);
      expectEngineAt(need(ids.theirLane1, "seat 2's lane-1 unit"), swapped.theirLane1);

      // R33 read twice over, which is why each seat set a trap: the trap seat 1 OWNS is now seat
      // 2's to read and seat 1's to guess at, and seat 2's trap is now seat 1's to read.
      // Ownership never moved (R12) — only control did (R73).
      expectTrapHidden(need(ids.myPawn, "seat 1's My Pawn"), swapped.myPawn, nameOf(96));
      expectTrapReadable(need(ids.honeypot, "seat 2's Bear Honeypot"), swapped.honeypot, nameOf(60));
      // Its name is rendered on the field now, so the DOM can find the same instance by name.
      cy.fieldCardByName(nameOf(60)).should("eq", need(ids.honeypot, "seat 2's Bear Honeypot"));
    });
  });
});
