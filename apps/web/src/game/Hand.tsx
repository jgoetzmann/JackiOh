// A hand (BUILD M5-T1).
//
// `SideView.hand` is `CardView[] | { count: number }` and that union is the privacy boundary
// (SPEC §10.8): the viewer's hand is full cards with `hand-card-<instanceId>` testids, the
// opponent's hand is a number, so it renders exactly that many identical backs — no names, no
// def ids, no instance ids, nothing to read and nothing to click. The narrowing is
// `Array.isArray`, so there is no branch where a count could be rendered as cards.
//
// Polish task 7 (docs/polish/7-mobile-ux.md S6, S11, B26, B27): every card sits in a `.hand-slot`
// carrying its index as `--i`, and `.hand-cards` carries the hand size as `--n`, so board.css can
// lay the hand out as an overlapping fan without measuring anything. On the viewer's own hand a
// tap lifts a card (`data-lifted="true"`) so it can be read, legal or not — the lift is a
// capture-phase click, so it happens even when the card itself refuses the click. It is local
// view state, not a game action: a second tap, a press anywhere outside this hand, or the card
// leaving the hand lowers it. The selected hand card is always lifted. No card here is an HTML5
// drag source any more; drag to play is pointer events in game/drag/DragLayer.tsx, and the card a
// drop has just played is marked `data-landing` (drag/landing.ts), which board.css takes out of
// the fan while the board catches up with the play.

import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";

import type { CardView } from "@jackioh/shared";

import Card, { isSelected } from "./Card.tsx";
import { testid, type AnimatingMap, type ClickTarget, type Highlight, type Side } from "./contract.ts";
import { useLanding } from "./drag/landing.ts";
import { useSetting } from "../settings/index.ts";

export type HandProps = {
  side: Side;
  hand: CardView[] | { count: number };
  highlight?: Highlight;
  animating?: AnimatingMap;
  onClick?: (target: ClickTarget) => void;
};

export function handCount(hand: CardView[] | { count: number }): number {
  return Array.isArray(hand) ? hand.length : hand.count;
}

export default function Hand(props: HandProps): ReactElement {
  const { hand, side } = props;
  const count = handCount(hand);
  const yours = side === "you";
  const hoverPreviews = useSetting("hoverPreviews");
  const landing = useLanding();

  const rootRef = useRef<HTMLDivElement>(null);
  /** The instance id tapped up, or null. Only ever set on the viewer's own hand. */
  const [tapped, setTapped] = useState<string | null>(null);
  const tappedInHand = tapped !== null && Array.isArray(hand) && hand.some((card) => card.instanceId === tapped);

  // The card left the hand (played, discarded, stolen): forget it, so that the same instance
  // coming back later does not come back lifted.
  useEffect(() => {
    if (tapped !== null && !tappedInHand) setTapped(null);
  }, [tapped, tappedInHand]);

  // A press anywhere outside this hand lowers the tapped card. Capture phase on `window`, so a
  // press the board or a prompt swallows still counts, and so does one dispatched at the document.
  useEffect(() => {
    if (!tappedInHand) return undefined;
    const lower = (event: Event): void => {
      const root = rootRef.current;
      const target = event.target;
      if (root !== null && target instanceof Node && root.contains(target)) return;
      setTapped(null);
    };
    window.addEventListener("pointerdown", lower, true);
    return () => window.removeEventListener("pointerdown", lower, true);
  }, [tappedInHand]);

  function toggle(instanceId: string): void {
    setTapped((current) => (current === instanceId ? null : instanceId));
  }

  return (
    <div
      ref={rootRef}
      className={`hand hand-${side}`}
      data-testid={`hand-${side}`}
      data-side={side}
      data-count={count}
      data-hover-preview={yours ? (hoverPreviews ? "on" : "off") : undefined}
      aria-label={`${side} hand`}
    >
      <span className="pile">
        <span className="pile-label">Hand</span>
        <span className="pile-n" data-testid={`hand-count-${side}`}>
          {count}
        </span>
      </span>
      <div className="hand-cards" style={{ "--n": count } as CSSProperties}>
        {Array.isArray(hand)
          ? hand.map((card, index) => {
              const handTestid = testid.handCard(card.instanceId);
              const lifted =
                yours && ((tappedInHand && tapped === card.instanceId) || isSelected(props.highlight, handTestid));
              return (
                <div
                  key={card.instanceId}
                  className="hand-slot"
                  style={{ "--i": index } as CSSProperties}
                  data-lifted={lifted ? "true" : undefined}
                  data-landing={yours && landing === card.instanceId ? "true" : undefined}
                  onClickCapture={yours ? () => toggle(card.instanceId) : undefined}
                >
                  <Card
                    testId={handTestid}
                    card={card}
                    className="card-hand"
                    target={{ on: "hand", instanceId: card.instanceId }}
                    highlight={props.highlight}
                    animating={props.animating}
                    onClick={props.onClick}
                  />
                </div>
              );
            })
          : Array.from({ length: hand.count }, (_unused, index) => (
              <div key={`back-${index}`} className="hand-slot" style={{ "--i": index } as CSSProperties}>
                <Card card={null} className="card-hand" />
              </div>
            ))}
      </div>
    </div>
  );
}
