// The draw offer on the table (SPEC §2.5, R36, R269), as each seat sees it.
//
// Only the active player offers, once per turn, and the other seat answers. The offer stands, on
// both seats' views, as `PlayerView.drawOffer` until it is answered or lapses at the end of the
// offerer's turn; what became of it is in the view's event window (`drawAnswered`). So:
//
//  - the offerer, while its offer stands: "Draw offered — waiting for reply" (`draw-offer-status`);
//  - the other seat, while it stands: "Your opponent offers a draw" with Accept and Decline
//    (`draw-offer`, `draw-accept`, `draw-decline`), a notice beside the board rather than a modal
//    over it, since the game goes on around it. The buttons are live exactly when `legal` lists
//    the matching `answerDraw` (the engine withholds it while a prompt is open), and each sends
//    that listed body: no rule is applied here (CLAUDE.md rule 7);
//  - afterwards, for the rest of that turn: "You declined the draw" / "Your opponent declined the
//    draw", or "Draw accepted" (the result panel then says "Game drawn by agreement"); and an offer
//    that lapsed unanswered reads "The draw offer expired" through the turn after it (`draw-outcome`,
//    `data-outcome`).
//
// All of it sits in one element, `draw-toast`, which is the element the animation table's
// `drawOffered` and `drawAnswered` rows play on (animations.ts). It is drawn from the NEWEST view
// rather than the one the board is still showing: an offer moves nothing on the board, and the
// entry that animates its arrival needs the element there to animate. It sits in a live region that
// is always in the tree, so each notice is read out as it arrives.
//
// `view.drawOffer` alone says an offer stands (R269): every view carries it, and it is gone once
// the offer is answered, lapses, or the game ends. The event stream only says what became of one.

import { useId, type ReactElement } from "react";

import type { ActionBody, GameEvent, PlayerView } from "@jackioh/shared";

import { animTestid } from "./animations.ts";
import { testid } from "./contract.ts";
import "./notices.css";

export type DrawNotice =
  /** The viewer offered and the offer stands. */
  | { kind: "waiting" }
  /** The opponent offered and the viewer owes the answer. */
  | { kind: "offered" }
  | { kind: "declined"; byYou: boolean }
  | { kind: "accepted" }
  | { kind: "expired" };

export type DrawOutcome = "declined" | "accepted" | "expired";

/** How many turns an unanswered offer's "expired" note outlives it: the turn right after it lapsed. */
const EXPIRED_NOTE_TURNS = 1;

function isDrawEvent(event: GameEvent): event is Extract<GameEvent, { type: "drawOffered" | "drawAnswered" }> {
  return event.type === "drawOffered" || event.type === "drawAnswered";
}

/** What the viewer is shown about the draw offer, read off the view alone; null when nothing. */
export function drawNoticeFor(view: PlayerView): DrawNotice | null {
  const standing = view.drawOffer;
  if (standing !== undefined) return standing.by === view.viewer ? { kind: "waiting" } : { kind: "offered" };

  let at = -1;
  for (let index = view.events.length - 1; index >= 0; index -= 1) {
    const event = view.events[index];
    if (event !== undefined && isDrawEvent(event)) {
      at = index;
      break;
    }
  }
  const last = view.events[at];
  if (last === undefined || !isDrawEvent(last)) return null;
  const turnsSince = view.events.slice(at + 1).filter((event) => event.type === "turnStarted").length;

  if (last.type === "drawAnswered" && last.accept) return { kind: "accepted" };
  // A game that is over has no offer to answer and no decline to report: the result says it all
  // (R216). A conceded or timed-out game is not a lapsed offer either.
  if (view.result !== null) return null;
  if (last.type === "drawAnswered") {
    return turnsSince === 0 ? { kind: "declined", byYou: last.player === view.viewer } : null;
  }
  // An offer with no answer and no `drawOffer` has lapsed with its offerer's turn (R269).
  return turnsSince >= 1 && turnsSince <= EXPIRED_NOTE_TURNS ? { kind: "expired" } : null;
}

/** The words each notice says, as the screen and the live region both say them. */
export const DRAW_TEXT = {
  waiting: "Draw offered — waiting for reply",
  offered: "Your opponent offers a draw",
  declinedByYou: "You declined the draw",
  declinedByOpponent: "Your opponent declined the draw",
  accepted: "Draw accepted",
  expired: "The draw offer expired",
} as const;

export function drawNoticeText(notice: DrawNotice): string {
  switch (notice.kind) {
    case "waiting":
      return DRAW_TEXT.waiting;
    case "offered":
      return DRAW_TEXT.offered;
    case "declined":
      return notice.byYou ? DRAW_TEXT.declinedByYou : DRAW_TEXT.declinedByOpponent;
    case "accepted":
      return DRAW_TEXT.accepted;
    case "expired":
      return DRAW_TEXT.expired;
  }
}

/** The engine's own `answerDraw` body for this answer, when `legal` lists it. */
function answerFor(legal: readonly ActionBody[], accept: boolean): ActionBody | undefined {
  return legal.find((body) => body.type === "answerDraw" && body.accept === accept);
}

export type DrawOfferNoticeProps = {
  /** The newest view (see the header). */
  view: PlayerView;
  /** The moves the board may make now; the answers are live only when they are listed here. */
  legal: readonly ActionBody[];
  /** The animation runner's mark for `draw-toast`, if it is animating. */
  animating?: string;
  onAction(body: ActionBody): void;
};

export default function DrawOfferNotice({ view, legal, animating, onAction }: DrawOfferNoticeProps): ReactElement {
  const titleId = useId();
  const notice = drawNoticeFor(view);
  const text = notice === null ? "" : drawNoticeText(notice);
  const accept = answerFor(legal, true);
  const decline = answerFor(legal, false);

  return (
    // A live region that is always in the tree, so a notice arriving in it is read out; the notice
    // itself carries no role of its own, so nothing is said twice.
    <div className="draw-notices" aria-live="assertive">
      {notice === null ? null : (
        <div
          className="draw-toast"
          data-testid={animTestid.drawToast}
          data-animating={animating}
          data-draw={notice.kind}
        >
          {notice.kind === "waiting" ? (
            <p className="draw-toast__line" data-testid={testid.drawOfferStatus}>
              {text}
            </p>
          ) : notice.kind === "offered" ? (
            <section className="draw-offer" data-testid={testid.drawOffer} role="region" aria-labelledby={titleId}>
              <p className="draw-toast__line" id={titleId}>
                {text}
              </p>
              <div className="draw-offer__actions">
                <button
                  type="button"
                  className="draw-offer__accept"
                  data-testid={testid.drawAccept}
                  disabled={accept === undefined}
                  onClick={() => {
                    if (accept !== undefined) onAction(accept);
                  }}
                >
                  Accept
                </button>
                <button
                  type="button"
                  className="draw-offer__decline"
                  data-testid={testid.drawDecline}
                  disabled={decline === undefined}
                  onClick={() => {
                    if (decline !== undefined) onAction(decline);
                  }}
                >
                  Decline
                </button>
              </div>
            </section>
          ) : (
            <p className="draw-toast__line" data-testid={testid.drawOutcome} data-outcome={notice.kind}>
              {text}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
