// The face's glyphs: the attack sword, the health drop, the rarity gem's facets and the Legendary
// crest (docs/polish/6-cards.md, Surface B).
//
// Each glyph is an original SVG with no <text> and no <title>, so it names nothing and reads as
// nothing to a screen reader. It is drawn as an `<img>` of a `data:` URI rather than inline <svg>,
// because a full face renders only span, strong and img elements (B12): that is what lets a face
// sit inside the deck builder's <button>. Gradient ids are scoped to their own image, so two
// glyphs on one page can never collide.

import type { ReactElement } from "react";

type IconName = "sword" | "drop" | "gem" | "crest";

const SVG_NS = "http://www.w3.org/2000/svg";

// A gold medallion, as large as the drop beside it, over a long blade laid corner to corner: the
// tip shows top right and the guard and pommel bottom left, so the number sits on the medallion
// and both stats carry the same weight.
const SWORD = `<svg xmlns='${SVG_NS}' viewBox='0 0 64 64'>
<defs><radialGradient id='m' cx='.38' cy='.3' r='.8'><stop offset='0' stop-color='#fff6c4'/><stop offset='.42' stop-color='#f5bd2e'/><stop offset='.85' stop-color='#a86400'/><stop offset='1' stop-color='#6b3c00'/></radialGradient>
<linearGradient id='b' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#ffffff'/><stop offset='.5' stop-color='#cfd6e4'/><stop offset='1' stop-color='#7d879c'/></linearGradient></defs>
<path d='M53 4 L61 3 L60 11 L42 29 L35 22 Z' fill='url(#b)' stroke='#1f2430' stroke-width='2.2' stroke-linejoin='round'/>
<path d='M7 43 L21 57 L18 60 L4 46 Z' fill='#c9892b' stroke='#2a1906' stroke-width='2.2' stroke-linejoin='round'/>
<path d='M10 51 L4 57 L7 60 L13 54 Z' fill='#6b4215' stroke='#2a1906' stroke-width='2'/>
<circle cx='4.5' cy='59.5' r='3' fill='#e0a53a' stroke='#2a1906' stroke-width='1.6'/>
<circle cx='31' cy='33' r='24.5' fill='url(#m)' stroke='#3b2400' stroke-width='3'/>
<circle cx='31' cy='33' r='20' fill='none' stroke='#fff2b8' stroke-opacity='.45' stroke-width='1.5'/>
<ellipse cx='23' cy='22' rx='9' ry='5' fill='#fff' opacity='.3' transform='rotate(-25 23 22)'/>
</svg>`;

const DROP = `<svg xmlns='${SVG_NS}' viewBox='0 0 64 64'>
<defs><radialGradient id='d' cx='.4' cy='.58' r='.72'><stop offset='0' stop-color='#ff9f92'/><stop offset='.5' stop-color='#cf2626'/><stop offset='1' stop-color='#650909'/></radialGradient></defs>
<path d='M32 3 C38 16 54 29 54 41 A22 22 0 0 1 10 41 C10 29 26 16 32 3 Z' fill='url(#d)' stroke='#3a0505' stroke-width='3' stroke-linejoin='round'/>
<ellipse cx='23' cy='39' rx='5' ry='8' fill='#fff' opacity='.3'/>
</svg>`;

const GEM = `<svg xmlns='${SVG_NS}' viewBox='0 0 64 64'>
<path d='M4 4 L32 32 L60 4 M4 60 L32 32 L60 60' fill='none' stroke='#fff' stroke-opacity='.5' stroke-width='3'/>
<path d='M16 16 H48 V48 H16 Z' fill='#fff' fill-opacity='.2' stroke='#fff' stroke-opacity='.55' stroke-width='2'/>
<path d='M10 10 L22 10 L10 22 Z' fill='#fff' fill-opacity='.7'/>
</svg>`;

const CREST = `<svg xmlns='${SVG_NS}' viewBox='0 0 120 40'>
<defs><linearGradient id='g' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#fff4c0'/><stop offset='.5' stop-color='#e2a526'/><stop offset='1' stop-color='#7a4a00'/></linearGradient>
<radialGradient id='j' cx='.4' cy='.35' r='.7'><stop offset='0' stop-color='#fff'/><stop offset='.4' stop-color='#ff9f1c'/><stop offset='1' stop-color='#8a3a00'/></radialGradient></defs>
<g id='w' fill='url(#g)' stroke='#4a2e00' stroke-width='1.5' stroke-linejoin='round'>
<path d='M56 30 C44 22 28 8 3 9 C14 14 20 19 24 23 C16 21 10 21 4 23 C16 28 32 32 56 34 Z'/>
<path d='M50 34 C40 35 30 36 18 33 C26 38 40 39 52 37 Z'/>
<ellipse cx='36' cy='18' rx='5' ry='2.2' transform='rotate(-25 36 18)'/>
<ellipse cx='44' cy='23' rx='5' ry='2.2' transform='rotate(-35 44 23)'/>
</g>
<use href='#w' transform='translate(120 0) scale(-1 1)'/>
<circle cx='60' cy='25' r='9' fill='url(#j)' stroke='#4a2e00' stroke-width='2'/>
<path d='M60 3 L64 12 L60 16 L56 12 Z' fill='url(#g)' stroke='#4a2e00' stroke-width='1.5'/>
</svg>`;

function dataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg.replace(/\n/g, ""))}`;
}

const ICON_URI: Readonly<Record<IconName, string>> = {
  sword: dataUri(SWORD),
  drop: dataUri(DROP),
  gem: dataUri(GEM),
  crest: dataUri(CREST),
};

export function Icon({ name }: { name: IconName }): ReactElement {
  return (
    <img
      className={`cf-icon cf-icon--${name}`}
      src={ICON_URI[name]}
      alt=""
      aria-hidden="true"
      draggable={false}
      decoding="async"
    />
  );
}
