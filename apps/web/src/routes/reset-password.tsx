// `/reset-password` — choose a new password after following a recovery link (B31, R193).
//
// `/login` reads the recovery link, scrubs it from the address bar, and hands its session to
// `auth/redirect.ts`, which holds it FOR THIS TAB ONLY (memory, mirrored to `sessionStorage` so a
// reload or a discarded tab does not spend the reset). This screen is the one place that session is
// used: `PUT /auth/v1/user` with its access token sets the new password, and only then does the
// session become the stored one (`adoptSession`, which revokes any session it replaces) and the
// player go on to `/decks`. Until a password is saved nothing reaches `localStorage`.
//
// LEAVING LETS IT GO. The held session is abandoned as soon as the screen is left without saving, so
// the next person at this computer cannot press Back and find a working "choose a new password"
// form for someone else's account. Abandoning also revokes it at the provider, because its tokens
// came in a URL, and the browser's history keeps the URL a page loaded with:
//   - the screen's own exits (back, "Back to sign in") ASK FIRST, because the link works only once
//     and a stray tap (the back control sits where a phone's back gesture does) would otherwise
//     spend it; once the player confirms, the session is abandoned;
//   - leaving any other way within the app (the screen unmounts) abandons it, just after the
//     unmount, so React's StrictMode rehearsal (unmount, then mount again) does not;
//   - leaving the page for another site abandons it (`pagehide` into the back/forward cache), and a
//     page the browser's Back or Forward button loads afresh finds it abandoned.
// A reload keeps it: that is the case the tab's own storage is for.
//
// A SESSION THAT RUNS OUT WHILE THE FORM IS OPEN is renewed with its refresh token before the new
// password is sent, and once more if the provider refuses the access token (R194), so a player who
// took their time is not told the link was spent.
//
// NOT GATED. A player here is by definition not signed in yet. Without a held recovery session
// (a bookmark, a link opened in another tab, a reset already left) the screen says so and offers
// the two ways forward: ask for a new link (`/login?mode=forgot`) or go back to sign in. No dead
// ends.

import { useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";

import Address from "../auth/Address.tsx";
import {
  abandonRecoverySession,
  abandonRecoverySessionSoon,
  emailFromToken,
  holdRecoverySession,
  keepRecoverySession,
  recoverySession,
  releaseRecoverySession,
  type HeldRecovery,
} from "../auth/redirect.ts";
import { resetTestid } from "../auth/testids.ts";
import { confirmProblem, newPasswordProblem } from "../auth/validation.ts";
import {
  AUTH_MESSAGES,
  AuthError,
  adoptSession,
  refreshSession,
  sessionNearExpiry,
  updatePassword,
} from "../net/auth.ts";
import { loginPath, navigate, paths } from "../net/navigate.ts";
import { forgetPendingAddresses, readSession, type Session } from "../net/session.ts";
import { BackLink } from "./nav.tsx";

import "../auth/auth.css";
import "../auth/tavern.css";

export { resetTestid };

function requestNewLink(): void {
  abandonRecoverySession();
  navigate(loginPath({ mode: "forgot" }));
}

function backToSignIn(): void {
  abandonRecoverySession();
  navigate(paths.login);
}

/** Whether the browser's Back or Forward button loaded this document (not a restore from its cache). */
function loadedFromHistory(): boolean {
  try {
    const [entry] = performance.getEntriesByType("navigation");
    return (entry as PerformanceNavigationTiming | undefined)?.type === "back_forward";
  } catch {
    return false;
  }
}

/**
 * The session this screen may use. A document the Back or Forward button loaded afresh can only
 * have reached this screen by coming back to it after leaving the page, so a session still in the
 * tab's storage then was abandoned, not reloaded.
 */
function heldForThisScreen(): HeldRecovery | null {
  if (loadedFromHistory()) {
    abandonRecoverySession();
    return null;
  }
  return recoverySession();
}

export default function ResetPasswordRoute(): ReactElement {
  // Taken once, into the screen's own state: nothing re-opens it once the screen lets it go.
  const [held, setHeld] = useState(heldForThisScreen);
  /** The session to send with: the link's, or its renewal once it has been renewed (R194). */
  const sessionRef = useRef<Session | null>(held?.session ?? null);

  useEffect(() => {
    if (held === null) return;
    // Held while mounted, and abandoned the moment the screen is left unsaved. StrictMode's
    // rehearsal unmount schedules the abandonment and this mount calls it off.
    keepRecoverySession();
    holdRecoverySession(sessionRef.current ?? held.session, held.email);
    const onPageHide = (event: PageTransitionEvent): void => {
      // Into the back/forward cache: the page was left for another. A reload is not persisted.
      if (event.persisted) abandonRecoverySession();
    };
    const onPageShow = (event: PageTransitionEvent): void => {
      if (!event.persisted) return;
      const next = recoverySession();
      sessionRef.current = next?.session ?? null;
      setHeld(next);
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      // After a save the session is already the stored one and nothing is held: this is a no-op.
      abandonRecoverySessionSoon();
    };
  }, [held]);
  /** An exit pressed while the link still works: where it goes, once the player confirms. */
  const [leaving, setLeaving] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkSpent, setLinkSpent] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  /** The address this browser is signed in as now, when it is not the one being reset. */
  const [replaced] = useState(() => {
    const current = readSession();
    const currentEmail = current === null ? null : emailFromToken(current.accessToken);
    const resetEmail = held?.email ?? null;
    if (currentEmail === null || resetEmail === null) return null;
    return currentEmail.trim().toLowerCase() === resetEmail.trim().toLowerCase() ? null : currentEmail;
  });

  if (held === null) {
    return (
      <div className="app-shell auth-screen tavern" data-testid={resetTestid.screen}>
        <BackLink onLeave={abandonRecoverySession} />
        <section className="panel panel--auth panel--split">
          <div className="auth-board__head">
            <div className="brand">
              <h1>JackiOh</h1>
            </div>
            <h2>Reset your password</h2>
          </div>
          <div className="auth-board__body">
            <div className="auth-no-link" data-testid={resetTestid.noLink}>
              <p className="notice" role="status">
                This page needs the link from a password reset email. It may have been opened
                already, in another tab, or left without saving. Ask for a new one, or sign in if
                you remember your password.
              </p>
              <div className="auth-actions">
                <button
                  type="button"
                  className="button-primary"
                  data-testid={resetTestid.requestNew}
                  onClick={requestNewLink}
                >
                  Email me a new link
                </button>
                <button
                  type="button"
                  className="link-button"
                  data-testid={resetTestid.backToSignIn}
                  onClick={backToSignIn}
                >
                  Back to sign in
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    );
  }

  const recovery = held;

  /**
   * One renewal of the held session with its own refresh token (R194), kept as the held session so
   * a reload or a second try uses the new one: the provider rotates refresh tokens and treats a
   * reused one as stolen. A renewal the provider refuses means the link's session is over.
   */
  async function renewed(session: Session): Promise<Session | null> {
    const refreshToken = typeof session.refreshToken === "string" && session.refreshToken.length > 0 ? session.refreshToken : null;
    if (refreshToken === null) return null;
    let next: Session;
    try {
      next = await refreshSession(refreshToken);
    } catch (cause) {
      if (cause instanceof AuthError && cause.failure === "sessionEnded") throw new AuthError("linkExpired");
      throw cause;
    }
    sessionRef.current = next;
    holdRecoverySession(next, recovery.email);
    return next;
  }

  /**
   * Sends the new password with the held session, renewed first when it is about to run out, and
   * renewed and sent once more when the provider refuses its access token. Resolves with the
   * session that set it.
   */
  async function save(newPassword: string): Promise<Session> {
    let session = sessionRef.current ?? recovery.session;
    let renewedOnce = false;
    if (sessionNearExpiry(session, Date.now())) {
      const next = await renewed(session);
      if (next !== null) {
        session = next;
        renewedOnce = true;
      }
    }
    try {
      await updatePassword(session.accessToken, newPassword);
      return session;
    } catch (cause) {
      if (renewedOnce || !(cause instanceof AuthError && cause.failure === "linkExpired")) throw cause;
      const next = await renewed(session);
      if (next === null) throw cause;
      await updatePassword(next.accessToken, newPassword);
      return next;
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (busy) return;

    const nextPasswordError = newPasswordProblem(password);
    const nextConfirmError = confirmProblem(password, confirm);
    setPasswordError(nextPasswordError);
    setConfirmError(nextConfirmError);
    if (nextPasswordError !== null || nextConfirmError !== null) {
      // The first field to fix, for a keyboard or a screen reader.
      document.getElementById(nextPasswordError !== null ? "reset-password" : "reset-confirm")?.focus();
      return;
    }

    setBusy(true);
    setError(null);
    setLeaving(null);
    save(password)
      .then((session) => {
        // Only now does the recovery session become the stored one (R193), and the session it
        // replaces is revoked, as the screen said it would be (R194).
        adoptSession(session);
        releaseRecoverySession();
        forgetPendingAddresses();
        navigate(paths.decks);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof AuthError ? cause.message : AUTH_MESSAGES.service);
        if (cause instanceof AuthError && cause.failure === "linkExpired") setLinkSpent(true);
      })
      .finally(() => {
        setBusy(false);
      });
  }

  /**
   * An exit from the form. While the link still works, leaving spends it, so the screen asks first;
   * a link the provider has already refused has nothing left to lose.
   */
  function exitTo(target: string): void {
    if (linkSpent) {
      abandonRecoverySession();
      navigate(target);
      return;
    }
    setLeaving(target);
  }

  function confirmLeave(): void {
    if (leaving === null) return;
    const target = leaving;
    abandonRecoverySession();
    navigate(target);
  }

  return (
    <div className="app-shell auth-screen tavern" data-testid={resetTestid.screen}>
      <BackLink
        onPress={() => {
          exitTo(paths.landing);
        }}
      />
      <section className="panel panel--auth panel--split">
        <div className="auth-board__head">
          <div className="brand">
            <h1>JackiOh</h1>
          </div>
          <h2>Choose a new password</h2>

          {leaving === null ? null : (
            <div className="auth-link-error" data-testid={resetTestid.leaveConfirm} role="alert">
              <p className="notice">
                Leave without saving? The link in your email works only once, so you would need to ask
                for a new one.
              </p>
              <div className="auth-actions">
                <button
                  type="button"
                  className="button-primary"
                  data-testid={resetTestid.stay}
                  onClick={() => {
                    setLeaving(null);
                  }}
                >
                  Stay and choose a password
                </button>
                <button type="button" className="link-button" data-testid={resetTestid.leave} onClick={confirmLeave}>
                  Leave without saving
                </button>
              </div>
            </div>
          )}

          <p className="auth-hint">
            For{" "}
            <strong data-testid={resetTestid.email}>
              {recovery.email === null ? "your account" : <Address value={recovery.email} />}
            </strong>
          </p>
          {replaced === null ? null : (
            // Never silently: saving makes the reset account this browser's session (R193).
            <p className="auth-hint" data-testid={resetTestid.replaces}>
              Saving signs this browser out of{" "}
              <strong>
                <Address value={replaced} />
              </strong>
              .
            </p>
          )}
        </div>

        <div className="auth-board__body">
          <form className="form-card" data-testid={resetTestid.form} onSubmit={onSubmit} noValidate>
            {/* The account the new password belongs to, for a password manager to save it against. */}
            <input
              type="email"
              name="username"
              autoComplete="username"
              data-testid={resetTestid.username}
              value={recovery.email ?? ""}
              readOnly
              hidden
            />
            <label htmlFor="reset-password">New password</label>
            <div className="input-with-affix">
              <input
                id="reset-password"
                data-testid={resetTestid.password}
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={password}
                aria-invalid={passwordError !== null}
                aria-describedby={passwordError !== null ? "reset-password-error" : undefined}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setPasswordError(null);
                }}
              />
              <button
                type="button"
                className="affix-button"
                data-testid={resetTestid.togglePassword}
                // One toggle shows or hides both fields, so the two can be compared by eye.
                aria-label={showPassword ? "Hide passwords" : "Show passwords"}
                aria-pressed={showPassword}
                onClick={() => {
                  setShowPassword((shown) => !shown);
                }}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
            {passwordError !== null ? (
              <p id="reset-password-error" className="auth-field-error" data-testid={resetTestid.passwordError}>
                {passwordError}
              </p>
            ) : null}

            <label htmlFor="reset-confirm">Type it again</label>
            <input
              id="reset-confirm"
              data-testid={resetTestid.confirm}
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={confirm}
              aria-invalid={confirmError !== null}
              aria-describedby={confirmError !== null ? "reset-confirm-error" : undefined}
              onChange={(event) => {
                setConfirm(event.target.value);
                setConfirmError(null);
              }}
            />
            {confirmError !== null ? (
              <p id="reset-confirm-error" className="auth-field-error" data-testid={resetTestid.confirmError}>
                {confirmError}
              </p>
            ) : null}

            <button type="submit" data-testid={resetTestid.submit} disabled={busy}>
              {busy ? "Saving…" : "Save new password"}
            </button>
          </form>

          {error !== null ? (
            <p className="notice" data-testid={resetTestid.error} role="alert">
              {error}
            </p>
          ) : null}

          <div className="auth-links">
            {linkSpent ? (
              <button
                type="button"
                className="link-button"
                data-testid={resetTestid.requestNew}
                onClick={requestNewLink}
              >
                Email me a new link
              </button>
            ) : null}
            <button
              type="button"
              className="link-button"
              data-testid={resetTestid.backToSignIn}
              onClick={() => {
                exitTo(paths.login);
              }}
            >
              Back to sign in
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
