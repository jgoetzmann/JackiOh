// `/match/<id>` — the networked board (BUILD M6-T4, SPEC §9.5).
//
// The whole route is three lines of intent: open the socket (`game/net.ts`), render whatever
// `PlayerView` came back through the same `Game.tsx` the hotseat route renders, and send clicks
// straight back out. CLAUDE.md rule 7: no rule is decided here, and nothing on screen comes from
// anywhere but the view.
//
// THE READ-ONLY BOARD. `game/actions.ts` derives every clickable element by filtering the
// `legalActions` array (BUILD M5-T2: "The client never computes legality itself; it asks
// `legalActions` and greys out the rest"), and `apps/server/src/match/protocol.ts` has no frame
// that carries it — `view`, `ack`, `error`, `prompt`, `clock` and that is all. `net.ts` accepts the
// array from either shape a server may grow (a `legal` field on the `view` frame, or a `legal`
// frame of its own) and reports when neither has ever arrived; this file renders that state as a
// loud notice instead of a silently dead board. Prompts still work — `Prompt.tsx` rebuilds an
// `answer` from `PendingView.options` when it is given no array — so a networked match can be
// mulliganed and its choices answered, and nothing else. It is an ASK on the owner of
// `protocol.ts` / `actor.ts`, not something to paper over with a client-side legality check.
//
// THE CATALOG. `CardView` is `{ instanceId, defId, radiant, cost }` (§10.8), so a view alone cannot
// put a card's NAME on its face — and `cy.playByName` / `cy.handCardByName` find cards by name. The
// hotseat route gets its defs from the engine it is running; a networked client has no engine, so
// this route reads `GET /api/catalog` (the endpoint `apps/web/src/net/api.ts` documents as its own
// finding against §9.4's "static, versioned, shipped with the client") and feeds `CatalogContext`.
// With no catalog the board still renders — every card shows its `defId`, never a guessed name.

import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import type { ActionBody, CardDefs, PlayerId } from "@jackioh/shared";

import Clock from "../game/Clock.tsx";
import Game from "../game/Game.tsx";
import { CatalogContext, lookupFromDefs } from "../game/catalog.ts";
import {
  installDevHandle,
  remainingMs,
  useMatch,
  viewDerivedState,
  type SocketFactory,
} from "../game/net.ts";
import { getCatalog } from "../net/api.ts";

/** Chrome this route invented. None of it is in `e2e/support/testids.ts`; see the hand-off report. */
export const matchTestid = {
  /** The connection line: `connecting`, `open`, `reconnecting`, `refused`, `closed`. */
  status: "match-status",
  /** The notice that stands in for the missing legal-action frame. */
  missingLegal: "missing-legal-frame",
  /** The panel shown before the first `view` frame lands. */
  connecting: "match-connecting",
} as const;

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

export default function MatchRoute({ matchId, token, socketFactory }: MatchRouteProps): ReactElement {
  const match = useMatch({
    matchId,
    token,
    ...(socketFactory === undefined ? {} : { socketFactory }),
  });
  const defs = useCatalog();
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
  const clock = match.clock;

  if (view === null) {
    return (
      <div className="app-shell">
        <h1>JackiOh</h1>
        <p className="notice" data-testid={matchTestid.connecting} role="status">
          {match.connection === "refused"
            ? (match.error ?? "the server refused this match socket")
            : `Connecting to match ${matchId}…`}
        </p>
        {match.connection === "refused" ? null : (
          <p className="notice">
            <code data-testid={matchTestid.status}>{match.connection}</code> · <code>{match.url}</code>
          </p>
        )}
      </div>
    );
  }

  const activeIsYou = view.active === view.viewer;
  // R79's turn clock belongs to the ACTIVE player. `clock` frames are preferred over
  // `PlayerView.clockMs` because they carry the server's `now`, which is what makes a countdown
  // immune to this tab's wall-clock skew (`protocol.ts`).
  const turnMs = clock === null ? view.clockMs : remainingMs(clock.clocks.turnDeadline, clock);
  const opponent: PlayerId = view.opponent.player;
  const graceMs = {
    you: clock === null ? null : remainingMs(clock.clocks.graceDeadline[view.viewer], clock),
    opponent: clock === null ? null : remainingMs(clock.clocks.graceDeadline[opponent], clock),
  };

  const board = (
    <Game view={view} legal={match.legal} onAction={match.send} error={match.error} />
  );

  return (
    <div className="app-shell">
      <header className="match-bar">
        <span>
          match <code>{matchId}</code> · seat <code>{view.viewer}</code> · turn {view.turn} ·{" "}
          <code data-testid={matchTestid.status}>{match.connection}</code>
        </span>
        <Clock
          youMs={activeIsYou ? turnMs : null}
          opponentMs={activeIsYou ? null : turnMs}
          graceMs={graceMs}
        />
      </header>

      {match.legalSource === "none" ? (
        <p className="notice" data-testid={matchTestid.missingLegal} role="alert">
          This board is read-only. <code>apps/server/src/match/protocol.ts</code> sends{" "}
          <code>view</code>, <code>ack</code>, <code>error</code>, <code>prompt</code> and{" "}
          <code>clock</code>, and none of them carries the <code>legalActions</code> array BUILD
          M5-T2 requires (&ldquo;the client never computes legality itself; it asks{" "}
          <code>legalActions</code> and greys out the rest&rdquo;). Until the actor sends one — as a{" "}
          <code>legal</code> field on the <code>view</code> frame, or as a <code>legal</code> frame
          of its own; this client accepts either — only prompts can be answered.
        </p>
      ) : null}

      {lookup === null ? board : <CatalogContext.Provider value={lookup}>{board}</CatalogContext.Provider>}
    </div>
  );
}
