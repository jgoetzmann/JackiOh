// The emblem at the heart of every procedural picture: one small original glyph per art theme
// (docs/polish/6-cards.md, Surface A). Each is drawn for this project in a 24×24 box centred on
// (12, 12), as plain path data with no text, no external references and no borrowed artwork.
// `svg.ts` places a glyph with a transform, so the paths here never move.

import { fmt } from "./hash.ts";

export type EmblemGlyph =
  | "shield" | "cat" | "book" | "virus" | "fruit" | "vortex" | "bolt" | "coin"
  | "sword" | "star" | "tower" | "eye" | "rune"
  | "flame" | "moon" | "crown" | "hourglass" | "crystal";

type EmblemPath = { d: string; rule: "nonzero" | "evenodd" };

/** The glyphs' drawing box: 24 units wide and tall. */
export const EMBLEM_BOX = 24;
const CENTRE = EMBLEM_BOX / 2;

function circle(cx: number, cy: number, r: number): string {
  return `M${fmt(cx - r)} ${fmt(cy)}A${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(cx + r)} ${fmt(cy)}A${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(cx - r)} ${fmt(cy)}Z`;
}

/** Rotates a point about the glyph's centre, in degrees, and prints it. */
function turned(x: number, y: number, degrees: number): string {
  const radians = (degrees * Math.PI) / 180;
  const dx = x - CENTRE;
  const dy = y - CENTRE;
  const rx = CENTRE + dx * Math.cos(radians) - dy * Math.sin(radians);
  const ry = CENTRE + dx * Math.sin(radians) + dy * Math.cos(radians);
  return `${fmt(rx)} ${fmt(ry)}`;
}

/** A point at `radius` from the centre along `degrees` (0 = right, clockwise on screen). */
function polar(radius: number, degrees: number, sideways = 0): [number, number] {
  const radians = (degrees * Math.PI) / 180;
  const x = CENTRE + radius * Math.cos(radians) - sideways * Math.sin(radians);
  const y = CENTRE + radius * Math.sin(radians) + sideways * Math.cos(radians);
  return [x, y];
}

function virusPath(): string {
  const CORE = 5.6;
  const SPIKE_END = 8.5;
  const SPIKE_HALF = 0.7;
  const KNOB_AT = 10;
  const KNOB = 1.5;
  const SPIKES = 8;
  const parts: string[] = [circle(CENTRE, CENTRE, CORE)];
  // Three pits in the core, so the glyph reads as a cell rather than a sun.
  parts.push(circle(10.2, 10.6, 1.2), circle(14, 11.4, 0.9), circle(11.6, 14.2, 1));
  for (let k = 0; k < SPIKES; k += 1) {
    const angle = (360 / SPIKES) * k + 22.5;
    const [ax, ay] = polar(CORE, angle, -SPIKE_HALF);
    const [bx, by] = polar(SPIKE_END, angle, -SPIKE_HALF);
    const [cx, cy] = polar(SPIKE_END, angle, SPIKE_HALF);
    const [dx, dy] = polar(CORE, angle, SPIKE_HALF);
    parts.push(`M${fmt(ax)} ${fmt(ay)}L${fmt(bx)} ${fmt(by)}L${fmt(cx)} ${fmt(cy)}L${fmt(dx)} ${fmt(dy)}Z`);
    const [kx, ky] = polar(KNOB_AT, angle);
    parts.push(circle(kx, ky, KNOB));
  }
  return parts.join("");
}

function vortexPath(): string {
  // One swirling arm, repeated three times about the centre.
  const arm: readonly (readonly [number, number])[] = [
    [12, 10.6],
    [12.8, 6.6], [16, 3.8], [21, 4.6],
    [17.4, 5.8], [15.2, 8.6], [14.9, 11.6],
    [14.8, 13.4], [13, 13.6], [12, 10.6],
  ];
  const parts: string[] = [];
  for (const degrees of [0, 120, 240]) {
    const p = arm.map(([x, y]) => turned(x, y, degrees));
    parts.push(`M${p[0]}C${p[1]} ${p[2]} ${p[3]}C${p[4]} ${p[5]} ${p[6]}C${p[7]} ${p[8]} ${p[9]}Z`);
  }
  return parts.join("");
}

export const EMBLEMS: Readonly<Record<EmblemGlyph, EmblemPath>> = {
  // A heater shield, party per pale: the right half is cut away.
  shield: {
    d: "M12 2L20.5 5V11.2C20.5 16.4 17 20.1 12 22C7 20.1 3.5 16.4 3.5 11.2V5Z" +
      "M12 5.4L17.4 7.3V11.3C17.4 14.7 15.3 17.2 12 18.6Z",
    rule: "evenodd",
  },
  // A cat's head with pointed ears, almond eyes and a small nose.
  cat: {
    d: "M5.2 8.6L4.4 2.6L9.3 5.7C11 5.2 13 5.2 14.7 5.7L19.6 2.6L18.8 8.6C20.2 10.4 20.9 12.6 20.9 14.8" +
      "C20.9 19.2 16.9 21.8 12 21.8C7.1 21.8 3.1 19.2 3.1 14.8C3.1 12.6 3.8 10.4 5.2 8.6Z" +
      "M7.4 13.3C8.2 11.7 10.1 11.7 10.9 13.3C10.1 14.9 8.2 14.9 7.4 13.3Z" +
      "M13.1 13.3C13.9 11.7 15.8 11.7 16.6 13.3C15.8 14.9 13.9 14.9 13.1 13.3Z" +
      "M10.9 16.4H13.1L12 17.6Z",
    rule: "evenodd",
  },
  // An open book with a spine gap and two ruled lines on each page.
  book: {
    d: "M2 5.6C5.6 4.2 9 4.6 12 6.8C15 4.6 18.4 4.2 22 5.6V19.6C18.4 18.2 15 18.6 12 20.8C9 18.6 5.6 18.2 2 19.6Z" +
      "M11.5 8.2H12.5V19.2H11.5Z" +
      "M4.4 8.8C6.4 8.2 8.2 8.4 9.8 9.2V10.2C8.2 9.4 6.4 9.2 4.4 9.8Z" +
      "M4.4 12C6.4 11.4 8.2 11.6 9.8 12.4V13.4C8.2 12.6 6.4 12.4 4.4 13Z" +
      "M19.6 8.8C17.6 8.2 15.8 8.4 14.2 9.2V10.2C15.8 9.4 17.6 9.2 19.6 9.8Z" +
      "M19.6 12C17.6 11.4 15.8 11.6 14.2 12.4V13.4C15.8 12.6 17.6 12.4 19.6 13Z",
    rule: "evenodd",
  },
  // A pitted cell ringed by knobbed spikes.
  virus: { d: virusPath(), rule: "evenodd" },
  // A round fruit with a stem, a leaf and a highlight.
  fruit: {
    d: "M12 7.4C15.8 5.3 20.6 7.1 20.6 12.7C20.6 17.7 16.8 21.7 12 21.7C7.2 21.7 3.4 17.7 3.4 12.7C3.4 7.1 8.2 5.3 12 7.4Z" +
      "M11.3 6.9C11.3 5.1 11.9 3.5 13.2 2.3L14 3C12.9 4.1 12.4 5.4 12.5 6.9Z" +
      "M13.9 5C15.3 2.5 18.3 1.7 20.7 2.6C19.7 5.1 16.9 6.2 13.9 5Z" +
      "M6.6 11.8C6.9 10.1 8.1 9 9.6 8.8C8.6 9.8 8 10.9 7.9 12.3Z",
    rule: "evenodd",
  },
  // Three arms swirling about the centre.
  vortex: { d: vortexPath(), rule: "nonzero" },
  // A lightning bolt.
  bolt: { d: "M13.6 1.8L4.8 13.6H10.9L9.4 22.2L19.2 9.4H13L15.8 1.8Z", rule: "nonzero" },
  // A rimmed coin with a lozenge struck in the middle.
  coin: {
    d: circle(CENTRE, CENTRE, 9.6) + circle(CENTRE, CENTRE, 7.4) + "M12 6.6L15.8 12L12 17.4L8.2 12Z",
    rule: "evenodd",
  },
  // An upright sword: fullered blade, crossguard, grip and pommel.
  sword: {
    d: "M12 1.4L14.1 4.9V15.2H9.9V4.9Z" +
      "M11.6 5.6H12.4V14.4H11.6Z" +
      "M5.4 15.2H18.6V17.2H5.4Z" +
      "M11 17.2H13V20.6H11Z" +
      circle(12, 22, 1.4),
    rule: "evenodd",
  },
  // A four-pointed sparkle with a smaller one beside it.
  star: {
    d: "M12 1.5C12.8 7.4 16.6 11.2 22.5 12C16.6 12.8 12.8 16.6 12 22.5C11.2 16.6 7.4 12.8 1.5 12C7.4 11.2 11.2 7.4 12 1.5Z" +
      "M19 2C19.3 4.2 19.8 4.7 22 5C19.8 5.3 19.3 5.8 19 8C18.7 5.8 18.2 5.3 16 5C18.2 4.7 18.7 4.2 19 2Z",
    rule: "nonzero",
  },
  // A crenellated tower with an arched door and a slit window.
  tower: {
    d: "M7 22V9.4H5.4V3.6H8.2V5.8H10.6V3.6H13.4V5.8H15.8V3.6H18.6V9.4H17V22Z" +
      "M10.2 22V17.6A1.8 1.8 0 0 1 13.8 17.6V22Z" +
      "M11.2 10.6H12.8V13.8H11.2Z",
    rule: "evenodd",
  },
  // An open eye: almond, iris ring and pupil.
  eye: {
    d: "M1.4 12C5 5.8 19 5.8 22.6 12C19 18.2 5 18.2 1.4 12Z" + circle(CENTRE, CENTRE, 4.8) + circle(CENTRE, CENTRE, 2.1),
    rule: "evenodd",
  },
  // A flame with a hollow heart.
  flame: {
    d: "M12 1.8C13.6 6 18.4 8.6 18.4 14.4A6.4 6.4 0 0 1 5.6 14.4C5.6 10.6 8 8.9 9.2 6.2C10 8.5 10.9 9.4 12.2 10C12.7 7.3 12.5 4.5 12 1.8Z" +
      "M12 12.8C13.3 14.5 14.4 15.6 14.4 17.3A2.4 2.4 0 0 1 9.6 17.3C9.6 15.6 10.7 14.5 12 12.8Z",
    rule: "evenodd",
  },
  // A crescent moon.
  moon: { d: "M15.4 2.4A9.8 9.8 0 1 0 21.6 16.6A7.8 7.8 0 1 1 15.4 2.4Z", rule: "nonzero" },
  // A five-pointed crown on a band.
  crown: {
    d: "M2.8 7.6L7.4 11.6L12 4.4L16.6 11.6L21.2 7.6L19.4 17.8H4.6Z" + "M4.6 19H19.4V21.6H4.6Z",
    rule: "nonzero",
  },
  // An hourglass with sand settled in the lower bulb.
  hourglass: {
    d: "M5.6 1.8H18.4V4H17.2C17.2 8.2 14.6 10.2 13.3 12C14.6 13.8 17.2 15.8 17.2 20H18.4V22.2H5.6V20H6.8C6.8 15.8 9.4 13.8 10.7 12C9.4 10.2 6.8 8.2 6.8 4H5.6Z" +
      "M9.2 19.8C9.6 17.4 11 16.1 12 15C13 16.1 14.4 17.4 14.8 19.8Z",
    rule: "evenodd",
  },
  // A cut crystal: a long kite with its crown facet picked out.
  crystal: {
    d: "M12 1.4L18.6 8.2L12 22.6L5.4 8.2Z" + "M12 3.8L16.2 8.2H7.8Z",
    rule: "evenodd",
  },
  // A stave rune with three branches.
  rune: {
    d: "M11 2H13V22H11Z" +
      "M13 4.6L19 9.1L17.8 10.7L13 7.1Z" +
      "M11 12.2L5 16.7L6.2 18.3L11 14.7Z" +
      "M13 13.4L18.6 17.6L17.4 19.2L13 15.9Z",
    rule: "nonzero",
  },
};
