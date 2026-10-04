// `/match/<id>` — the networked board (BUILD M6-T4, SPEC §9.5).
//
// The whole route is three lines of intent: open the socket (`game/net.ts`), render whatever
// `PlayerView` came back through the same `Game.tsx` the hotseat route renders, and send clicks
// straight back out. CLAUDE.md rule 7: no rule is decided here, and nothing on screen comes from
// anywhere but the view.
//
// WHERE LEGALITY COMES FROM. `game/actions.ts` derives every clickable element by filtering the
// `legalActions` array (BUILD M5-T2: "The client never computes legality itself; it asks
// `legalActions` and greys out the rest"). The actor sends it on the `view` frame —
// `apps/server/src/match/protocol.ts` `ViewMessage` is `{type:"view", view, legal}` and `pushView`
// fills it with `legalActions(state, player)` for that socket's own seat — so this route hands
// `match.legal` to the same `Game.tsx` the hotseat route hands `engine.legalActions(state, seat)`.
// `net.ts` also accepts a `legal` frame of its own and reports when NEITHER has ever arrived; this
// file renders that state as a loud notice instead of a silently dead board, because the failure
// is invisible otherwise: prompts would still work (`Prompt.tsx` rebuilds an `answer` from
// `PendingView.options` when it is given no array) and nothing else would. Nothing here papers
// over it with a client-side legality check.
//
// THE CATALOG. `CardView` is `{ instanceId, defId, radiant, cost }` (§10.8), so a view alone cannot
// put a card's NAME on its face — and `cy.playByName` / `cy.handCardByName` find cards by name. The
// hotseat route gets its defs from the engine it is running; a networked client has no engine, so
// this route reads `GET /api/catalog` (the endpoint `apps/web/src/net/api.ts` documents as its own
// finding against §9.4's "static, versioned, shipped with the client") and feeds `CatalogContext`.
// With no catalog the board still renders — every card shows its `defId`, never a guessed name.

import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import type { ActionBody, CardDefs, PlayerId, PlayerView } from "@jackioh/shared";

import Clock, { turnKeyOf, useFrameFor } from "../game/Clock.tsx";
import Game from "../game/Game.tsx";
import { CatalogContext, lookupFromDefs } from "../game/catalog.ts";
import {
  installDevHandle,
  remainingMs,
  useMatch,
  viewDerivedState,
  type ConnectionState,
  type SocketFactory,
} from "../game/net.ts";
import { Loading, SITE_NAME, ShellPanel, documentTitleFor } from "../main.tsx";
import { getCatalog, getMatchRanks, type MatchRanksResponse } from "../net/api.ts";
import { navigate, paths } from "../net/navigate.ts";
import { rankWords } from "../rank/rank.ts";
import { BackLink, followInApp } from "./nav.tsx";
import { SeriesBanner, SeriesContinue, useMatchSeries } from "./SeriesBanner.tsx";

const DEV_ONLY = import.meta.env.MODE !== "production";

/** R79: the seat an open prompt waits on, as the view says it (`PlayerView.pending`), or null. */
export function promptHolderOf(pending: PlayerView["pending"], viewer: PlayerId): PlayerId | null {
  if (pending === null) return null;
  return pending.forYou ? viewer : pending.pendingFor;
}

/** Chrome this route invented. None of it is in `e2e/support/testids.ts`; see the hand-off report. */
export const matchTestid = {
  /**
   * The connection line, in a player's words (`connectionWords`). The raw state (`connecting`,
   * `open`, `reconnecting`, `refused`, `closed`) rides on its `data-connection`.
   */
  status: "match-status",
  /** The notice that stands in for the missing legal-action frame. */
  missingLegal: "missing-legal-frame",
  /** The panel shown before the first `view` frame lands. */
  connecting: "match-connecting",
  /** The sentence that stands in for a refused socket. */
  refused: "match-refused",
  /** Both seats' visible ranks and whether this game moves them (R604, R612). */
  ranks: "match-ranks",
} as const;

/** A connection state in a player's words, for the match bar and the wait before the board. */
export function connectionWords(state: ConnectionState): string {
  switch (state) {
    case "open":
      return "Connected";
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return "Reconnecting…";
    case "refused":
      return "This match isn\u2019t available";
    case "closed":
      return "Disconnected";
  }
}

/** The connection line: the words for a player, the raw state for tests. */
function ConnectionLine({ state }: { state: ConnectionState }): ReactElement {
  return (
    <span data-testid={matchTestid.status} data-connection={state}>
      {connectionWords(state)}
    </span>
  );
}

export type MatchRouteProps = {
  matchId: string;
  /** The bearer token the gate already resolved; this route never reads storage itself. */
  token: string;
  /** Test seam, passed straight to `net.ts`. Unused in the app. */
  socketFactory?: SocketFactory;
};

/**
 * `GET /api/catalog`, once. It is public, versioned data (§5.1) and carries no match state, so a
 * failure is not fatal: the board renders `defId`s instead of names.
 */
function useCatalog(): CardDefs | null {
  const [defs, setDefs] = useState<CardDefs | null>(null);
  useEffect(() => {
    let cancelled = false;
    getCatalog()
      .then((response) => {
        if (!cancelled) setDefs(response.defs);
      })
      .catch(() => {
        // No catalog: `catalog.ts` falls back to the def id, which keeps the board honest about
        // what a `PlayerView` does and does not contain.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return defs;
}

/**
 * The socket URL with its credentials stripped, for display only.
 *
 * `net.ts`'s `socketUrlFor` puts the access token in the query string (`url.searchParams.set(
 * "token", token)`), so rendering the URL raw printed a live bearer token on screen and into the
 * DOM on every connect — visible in a screenshot, a screen share, over a shoulder, and to any
 * extension that can read the page. The host and path are the useful part of the diagnostic; the
 * query never was.
 *
 * Returns the input unchanged if it will not parse, since this is a status line and must not be
 * the thing that throws.
 */
export function withoutToken(raw: string): string {
  try {
    const url = new URL(raw);
    url.search = "";
    return url.toString();
  } catch {
    return raw;
  }
}

/** A `GET /api/matches/:id/ranks` body, or null when the answer is not one. */
function asMatchRanks(value: unknown): MatchRanksResponse | null {
  if (typeof value !== "object" || value === null) return null;
  const { ranked, seats } = value as { ranked?: unknown; seats?: unknown };
  if (typeof ranked !== "boolean" || typeof seats !== "object" || seats === null) return null;
  for (const side of ["p1", "p2"] as const) {
    const seat = (seats as Record<string, unknown>)[side];
    if (typeof seat !== "object" || seat === null) return null;
    const { tag, rank } = seat as { tag?: unknown; rank?: unknown };
    if (typeof tag !== "string" || typeof rank !== "object" || rank === null) return null;
    if (typeof (rank as { tier?: unknown }).tier !== "string") return null;
  }
  return value as MatchRanksResponse;
}

/**
 * Both seats' ranks for the match bar (R604, R612): whether this game moves the rating, and each
 * seat's visible rank. Read once: a promotion mid-match shows on the next one. An answer that is
 * not a ranks body — or no answer — leaves no banner rather than breaking the board.
 */
function useMatchRanks(token: string, matchId: string): MatchRanksResponse | null {
  const [ranks, setRanks] = useState<MatchRanksResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    getMatchRanks(token, matchId).then(
      (answer) => {
        if (!cancelled) setRanks(asMatchRanks(answer));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [token, matchId]);
  return ranks;
}

export default function MatchRoute({ matchId, token, socketFactory }: MatchRouteProps): ReactElement {
  const match = useMatch({
    matchId,
    token,
    ...(socketFactory === undefined ? {} : { socketFactory }),
  });
  const defs = useCatalog();
  const ranks = useMatchRanks(token, matchId);
  // R336: a Conquest game shows its series' score and won decks, and once it is over the way to the next game.
  const series = useMatchSeries(token, matchId, match.view?.result != null);
  const lookup = useMemo(() => (defs === null ? null : lookupFromDefs(defs)), [defs]);

  // BUILD M5-T3 / `e2e/support/types.ts`: `window.__jackioh` outside production builds. Installed
  // once, reading through a ref, so a spec that re-reads `handle.state` sees the current view and
  // not the one that existed when the effect ran.
  const latest = useRef(match);
  latest.current = match;
  useEffect(
    () =>
      installDevHandle({
        get state() {
          const view = latest.current.view;
          return view === null ? null : viewDerivedState(view);
        },
        get seed() {
          // The server mints the match seed and never sends it: with the seed and the log a client
          // could reconstruct the library order (§9.1, §9.3). See `viewDerivedState`.
          return "";
        },
        get seat() {
          return latest.current.view?.viewer ?? null;
        },
        dispatch: (action) => {
          // `playerId` is dropped: `parseClientMessage` discards it and the actor stamps the
          // authenticated seat, so sending one would be theatre.
          const { playerId: _seat, ...body } = action;
          latest.current.send(body as ActionBody);
        },
      }),
    [],
  );

  const view = match.view;
  // The clock frame of the turn the view is on (Clock.tsx `useFrameFor`): a view that has moved on
  // to the next turn never reads the last turn's deadline, even for the moment before its frame lands.
  const clock = useFrameFor(match.clock, turnKeyOf(view));

  // What the server said when it refused the socket is for a debugger, not the player (below).
  const refusedWith = match.connection === "refused" ? (match.error ?? "no reason given") : null;
  useEffect(() => {
    if (refusedWith === null) return;
    console.error(`The server refused the socket for match ${matchId}: ${refusedWith}`);
  }, [refusedWith, matchId]);

  // No frame has carried `legalActions` (see WHERE LEGALITY COMES FROM above): the player gets a
  // sentence, and the console gets why.
  const readOnly = view !== null && match.legalSource === "none";
  useEffect(() => {
    if (!readOnly) return;
    // Worded without the build plan's task ids or repository paths, which ship in the bundle.
    console.error(
      "This board is read-only: nothing this socket has received carries the `legalActions` array, " +
        "so only prompts can be answered. The match server sends it as a `legal` field on the " +
        "`view` frame; a `legal` frame of its own would do as well.",
    );
  }, [readOnly]);

  // The tab says when it is the player's turn, so a match in a background tab can be found.
  const yourTurn = view !== null && view.result === null && view.active === view.viewer;
  useEffect(() => {
    document.title = yourTurn ? `Your turn · ${SITE_NAME}` : documentTitleFor(paths.match(matchId));
  }, [yourTurn, matchId]);

  if (view === null) {
    if (match.connection === "refused") {
      return (
        <ShellPanel testId={matchTestid.connecting}>
          <p className="notice" data-testid={matchTestid.refused} role="alert">
            This match isn&rsquo;t available. It may have ended, or it may not be yours to join.
          </p>
          <div className="row">
            <a className="button-primary" href={paths.play} onClick={followInApp(paths.play)}>
              Back to the lobby
            </a>
          </div>
        </ShellPanel>
      );
    }
    // Render's free tier can take most of a minute to wake, which `slow` says once it has.
    return (
      <Loading what="Joining the match…" slow testId={matchTestid.connecting}>
        <p className="auth-hint">
          <ConnectionLine state={match.connection} />
          {DEV_ONLY ? (
            <>
              {" "}
              · match <code>{matchId}</code> · <code>{withoutToken(match.url)}</code>
            </>
          ) : null}
        </p>
      </Loading>
    );
  }

  const activeIsYou = view.active === view.viewer;
  // R79's turn clock belongs to the ACTIVE player. `clock` frames are preferred over
  // `PlayerView.clockMs` because they carry the server's `now`, which is what makes a countdown
  // immune to this tab's wall-clock skew (`protocol.ts`).
  const turnMs = clock === null ? view.clockMs : remainingMs(clock.clocks.turnDeadline, clock);
  // R265, R268: while both mulligans are open one deadline runs for both seats, reported as the
  // prompt deadline (and as each seat's `clockMs`), so both sides show it — the seat that has
  // already answered included, since it is waiting on it.
  const inMulligan = view.mulligan !== undefined;
  const mulliganMs = clock === null ? view.clockMs : remainingMs(clock.clocks.promptDeadline, clock);
  const opponent: PlayerId = view.opponent.player;
  const graceMs = {
    you: clock === null ? null : remainingMs(clock.clocks.graceDeadline[view.viewer], clock),
    opponent: clock === null ? null : remainingMs(clock.clocks.graceDeadline[opponent], clock),
  };

  const board = (
    <Game
      view={view}
      legal={match.legal}
      onAction={match.send}
      trackStats
      // A refused socket's reason is the console's (above); the board says it in a player's words.
      error={refusedWith === null ? match.error : `${connectionWords("refused")}. Head back to the lobby.`}
      resultActions={
        // A finished match's way on (Result.tsx): the series' next game first when there is one,
        // then the lobby, where the next one starts.
        <>
          <SeriesContinue series={series} matchId={matchId} />
          <button type="button" data-testid="result-back" onClick={() => navigate(paths.play)}>
            Back to lobby
          </button>
        </>
      }
    />
  );

  return (
    <div className="app-shell app-shell--wide">
      {/*
        Leaving does NOT end the match — §9.5's clocks and the reaper still own that, and the
        socket reconnects if you come back. Being unable to leave at all was the worse failure:
        nav.tsx names this screen as trapped and it was the one that never got a way out.
      */}
      <BackLink />
      <header className="match-bar">
        <span>
          Online match · Turn {view.turn} · <ConnectionLine state={match.connection} />
          {DEV_ONLY ? (
            <>
              {" "}
              · match <code>{matchId}</code> · seat <code>{view.viewer}</code>
            </>
          ) : null}
        </span>
        <Clock
          youMs={inMulligan ? mulliganMs : activeIsYou ? turnMs : null}
          opponentMs={inMulligan ? mulliganMs : activeIsYou ? null : turnMs}
          graceMs={graceMs}
          mulligan={inMulligan}
          // R268, R439: the readout counts down off the frame's own deadlines between the server's
          // frames — the mulligan window can pass with none, and a turn's last 30 seconds must tick.
          frame={clock}
          viewer={view.viewer}
          // R79: the turn clock is the active player's, and a prompt held by the other seat runs its
          // own. A finished game runs neither.
          activePlayer={view.result === null ? view.active : null}
          promptHolder={view.result === null ? promptHolderOf(view.pending, view.viewer) : null}
        />
      </header>
      <SeriesBanner series={series} matchId={matchId} gameOver={view.result !== null} />
      {ranks !== null ? (
        <p className="match-ranks" data-testid={matchTestid.ranks}>
          {ranks.ranked ? "Ranked match" : "Unranked match"} · {ranks.seats.p1.tag}
          {ranks.seats.p1.you ? " (you)" : ""} {rankWords(ranks.seats.p1.rank)} vs {ranks.seats.p2.tag}
          {ranks.seats.p2.you ? " (you)" : ""} {rankWords(ranks.seats.p2.rank)}
        </p>
      ) : null}

      {readOnly ? (
        <p className="notice" data-testid={matchTestid.missingLegal} role="alert">
          Your moves can&rsquo;t be sent from this board right now. Reload the page to rejoin the match.
        </p>
      ) : null}

      {/*
        The provider is ALWAYS rendered, `value={null}` included. `GET /api/catalog` resolves
        asynchronously, and conditionally wrapping the board changes the element type at this
        position the moment it lands — which makes React unmount the whole board and mount a fresh
        one. Every DOM node is replaced, so a click Cypress had already resolved to a prompt option
        (or a player's half-finished play) is thrown away mid-gesture: `cy.click()` reports the
        element "disappeared from the page". `CatalogContext`'s default is `null` and `useCardInfo`
        falls back to `unknownCard(defId)` for it, so a null value renders exactly what the
        unwrapped board rendered — def ids, never a guessed name.
      */}
      <CatalogContext.Provider value={lookup}>{board}</CatalogContext.Provider>
    </div>
  );
}
