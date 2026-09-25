// The board's series banner: which Best-of-3 series this game belongs to, the score, and once the
// game is over the way on to the next one (SPEC §9.5, R259).
//
// `/match/<id>` knows only its match. `GET /api/matches/:id/series` answers the series that match
// is a game of (or null), as the caller's own projection, so the banner reads it once when the
// board opens and again when the game ends (the score has moved), then every `SERIES_POLL_SECONDS`
// while the series is still going: right after a game the server is opening the next pick phase,
// and game 3's picks are made for both players, so the next game may already be running. A match
// that is not a series game makes one request and shows nothing. Nothing here is a rule (CLAUDE.md
// rule 7): every word comes from the view.

import { useEffect, useState, type ReactElement } from "react";

import { SERIES_POLL_SECONDS } from "../../../server/src/config.ts";
import { getSeriesForMatch, type SeriesView } from "../net/api.ts";
import { paths } from "../net/navigate.ts";
import { followInApp } from "./nav.tsx";
import "./lobby.css";

/** Unit conversion, not configuration. */
const MS_PER_SECOND = 1000;

/** Chrome this component invented; `e2e/support/testids.ts` mirrors the strings. */
export const seriesBannerTestid = {
  /** The banner (`data-series-id`), on a series game only. */
  banner: "series-banner",
  /** Once this game is over: the way to the next game (or to the series screen to pick for it). */
  continue: "series-banner-continue",
  /** Once the series is over: its result (`data-outcome`). */
  result: "series-banner-result",
  /** The same way on, as the first action of the board's result panel. */
  panelContinue: "result-series-continue",
} as const;

type SeriesResult = NonNullable<SeriesView["result"]>;

/** How a finished series reads from this player's side; the series screen says it the same way. */
export const SERIES_OUTCOME_HEADLINE: Readonly<Record<SeriesResult["outcome"], string>> = {
  win: "You won the series",
  loss: "You lost the series",
  draw: "The series is a draw",
  abandoned: "The series was called off",
};

/** A call that may throw synchronously (or return nothing, in a test), as a promise. */
function attempt<T>(call: () => Promise<T>): Promise<T> {
  return Promise.resolve().then(call);
}

/** The answer's series, or null for "not a series game" (and for anything that is not an answer). */
function seriesOf(answer: unknown): SeriesView | null {
  if (typeof answer !== "object" || answer === null) return null;
  const series = (answer as { series?: unknown }).series;
  if (typeof series !== "object" || series === null) return null;
  return typeof (series as { id?: unknown }).id === "string" ? (series as SeriesView) : null;
}

/**
 * The series `matchId` is a game of, or null (not a series game, or not read yet). Read on mount,
 * again when `gameOver` turns true, and every `SERIES_POLL_SECONDS` while the game is over and the
 * series is not. A failed read is ignored: the banner is a convenience, never a blocker.
 */
export function useMatchSeries(token: string, matchId: string, gameOver: boolean): SeriesView | null {
  const [series, setSeries] = useState<SeriesView | null>(null);
  const [notSeries, setNotSeries] = useState(false);
  const poll = gameOver && series !== null && series.status !== "over";

  useEffect(() => {
    if (notSeries) return;
    let cancelled = false;
    const read = (): void => {
      attempt(() => getSeriesForMatch(token, matchId)).then(
        (answer) => {
          if (cancelled) return;
          const found = seriesOf(answer);
          if (found === null) setNotSeries(true);
          else setSeries(found);
        },
        () => undefined,
      );
    };
    read();
    if (!poll) {
      return () => {
        cancelled = true;
      };
    }
    const handle = setInterval(read, SERIES_POLL_SECONDS * MS_PER_SECOND);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [token, matchId, gameOver, poll, notSeries]);

  return notSeries ? null : series;
}

/** Where "continue" goes from a finished game of `series`, and what it says; null once it is over. */
export function nextStep(series: SeriesView, matchId: string): { href: string; label: string } | null {
  if (series.status === "over") return null;
  const next = `Continue to game ${String(series.gameNo)}`;
  if (series.status === "picking") return { href: paths.series(series.id), label: next };
  const running = series.currentMatchId;
  if (running !== null && running !== matchId) return { href: paths.match(running), label: next };
  // The series has not moved on from this game yet: its screen will show the next pick.
  return { href: paths.series(series.id), label: "Back to the series" };
}

/** The way on from a finished series game, or the series' result once it is over. */
function WayOn({ series, matchId, testid }: { series: SeriesView; matchId: string; testid: string }): ReactElement {
  const step = nextStep(series, matchId);
  if (step === null) {
    return (
      <a href={paths.series(series.id)} data-testid={testid} onClick={followInApp(paths.series(series.id))}>
        See the series
      </a>
    );
  }
  return (
    <a
      className="series-banner__continue"
      href={step.href}
      data-testid={testid}
      onClick={followInApp(step.href)}
    >
      {step.label}
    </a>
  );
}

export type SeriesBannerProps = { series: SeriesView | null; matchId: string; gameOver: boolean };

/** "Best of 3 · You 1 – 0 Opponent", and once this game is over the way on or the result. */
export function SeriesBanner({ series, matchId, gameOver }: SeriesBannerProps): ReactElement | null {
  if (series === null) return null;
  const result = series.result;
  return (
    <div className="series-banner" data-testid={seriesBannerTestid.banner} data-series-id={series.id}>
      <span className="series-banner__score">
        Best of {String(series.maxGames)} · You {String(series.you.wins)} – {String(series.opponent.wins)} Opponent
      </span>
      {gameOver && result !== null ? (
        <span data-testid={seriesBannerTestid.result} data-outcome={result.outcome}>
          {SERIES_OUTCOME_HEADLINE[result.outcome]}
        </span>
      ) : null}
      {gameOver ? <WayOn series={series} matchId={matchId} testid={seriesBannerTestid.continue} /> : null}
    </div>
  );
}

/** The same way on for the board's result panel, where it is the first (primary) action. */
export function SeriesContinue({ series, matchId }: { series: SeriesView | null; matchId: string }): ReactElement | null {
  if (series === null) return null;
  return <WayOn series={series} matchId={matchId} testid={seriesBannerTestid.panelContinue} />;
}
