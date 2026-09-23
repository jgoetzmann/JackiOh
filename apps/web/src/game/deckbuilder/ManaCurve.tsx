// One deck's mana curve: a bar per cost bucket (0–5, 6+, X), as Hearthstone's deck list draws it.
// The counts come from `manaCurve` in filters.ts; this file only draws them.

import type { ReactElement } from "react";

import type { CatalogSnapshot } from "@jackioh/validator";

import { COST_BUCKETS, manaCurve } from "./filters.ts";
import { deckCurveId } from "./testids.ts";

type ManaCurveProps = {
  /** 1-based, like every deck number on this screen. */
  deck: number;
  cardIds: readonly string[];
  catalog: CatalogSnapshot;
};

/** The tallest bar fills the chart; an empty deck draws every bar empty rather than dividing by 0. */
const FULL_PERCENT = 100;

export default function ManaCurve({ deck, cardIds, catalog }: ManaCurveProps): ReactElement {
  const counts = manaCurve(cardIds, catalog);
  const tallest = Math.max(1, ...COST_BUCKETS.map((bucket) => counts[bucket]));
  const summary = COST_BUCKETS.map((bucket) => `${bucket}: ${String(counts[bucket])}`).join(", ");

  return (
    <div
      className="db-curve"
      data-testid={deckCurveId(deck)}
      role="img"
      aria-label={`Mana curve, cost: count. ${summary}`}
    >
      {COST_BUCKETS.map((bucket) => {
        const count = counts[bucket];
        return (
          <span
            key={bucket}
            className="db-bar"
            data-bucket={bucket}
            data-count={String(count)}
          >
            <span className="db-bar-count">{count > 0 ? String(count) : ""}</span>
            <span className="db-bar-track">
              <span
                className="db-bar-fill"
                style={{ height: `${String((count / tallest) * FULL_PERCENT)}%` }}
              />
            </span>
            <span className="db-bar-label">{bucket}</span>
          </span>
        );
      })}
    </div>
  );
}
