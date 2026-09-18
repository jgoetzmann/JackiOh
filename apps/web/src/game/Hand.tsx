// A hand (BUILD M5-T1).
//
// `SideView.hand` is `CardView[] | { count: number }` and that union is the privacy boundary
// (SPEC §10.8): the viewer's hand is full cards with `hand-card-<instanceId>` testids, the
// opponent's hand is a number, so it renders exactly that many identical backs — no names, no
// def ids, no instance ids, nothing to read and nothing to click. The narrowing is
// `Array.isArray`, so there is no branch where a count could be rendered as cards.

import type { ReactElement } from "react";

import type { CardView } from "@jackioh/shared";

import Card from "./Card.tsx";
import { testid, type AnimatingMap, type ClickTarget, type Highlight, type Side } from "./contract.ts";

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

  return (
    <div className={`hand hand-${side}`} data-testid={`hand-${side}`} data-side={side} aria-label={`${side} hand`}>
      <span className="pile">
        <span className="pile-label">Hand</span>
        <span className="pile-n" data-testid={`hand-count-${side}`}>
          {count}
        </span>
      </span>
      <div className="hand-cards">
        {Array.isArray(hand)
          ? hand.map((card) => (
              <Card
                key={card.instanceId}
                testId={testid.handCard(card.instanceId)}
                card={card}
                className="card-hand"
                draggable
                target={{ on: "hand", instanceId: card.instanceId }}
                highlight={props.highlight}
                animating={props.animating}
                onClick={props.onClick}
              />
            ))
          : Array.from({ length: hand.count }, (_unused, index) => (
              <Card key={`back-${index}`} card={null} className="card-hand" />
            ))}
      </div>
    </div>
  );
}
