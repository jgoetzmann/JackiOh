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
//
// A PENDING ACCOUNT has no record, and `/api/profile` is `auth: "active"`, so it refuses one with
// 403 `account_pending`. The gate opens this screen to a pending account precisely because it
// still has an address, a status and a way to sign out, so for one the screen shows what the
// gate's own read (`/api/auth/me`) already says, and the way on: redeeming an invite code.
//
// THE SAME TAVERN AS THE WAY IN. The landing's corner pill opens this screen, and for a pending
// account it is the road to the code screen, so it wears the sign-in screens' frame
// (`auth/tavern.css`): the board, the gold call to action, wood for the rest. A status is said in
// a player's words; the raw value rides on `data-status` for tests.

import { useEffect, useState, useSyncExternalStore, type ReactElement } from "react";

import { AUTH_SIGN_OUT_WAIT_SECONDS } from "../../../server/src/config.ts";
import { getProfile, type MeResponse, type ProfileResponse } from "../net/api.ts";
import { revokeSignedOutSession, sessionNearExpiry } from "../net/auth.ts";
import { paths } from "../net/navigate.ts";
import { clearSession, forgetPendingAddresses, readSession } from "../net/session.ts";
import { BackLink, followInApp } from "./nav.tsx";

import "../auth/tavern.css";

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
  redeem: "account-redeem",
} as const;

/** An account's status in a player's words (§9.4's three). */
export function statusWords(status: MeResponse["profile"]["status"]): string {
  switch (status) {
    case "pending":
      return "Waiting for an invite code";
    case "active":
      return "Active";
    case "banned":
      return "Banned";
  }
}

/** 0.5 -> "50%". Null means nothing has been played, which is not the same as 0%. */
export function formatWinRate(winRate: number | null): string {
  return winRate === null ? "—" : `${String(Math.round(winRate * 100))}%`;
}

/**
 * Signing out clears the token, revokes it at the provider, and then does a REAL navigation rather
 * than a pushState.
 *
 * REVOKE (R194). Clearing the device alone left the refresh token valid at the provider, so a copy
 * of it (a synced profile, a stolen backup) could keep renewing sessions after the player believed
 * they had signed out. `revokeSignedOutSession` posts `/auth/v1/logout?scope=local` with
 * `keepalive`, so the request survives the page load below. For a live session it is fired and NOT
 * awaited: the device's copy is already gone, the call never throws, and a slow provider must not
 * hold the player on this screen.
 *
 * An EXPIRED session is the exception. The provider refuses to log out an expired access token, so
 * it has to be renewed first, and the revocation can only be sent once the renewal answers, which a
 * page load would cut off. So sign-out waits for the two, at most `AUTH_SIGN_OUT_WAIT_SECONDS`, and
 * then loads the landing page whatever happened.
 *
 * `useAccount` reads the session once, in a mount effect, so a client-side navigate would leave
 * every already-mounted gate holding the account it resolved before the token was cleared. A
 * document load is the honest way to drop that state, and signing out is rare enough that the
 * reload costs nothing.
 */
export function signOut(): void {
  // ONE SIGN-OUT AT A TIME. While an expired session is being renewed so it can be revoked, the
  // device's copy is already gone, so a second press would find no session and load the page at
  // once, cutting off the renewal before the revocation was ever sent. A press while one is in
  // flight joins it instead; the buttons say "Signing out…" meanwhile (`useSigningOut`).
  if (signingOut) return;
  const session = readSession();
  clearSession();
  // Whatever sign-up or reset this browser was waiting on ends with it (R193): an address left
  // armed here would accept the next person's link, or one planted by someone else.
  forgetPendingAddresses();
  let left = false;
  const leave = (): void => {
    if (left || typeof window === "undefined") return;
    left = true;
    window.location.assign(paths.landing);
  };
  if (session === null) {
    leave();
    return;
  }
  const revoking = revokeSignedOutSession(session);
  if (!sessionNearExpiry(session, Date.now())) {
    leave();
    return;
  }
  setSigningOut(true);
  const timer = setTimeout(() => {
    leave();
    setSigningOut(false);
  }, AUTH_SIGN_OUT_WAIT_SECONDS * 1000);
  void revoking.finally(() => {
    clearTimeout(timer);
    leave();
    // The page is leaving; a press in the moment before it goes finds no session and just leaves.
    setSigningOut(false);
  });
}

/** True from a sign-out that has to wait (an expired session) until the page leaves. */
let signingOut = false;
const signingOutListeners = new Set<() => void>();

function setSigningOut(value: boolean): void {
  signingOut = value;
  for (const listener of signingOutListeners) listener();
}

/** Test seam: a sign-out whose page load a test stubbed never ends on its own. */
export function resetSigningOutForTests(): void {
  setSigningOut(false);
}

/**
 * Whether a sign-out is under way, for the Sign out buttons to show "Signing out…" and stay
 * disabled until the page leaves.
 */
export function useSigningOut(): boolean {
  return useSyncExternalStore(
    (listener) => {
      signingOutListeners.add(listener);
      return () => {
        signingOutListeners.delete(listener);
      };
    },
    () => signingOut,
    () => false,
  );
}

/** The label a Sign out button shows. */
export function signOutLabel(busy: boolean): string {
  return busy ? "Signing out…" : "Sign out";
}

export type AccountRouteProps = {
  token: string;
  /** The gate's read of the account. A pending one is shown from it, since it has no record. */
  me?: MeResponse;
};

export default function AccountRoute({ token, me }: AccountRouteProps): ReactElement {
  const pending = me !== undefined && me.profile.status === "pending";
  const leaving = useSigningOut();
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (pending) return;
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
  }, [token, pending]);

  const played = profile === null ? 0 : profile.record.wins + profile.record.losses + profile.record.draws;

  return (
    <div className="app-shell tavern account-screen" data-testid={accountTestid.screen}>
      <BackLink />

      <section className="panel panel--auth">
        <div className="brand">
          <h1>JackiOh</h1>
        </div>
        <h2>Your account</h2>

        {error !== null ? (
          <p className="notice" data-testid={accountTestid.error} role="alert">
            {error}
          </p>
        ) : null}

        {pending && me !== undefined ? (
          <>
            <AccountIdentity email={me.email} status={me.profile.status} />
            <p>Online play opens once this account has redeemed an invite code.</p>
            <div className="row">
              <a
                className="button-primary"
                href={paths.invite}
                data-testid={accountTestid.redeem}
                onClick={followInApp(paths.invite)}
              >
                Redeem an invite code
              </a>
            </div>
          </>
        ) : null}

        {!pending && profile === null && error === null ? (
          <p className="notice shell-panel__loading" data-testid={accountTestid.loading} role="status">
            Loading your account…
          </p>
        ) : null}

        {profile !== null ? (
          <>
            <AccountIdentity email={profile.email} status={profile.status} />

            <h3 className="account-heading">Record</h3>
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
          </>
        ) : null}

        <div className="account-session">
          <p>
            Signing out ends this session: this device forgets it, and it is revoked so no copy of it
            works again. Your account and decks are unaffected.
          </p>
          <div className="row">
            <button
              type="button"
              data-testid={accountTestid.signOut}
              disabled={leaving}
              aria-busy={leaving}
              onClick={signOut}
            >
              {signOutLabel(leaving)}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

/** Who is signed in, and the account's status in a player's words. */
function AccountIdentity({
  email,
  status,
}: {
  email: string | null;
  status: MeResponse["profile"]["status"];
}): ReactElement {
  return (
    <div className="account-identity">
      <p className="account-label">Signed in as</p>
      <p data-testid={accountTestid.email} className="account-email">
        {email ?? "(no email on this account)"}
      </p>
      <p className="account-status" data-testid={accountTestid.status} data-status={status}>
        {statusWords(status)}
      </p>
    </div>
  );
}
