// A practice tier's name, its one-line flavour and its crest: the emblem the setup cards, the HUD
// and the result screen share, so a tier looks the same everywhere it appears.
//
// The crest is inline SVG with no gradients (a gradient needs a document-unique id, and three
// crests share a page), coloured entirely from CSS through `--tier` (practice.css), so it costs no
// asset and follows the theme tokens. Its gems count the tier's rank in `DIFFICULTIES`.

import type { ReactElement } from "react";

import { DIFFICULTIES, type Difficulty } from "@jackioh/engine/config";

import "./practice.css";

export const DIFFICULTY_LABEL: Readonly<Record<Difficulty, string>> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
};

/** What facing the tier feels like; the exact resources are listed beside it. */
export const DIFFICULTY_TAGLINE: Readonly<Record<Difficulty, string>> = {
  easy: "An even match",
  medium: "The AI starts ahead",
  hard: "The AI outpaces you",
};

const SHIELD = "M24 2 L44 8.5 V27 C44 41 35.5 49.5 24 54 C12.5 49.5 4 41 4 27 V8.5 Z";
const BEVEL = "M24 7.5 L39.5 12.2 V27 C39.5 37.6 33.2 44.6 24 48.6 C14.8 44.6 8.5 37.6 8.5 27 V12.2 Z";
const GEM_SPACING = 11;
const GEM_Y = 28;

function gem(x: number): string {
  return `M${String(x)} ${String(GEM_Y - 7)} L${String(x + 5)} ${String(GEM_Y)} L${String(x)} ${String(GEM_Y + 7)} L${String(x - 5)} ${String(GEM_Y)} Z`;
}

type TierCrestProps = { tier: Difficulty; size?: "sm" | "md" | "lg" };

export function TierCrest({ tier, size = "md" }: TierCrestProps): ReactElement {
  const rank = DIFFICULTIES.indexOf(tier) + 1;
  const gems = Array.from({ length: rank }, (_, i) => 24 + (i - (rank - 1) / 2) * GEM_SPACING);
  return (
    <svg
      className={`practice-crest practice-crest--${size}`}
      data-tier={tier}
      viewBox="0 0 48 56"
      aria-hidden="true"
      focusable="false"
    >
      <path className="practice-crest__shield" d={SHIELD} />
      <path className="practice-crest__bevel" d={BEVEL} />
      {gems.map((x) => (
        <path key={x} className="practice-crest__gem" d={gem(x)} />
      ))}
    </svg>
  );
}
