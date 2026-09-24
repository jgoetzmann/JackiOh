// The art in a card's window (docs/polish/6-cards.md, Surface A, B6).
//
// A card with real art listed in the manifest gets an <img>; every other card, and any card
// whose image fails to load, gets its procedural SVG as the span's background. The art is
// decoration: it is aria-hidden, holds no text and names nothing, so a face-down card can never
// leak through it (CLAUDE.md rule 7). The span fills whatever box its parent gives it and clips
// itself to `shape`; sizing it is the parent's job, so nothing here sets a width.

import { useState, type ReactElement } from "react";

import type { CardType, Tag } from "@jackioh/shared";

import { ART_MANIFEST, artUrl, type ArtManifest } from "./manifest.ts";
import { proceduralArtUri } from "./svg.ts";
import { compositionFor, themeFor } from "./themes.ts";

import "./art.css";

export type ArtShape = "portrait" | "window" | "arch" | "notched" | "oval" | "strip";

export type CardArtProps = {
  defId: string;
  radiant: boolean;
  tags: readonly Tag[];
  type: CardType;
  shape: ArtShape;
  /** For tests. Defaults to ART_MANIFEST. */
  manifest?: ArtManifest;
  className?: string;
};

function classes(shape: ArtShape, className: string | undefined): string {
  const base = `cf-art cf-art--${shape}`;
  return className === undefined || className === "" ? base : `${base} ${className}`;
}

export function CardArt({ defId, radiant, tags, type, shape, manifest = ART_MANIFEST, className }: CardArtProps): ReactElement {
  // The src that failed to load, so a later src (another card, the other face) gets its own try.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const theme = themeFor(tags, type);
  const variant = radiant ? "radiant" : "base";
  const real = artUrl(defId, radiant, manifest);

  if (real !== null && real.src !== failedSrc) {
    const src = real.src;
    return (
      <span
        className={classes(shape, className)}
        data-art="real"
        data-art-theme={theme}
        data-art-variant={variant}
        aria-hidden="true"
      >
        <img
          className="cf-art-img"
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailedSrc(src)}
        />
        {real.tint ? <span className="cf-art-tint" /> : null}
      </span>
    );
  }

  const uri = proceduralArtUri(defId, theme, compositionFor(type), radiant);
  return (
    <span
      className={classes(shape, className)}
      data-art="procedural"
      data-art-theme={theme}
      data-art-variant={variant}
      aria-hidden="true"
      style={{ backgroundImage: `url("${uri}")`, backgroundSize: "cover" }}
    />
  );
}
