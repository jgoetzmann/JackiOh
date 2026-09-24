// The opponent's play, held up (Hearthstone's "your opponent played …"): when the other player plays
// a card, its face stands beside the field for about a second (SHOWCASE_HOLD_MS, divided by the
// viewer's effects speed, R201) so it can be read before the game moves on.
//
// What it shows is decided in plan.ts from the view's own redacted events (CLAUDE.md rule 7, R97,
// R202): the opponent's `cardPlayed`, and a card back with a caption when the view hides the card
// (a Trap or Field Trap set face down, R227). The viewer's own plays are never shown.
//
// Which plays are new is kept PER VIEWER. Online and in practice the viewer never changes, so this
// is "as they happen". On a hotseat device each seat catches up on the plays made since it last
// held the device, which is how the arriving player sees what was played while the other one had it.
//
// It paces nothing and blocks nothing. It is portalled to <body>, click-through (`pointer-events:
// none`) and hidden from assistive tech, which hears a polite live region instead; it never touches
// the animation runner, `data-animating` or `legal`, so it holds no view back and `cy.settled()`
// never waits for it. It goes when its hold runs out, when a newer play replaces it, on Escape, and
// on the viewer's first pointer down anywhere (a player who starts to act has moved on). While it is
// up, `data-showcase` is on it: the practice route holds the AI's next step on that attribute, as it
// does on `data-speaking`, so the AI never plays its next card over the one being read.
//
// Reduced motion (the media query, the settings panel's switch or the effects store's "reduce"):
// the card is information, not decoration, so it is still shown for the same hold, but it appears
// and goes without the fade and the rise (showcase.css keys that off `data-motion="reduce"`).

import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";

import type { GameEvent, PlayerId, PlayerView } from "@jackioh/shared";

import { CardBack, CardFace } from "../../cards/index.ts";
import { getFxSettings } from "../../fx/settings.ts";
import { reducedMotionNow } from "../animations.ts";
import { CatalogContext } from "../catalog.ts";
import { namedFace } from "../faces.ts";
import { SHOWCASE_FADE_MS, SHOWCASE_QUEUE_MAX, showcaseHoldMs, showcaseTestid, type ShowcaseKind } from "./constants.ts";
import { capQueue, eventsSince, opponentPlays, type ShowcasePlay } from "./plan.ts";
import "./showcase.css";

export type CardShowcaseProps = {
  /** The newest view (Game's `view` prop, not the one the board is still showing): a play is held up as it arrives. */
  view: PlayerView;
};

type Showing = { play: ShowcasePlay; seq: number; holdMs: number; reduced: boolean };

function kindOf(play: ShowcasePlay): ShowcaseKind {
  if (play.defId !== null) return "played";
  return play.set ? "set" : "hidden";
}

const CAPTION: Readonly<Record<ShowcaseKind, string>> = {
  played: "Opponent played",
  set: "Opponent set a card",
  hidden: "Opponent played a card",
};

export default function CardShowcase({ view }: CardShowcaseProps): ReactElement {
  const lookup = useContext(CatalogContext);
  const [showing, setShowing] = useState<Showing | null>(null);
  const current = useRef<Showing | null>(null);
  const waiting = useRef<ShowcasePlay[]>([]);
  /** Per viewer, the last event window this component saw (see the header). */
  const seen = useRef(new Map<PlayerId, readonly GameEvent[]>());
  const counter = useRef(0);

  const show = useCallback((next: Showing | null) => {
    current.current = next;
    setShowing(next);
  }, []);

  const advance = useCallback(() => {
    const play = waiting.current.shift();
    if (play === undefined) {
      show(null);
      return;
    }
    counter.current += 1;
    show({ play, seq: counter.current, holdMs: showcaseHoldMs(getFxSettings().speed), reduced: reducedMotionNow() });
  }, [show]);

  const dismiss = useCallback(() => {
    waiting.current = [];
    if (current.current !== null) show(null);
  }, [show]);

  // A layout effect, so a play is up in the same paint as the view that brought it.
  useLayoutEffect(() => {
    const previous = seen.current.get(view.viewer);
    seen.current.set(view.viewer, view.events);
    if (view.result !== null) {
      dismiss();
      return;
    }
    // The first view a seat is given has no "since": the board it shows has always been there.
    if (previous === undefined) return;
    const plays = opponentPlays(eventsSince(previous, view.events), view);
    if (plays.length === 0) return;
    waiting.current = capQueue([...waiting.current, ...plays], SHOWCASE_QUEUE_MAX);
    if (current.current === null) advance();
  }, [view, advance, dismiss]);

  // The hold. A newer play keeps its own: `showing` is a new object per play.
  useEffect(() => {
    if (showing === null) return undefined;
    const timer = setTimeout(advance, showing.holdMs);
    return () => {
      clearTimeout(timer);
    };
  }, [showing, advance]);

  // Escape, or the viewer's first pointer down anywhere, puts it away (and whatever was waiting).
  useEffect(() => {
    if (showing === null) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") dismiss();
    };
    const onPointerDown = (): void => {
      dismiss();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [showing, dismiss]);

  const play = showing?.play ?? null;
  // The card in play (SPEC §10.10): as it stands where the view lists it — a unit's numbers, a Heroic
  // Power's rolled power, a fused card's own text — else its definition at the price that was paid.
  const face =
    play === null || play.defId === null
      ? null
      : namedFace(lookup, view, {
          defId: play.defId,
          radiant: play.radiant,
          ...(play.instanceId === undefined ? {} : { instanceId: play.instanceId }),
          ...(play.costPaid === undefined ? {} : { cost: play.costPaid }),
        });
  const kind = play === null ? null : kindOf(play);
  const said = kind === null ? "" : kind === "played" ? `${CAPTION.played} ${face?.name ?? "a card"}` : CAPTION[kind];

  // Click-through inline as well as in showcase.css, as HoverPreview is: it never takes a click aimed
  // at the board under it, whatever stylesheet has loaded.
  const style = {
    pointerEvents: "none",
    "--showcase-ms": `${String(showing?.holdMs ?? 0)}ms`,
    "--showcase-fade-ms": `${String(SHOWCASE_FADE_MS)}ms`,
  } as CSSProperties;

  return (
    <>
      <p className="showcase-live" data-testid={showcaseTestid.live} role="status" aria-live="polite">
        {said}
      </p>
      {showing !== null && kind !== null
        ? createPortal(
            <div
              key={showing.seq}
              className="showcase"
              data-testid={showcaseTestid.root}
              data-showcase={kind}
              data-showcase-def={face?.defId}
              data-seq={showing.seq}
              data-motion={showing.reduced ? "reduce" : "full"}
              aria-hidden="true"
              style={style}
            >
              <span className="showcase-caption" data-testid={showcaseTestid.caption}>
                {CAPTION[kind]}
              </span>
              {face !== null ? (
                <span className="showcase-card" data-testid={showcaseTestid.face}>
                  <CardFace face={face} layout="full" />
                </span>
              ) : (
                <span className="showcase-card showcase-card--back" data-testid={showcaseTestid.back}>
                  <CardBack />
                </span>
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
