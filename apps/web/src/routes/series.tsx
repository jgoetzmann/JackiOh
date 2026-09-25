// `/series/<id>` — a Conquest series between its games (SPEC §9.5, R330–R338, R262).
//
// It renders the server's projection for this player (`GET /api/series/:id`, a `SeriesView`) and
// nothing else (CLAUDE.md rule 7). Which decks may be picked, when the clock runs out, who goes
// first and when the series ends are all the server's: the picker (`SeriesPicker.tsx`, R338) offers
// the decks the view says have not won, and a refusal is shown as the server wrote it. The hidden
// picks hold here by construction (R331, R336): the view carries only whether the opponent has
// picked and which of their decks have won, never a name, a card or a pick, so there is nothing to
// leak. Both sides' won decks — each locked for the rest of the series (R330) — are on screen.
//
// THE CLOCK (R333). `pickDeadline` is the server's epoch ms, and this device's clock may be minutes
// off. The view also carries the server's `now`, so the deadline is re-based onto this device's
// clock at the moment the view arrived (`receivedAt + pickDeadline - now`) and counted down from
// there, on the clock rather than in timer ticks (`auth/cooldown.ts`).
//
// THE GAME. While a game is on, the screen offers "Open game n". A player who is on this screen
// when a game starts is taken to the board once, by itself; one who came back here from the board
// on purpose is not sent away again.

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import { SERIES_POLL_SECONDS } from "../../../server/src/config.ts";
import { useSecondsUntil } from "../auth/cooldown.ts";
import { ApiRequestError, forfeitSeries, getSeries, pickSeriesDeck, type SeriesView } from "../net/api.ts";
import { navigate, paths } from "../net/navigate.ts";
import { BackLink, followInApp } from "./nav.tsx";
import { SERIES_OUTCOME_HEADLINE } from "./SeriesBanner.tsx";
import SeriesPicker, { deckStanding, seriesPickerTestid } from "./SeriesPicker.tsx";
import "../auth/tavern.css";
import "./lobby.css";

/** Unit conversion, not configuration. */
const MS_PER_SECOND = 1000;

/** Chrome this screen invented; `e2e/support/testids.ts` mirrors the strings. */
export const seriesTestid = {
  screen: "series-screen",
  loading: "series-loading",
  /** A refusal or a failed read, in the server's words. */
  error: "series-error",
  /** `data-you`, `data-opponent`: the game wins so far. */
  score: "series-score",
  /** One of your three decks in the standings: `data-won` (locked, R330), `data-picked`. */
  deck: (slot: number): string => `series-deck-${String(slot)}`,
  /** The deck-selection panel and its parts (R338): `SeriesPicker.tsx`. */
  picker: seriesPickerTestid.picker,
  /** A deck in the picker: selects it; disabled once it has won. */
  pick: seriesPickerTestid.choice,
  /** Seals the selected deck as the pick (R331). */
  lockIn: seriesPickerTestid.lockIn,
  /** One of the opponent's decks: `data-won` and nothing else (R336). */
  opponentDeck: (slot: number): string => `series-opponent-deck-${String(slot)}`,
  /** The pick clock's whole seconds left (`data-seconds`), R333. */
  clock: seriesPickerTestid.clock,
  /** "Opponent is choosing…" or "Opponent has picked" (`data-picked`). */
  opponentStatus: seriesPickerTestid.opponentStatus,
  /** The running game's board, while a game is on. */
  openMatch: "series-open-match",
  forfeit: "series-forfeit",
  forfeitConfirm: "series-forfeit-confirm",
  forfeitCancel: "series-forfeit-cancel",
  /** Once over: `data-outcome` win | loss | draw | abandoned. */
  result: "series-result",
  /** One game of the history: `data-result` win | loss | draw | pending. */
  game: (gameNo: number): string => `series-game-${String(gameNo)}`,
  /** The way back to the lobby from a finished series. */
  backToPlay: "series-back-to-play",
} as const;

type SeriesResult = NonNullable<SeriesView["result"]>;

const GAME_RESULT_WORD: Readonly<Record<"win" | "loss" | "draw", string>> = {
  win: "Win",
  loss: "Loss",
  draw: "Draw",
};

/** Why the series ended, from this player's side (R330, R333, R334). */
export function endReasonWords(result: SeriesResult, winsNeeded: number, maxGames: number): string {
  switch (result.endReason) {
    case "decided":
      return result.outcome === "win"
        ? `You won a game with each of your ${String(winsNeeded)} decks.`
        : `Your opponent won a game with each of their ${String(winsNeeded)} decks.`;
    case "exhausted":
      if (result.outcome === "draw") return `The series reached its ${String(maxGames)}-game limit with the wins level.`;
      return `The series reached its ${String(maxGames)}-game limit, and ${result.outcome === "win" ? "you" : "your opponent"} had won more games.`;
    case "forfeit":
      return result.outcome === "win" ? "Your opponent forfeited the series." : "You forfeited the series.";
    case "abandoned":
      return "The series ended without a winner: nobody picked a deck in time, or a game could not be started.";
  }
}

/** The rating line: "Rating 1000 → 1016", or why nothing moved (R262). */
export function ratingWords(result: SeriesResult): string {
  if (result.outcome === "abandoned" || result.ratingBefore === null || result.ratingAfter === null) {
    return "Unrated: no rating changed.";
  }
  return `Rating ${String(result.ratingBefore)} → ${String(result.ratingAfter)}`;
}

function messageOf(cause: unknown): string {
  if (cause instanceof ApiRequestError) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}

/** A call that may throw synchronously (or return nothing, in a test), as a promise. */
function attempt<T>(call: () => Promise<T>): Promise<T> {
  return Promise.resolve().then(call);
}

/** A view and when this device received it: the base the pick clock is counted from. */
type Received = { view: SeriesView; receivedAt: number };

/**
 * The pick deadline on this device's clock: the server's deadline less the server's `now`, added
 * to the moment the view arrived. Null outside the pick phase.
 */
export function localDeadline(received: Received): number | null {
  const { view, receivedAt } = received;
  if (view.status !== "picking" || view.pickDeadline === null) return null;
  return receivedAt + (view.pickDeadline - view.now);
}

/** The screen's hero, as /play wears it: the brand, the mode, and what it asks of a player. */
function SeriesHero(): ReactElement {
  return (
    <header className="play-hero">
      <div className="brand">
        <h1>JackiOh</h1>
      </div>
      <p className="play-hero__title">Conquest</p>
      <p className="play-hero__lead">Win a game with each of your three decks. A deck that wins is locked.</p>
    </header>
  );
}

export type SeriesRouteProps = { seriesId: string; token: string };

export default function SeriesRoute({ seriesId, token }: SeriesRouteProps): ReactElement {
  const [received, setReceived] = useState<Received | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Every request is numbered, and an answer older than one already shown is dropped: a poll sent
  // just before a pick must not put the old pick back on screen when it lands after it.
  const sent = useRef(0);
  const shown = useRef(0);
  const accept = useCallback((view: SeriesView, request: number) => {
    if (request < shown.current) return;
    shown.current = request;
    setReceived({ view, receivedAt: Date.now() });
  }, []);

  const over = received?.view.status === "over";
  useEffect(() => {
    if (over) return;
    let cancelled = false;
    const read = (): void => {
      sent.current += 1;
      const request = sent.current;
      attempt(() => getSeries(token, seriesId)).then(
        (view) => {
          if (cancelled) return;
          accept(view, request);
          setLoadError(null);
        },
        (cause: unknown) => {
          // Kept for a first read only: a blip while a view is on screen is retried next tick.
          if (!cancelled) setLoadError(messageOf(cause));
        },
      );
    };
    read();
    const handle = setInterval(read, SERIES_POLL_SECONDS * MS_PER_SECOND);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [token, seriesId, over, accept]);

  // A game that starts while the player is on this screen opens once, by itself. The first view is
  // only noted: a player who came back here from the board chose to.
  const lastRunning = useRef<string | null | undefined>(undefined);
  const opened = useRef(new Set<string>());
  const view = received?.view ?? null;
  useEffect(() => {
    if (view === null) return;
    const running = view.status === "playing" ? view.currentMatchId : null;
    const before = lastRunning.current;
    lastRunning.current = running;
    if (before === undefined || running === null || running === before || opened.current.has(running)) return;
    opened.current.add(running);
    navigate(paths.match(running));
  }, [view]);

  const deadline = received === null ? null : localDeadline(received);
  const secondsLeft = useSecondsUntil(deadline);

  function act(work: () => Promise<SeriesView>): void {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    sent.current += 1;
    const request = sent.current;
    attempt(work)
      .then(
        (next) => {
          accept(next, request);
        },
        (cause: unknown) => {
          setActionError(messageOf(cause));
        },
      )
      .finally(() => {
        setBusy(false);
      });
  }

  /** R331: seals `slot` as this player's pick. */
  function onPick(slot: number): void {
    act(() => pickSeriesDeck(token, seriesId, slot));
  }

  function onForfeit(): void {
    setConfirming(false);
    act(() => forfeitSeries(token, seriesId));
  }

  if (view === null) {
    return (
      <div className="app-shell tavern lobby play-screen series" data-testid={seriesTestid.screen}>
        <BackLink to={paths.play} />
        <SeriesHero />
        {loadError === null ? (
          <p className="notice" data-testid={seriesTestid.loading} role="status">
            Loading the series…
          </p>
        ) : (
          <p className="notice" data-testid={seriesTestid.error} role="alert">
            {loadError}
          </p>
        )}
      </div>
    );
  }

  const { you, opponent } = view;
  const picking = view.status === "picking";
  const yourDecks = [...you.decks].sort((a, b) => a.slot - b.slot);
  const theirDecks = [...opponent.decks].sort((a, b) => a.slot - b.slot);
  const deckName = (slot: number): string => you.decks.find((deck) => deck.slot === slot)?.name ?? `Deck ${String(slot + 1)}`;

  return (
    <div className="app-shell tavern lobby play-screen series" data-testid={seriesTestid.screen} data-status={view.status}>
      <BackLink to={paths.play} />
      <SeriesHero />

      {actionError === null ? null : (
        <p className="notice" data-testid={seriesTestid.error} role="alert">
          {actionError}
        </p>
      )}

      <div className="play-layout">
        <div className="play-side">
          {picking ? <SeriesPicker view={view} secondsLeft={secondsLeft} busy={busy} onLockIn={onPick} /> : null}

          {view.status === "playing" && view.currentMatchId !== null ? (
            <section className="lobby-card play-panel series-panel" aria-labelledby="series-game-heading">
              <h2 id="series-game-heading" className="play-panel__heading">
                Game {String(view.gameNo)} is on
              </h2>
              <a
                className="button-primary play-cta series-open"
                href={paths.match(view.currentMatchId)}
                data-testid={seriesTestid.openMatch}
                onClick={followInApp(paths.match(view.currentMatchId))}
              >
                Open game {String(view.gameNo)}
              </a>
              {/* R334: a game is conceded on the board; the series can only be forfeited between games. */}
              <p className="lobby-note">To give up this game, concede it on the board.</p>
            </section>
          ) : null}

          {view.result === null ? null : (
            <section
              className="lobby-card play-panel series-panel series-result"
              data-testid={seriesTestid.result}
              data-outcome={view.result.outcome}
            >
              <span className="series-result__word">{SERIES_OUTCOME_HEADLINE[view.result.outcome]}</span>
              <p>{endReasonWords(view.result, view.winsNeeded, view.maxGames)}</p>
              <p>{ratingWords(view.result)}</p>
              <a
                className="button-primary play-cta"
                href={paths.play}
                data-testid={seriesTestid.backToPlay}
                onClick={followInApp(paths.play)}
              >
                Back to the lobby
              </a>
            </section>
          )}
        </div>

        <div className="play-side">
          <section className="lobby-card play-panel series-panel" aria-labelledby="series-standing-heading">
            <h2 id="series-standing-heading" className="play-panel__heading">
              The series
            </h2>
            <p
              className="series-score"
              data-testid={seriesTestid.score}
              data-you={you.wins}
              data-opponent={opponent.wins}
            >
              <span>
                You {String(you.wins)} – {String(opponent.wins)} Opponent
              </span>
              <span className="series-score__first">
                Win with all {String(view.winsNeeded)} decks · game {String(view.gameNo)} of at most {String(view.maxGames)}
              </span>
            </p>

            <h3 className="series-panel__label">Your decks · {you.trioName}</h3>
            <ul className="play-trio-decks" aria-label="Your decks">
              {yourDecks.map((deck) => {
                const isPick = you.pick === deck.slot;
                return (
                  <li
                    key={deck.slot}
                    className="play-trio-deck series-deck"
                    data-testid={seriesTestid.deck(deck.slot)}
                    data-won={deck.won ? "true" : "false"}
                    data-picked={isPick ? "true" : "false"}
                    title={deckStanding(deck)}
                  >
                    <span className="series-deck__name">{deck.name}</span>
                    <span className="series-deck__standing">{deck.won ? "won · locked" : isPick ? "your pick" : deckStanding(deck).toLowerCase()}</span>
                  </li>
                );
              })}
            </ul>
            <p className="lobby-note">A deck that wins a game is locked for the rest of the series.</p>

            <h3 className="series-panel__label">Their decks</h3>
            <ul className="play-trio-decks" aria-label="Your opponent's decks">
              {theirDecks.map((deck) => (
                <li
                  key={deck.slot}
                  className="play-trio-deck series-deck"
                  data-testid={seriesTestid.opponentDeck(deck.slot)}
                  data-won={deck.won ? "true" : "false"}
                >
                  <span className="series-deck__name">Deck {String(deck.slot + 1)}</span>
                  <span className="series-deck__standing">{deck.won ? "won · locked" : "not won yet"}</span>
                </li>
              ))}
            </ul>
          </section>

          {view.games.length === 0 ? null : (
            <section className="lobby-card play-panel series-panel" aria-labelledby="series-games-heading">
              <h2 id="series-games-heading" className="play-panel__heading play-panel__heading--sub">
                Games
              </h2>
              <ol className="series-history">
                {view.games.map((game) => (
                  <li key={game.gameNo} data-testid={seriesTestid.game(game.gameNo)} data-result={game.result ?? "pending"}>
                    Game {String(game.gameNo)}: {deckName(game.yourSlot)} vs their deck {String(game.opponentSlot + 1)} —{" "}
                    <span className="series-history__result">
                      {game.result === null ? "in progress" : GAME_RESULT_WORD[game.result]}
                    </span>{" "}
                    · {game.youWentFirst ? "you went first" : "they went first"}
                  </li>
                ))}
              </ol>
            </section>
          )}

          {picking ? (
            <section className="lobby-card play-panel series-panel" aria-label="Leave the series">
              {confirming ? (
                <div className="row" role="alertdialog" aria-label="Forfeit the series?">
                  <p>Forfeit the series? Your opponent wins it, and your rating moves as for a loss.</p>
                  <button type="button" data-testid={seriesTestid.forfeitConfirm} disabled={busy} onClick={onForfeit}>
                    Forfeit
                  </button>
                  <button
                    type="button"
                    className="link-button"
                    data-testid={seriesTestid.forfeitCancel}
                    onClick={() => {
                      setConfirming(false);
                    }}
                  >
                    Keep playing
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="link-button"
                  data-testid={seriesTestid.forfeit}
                  disabled={busy}
                  onClick={() => {
                    setConfirming(true);
                  }}
                >
                  Forfeit the series
                </button>
              )}
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
