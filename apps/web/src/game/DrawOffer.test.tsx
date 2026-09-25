// The draw offer on the table (DrawOffer.tsx, §2.5, R36, R269), read off the view alone: the
// offerer's "waiting for reply", the other seat's Accept and Decline (live only when `legal` lists
// `answerDraw`), and what became of the offer. All of it is the `draw-toast` element the animation
// table's `drawOffered` / `drawAnswered` rows play on.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActionBody, GameEvent, PlayerView } from "@jackioh/shared";

import { DRAW_TEXT, drawNoticeFor } from "./DrawOffer.tsx";
import Game from "./Game.tsx";
import { baseView, withEvents } from "../test/fixtures.ts";

afterEach(cleanup);

const OFFER_BY_P1: GameEvent = { type: "drawOffered", player: "p1" };
const OFFER_BY_P2: GameEvent = { type: "drawOffered", player: "p2" };
const ANSWER: readonly ActionBody[] = [
  { type: "answerDraw", accept: true },
  { type: "answerDraw", accept: false },
  { type: "concede" },
];

/** p1's view; `by` stands an offer (R269), `events` is the window. */
function view(over: { by?: "p1" | "p2"; events?: GameEvent[]; viewer?: "p1" | "p2" } & Partial<PlayerView> = {}): PlayerView {
  const { by, events = [], ...rest } = over;
  return withEvents(baseView({ ...(by === undefined ? {} : { drawOffer: { by } }), ...rest }), events);
}

function renderGame(v: PlayerView, legal: readonly ActionBody[] = []) {
  const onAction = vi.fn<(body: ActionBody) => void>();
  render(<Game view={v} legal={legal} onAction={onAction} />);
  return onAction;
}

describe("drawNoticeFor", () => {
  it("R269 a standing offer: waiting for the offerer, a question for the other seat", () => {
    expect(drawNoticeFor(view({ by: "p1", events: [OFFER_BY_P1] }))).toEqual({ kind: "waiting" });
    expect(drawNoticeFor(view({ by: "p2", events: [OFFER_BY_P2], active: "p2" }))).toEqual({ kind: "offered" });
  });

  it("nothing when no offer was made in the window", () => {
    expect(drawNoticeFor(view())).toBeNull();
    expect(drawNoticeFor(view({ events: [{ type: "turnStarted", player: "p1", turn: 3 }] }))).toBeNull();
  });

  it("a decline, for the rest of that turn, from each side", () => {
    const declinedByP2: GameEvent = { type: "drawAnswered", player: "p2", accept: false };
    expect(drawNoticeFor(view({ events: [OFFER_BY_P1, declinedByP2] }))).toEqual({ kind: "declined", byYou: false });
    expect(drawNoticeFor(view({ viewer: "p2", events: [OFFER_BY_P1, declinedByP2] }))).toEqual({ kind: "declined", byYou: true });
    // The next turn has begun: the news is old.
    expect(
      drawNoticeFor(view({ events: [OFFER_BY_P1, declinedByP2, { type: "turnStarted", player: "p2", turn: 4 }] })),
    ).toBeNull();
  });

  it("an acceptance", () => {
    expect(drawNoticeFor(view({ events: [OFFER_BY_P1, { type: "drawAnswered", player: "p2", accept: true }] }))).toEqual({
      kind: "accepted",
    });
  });

  it("R269 an offer that lapsed unanswered reads as expired through the turn after it, then nothing", () => {
    const lapsed = [OFFER_BY_P1, { type: "turnEnded", player: "p1", turn: 3, unspentMana: 0 }, { type: "turnStarted", player: "p2", turn: 4 }] as GameEvent[];
    expect(drawNoticeFor(view({ events: lapsed }))).toEqual({ kind: "expired" });
    expect(drawNoticeFor(view({ viewer: "p2", events: lapsed }))).toEqual({ kind: "expired" });
    expect(drawNoticeFor(view({ events: [...lapsed, { type: "turnStarted", player: "p1", turn: 5 }] }))).toBeNull();
  });

  it("a view that cannot carry drawOffer still shows an offer with no answer and no turn since as standing", () => {
    expect(drawNoticeFor(view({ events: [OFFER_BY_P2] }))).toEqual({ kind: "offered" });
    expect(drawNoticeFor(view({ events: [OFFER_BY_P1] }))).toEqual({ kind: "waiting" });
  });
});

describe("the offerer", () => {
  it("R269 sees 'Draw offered — waiting for reply' while its offer stands, and no answers", () => {
    renderGame(view({ by: "p1", events: [OFFER_BY_P1] }), [{ type: "endTurn" }, { type: "concede" }]);
    expect(screen.getByTestId("draw-offer-status")).toHaveTextContent("Draw offered — waiting for reply");
    expect(screen.getByTestId("draw-toast")).toHaveAttribute("data-draw", "waiting");
    expect(screen.queryByTestId("draw-accept")).toBeNull();
    expect(screen.queryByTestId("draw-decline")).toBeNull();
  });

  it("sees 'Your opponent declined the draw' after a decline", () => {
    renderGame(view({ events: [OFFER_BY_P1, { type: "drawAnswered", player: "p2", accept: false }] }));
    const outcome = screen.getByTestId("draw-outcome");
    expect(outcome).toHaveAttribute("data-outcome", "declined");
    expect(outcome).toHaveTextContent(DRAW_TEXT.declinedByOpponent);
    expect(DRAW_TEXT.declinedByOpponent).toBe("Your opponent declined the draw");
    expect(screen.queryByTestId("draw-offer-status")).toBeNull();
  });
});

describe("the seat that answers", () => {
  it("R36 sees 'Your opponent offers a draw' as a labelled region beside the board, not a modal", () => {
    renderGame(view({ by: "p2", active: "p2", events: [OFFER_BY_P2] }), ANSWER);
    const offer = screen.getByTestId("draw-offer");
    expect(offer).toHaveAttribute("role", "region");
    expect(offer).toHaveAccessibleName(DRAW_TEXT.offered);
    expect(offer).toHaveTextContent("Your opponent offers a draw");
    expect(offer.closest("[aria-live]"), "announced as it arrives").not.toBeNull();
    expect(document.querySelector("[aria-modal='true']"), "the board stays usable").toBeNull();
    // The board is still there and still clickable around it.
    expect(screen.getByTestId("board")).toBeInTheDocument();
  });

  it("R36 Accept and Decline send the engine's own answerDraw bodies", () => {
    const onAction = renderGame(view({ by: "p2", active: "p2", events: [OFFER_BY_P2] }), ANSWER);
    fireEvent.click(screen.getByTestId("draw-accept"));
    expect(onAction).toHaveBeenLastCalledWith({ type: "answerDraw", accept: true });
    fireEvent.click(screen.getByTestId("draw-decline"));
    expect(onAction).toHaveBeenLastCalledWith({ type: "answerDraw", accept: false });
    expect(onAction).toHaveBeenCalledTimes(2);
  });

  it("the answers are buttons, reachable from the keyboard, in the order Accept then Decline", () => {
    renderGame(view({ by: "p2", active: "p2", events: [OFFER_BY_P2] }), ANSWER);
    const accept = screen.getByTestId("draw-accept");
    const decline = screen.getByTestId("draw-decline");
    expect(accept.tagName).toBe("BUTTON");
    expect(decline.tagName).toBe("BUTTON");
    expect(accept.compareDocumentPosition(decline) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    accept.focus();
    expect(accept).toHaveFocus();
  });

  it("the answers are live only when legal lists them (a prompt is open, say), and never fire otherwise", () => {
    const onAction = renderGame(view({ by: "p2", active: "p2", events: [OFFER_BY_P2] }), [{ type: "concede" }]);
    expect(screen.getByTestId("draw-accept")).toBeDisabled();
    expect(screen.getByTestId("draw-decline")).toBeDisabled();
    fireEvent.click(screen.getByTestId("draw-accept"));
    expect(onAction).not.toHaveBeenCalled();
  });

  it("sees 'You declined the draw' after its own decline", () => {
    renderGame(view({ viewer: "p1", active: "p2", events: [OFFER_BY_P2, { type: "drawAnswered", player: "p1", accept: false }] }));
    expect(screen.getByTestId("draw-outcome")).toHaveTextContent("You declined the draw");
    expect(screen.queryByTestId("draw-offer")).toBeNull();
  });
});

describe("outcomes on both seats", () => {
  it("R36 an accepted offer: 'Game drawn by agreement' in the result on both seats", () => {
    for (const viewer of ["p1", "p2"] as const) {
      renderGame(
        view({
          viewer,
          events: [OFFER_BY_P1, { type: "drawAnswered", player: "p2", accept: true }, { type: "gameOver", winner: "draw", reason: "draw-accepted" }],
          result: { winner: "draw", reason: "draw-accepted" },
        }),
      );
      const result = screen.getByTestId("result-overlay");
      expect(result).toHaveAttribute("data-outcome", "draw");
      expect(result).toHaveTextContent("Draw");
      expect(result).toHaveTextContent("Game drawn by agreement");
      expect(screen.getByTestId("draw-outcome")).toHaveAttribute("data-outcome", "accepted");
      cleanup();
    }
  });

  it("R269 a lapsed offer reads 'The draw offer expired' on both seats", () => {
    const events = [OFFER_BY_P1, { type: "turnStarted", player: "p2", turn: 4 }] as GameEvent[];
    for (const viewer of ["p1", "p2"] as const) {
      renderGame(view({ viewer, active: "p2", events }));
      expect(screen.getByTestId("draw-outcome")).toHaveTextContent("The draw offer expired");
      expect(screen.getByTestId("draw-outcome")).toHaveAttribute("data-outcome", "expired");
      cleanup();
    }
  });

  it("with no offer, no draw-toast at all (the live region is there, empty)", () => {
    renderGame(view());
    expect(screen.queryByTestId("draw-toast")).toBeNull();
    const region = document.querySelector(".draw-notices");
    expect(region).not.toBeNull();
    expect(region).toHaveAttribute("aria-live", "assertive");
    expect(region?.textContent).toBe("");
  });
});
