// One backrow occupant (BUILD M5-T1): a public card, a face-down card, or nothing.
//
// `BackrowView` is the union that decides it, and the narrowing on `faceDown` is the whole
// privacy story: a `{ faceDown: true }` entry carries no `instanceId`, no `defId`, no cost and no
// type (SPEC §10.8, R33), so the back cannot render a name even by accident and cannot carry a
// `card-<instanceId>` testid. Such a zone is reportable only as a `zone` click, which is correct:
// there is nothing else the viewer is allowed to know about it.

import type { ReactElement } from "react";

import type { BackrowView } from "@jackioh/shared";

import Card, { type Pops } from "./Card.tsx";
import { testid, type AnimatingMap, type ClickTarget, type Highlight, type Side } from "./contract.ts";

export type BackrowProps = {
  entry: BackrowView;
  side: Side;
  lane: number;
  highlight?: Highlight;
  animating?: AnimatingMap;
  onClick?: (target: ClickTarget) => void;
  pops?: ReadonlyMap<string, Pops>;
};

export default function Backrow(props: BackrowProps): ReactElement | null {
  const { entry } = props;

  if (entry === null) return null;

  if (entry.faceDown) {
    return <Card card={null} className="card-backrow" />;
  }

  const testId = testid.card(entry.instanceId);
  return (
    <Card
      testId={testId}
      card={entry}
      type={entry.type}
      owner={entry.owner}
      controller={entry.controller}
      counters={entry.counters}
      className="card-backrow"
      target={{ on: "backrow", instanceId: entry.instanceId, side: props.side, lane: props.lane }}
      highlight={props.highlight}
      animating={props.animating}
      onClick={props.onClick}
      pops={props.pops?.get(testId)}
    />
  );
}
