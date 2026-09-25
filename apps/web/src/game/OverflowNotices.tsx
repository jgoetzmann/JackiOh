// The board's own notices for §2.4's three overflows (SPEC §10.10, R318): "Fatigue N" and "Library
// full" on a library pile, "Hand full" over a hand.
//
// They are read off the animation runner's entries and nothing else, exactly as the number pops are
// (Board.tsx `popsFrom`): `animated` is every entry the runner has started since the board last
// caught up, each one the elements it marks and the events it plays. A notice therefore mounts when
// the runner starts its event's entry and stays until the board shows the next view, so "Fatigue 3"
// is still on the pile while the `damage` after it lands on the hero. When one burst has several
// for one pile or one hand, the newest started wins. `data-playing="true"` is on a notice only while
// its own entry is in flight, and the motion in animations.css keys off it; the rest of the time the
// notice rests with its tag up. Under reduced motion the runner starts no entry, so nothing mounts.
//
// No rule lives here (CLAUDE.md rule 7), and nothing is read past the redacted event (R97, R202): the
// refused or burned card is drawn from the event's own `defId`, face up where the viewer reads it
// and a back where the event carries the sentinel. The notices take no pointer event and carry no
// `data-animating` of their own; the pile they sit in carries the runner's, as it always has.

import { useContext, type ReactElement } from "react";

import type { GameEvent, GameEventType, LibraryOverflowOutcome, PlayerView } from "@jackioh/shared";

import { CardBack, CardFace } from "../cards/index.ts";
import { animTestid } from "./animations.ts";
import { CatalogContext } from "./catalog.ts";
import { sideOf, type AnimatingMap, type AnimationFrames, type Side } from "./contract.ts";
import { HIDDEN_CARD, namedFace } from "./faces.ts";
import "./overflow.css";

/** The events that raise a notice, and the element each one's notice sits in. */
const NOTICE_EVENTS: readonly GameEventType[] = ["fatigue", "libraryOverflow", "burned"];

/** A refused or burned card as the event names it: the sentinel stays the sentinel (R97). */
export type NoticeCard = { instanceId: string; defId: string };

export type PileNoticeModel =
  | { kind: "fatigue"; count: number; playing: boolean }
  | { kind: "libraryFull"; card: NoticeCard; outcome: LibraryOverflowOutcome; playing: boolean };

export type BurnNoticeModel = { card: NoticeCard; playing: boolean };

export type OverflowNotices = {
  /** Per side, the notice on that side's library pile. */
  pile: ReadonlyMap<Side, PileNoticeModel>;
  /** Per side, the card burning over that side's hand. */
  burn: ReadonlyMap<Side, BurnNoticeModel>;
};

export const NO_NOTICES: OverflowNotices = { pile: new Map(), burn: new Map() };

/** The testids the notices answer to (the e2e contract, R318). */
export const noticeTestid = {
  pile: (side: Side): string => `pile-notice-${side}`,
  overflowCard: (side: Side): string => `overflow-card-${side}`,
  burn: (side: Side): string => `burn-notice-${side}`,
  burnCard: (side: Side): string => `burn-card-${side}`,
} as const;

/** The element an overflow event's notice sits in, as the animation table resolves it. */
function regionOf(view: PlayerView, event: GameEvent): { side: Side; region: string } | null {
  if (event.type === "fatigue" || event.type === "libraryOverflow") {
    const side = sideOf(view, event.player);
    return { side, region: animTestid.library(side) };
  }
  if (event.type === "burned") {
    const side = sideOf(view, event.owner);
    return { side, region: animTestid.hand(side) };
  }
  return null;
}

/**
 * The notices to draw, from the entries the runner has started this burst (see the header). An
 * event raises its notice only when its entry actually marked that element, which is also what
 * keeps a board rendered straight from a fixture honest: with no burst, "whatever is animating,
 * against the shown view", as the number pops fall back to.
 *
 * An entry is playing while it is the one in flight: the runner's `animating()` is that entry's own
 * frames, and Game keeps it last in the burst.
 */
export function noticesFrom(
  view: PlayerView,
  animating: AnimatingMap | undefined,
  animated?: readonly AnimationFrames[],
): OverflowNotices {
  const sources: readonly AnimationFrames[] =
    animated ?? (animating === undefined ? [] : [{ frames: animating, events: view.events }]);
  if (sources.length === 0) return NO_NOTICES;
  const pile = new Map<Side, PileNoticeModel>();
  const burn = new Map<Side, BurnNoticeModel>();
  const last = sources.length - 1;
  sources.forEach((source, index) => {
    for (const [region, type] of source.frames) {
      if (!NOTICE_EVENTS.includes(type)) continue;
      // The last event of that type the entry plays on that element: the runner animates in order.
      const event = [...source.events].reverse().find((e) => e.type === type && regionOf(view, e)?.region === region);
      if (event === undefined) continue;
      const playing =
        animating !== undefined && (source.frames === animating || (index === last && animating.get(region) === type));
      const at = regionOf(view, event);
      if (at === null) continue;
      if (event.type === "fatigue") pile.set(at.side, { kind: "fatigue", count: event.count, playing });
      if (event.type === "libraryOverflow") {
        pile.set(at.side, {
          kind: "libraryFull",
          card: { instanceId: event.instanceId, defId: event.defId },
          outcome: event.outcome,
          playing,
        });
      }
      if (event.type === "burned") burn.set(at.side, { card: { instanceId: event.instanceId, defId: event.defId }, playing });
    }
  });
  return pile.size === 0 && burn.size === 0 ? NO_NOTICES : { pile, burn };
}

/**
 * The card a notice holds: its face in play where the viewer reads it (faces.ts), a back for the
 * sentinel, which names nothing (R97). Compact, since it is drawn small.
 */
function NoticeCardFace({
  card,
  view,
  className,
  testId,
  outcome,
  as: Tag = "span",
}: {
  card: NoticeCard;
  view: PlayerView;
  className: string;
  testId: string;
  outcome?: LibraryOverflowOutcome;
  /** The contract's element: a span in a pile (which is itself a span), a div over a hand. */
  as?: "span" | "div";
}): ReactElement {
  const lookup = useContext(CatalogContext);
  const face =
    card.defId === HIDDEN_CARD
      ? null
      : namedFace(lookup, view, {
          defId: card.defId,
          radiant: false,
          ...(card.instanceId === HIDDEN_CARD ? {} : { instanceId: card.instanceId }),
        });
  return (
    <Tag className={className} data-testid={testId} data-face={face === null ? "back" : "face"} data-outcome={outcome}>
      {face === null ? <CardBack /> : <CardFace face={face} layout="compact" />}
    </Tag>
  );
}

/** Inside the library pile: "Fatigue N", or "Library full" with the card it turned away. */
export function PileNotice({
  notice,
  side,
  view,
}: {
  notice: PileNoticeModel | undefined;
  side: Side;
  view: PlayerView;
}): ReactElement | null {
  if (notice === undefined) return null;
  const playing = notice.playing ? "true" : undefined;
  if (notice.kind === "fatigue") {
    return (
      <span className="pile-notice" data-testid={noticeTestid.pile(side)} data-kind="fatigue" data-side={side} data-playing={playing}>
        <span className="pile-notice-tag">Fatigue {notice.count}</span>
      </span>
    );
  }
  return (
    <span
      className="pile-notice"
      data-testid={noticeTestid.pile(side)}
      data-kind="libraryFull"
      data-side={side}
      data-outcome={notice.outcome}
      data-playing={playing}
    >
      <span className="pile-notice-tag">Library full</span>
      <NoticeCardFace
        card={notice.card}
        view={view}
        className="overflow-card"
        testId={noticeTestid.overflowCard(side)}
        outcome={notice.outcome}
      />
    </span>
  );
}

/** Inside the hand region: "Hand full" over the card that burned. */
export function BurnNotice({
  notice,
  side,
  view,
}: {
  notice: BurnNoticeModel | undefined;
  side: Side;
  view: PlayerView;
}): ReactElement | null {
  if (notice === undefined) return null;
  return (
    <div className="burn-notice" data-testid={noticeTestid.burn(side)} data-side={side} data-playing={notice.playing ? "true" : undefined}>
      <span className="burn-tag">Hand full</span>
      <NoticeCardFace card={notice.card} view={view} className="burn-card" testId={noticeTestid.burnCard(side)} as="div" />
    </div>
  );
}
