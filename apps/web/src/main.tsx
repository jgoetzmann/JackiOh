// Entry point and the route table. The client is a `PlayerView` renderer (CLAUDE.md rule 7, SPEC
// §10.8): this file picks a route, applies §9.4's gate once, and gets out of the way.
//
// Routing is still a pathname switch rather than a router dependency, but the pathname now comes
// from `usePathname()` (`net/navigate.ts`) instead of being read once at boot, because a redirect
// has to re-render: `cy.location("pathname")` in specs 09 and 10 reads the real URL, so the gate
// moves the URL with `history.replaceState` and this component follows it.
//
// THE GATE IS UX, NOT SECURITY. SPEC §9.4: "A pending account can log in, verify its email and see
// the code screen, and nothing else: no collection, loadout, queue or match." The server is what
// enforces that — every endpoint but `/api/auth/me` and `/api/codes/*` is declared `auth: "active"`
// and answers 403 `account_pending`, and `wsServer.ts` runs the same `assertActive` on the upgrade.
// What `Gated` does is read `GET /api/auth/me`, the endpoint §9.4 provides precisely so "the client
// knows to show the code screen", and send the browser to the screen that will actually work. It
// lives in exactly one place so there is one thing to change when §9.4 grows a status.

import { StrictMode, Suspense, lazy, useEffect, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

import { useAccount, type Account } from "./net/gate.ts";
import { matchIdOf, navigate, paths, usePathname } from "./net/navigate.ts";
import type { MeResponse } from "./net/api.ts";

import "./index.css";

const HotseatRoute = lazy(() => import("./routes/dev/hotseat.tsx"));
const LoginRoute = lazy(() => import("./routes/login.tsx"));
const InviteRoute = lazy(() => import("./routes/invite.tsx"));
const DecksRoute = lazy(() => import("./routes/decks.tsx"));
const PlayRoute = lazy(() => import("./routes/play.tsx"));
const AccountRoute = lazy(() => import("./routes/account.tsx"));
const MatchRoute = lazy(() => import("./routes/match.tsx"));

const DEV_ONLY = import.meta.env.MODE !== "production";

/** Chrome this file invented: the gate's two holding panels. No spec asserts on them. */
export const shellTestid = {
  loading: "gate-loading",
  error: "gate-error",
} as const;

function Landing(): ReactElement {
  // The landing is not gated, so it asks for itself. `useAccount` answers `loading` first, and
  // rendering nothing for that beat avoids flashing "Sign in" at somebody who already is.
  const account = useAccount();
  const signedIn = account.kind === "ready";

  return (
    <div className="app-shell">
      <nav className="row screen-nav screen-nav--end">
        {account.kind === "loading" ? null : signedIn ? (
          <a className="button-secondary" href={paths.account} data-testid="landing-account">
            Account
          </a>
        ) : (
          <a className="button-secondary" href={paths.login} data-testid="landing-sign-in">
            Sign in
          </a>
        )}
      </nav>

      <div className="hero">
        <div className="brand">
          <h1>JackiOh</h1>
          <span className="tagline">a 1v1 card game</span>
        </div>
        <p className="lede">
          Hearthstone-style mana and combat on Yu-Gi-Oh-style lanes, with a hidden trap backrow.
        </p>
        <div className="row">
          <a className="button-primary" href={paths.play} role="button">
            Play a match
          </a>
          <a className="button-secondary" href={paths.decks} role="button">
            Build decks
          </a>
        </div>
      </div>

      <div className="card-grid">
        <section className="panel">
          <h2>Play</h2>
          <p>Queue for a ranked match, or make a room code and send it to someone.</p>
          <a href={paths.play}>Find a game →</a>
        </section>
        <section className="panel">
          <h2>Decks</h2>
          <p>Three decks, twenty cards each, singleton — no card twice and none shared between decks.</p>
          <a href={paths.decks}>Edit your decks →</a>
        </section>
        {DEV_ONLY ? (
          // Dev-only, and it really is absent in production: main.tsx serves NotFound for
          // /dev/hotseat when MODE is production, so a link here would 404 on a deploy.
          <section className="panel">
            <h2>Hotseat</h2>
            <p>Both seats on one device. No account, no server — it runs the engine in the tab.</p>
            <a href={`${paths.hotseat}?seed=42&a=first20&b=first20`}>Open hotseat →</a>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function NotFound({ path }: { path: string }): ReactElement {
  return (
    <div className="app-shell">
      <h1>JackiOh</h1>
      <p className="notice">
        No route for <code>{path}</code>.
      </p>
    </div>
  );
}

function Loading({ what }: { what: string }): ReactElement {
  return (
    <div className="app-shell">
      <h1>JackiOh</h1>
      <p className="notice" data-testid={shellTestid.loading} role="status">
        {what}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The gate (SPEC §9.4)
// ---------------------------------------------------------------------------------------------

export type ReadyAccount = { token: string; me: MeResponse };

export type GatedProps = {
  /**
   * `/invite` is the one screen a pending account may see, so it opens the gate to both statuses.
   * Everything else is `active`-only.
   */
  allowPending?: boolean;
  children: (account: ReadyAccount) => ReactElement;
};

/** Where a given account belongs, or null when it may stay where it is. */
export function redirectFor(account: Account, allowPending: boolean): string | null {
  if (account.kind === "anonymous") return paths.login;
  if (account.kind === "ready" && account.me.profile.status === "pending" && !allowPending) {
    return paths.invite;
  }
  return null;
}

export function Gated({ allowPending = false, children }: GatedProps): ReactElement {
  const account = useAccount();
  const target = redirectFor(account, allowPending);

  // In an effect, never during render: `navigate` dispatches an event that re-renders every
  // `usePathname` subscriber, and doing that while this component is rendering would be an update
  // during render.
  useEffect(() => {
    if (target !== null) navigate(target, { replace: true });
  }, [target]);

  if (account.kind === "loading") return <Loading what="Checking your account…" />;
  if (account.kind === "anonymous") return <Loading what="Sign in to continue." />;
  if (account.kind === "error") {
    return (
      <div className="app-shell">
        <h1>JackiOh</h1>
        <p className="notice" data-testid={shellTestid.error} role="alert">
          {account.message}
        </p>
      </div>
    );
  }

  const status = account.me.profile.status;
  if (status === "pending" && !allowPending) return <Loading what="Redeem an invite code first." />;
  if (status === "banned") {
    // Not in SPEC, and no R-row: §9.4 has three statuses and names a screen for two of them. This
    // is a terminal message, not a decision — the server already refuses a banned account at every
    // door (R145 reports it distinctly, because it depends on the caller's own account and leaks
    // nothing), so nothing downstream rides on what this screen says and there is no rule to state.
    return (
      <div className="app-shell">
        <h1>JackiOh</h1>
        <p className="notice" data-testid={shellTestid.error} role="alert">
          This account is banned.
        </p>
      </div>
    );
  }

  return children({ token: account.token, me: account.me });
}

// ---------------------------------------------------------------------------------------------
// The route table
// ---------------------------------------------------------------------------------------------

export function App(): ReactElement {
  const path = usePathname();

  const route = ((): ReactElement => {
    if (path === paths.landing) return <Landing />;
    if (path === paths.login) return <LoginRoute />;
    if (path === paths.invite) return <Gated allowPending>{() => <InviteRoute />}</Gated>;
    if (path === paths.decks) return <Gated>{() => <DecksRoute />}</Gated>;
    if (path === paths.play) return <Gated>{(account) => <PlayRoute token={account.token} />}</Gated>;
    // `allowPending`: a pending account still has an email, a status and a way to sign out,
    // and being unable to sign out of the screen that tells you to redeem a code is the trap
    // this route exists to remove.
    if (path === paths.account) {
      return (
        <Gated allowPending>{(account) => <AccountRoute token={account.token} />}</Gated>
      );
    }

    const matchId = matchIdOf(path);
    if (matchId !== null) {
      return (
        <Gated>
          {(account) => <MatchRoute matchId={matchId} token={account.token} />}
        </Gated>
      );
    }

    if (path === paths.hotseat) {
      if (!DEV_ONLY) return <NotFound path={path} />;
      return <HotseatRoute />;
    }
    return <NotFound path={path} />;
  })();

  return <Suspense fallback={<Loading what="Loading…" />}>{route}</Suspense>;
}

/**
 * `index.html` loads this module as its only script, so the mount is a module side effect.
 *
 * Vitest imports the module to reach `App`, `Gated` and `redirectFor`, and a second React root
 * mounted into the test's own document would duplicate every query and every `/api/auth/me` round
 * trip. `MODE` is `"test"` only under vitest (`routes/gate.test.tsx` asserts it, so a change in
 * vitest's default fails there rather than silently double-mounting here).
 */
if (import.meta.env.MODE !== "test") {
  const host = document.getElementById("root");
  if (host === null) throw new Error("index.html is missing #root");

  createRoot(host).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  // Polish 2: UI ticks and the audio unlock on every screen, off the first paint (audio/appAudio.ts).
  void import("./audio/appAudio.ts").then((audio) => audio.retainAppAudio());
}
