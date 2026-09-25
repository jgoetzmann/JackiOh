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
//
// NO DEAD ENDS (docs/polish/5-sign-in.md, B40). Every panel this file draws itself — the gate's
// error, the banned account, the 404, a screen whose code failed to load, and a check that is
// taking too long — offers a way out: home, sign out, and try again where trying again can help.
// The landing page is `routes/landing.tsx`, imported statically because it is the first screen most
// visits see. The panels sit in the same tavern frame as the sign-in screens (`auth/tavern.css`),
// since they are the waypoints between the landing and those screens.
//
// ONE GATE PER SCREEN. Every gated route renders `<Gated>` at the same place in the tree, so React
// would reuse one instance (and the account it read) across in-app moves: a redemption on
// `/invite` went on to `/decks` still holding the "pending" account it read before, and bounced
// straight back. Each route's gate is keyed by its path, so a move re-reads `/api/auth/me`.
//
// ONE SOCKET PER SESSION (R194). The gate renews a session shortly before its token expires and
// hands the new token down. The match screen is keyed by the provider session the token belongs to,
// so a renewal of the same session keeps its socket (the new token waits for the next reconnect),
// and only a different session, or account, opens a new one.
//
// EMAILED LINKS ON ANY PATH (R193). Before the route switch runs, a link is scrubbed from the
// address bar, on `/login` too (whose screen is a lazy chunk that may be slow or fail to load), and
// one that landed anywhere else (Supabase's Site URL fallback) is handed to `/login`.

import {
  Component,
  StrictMode,
  Suspense,
  lazy,
  useEffect,
  useState,
  type ErrorInfo,
  type ReactElement,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";

import { GATE_SLOW_NOTICE_SECONDS } from "../../server/src/config.ts";
import { useSecondsUntil } from "./auth/cooldown.ts";
import { adoptAuthRedirect, sessionIdFromToken } from "./auth/redirect.ts";
import { shellTestid } from "./auth/testids.ts";
import { useAccount, type Account } from "./net/gate.ts";
import { currentPath, loginPath, matchIdOf, navigate, paths, seriesIdOf, usePathname } from "./net/navigate.ts";
import { rememberReturnTo } from "./net/return-to.ts";
import { readSession } from "./net/session.ts";
import type { MeResponse } from "./net/api.ts";
// Static, not lazy: the gate's own panels offer "Sign out", which must work synchronously from a
// screen that failed to load anything else, so account.tsx is in the entry chunk either way.
import AccountRoute, { signOut, signOutLabel, useSigningOut } from "./routes/account.tsx";
import LandingRoute from "./routes/landing.tsx";
import { followInApp } from "./routes/nav.tsx";
import { readSettings } from "./settings/store.ts";

import "./index.css";
import "./auth/tavern.css";

const HotseatRoute = lazy(() => import("./routes/dev/hotseat.tsx"));
const LoginRoute = lazy(() => import("./routes/login.tsx"));
const ResetPasswordRoute = lazy(() => import("./routes/reset-password.tsx"));
const InviteRoute = lazy(() => import("./routes/invite.tsx"));
const DecksRoute = lazy(() => import("./routes/decks.tsx"));
const PlayRoute = lazy(() => import("./routes/play.tsx"));
const MatchRoute = lazy(() => import("./routes/match.tsx"));
const SeriesRoute = lazy(() => import("./routes/series.tsx"));
const PracticeRoute = lazy(() => import("./routes/practice.tsx"));

const DEV_ONLY = import.meta.env.MODE !== "production";

/**
 * Chrome this file invented: the gate's holding panels, their exits and the 404. The names live in
 * `auth/testids.ts` so Cypress specs can import them; re-exported here so existing imports keep
 * working.
 */
export { shellTestid };

/** The frame every panel this file draws sits in: the wordmark on the tavern board. */
function ShellPanel({ testId, children }: { testId?: string; children: ReactNode }): ReactElement {
  return (
    <div className="app-shell tavern shell-panel" data-testid={testId}>
      <section className="panel panel--auth">
        <div className="brand">
          <h1>JackiOh</h1>
        </div>
        {children}
      </section>
    </div>
  );
}

/** "Home": back to the landing page, in place on a plain click and a real link otherwise. */
function HomeLink({ testId, label = "Home" }: { testId: string; label?: string }): ReactElement {
  return (
    <a
      className="button-secondary"
      href={paths.landing}
      data-testid={testId}
      onClick={followInApp(paths.landing)}
    >
      {label}
    </a>
  );
}

/** "Sign out": `routes/account.tsx` clears the device, revokes the session and reloads `/`. */
function SignOutButton(): ReactElement {
  const leaving = useSigningOut();
  return (
    <button
      type="button"
      data-testid={shellTestid.signOut}
      disabled={leaving}
      aria-busy={leaving}
      onClick={() => {
        signOut();
      }}
    >
      {signOutLabel(leaving)}
    </button>
  );
}

/** A path the client serves nothing at. Said in a player's words; the path is shown, never followed. */
function NotFound({ path }: { path: string }): ReactElement {
  return (
    <ShellPanel testId={shellTestid.notFound}>
      <p className="notice">That page doesn&rsquo;t exist.</p>
      <p className="auth-hint">
        There is nothing at <code>{path}</code>. The link may be wrong or out of date.
      </p>
      <div className="row">
        <HomeLink testId={shellTestid.notFoundHome} label="Back to the start" />
      </div>
    </ShellPanel>
  );
}

/**
 * A holding panel. With `slow`, a wait that runs past `GATE_SLOW_NOTICE_SECONDS` says why it may
 * be slow (Render's free tier sleeps and takes about a minute to wake) and offers the way out, so a
 * server or network that never answers is not a trap.
 */
function Loading({ what, slow = false }: { what: string; slow?: boolean }): ReactElement {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!slow) return;
    const timer = window.setTimeout(() => {
      setLate(true);
    }, GATE_SLOW_NOTICE_SECONDS * 1000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [slow]);

  return (
    <ShellPanel>
      <p className="notice shell-panel__loading" data-testid={shellTestid.loading} role="status">
        {what}
      </p>
      {late ? (
        <>
          <p className="notice" data-testid={shellTestid.slow}>
            This is taking a while. The server may be waking up, which can take up to a minute.
          </p>
          <div className="row">
            <HomeLink testId={shellTestid.home} />
            {readSession() === null ? null : <SignOutButton />}
          </div>
        </>
      ) : null}
    </ShellPanel>
  );
}

/**
 * Seconds left of a stated wait, from when it was stated: counted on the clock, so a tab the
 * browser put to sleep does not come back still waiting (`auth/cooldown.ts`). 0 when there is none.
 */
function useCountdown(totalMs: number | undefined): number {
  const [deadline, setDeadline] = useState(() => (totalMs === undefined ? null : Date.now() + totalMs));
  const [stated, setStated] = useState(totalMs);
  if (stated !== totalMs) {
    // A new wait was stated: counted from now.
    setStated(totalMs);
    setDeadline(totalMs === undefined ? null : Date.now() + totalMs);
  }
  return useSecondsUntil(deadline);
}

/** The gate's error panel: the sentence, and the three ways on. A stated wait holds the retry. */
function GateError({ account }: { account: Extract<Account, { kind: "error" }> }): ReactElement {
  const wait = useCountdown(account.retryAfterMs);
  return (
    <ShellPanel>
      <p className="notice" data-testid={shellTestid.error} role="alert">
        {account.message}
        {wait > 0 ? ` You can try again in ${String(wait)} s.` : null}
      </p>
      <div className="row">
        <button
          type="button"
          className="button-primary"
          data-testid={shellTestid.retry}
          disabled={wait > 0}
          onClick={() => {
            // Re-reads /api/auth/me in place, without a page load.
            account.retry?.();
          }}
        >
          {wait > 0 ? `Try again in ${String(wait)} s` : "Try again"}
        </button>
        <HomeLink testId={shellTestid.home} />
        <SignOutButton />
      </div>
    </ShellPanel>
  );
}

/**
 * A screen whose code could not be loaded. Every route but the landing page is a lazy chunk, and a
 * chunk fails on a flaky network, and after every deploy for a tab left open (the old hashed file is
 * gone, and the host answers the request with `index.html`). Without this the whole root unmounted
 * to a blank page. A reload fetches the current build; the home link is a real page load too.
 */
type LoadFailedState = { failed: boolean };

export class RouteErrorBoundary extends Component<{ children: ReactNode }, LoadFailedState> {
  override state: LoadFailedState = { failed: false };

  static getDerivedStateFromError(): LoadFailedState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Kept for whoever opens the console; the player gets the panel below.
    console.error("A screen failed to load", error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <ShellPanel testId={shellTestid.loadFailed}>
        <p className="notice" role="alert">
          This screen didn&rsquo;t load. Check your connection, then reload the page.
        </p>
        <div className="row">
          <button
            type="button"
            className="button-primary"
            data-testid={shellTestid.reload}
            onClick={() => {
              window.location.reload();
            }}
          >
            Reload
          </button>
          <a className="button-secondary" href={paths.landing} data-testid={shellTestid.loadFailedHome}>
            Home
          </a>
        </div>
      </ShellPanel>
    );
  }
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
  if (account.kind === "anonymous") {
    // A renewal the provider refused (R194) ended the session, and the sign-in screen says so.
    // The reason is the only thing ever put in that query (`loginPath`), never a destination.
    return account.reason === "expired" ? loginPath({ reason: "expired" }) : paths.login;
  }
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
    if (target === null) return;
    // Sent to sign in: the sign-in comes back to this screen (a fixed `paths` value, never a URL).
    if (account.kind === "anonymous") rememberReturnTo(currentPath());
    navigate(target, { replace: true });
  }, [target, account.kind]);

  if (account.kind === "loading") return <Loading what="Checking your account…" slow />;
  if (account.kind === "anonymous") return <Loading what="Sign in to continue." />;
  if (account.kind === "error") return <GateError account={account} />;

  const status = account.me.profile.status;
  if (status === "pending" && !allowPending) return <Loading what="Redeem an invite code first." />;
  if (status === "banned") {
    // Not in SPEC, and no R-row: §9.4 has three statuses and names a screen for two of them. This
    // is a terminal message, not a decision — the server already refuses a banned account at every
    // door (R145 reports it distinctly, because it depends on the caller's own account and leaks
    // nothing), so nothing downstream rides on what this screen says and there is no rule to state.
    return (
      <ShellPanel>
        <p className="notice" data-testid={shellTestid.error} role="alert">
          This account is banned.
        </p>
        <div className="row">
          <HomeLink testId={shellTestid.home} />
          <SignOutButton />
        </div>
      </ShellPanel>
    );
  }

  return children({ token: account.token, me: account.me });
}

// ---------------------------------------------------------------------------------------------
// The route table
// ---------------------------------------------------------------------------------------------

/**
 * The provider session a token belongs to (its `session_id` claim), else the token itself (the
 * end-to-end fixtures name none, and never renew). See ONE SOCKET PER SESSION above.
 */
function sessionKeyOf(token: string): string {
  return sessionIdFromToken(token) ?? token;
}

export function App(): ReactElement {
  // Before the first read of the path: an emailed link is scrubbed, and moved to `/login` (R193).
  useState(() => adoptAuthRedirect(paths.login));
  const path = usePathname();

  const route = ((): ReactElement => {
    if (path === paths.landing) return <LandingRoute />;
    if (path === paths.login) return <LoginRoute />;
    if (path === paths.resetPassword) return <ResetPasswordRoute />;
    // `key={path}` on every gate: see ONE GATE PER SCREEN above.
    // The gate's own read of the account is handed down, so the code screen does not read it twice.
    if (path === paths.invite) {
      return <Gated key={path} allowPending>{(account) => <InviteRoute account={account} />}</Gated>;
    }
    if (path === paths.decks) return <Gated key={path}>{() => <DecksRoute />}</Gated>;
    if (path === paths.play) return <Gated key={path}>{(account) => <PlayRoute token={account.token} />}</Gated>;
    // `allowPending`: a pending account still has an email, a status and a way to sign out,
    // and being unable to sign out of the screen that tells you to redeem a code is the trap
    // this route exists to remove.
    if (path === paths.account) {
      return (
        <Gated key={path} allowPending>
          {(account) => <AccountRoute token={account.token} me={account.me} />}
        </Gated>
      );
    }

    if (path === paths.practice) return <PracticeRoute />;

    const matchId = matchIdOf(path);
    if (matchId !== null) {
      return (
        <Gated key={path}>
          {(account) => (
            <MatchRoute key={sessionKeyOf(account.token)} matchId={matchId} token={account.token} />
          )}
        </Gated>
      );
    }

    // R338: the Conquest series screen, behind the same gate as the board it leads to.
    const seriesId = seriesIdOf(path);
    if (seriesId !== null) {
      return <Gated key={path}>{(account) => <SeriesRoute seriesId={seriesId} token={account.token} />}</Gated>;
    }

    if (path === paths.hotseat) {
      if (!DEV_ONLY) return <NotFound path={path} />;
      return <HotseatRoute />;
    }
    return <NotFound path={path} />;
  })();

  // Keyed by the path, so moving to another screen clears a failed load's panel.
  return (
    <RouteErrorBoundary key={path}>
      <Suspense fallback={<Loading what="Loading…" slow />}>{route}</Suspense>
    </RouteErrorBoundary>
  );
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

  // The settings store's first read puts `data-reduce-motion` on <html> (index.css), so the player's
  // "Reduce motion" holds from the first paint of every screen, not only once a board has read it.
  readSettings();
  createRoot(host).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  // Polish 2: UI ticks and the audio unlock on every screen, off the first paint (audio/appAudio.ts).
  void import("./audio/appAudio.ts").then((audio) => audio.retainAppAudio());
}
