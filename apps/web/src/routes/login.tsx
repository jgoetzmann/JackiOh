// `/login` — email and password, against the auth provider directly (SPEC §9.2's first arrow out
// of the browser). `net/auth.ts` is the only thing here that talks to it; this file is the form.
//
// NO SPEC DRIVES THIS SCREEN'S CHROME. The M8 suite never signs in through the UI: specs 05, 06,
// 09 and 10 seed `localStorage["jackioh.e2e.session"]` in `cy.visit`'s `onBeforeLoad` because
// ASSUMPTION A6 promises the fixture accounts carry ready-made tokens. So the layout is small and
// the testids below are this screen's own invention.
//
// WHAT IT DOES NOT DECIDE. Nothing here judges whether a password is wrong, whether an email is
// verified, or whether the account is pending: `net/auth.ts` reduces every refusal to R160's one
// message per endpoint, `/api/auth/me` answers the status, and the gate in `main.tsx` acts on it.
// Signing in sends the player to `/decks`; a pending account is bounced on to `/invite` from there.

import { useState, type FormEvent, type ReactElement } from "react";

import { AuthError, signIn, signUp } from "../net/auth.ts";
import { navigate, paths } from "../net/navigate.ts";
import { writeSession } from "../net/session.ts";

/** Chrome this screen invented; none of it is in `e2e/support/testids.ts` (no spec drives it). */
export const loginTestid = {
  form: "login-form",
  email: "login-email",
  password: "login-password",
  submit: "login-submit",
  error: "login-error",
  mode: "login-mode",
  notice: "login-notice",
} as const;

type Mode = "signIn" | "signUp";

export default function LoginRoute(): ReactElement {
  const [mode, setMode] = useState<Mode>("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);

    const done = (): void => {
      setBusy(false);
    };
    const failed = (cause: unknown): void => {
      // `AuthError` messages are already R160-safe; anything else is a network or programming
      // fault and is shown as itself.
      setError(cause instanceof AuthError || cause instanceof Error ? cause.message : String(cause));
    };

    if (mode === "signUp") {
      signUp(email, password)
        .then(() => {
          // §9.4 step 1 requires a verified email before a code can be redeemed, so the next step
          // is the inbox, not the game. Said identically whether or not the address was already
          // registered -- see `signUp`'s note on why the provider makes that true for free.
          setNotice("Check your email for a confirmation link, then sign in.");
          setMode("signIn");
          setPassword("");
        })
        .catch(failed)
        .finally(done);
      return;
    }

    signIn(email, password)
      .then((result) => {
        writeSession(result.session);
        // `/decks` is the first gated screen; the one gate in `main.tsx` redirects from there, so
        // this file needs no notion of account status.
        navigate(paths.decks, { replace: true });
      })
      .catch(failed)
      .finally(done);
  }

  const signingUp = mode === "signUp";

  return (
    <div className="app-shell">
      <h1>JackiOh — {signingUp ? "create an account" : "sign in"}</h1>

      <form className="form-card" data-testid={loginTestid.form} onSubmit={onSubmit}>
        <label htmlFor="login-email">Email</label>
        <input
          id="login-email"
          data-testid={loginTestid.email}
          type="email"
          autoComplete="username"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
        />

        <label htmlFor="login-password">Password</label>
        <input
          id="login-password"
          data-testid={loginTestid.password}
          type="password"
          autoComplete={signingUp ? "new-password" : "current-password"}
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />

        <button type="submit" data-testid={loginTestid.submit} disabled={busy}>
          {busy
            ? signingUp
              ? "Creating…"
              : "Signing in…"
            : signingUp
              ? "Create account"
              : "Sign in"}
        </button>
      </form>

      <button
        type="button"
        className="link-button"
        data-testid={loginTestid.mode}
        onClick={() => {
          setMode(signingUp ? "signIn" : "signUp");
          setError(null);
          setNotice(null);
        }}
      >
        {signingUp ? "Already have an account? Sign in" : "No account? Create one"}
      </button>

      {notice !== null ? (
        <p className="notice" data-testid={loginTestid.notice} role="status">
          {notice}
        </p>
      ) : null}

      {error !== null ? (
        <p className="notice" data-testid={loginTestid.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
