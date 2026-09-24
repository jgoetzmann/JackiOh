// The tall card (docs/polish/6-cards.md, Surface B "CardFace DOM"): cost gem, art window, name
// ribbon, rarity gem, type line, rules box, tag badges, and sword and drop for units.
//
// Every element is a span, strong or img, so a face can sit inside the deck builder's <button>.
// Nothing here carries `data-testid`, `data-attack`, `data-health`, `data-keyword` or the `card`
// class token: those belong to the board's root element (game/Card.tsx) and the minion form, and a
// face in a hover preview must never answer an e2e selector meant for the board (B12, B20).
//
// `layout="compact"` is a face-up backrow card: cost, art, name, rarity gem and type line, with no
// rules box, tags or stats.

import { useRef, type CSSProperties, type ReactElement } from "react";

import type { CardType } from "@jackioh/shared";

import { CardArt, type ArtShape } from "./art/index.ts";
import { FIT_FLOOR_PX, TIER_SCALE } from "./constants.ts";
import { nameTier, textTier, useFitText } from "./fit.ts";
import { Icon } from "./icons.tsx";
import { foilFor, type FaceModel } from "./model.ts";
import { RulesText } from "./RulesText.tsx";
import { useCardSettings } from "./settings.ts";

import "./cards.css";

export type CardFaceProps = { face: FaceModel; layout?: "full" | "compact"; className?: string };

/** The art window's shape follows the card type, as Hearthstone's minion oval and spell frame do. */
const ART_SHAPE: Readonly<Record<CardType, ArtShape>> = {
  Unit: "portrait",
  Spell: "window",
  "Field Spell": "arch",
  Trap: "notched",
  "Field Trap": "notched",
};

function join(...parts: (string | false | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(" ");
}

/** Base text and the radiant clause, as one string: what `textTier` and `useFitText` measure. */
function printedText(face: FaceModel): string {
  return face.text.radiant === null ? face.text.base : `${face.text.base} ${face.text.radiant}`;
}

/** Hearthstone draws no gem on Free and Core cards; tokens and unknown cards get none here. */
function hasRarityGem(face: FaceModel): boolean {
  return face.rarity !== null && face.rarity !== "Token";
}

/** Longer than two characters (Ceaseless Void's 100): cards.css steps the gem's number down. */
const LONG_COST_CHARS = 3;

export function costDigits(text: string): string | undefined {
  return text.length >= LONG_COST_CHARS ? String(LONG_COST_CHARS) : undefined;
}

export function hasCrest(face: FaceModel): boolean {
  return face.rarity === "Legendary" || face.rarity === "Mythic";
}

export function CardFace({ face, layout = "full", className }: CardFaceProps): ReactElement {
  const settings = useCardSettings();
  const nameRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);

  const full = layout === "full";
  const printed = printedText(face);
  const names = nameTier(face.name);
  const texts = textTier(printed);
  useFitText(nameRef, face.name);
  // The rules box only exists on a full face; keying on the layout refits it when one appears. Its
  // floor keeps dense cards readable: the long layout first, then a clamp (fit.ts).
  useFitText(textRef, full ? printed : "", { floorPx: FIT_FLOOR_PX });

  const scales = { "--cf-name-scale": String(TIER_SCALE[names]), "--cf-text-scale": String(TIER_SCALE[texts]) } as CSSProperties;

  return (
    <span
      className={join("cf", `cf--${layout}`, className)}
      data-layout={layout}
      data-card-type={face.type}
      data-rarity={face.rarity ?? undefined}
      data-name-tier={names}
      data-text-tier={texts}
      data-foil={foilFor(face, settings.animatedFoil)}
      data-radiant-face={face.radiant ? "true" : undefined}
      style={scales}
    >
      <span className="cf-scale">
        <span className="cost-gem" data-cost={face.cost.value} data-tone={face.cost.tone} data-digits={costDigits(face.cost.text)}>
          {face.cost.text}
          {face.cost.alt !== null && <span className="cf-cost-alt">{face.cost.alt}</span>}
        </span>

        {hasCrest(face) && (
          <span className="cf-crest">
            <Icon name="crest" />
          </span>
        )}

        <span className="cf-art-frame">
          <CardArt defId={face.defId} radiant={face.radiant} tags={face.tags} type={face.type} shape={ART_SHAPE[face.type]} />
        </span>

        <span className="card-name" ref={nameRef}>
          {face.name}
        </span>

        {hasRarityGem(face) && (
          <span className="cf-gem" data-rarity={face.rarity ?? undefined}>
            <Icon name="gem" />
          </span>
        )}

        <span className="card-type">{face.type}</span>

        {full && (
          <span className="card-text" ref={textRef}>
            <span className="cf-text-base">
              <RulesText text={face.text.base} />
            </span>
            {face.text.radiant !== null && (
              <span className="cf-text-radiant">
                <RulesText text={face.text.radiant} />
              </span>
            )}
          </span>
        )}

        {full && face.tags.length > 0 && (
          <span className="cf-tags">
            {face.tags.map((tag) => (
              <span key={tag} className="cf-tag" data-tag={tag}>
                {tag}
              </span>
            ))}
          </span>
        )}

        {full && face.type === "Unit" && face.stats !== null && (
          <span className="cf-stats">
            <span className="cf-atk" data-face-attack={face.stats.attack} data-tone={face.stats.attackTone}>
              <Icon name="sword" />
              <span className="cf-num">{face.stats.attack}</span>
            </span>
            <span className="cf-hp" data-face-health={face.stats.health} data-tone={face.stats.healthTone}>
              <Icon name="drop" />
              <span className="cf-num">{face.stats.health}</span>
            </span>
          </span>
        )}
      </span>
    </span>
  );
}
