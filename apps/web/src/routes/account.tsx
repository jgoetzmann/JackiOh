// `/account` — who you are signed in as, how you have done, and the way out.
//
// NO SPEC DRIVES THIS SCREEN. §9.4 gives an account a status and §9.5 gives it a rating and a
// results history; none of it was reachable from the client, so a player could not see which
// address they were signed in as, could not see their record, and — the one that actually traps
// people — could not sign out at all. `net/session.ts` held the token and nothing ever cleared it.
//
// The record comes from `GET /api/profile`, which counts `results` server-side. The win rate is
// computed there too rather than here, so the number on screen cannot disagree with the counts
// beside it.

import { useEffect, useState, type ReactElement } from "react";

import { getProfile, type ProfileResponse } from "../net/api.ts";
import { navigate, paths } from "../net/navigate.ts";
import { clearSession } from "../net/session.ts";

export const accountTestid = {
  screen: "account-screen",
  email: "account-email",
  status: "account-status",
  rating: "account-rating",
  record: "account-record",
  winRate: "account-win-rate",
  signOut: "account-sign-out",
  error: "account-error",
  loading: "account-loading",
} as const;

/** 0.5 -> "50%". Null means nothing has been played, which is not the same as 0%. */
export function formatWinRate(winRate: number | null): string {
  return winRate === null ? "—" : `${String(Math.round(winRate * 100))}%`;
}

/**
 * Signing out clears the token and then does a REAL navigation rather than a pushState.
 *
 * `useAccount` reads the session once, in a mount effect, so a client-side navigate would leave
 * every already-mounted gate holding the account it resolved before the token was cleared. A
 * document load is the honest way to drop that state, and signing out is rare enough that the
 * reload costs nothing.
 */
export function signOut(): void {
  clearSession();
  if (typeof window === "undefined") return;
  window.location.assign(paths.landing);
}

export type AccountRouteProps = { token: string };

export default function AccountRoute({ token }: AccountRouteProps): ReactElement {
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getProfile(token)
      .then((next) => {
        if (!cancelled) setProfile(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const played = profile === null ? 0 : profile.record.wins + profile.record.losses + profile.record.draws;

  return (
    <div className="app-shell" data-testid={accountTestid.screen}>
      <nav className="row">
        <button
          type="button"
          className="link-button"
          onClick={() => {
            navigate(paths.landing);
          }}
        >
          ← Back
        </button>
      </nav>

      <h1>Account</h1>

      {error !== null ? (
        <p className="notice" data-testid={accountTestid.error} role="alert">
          {error}
        </p>
      ) : null}

      {profile === null && error === null ? (
        <p className="notice" data-testid={accountTestid.loading} role="status">
          Loading your account…
        </p>
      ) : null}

      {profile !== null ? (
        <>
          <section className="panel">
            <h2>Signed in as</h2>
            <p data-testid={accountTestid.email} className="account-email">
              {profile.email ?? "(no email on this account)"}
            </p>
            <p>
              Status <code data-testid={accountTestid.status}>{profile.status}</code>
            </p>
          </section>

          <section className="panel">
            <h2>Record</h2>
            <div className="stat-row">
              <div className="stat">
                <span className="stat-value" data-testid={accountTestid.rating}>
                  {profile.rating}
                </span>
                <span className="stat-label">Rating</span>
              </div>
              <div className="stat">
                <span className="stat-value" data-testid={accountTestid.winRate}>
                  {formatWinRate(profile.winRate)}
                </span>
                <span className="stat-label">Win rate</span>
              </div>
              <div className="stat">
                <span className="stat-value" data-testid={accountTestid.record}>
                  {profile.record.wins}–{profile.record.losses}–{profile.record.draws}
                </span>
                <span className="stat-label">W–L–D</span>
              </div>
              <div className="stat">
                <span className="stat-value">{played}</span>
                <span className="stat-label">Played</span>
              </div>
            </div>
            {played === 0 ? <p>No finished matches yet.</p> : null}
          </section>
        </>
      ) : null}

      <section className="panel">
        <h2>Session</h2>
        <p>Signing out clears this device&rsquo;s token. Your account and decks are unaffected.</p>
        <div className="row">
          <button type="button" data-testid={accountTestid.signOut} onClick={signOut}>
            Sign out
          </button>
        </div>
      </section>
    </div>
  );
}
