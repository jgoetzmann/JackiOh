// The board minion (docs/polish/6-cards.md, Surface B "MinionFace DOM"): an oval portrait with its
// cost, a name plate, attack and health, keyword chips, the Divine Shield bubble and a Taunt frame
// — Hearthstone's minion on the board.
//
// Every element the board's tests and the e2e specs read lives here under its old name:
// `.stats`, `.stat-attack[data-attack]`, `.stat-health[data-health][data-max-health]` whose text is
// still "health/max" (BUILD M5-T1's "current over max"), `.stat-armor[data-armor]`,
// `.keywords .keyword[data-keyword][data-n][title]` and `.shield-icon`. The numbers are the
// view's (UnitView) and nothing else; the tones only compare them with the printed face.
//
// Keywords. Every keyword keeps its `[data-keyword]` badge in the DOM, but only the ones the minion
// does not already draw as a state get a visible chip: Taunt is the shield frame, Divine Shield the
// bubble, Armor the steel plate by the health gem. At most KEYWORD_CHIPS_MAX chips show, legible
// at a pixel floor (cards.css); past that the last one becomes a "+n" count, and the hover preview
// and the inspect sheet list them all.
//
// There is no "zzz". `canAct` is false for every unit whose controller is not the active player,
// and a summoning-sick unit may still switch (§4.1), so it can neither say "this unit is asleep"
// nor "this one can attack". Whether a unit can attack is `legalActions`', drawn by the board's
// highlight (task 7's green), never read off the view here (CLAUDE.md rule 7).

import { useRef, type ReactElement } from "react";

import { hasKeyword, keywordKey, type Keyword, type UnitView } from "@jackioh/shared";

import { CardArt } from "./art/index.ts";
import { costDigits, hasCrest } from "./CardFace.tsx";
import { useFitText } from "./fit.ts";
import { KEYWORD_MARK } from "./glossary.ts";
import { Icon } from "./icons.tsx";
import { foilFor, type FaceModel } from "./model.ts";
import { useCardSettings } from "./settings.ts";

import "./cards.css";

export type MinionFaceProps = { face: FaceModel; unit: UnitView; className?: string };

/** How many keyword chips a minion shows before the last becomes a "+n" count. */
export const KEYWORD_CHIPS_MAX = 3;

/** Keywords the minion draws as a state rather than a chip: the Taunt frame, the Divine Shield bubble, the Armor plate. */
export function drawnAsState(keyword: Keyword, armor: number): boolean {
  if (keyword.kind === "Taunt" || keyword.kind === "Divine Shield") return true;
  return keyword.kind === "Armor" && armor > 0;
}

/** The keywords that get a visible chip, and the ones folded into the "+n" count. */
export function keywordChips(keywords: readonly Keyword[], armor: number): { shown: Keyword[]; folded: Keyword[] } {
  const chips = keywords.filter((keyword) => !drawnAsState(keyword, armor));
  const room = chips.length <= KEYWORD_CHIPS_MAX ? chips.length : KEYWORD_CHIPS_MAX - 1;
  return { shown: chips.slice(0, room), folded: chips.slice(room) };
}

function KeywordIcons({ keywords, armor }: { keywords: readonly Keyword[]; armor: number }): ReactElement | null {
  if (keywords.length === 0) return null;
  const { shown, folded } = keywordChips(keywords, armor);
  return (
    <span className="keywords">
      {keywords.map((keyword, index) => (
        <span
          key={`${keywordKey(keyword)}-${index}`}
          className="keyword keyword-icon"
          data-keyword={keyword.kind}
          data-n={"n" in keyword ? keyword.n : undefined}
          data-chip={shown.includes(keyword) ? undefined : "hidden"}
          title={keywordKey(keyword)}
        >
          {KEYWORD_MARK[keyword.kind]}
          {"n" in keyword ? ` ${keyword.n}` : ""}
        </span>
      ))}
      {folded.length > 0 && (
        <span className="cf-kw-more" title={folded.map(keywordKey).join(", ")}>
          +{folded.length}
        </span>
      )}
    </span>
  );
}

export function MinionFace({ face, unit, className }: MinionFaceProps): ReactElement {
  const settings = useCardSettings();
  const nameRef = useRef<HTMLSpanElement>(null);
  useFitText(nameRef, face.name);

  const attackTone = face.stats?.attackTone ?? "base";
  const healthTone = face.stats?.healthTone ?? "base";

  return (
    <span
      className={className === undefined ? "cf cf--minion" : `cf cf--minion ${className}`}
      data-layout="minion"
      data-card-type={face.type}
      data-rarity={face.rarity ?? undefined}
      data-foil={foilFor(face, settings.animatedFoil)}
      data-radiant-face={face.radiant ? "true" : undefined}
      data-taunt={hasKeyword(unit.keywords, "Taunt") ? "true" : undefined}
    >
      <span className="cf-scale">
        <span className="cf-portrait">
          <CardArt defId={face.defId} radiant={face.radiant} tags={face.tags} type={face.type} shape="oval" />
        </span>

        {hasCrest(face) && (
          <span className="cf-crest">
            <Icon name="crest" />
          </span>
        )}

        <span className="cost-gem" data-cost={face.cost.value} data-tone={face.cost.tone} data-digits={costDigits(face.cost.text)}>
          {face.cost.text}
        </span>

        <span className="card-name" ref={nameRef}>
          {face.name}
        </span>

        <span className="stats">
          <span className="stat stat-attack" data-attack={unit.attack} data-tone={attackTone}>
            {unit.attack}
          </span>
          <span className="stat stat-health" data-health={unit.health} data-max-health={unit.maxHealth} data-tone={healthTone}>
            {unit.health}
            <span className="cf-max">/{unit.maxHealth}</span>
          </span>
          {unit.armor > 0 && (
            <span className="stat stat-armor" data-armor={unit.armor}>
              {unit.armor}
            </span>
          )}
        </span>

        <KeywordIcons keywords={unit.keywords} armor={unit.armor} />

        {/* The `divineShieldLost` animation removes this by the keyword leaving the view. */}
        {hasKeyword(unit.keywords, "Divine Shield") && (
          <span className="shield-icon" data-icon="shield" aria-label="Divine Shield" />
        )}

      </span>
    </span>
  );
}
