// The back of a card (docs/polish/6-cards.md, Surface B "CardBack DOM"): an original pattern and
// emblem, plus the legacy `.card-back-mark`.
//
// A back is what SPEC §10.8 leaves of a card the viewer may not see: the opponent's hand, a
// face-down trap (R33). So it takes no props and draws nothing that could name a card — no text
// node, no <text>, no <title>, no def id — and its textContent is "" (Board.test.tsx, B16).

import type { ReactElement } from "react";

import "./cards.css";

export function CardBack(): ReactElement {
  return (
    <span className="cf-back" aria-hidden="true">
      <svg className="cf-back-emblem" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        <circle cx="50" cy="50" r="44" fill="none" stroke="#d4af37" strokeOpacity="0.7" strokeWidth="3" />
        <circle cx="50" cy="50" r="36" fill="none" stroke="#d4af37" strokeOpacity="0.4" strokeWidth="1.5" strokeDasharray="4 3" />
        <path
          d="M50 12 L60 40 L88 50 L60 60 L50 88 L40 60 L12 50 L40 40 Z"
          fill="#7f6bd0"
          fillOpacity="0.55"
          stroke="#e8d28a"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path d="M50 30 L55 45 L70 50 L55 55 L50 70 L45 55 L30 50 L45 45 Z" fill="#241c44" fillOpacity="0.6" />
        <circle cx="50" cy="50" r="7" fill="#ffd24a" fillOpacity="0.9" />
      </svg>
      <span className="card-back-mark" aria-hidden="true" />
    </span>
  );
}
