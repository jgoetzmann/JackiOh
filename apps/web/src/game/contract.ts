// The integration contract between the board (M5-T1), the action builders and prompts (M5-T2),
// the hotseat loop (M5-T3) and the animation runner (M5-T4).
//
// Everything here is presentation vocabulary. No rule lives in this file: the board reports what
// was clicked, `actions.ts` turns that into an `ActionBody` chosen from `legalActions`, and the
// engine decides. `Highlight` is a set of `data-testid`s the engine has already blessed.

import type { GameEventType, PlayerId, PlayerView, Row } from "@jackioh/shared";

/** Viewer-relative sides. `viewFor` already orients the view, so the DOM says "you"/"opponent". */
export type Side = "you" | "opponent";

export const UNIT_LANES = 5;
export const BACKROW_LANES = 5;

/**
 * Lanes are 1-based, because the engine's are: `packages/engine/src/zones.ts` builds slots with
 * `lane: i + 1` and reads `side.units[ref.lane - 1]`, and `e2e/support/types.ts` declares
 * `Lane = 1 | 2 | 3 | 4 | 5`. A `ZoneChoice` inside a `play` action therefore carries 1..5, so
 * the client's zone testids must too or nothing the engine blesses would ever light up.
 */
export const LANES: readonly number[] = [1, 2, 3, 4, 5];
export const ROWS: readonly Row[] = ["units", "backrow"];

/** `SideView.units` / `.backrow` / `.locks` / `.reserved` are 0-based arrays over 1-based lanes. */
export function laneIndex(lane: number): number {
  return lane - 1;
}

/** The `data-testid`s BUILD M5-T1 fixes. Every clickable element gets its id from here. */
export const testid = {
  zone: (side: Side, row: Row, lane: number): string => `zone-${side}-${row}-${lane}`,
  card: (instanceId: string): string => `card-${instanceId}`,
  hero: (side: Side): string => `hero-${side}`,
  handCard: (instanceId: string): string => `hand-card-${instanceId}`,
  switchPosition: (instanceId: string): string => `switch-${instanceId}`,
  endTurn: "end-turn",
  offerDraw: "offer-draw",
  power: "power",
  concede: "concede",
  log: "log",
  board: "board",
  seatSwitch: "seat-switch",
  result: "result-overlay",
  banner: "turn-banner",
} as const;

export function sideOf(view: PlayerView, player: PlayerId): Side {
  return player === view.viewer ? "you" : "opponent";
}

export function playerOf(view: PlayerView, side: Side): PlayerId {
  return side === "you" ? view.you.player : view.opponent.player;
}

export function sideView(view: PlayerView, side: Side) {
  return side === "you" ? view.you : view.opponent;
}

/** Something the player clicked, dragged to, or dropped on. Never a decision, only a report. */
export type ClickTarget =
  | { on: "hand"; instanceId: string }
  | { on: "unit"; instanceId: string; side: Side; lane: number }
  | { on: "backrow"; instanceId: string; side: Side; lane: number }
  | { on: "hero"; side: Side }
  | { on: "zone"; side: Side; row: Row; lane: number }
  | { on: "switch"; instanceId: string };

export type BoardControl = "end-turn" | "offer-draw" | "power" | "concede";

/**
 * What the board may offer. `legal` and `selected` hold `data-testid`s; anything clickable whose
 * testid is not in `legal` renders with `aria-disabled="true"` and `data-legal="false"` and does
 * not fire `onClick`. The client computes neither set from the rules — `actions.ts` derives them
 * from the `legalActions` array the engine returned.
 */
export type Highlight = {
  legal: ReadonlySet<string>;
  selected: ReadonlySet<string>;
};

export const NO_HIGHLIGHT: Highlight = { legal: new Set(), selected: new Set() };

/** Elements currently mid-animation, keyed by `data-testid` (M5-T4). */
export type AnimatingMap = ReadonlyMap<string, GameEventType>;

export type BoardProps = {
  view: PlayerView;
  highlight?: Highlight;
  animating?: AnimatingMap;
  onClick?: (target: ClickTarget) => void;
  onControl?: (control: BoardControl) => void;
};
