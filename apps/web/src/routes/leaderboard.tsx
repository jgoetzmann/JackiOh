// `/leaderboard` — the global ranked ladder (SPEC §9.12, R608, R612).
//
// Jlorious #1–#100 first, then every other placed player grouped by Grape tier, highest tier
// first, then how many are still playing placements. The caller's own standing heads the page.
// The page is read-only and decides nothing (CLAUDE.md rule 7): it renders `GET /api/leaderboard`
// through `rankWords`, and the hidden rating never reaches it.

import { useEffect, useState, type ReactElement } from "react";

import { getLeaderboard, type LeaderboardResponse } from "../net/api.ts";
import { divisionNumeral, rankWords, tierName } from "../rank/rank.ts";
import { BackLink } from "./nav.tsx";

import "../auth/tavern.css";
import "./leaderboard.css";

export const leaderboardTestid = {
  screen: "leaderboard-screen",
  loading: "leaderboard-loading",
  error: "leaderboard-error",
  season: "leaderboard-season",
  you: "leaderboard-you",
  jlorious: "leaderboard-jlorious",
  tier: "leaderboard-tier",
  raisins: "leaderboard-raisins",
} as const;

export type LeaderboardRouteProps = {
  token: string;
};

export default function LeaderboardRoute({ token }: LeaderboardRouteProps): ReactElement {
  const [board, setBoard] = useState<LeaderboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getLeaderboard(token)
      .then((next) => {
        if (!cancelled) setBoard(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="app-shell tavern leaderboard-screen" data-testid={leaderboardTestid.screen}>
      <BackLink />
      <section className="panel panel--auth">
        <div className="brand">
          <h1>JackiOh</h1>
        </div>
        <h2>Leaderboard</h2>

        {error !== null ? (
          <p className="notice" data-testid={leaderboardTestid.error} role="alert">
            {error}
          </p>
        ) : null}

        {board === null && error === null ? (
          <p className="notice shell-panel__loading" data-testid={leaderboardTestid.loading} role="status">
            Loading the ladder…
          </p>
        ) : null}

        {board !== null ? (
          <>
            <p data-testid={leaderboardTestid.season}>Season {board.season}</p>
            <p data-testid={leaderboardTestid.you}>
              {board.jlorious.some((row) => row.you) || board.tiers.some((tier) => tier.players.some((row) => row.you))
                ? `You are ${rankWords(board.you)}`
                : `You are ${rankWords(board.you)} — play rated games to climb`}
            </p>

            <h3 className="leaderboard-heading">Jlorious</h3>
            {board.jlorious.length === 0 ? (
              <p>No Jlorious players yet this season.</p>
            ) : (
              <ol data-testid={leaderboardTestid.jlorious}>
                {board.jlorious.map((row) => (
                  <li key={row.position} data-you={row.you ? "you" : undefined}>
                    #{row.position} {row.tag}
                    {row.you ? " (you)" : ""}
                  </li>
                ))}
              </ol>
            )}

            {board.tiers.map((tier) => (
              <section key={tier.tier} data-testid={leaderboardTestid.tier} data-tier={tier.tier}>
                <h3 className="leaderboard-heading">
                  {tierName(tier.tier)} ({tier.count})
                </h3>
                {tier.players.length === 0 ? (
                  <p>Nobody here yet.</p>
                ) : (
                  <ul>
                    {tier.players.map((row) => (
                      <li key={row.tag} data-you={row.you ? "you" : undefined}>
                        {row.tag} · Division {divisionNumeral(row.division)} · {row.pips} {row.pips === 1 ? "pip" : "pips"}
                        {row.you ? " (you)" : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}

            <p data-testid={leaderboardTestid.raisins}>
              {board.raisins === 0
                ? "Nobody is playing placements right now."
                : `${board.raisins} ${board.raisins === 1 ? "player is" : "players are"} still playing placements.`}
            </p>
          </>
        ) : null}
      </section>
    </div>
  );
}
