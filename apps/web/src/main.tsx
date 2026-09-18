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
const MatchRoute = lazy(() => import("./routes/match.tsx"));

const DEV_ONLY = import.meta.env.MODE !== "production";

/** Chrome this file invented: the gate's two holding panels. No spec asserts on them. */
export const shellTestid = {
  loading: "gate-loading",
  error: "gate-error",
} as const;

function Landing(): ReactElement {
  return (
    <div className="app-shell">
      <h1>JackiOh</h1>
      <p className="notice">
        <a href={paths.play}>Play</a> a networked match, edit your <a href={paths.decks}>decks</a>,
        or open <code>/dev/hotseat?seed=42&amp;a=first20&amp;b=first20</code> to play both seats on
        one device.
      </p>
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
}
