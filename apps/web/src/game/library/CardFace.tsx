// A full card drawn from its `CardDef` (SPEC §5): cost gem, name, type line, keywords, text and,
// for a unit, attack and health. One component serves the library's pages, the hover preview and
// the inspector: every size inside it is a container-query unit, so the card scales as one piece
// with whatever width its parent gives it.
//
// The catalog has no "no radiant form" flag. A card SPEC §8 lists with "No radiant form"
// (Quickstriker, Zao Gao, My Pawn and two tokens) carries a `radiant` face identical to its
// `base`, and §5.2 says becoming Radiant leaves such a card unchanged; `hasRadiantForm` is that
// comparison, and the inspector shows a card back rather than the same face twice.

import type { ReactElement } from "react";

import { keywordKey, type CardDef, type CardFace as Face } from "@jackioh/shared";

import { formatCost } from "../deckbuilder/Deckbuilder.tsx";
import { CARD_ASPECT } from "./library.ts";

/** Rules text past these lengths is set smaller, so §8's longest cells still fit the frame. */
const LONG_TEXT = 90;
const VERY_LONG_TEXT = 180;

function sameFace(a: Face, b: Face): boolean {
  return (
    a.attack === b.attack &&
    a.health === b.health &&
    a.text === b.text &&
    a.keywords.map(keywordKey).join() === b.keywords.map(keywordKey).join()
  );
}

export function hasRadiantForm(def: CardDef): boolean {
  return !sameFace(def.base, def.radiant);
}

/**
 * The §8 cell opens with the face's keywords ("Taunt; End of turn: heal to full"), which the card
 * already prints on their own line; this drops that exact prefix and keeps the rest verbatim.
 */
export function rulesText(face: Face): string {
  const prefix = face.keywords.map(keywordKey).join(", ");
  if (prefix === "" || !face.text.startsWith(prefix)) return face.text;
  const rest = face.text.slice(prefix.length);
  if (rest !== "" && !/^[;,.]/.test(rest)) return face.text;
  return rest.replace(/^[;,.]\s*/, "");
}

export type CardFaceProps = {
  def: CardDef;
  /** Draw the Radiant face (§5.2) in `--radiant` gold. */
  radiant?: boolean;
};

export default function CardFace({ def, radiant = false }: CardFaceProps): ReactElement {
  const face = radiant ? def.radiant : def.base;
  const text = rulesText(face);
  const keywords = face.keywords.map(keywordKey);
  const hasStats = face.attack !== undefined || face.health !== undefined;
  return (
    <div
      className="cf"
      style={{ aspectRatio: CARD_ASPECT }}
      data-card={def.id}
      data-type={def.type}
      data-radiant={radiant ? "true" : undefined}
    >
      <div className="cf-frame" data-stats={hasStats ? "true" : undefined}>
        <span className="cf-cost" aria-label={`Cost ${formatCost(def.cost)}`}>
          {formatCost(def.cost)}
        </span>
        <div className="cf-name">{def.name}</div>
        <div className="cf-type">
          {[def.type, ...def.tags].join(" · ")}
          {radiant ? <span className="cf-radiant-mark">Radiant</span> : null}
        </div>
        <div className="cf-body">
          {keywords.length > 0 ? <div className="cf-keywords">{keywords.join(", ")}</div> : null}
          {text === "" ? null : (
            <div
              className="cf-text"
              data-length={text.length > VERY_LONG_TEXT ? "xl" : text.length > LONG_TEXT ? "l" : undefined}
            >
              {text}
            </div>
          )}
        </div>
        {hasStats ? (
          <>
            <span className="cf-attack" aria-label={`Attack ${String(face.attack ?? 0)}`}>
              {face.attack ?? 0}
            </span>
            <span className="cf-health" aria-label={`Health ${String(face.health ?? 0)}`}>
              {face.health ?? 0}
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
}
