// `/login` — email and password, and nothing else (SPEC §9.4: "Managed auth provider").
//
// NO SPEC DRIVES THIS SCREEN. The M8 suite never signs in through the UI: specs 05, 06, 09 and 10
// seed `localStorage["jackioh.e2e.session"]` in `cy.visit`'s `onBeforeLoad` because ASSUMPTION A6
// promises the fixture accounts carry ready-made tokens. So this screen is deliberately small: it
// is the door `/decks`, `/play` and `/match/<id>` send an anonymous visitor to, and the one place a
// real session is written.
//
// The refusal is the server's, relayed verbatim (`ApiRequestError` carries `code` and `message`
// untouched). Nothing here decides whether a password is wrong, whether an email is verified, or
// whether the account is pending — `/api/auth/me` answers the last of those and the gate in
// `main.tsx` acts on it.

import { useState, type FormEvent, type ReactElement } from "react";

import { ApiRequestError, signIn } from "../net/api.ts";
import { navigate, paths } from "../net/navigate.ts";
import { writeSession } from "../net/session.ts";

/** Chrome this screen invented; none of it is in `e2e/support/testids.ts` (no spec drives it). */
export const loginTestid = {
  form: "login-form",
  email: "login-email",
  password: "login-password",
  submit: "login-submit",
  error: "login-error",
} as const;

export default function LoginRoute(): ReactElement {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);

    signIn(email, password)
      .then((response) => {
        writeSession({
          accessToken: response.session.accessToken,
          refreshToken: response.session.refreshToken,
          expiresAt: response.session.expiresAt,
        });
        // `/decks` is the first gated screen; a pending account is bounced on to `/invite` from
        // there by the one gate in `main.tsx`, so this file needs no notion of account status.
        navigate(paths.decks, { replace: true });
      })
      .catch((cause: unknown) => {
        setError(
          cause instanceof ApiRequestError || cause instanceof Error
            ? cause.message
            : String(cause),
        );
      })
      .finally(() => {
        setBusy(false);
      });
  }

  return (
    <div className="app-shell">
      <h1>JackiOh — sign in</h1>

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
          autoComplete="current-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />

        <button type="submit" data-testid={loginTestid.submit} disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>

      {error !== null ? (
        <p className="notice" data-testid={loginTestid.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
