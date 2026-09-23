// `/invite` — the code screen a pending account sees (SPEC §9.4, BUILD M6-T1).
//
// THE ERROR IS NOT THIS FILE'S TO WRITE. §9.4: "Missing, expired and exhausted codes return an
// identical error in identical time", and §9.8 makes that a security property rather than a
// nicety — a different sentence for one of the three kinds tells a scanner that a guessed code
// exists. R145 draws the line: everything that depends on the *code* shares one sentence, while
// what depends on the *account* (already active, banned, unverified email) is reported distinctly.
// The client cannot keep that line by paraphrasing, so it does not paraphrase: whatever
// `POST /api/codes/redeem` refuses with is rendered exactly as the server wrote it.
//
// A RATE LIMIT IS REPORTED AS ONE (R192). A refusal at §9.4 step 2 or 3, or R109's API limit, is a
// 429 `rate_limited` whose sentence is shown verbatim like every other refusal, plus a panel saying
// how long to wait (`details.retryAfterMs`). Submit stays off for that long. A rate limit depends
// on the caller's own account or address, never on whether a code exists, so saying so leaks
// nothing R145 protects. The screen also shows how many tries `GET /api/codes/status` says the
// account has left, and reads it again after every refusal so the number never goes stale. While a
// 429 stands the count is hidden: a per-IP refusal (a shared network) leaves this account's own
// count full, and "6 tries left" beside "wait an hour" would contradict itself.
//
// NOTHING WAITS FOR A RELOAD. "No tries left" and "paused" each come with the wait the server
// stated (`attemptsRetryAfterMs`, `retryAfterMs`), and the status is read again when it runs out.
// Every stated wait (those two and a 429's) is held as a DEADLINE on the clock from when it was
// stated, and the sentence is read from the clock at each render, so it counts down ("about 12
// minutes" half an hour into a 42-minute wait). A sleeping phone freezes timers, so what the wait
// lifts is checked again the moment the page is shown (`visibilitychange`, `pageshow`, `focus`),
// not only when a timer fires.
//
// A 503 FROM A REDEMPTION IS A PAUSE. The server answers `unavailable` only while redemption is
// switched off (§9.4's breaker, or the database's own switch), so Redeem goes off at once and the
// status is read again to say for how long: pressing again would only spend another try.
//
// A REQUEST THIS SCREEN MAKES ITSELF follows R194 like the gate's: a redemption or a status read
// the API refuses as unauthorised (the token expired while the screen was open) renews the session
// once and is sent again (`callWithRenewal`). A status read that fails for any other reason keeps
// the last status it had, so "No tries left" never turns back into a live Redeem button. A 409
// means the account is no longer pending (another tab redeemed): the server's sentence is shown
// (R145) and the account is read again, which turns the screen into "already active" with the way
// on.
//
// ONE READ OF THE ACCOUNT. Inside the app the gate has already read `/api/auth/me` and hands its
// answer down (`account`), as it does the token for `/play` and `/account`; a second read of this
// screen's own left Redeem dead, with nothing said, for as long as a slow network took to answer.
// Rendered on its own (the unit tests), the screen reads the account itself.
//
// WHERE A CODE COMES FROM. A player learns online play is invite-only before they sign up (the
// landing page and the sign-up form say so), and this screen says where codes come from (the
// JackiOh team hands them out: there is no way for a player to hand one on) and offers Play vs AI,
// which needs none, for the meantime.
//
// A CODE THAT WORKED SAYS SO. Redeeming is the payoff of the whole way in, so it ends on its own
// board ("You're in", with the way on to the decks) rather than dropping the player, unannounced,
// onto an empty deckbuilder.
//
// A REFUSED CODE IS NOT SENT AGAIN UNCHANGED. A missing, expired or exhausted code (R145's one
// sentence) cannot turn good a second later, so pressing Redeem again with the same code would only
// spend another of the hour's tries, and a player who presses it "in case it didn't take" would lock
// the account (and their own real code) out for the hour. Redeem stays off until the code is
// changed, and the screen says why. The field is locked while a code is being redeemed, so the
// answer is always about the code on screen.
//
// AN UNVERIFIED EMAIL has a way forward here: §9.4 step 1 refuses a code until the address is
// confirmed, so the screen says so above the form (from `/api/auth/me`, or from that refusal),
// offers to send the confirmation again, and reads the account again on "Check again". That check
// is the screen's own read: it says "Checking…" while it runs, says so when the address is still
// unconfirmed (otherwise nothing on screen would change), and a check that cannot reach the server
// says that too, beside the typed code, instead of handing the whole screen to the gate's error.
//
// ONE ACCOUNT'S STATE. The screen's own state (the typed code, a refusal, a rate limit) belongs to
// the account it was for: when the device moves to another account (a sign-in in another tab, a
// saved reset), the screen starts again for the new one.
//
// THE CODE IS READ, NEVER GUESSED AT (R191). `CodeField` reads every keystroke and paste with
// `readCodeInput`, the function the server reads the submitted code with, and refuses a character
// the alphabet leaves out instead of dropping it. Submit is on only for a complete code, so a
// partial code never costs one of §9.4's attempts. What is submitted is exactly what the box shows.
//
// THE FORMAT IS CONFIG, NOT A LITERAL. Every number of `XXXX-XXXX-XXXX-XXXX`, the alphabet and the
// separator come from `apps/server/src/config.ts` through `INVITE_CODE_FORMAT` (CLAUDE.md rule 9),
// which is where R79/R104 put them and where `e2e/cypress/e2e/10-invite-gate.cy.ts` reads them.
//
// THE ROUTE STAYS REACHABLE FOR BOTH STATUSES. Spec 10 visits it while pending and expects to
// stay; an active account that arrives is told it needs no code rather than bounced, because
// redemption is the pending → active transition and an active account asking again is a 409, not
// one of the three code failures. And there is always a way out: back, and sign out.

import { useEffect, useRef, useState } from "react";

import { readCodeInput } from "@jackioh/shared";

import {
  AUTH_EMAIL_RESEND_COOLDOWN_SECONDS,
  CODE_ATTEMPT_WINDOW_SECONDS,
  CODE_STATUS_RECHECK_FLOOR_SECONDS,
} from "../../../server/src/config.ts";
import Address from "../auth/Address.tsx";
import CodeField from "../auth/CodeField.tsx";
import { deadlineAfter, useAddressCooldown, useSecondsUntil } from "../auth/cooldown.ts";
import { INVITE_CODE_FORMAT, attemptsText, waitInWords } from "../auth/codeInput.ts";
import { inviteTestid } from "../auth/testids.ts";
import {
  ApiRequestError,
  getCodeStatus,
  getMe,
  redeemCode,
  retryAfterMsOf,
  type CodeStatusResponse,
  type MeResponse,
} from "../net/api.ts";
import { AUTH_MESSAGES, AUTH_NOTICES, AuthError, resendConfirmation } from "../net/auth.ts";
import { announceAccountChange, callWithRenewal, useAccount, type Account } from "../net/gate.ts";
import { loginPath, navigate, paths } from "../net/navigate.ts";
import { pendingEmailEntry } from "../net/session.ts";
import { signOut, signOutLabel, useSigningOut } from "./account.tsx";
import { BackLink, followInApp } from "./nav.tsx";

import "../auth/tavern.css";

export { INVITE_CODE_GROUPS, INVITE_CODE_PLACEHOLDER } from "../auth/codeInput.ts";

export const INVITE_CODE_INPUT = inviteTestid.input;
export const INVITE_SUBMIT = inviteTestid.submit;
export const INVITE_ERROR = inviteTestid.error;
/** §9.4's circuit breaker is open: the screen says so instead of guessing after a 503. */
export const INVITE_PAUSED = inviteTestid.paused;
/** An active account reached the code screen; redemption is not for it. */
export const INVITE_NOT_NEEDED = inviteTestid.notNeeded;

/** What the input shows for `raw`: R191's reading, grouped and separated per §9.4. */
export function formatInviteCode(raw: string): string {
  return readCodeInput(raw, INVITE_CODE_FORMAT).formatted;
}

/** `setTimeout`'s own ceiling (a signed 32-bit millisecond count); a longer wait fires at once. */
const LONGEST_TIMER_MS = 2_147_483_647;
/** Unit conversions, not configuration. */
const MS_PER_SECOND = 1000;

/**
 * A rate-limited refusal (R192): the wait it stated (kept for `data-retry-after-ms`), and the
 * deadline that wait makes on the clock, or null for both when it stated none.
 */
type RateLimit = { retryAfterMs: number | null; until: number | null };

function isRateLimited(cause: unknown): cause is ApiRequestError {
  return cause instanceof ApiRequestError && (cause.status === 429 || cause.code === "rate_limited");
}

/** A redemption refused because redemption is switched off (see A 503 FROM A REDEMPTION). */
function isPausedRefusal(cause: unknown): boolean {
  return cause instanceof ApiRequestError && cause.status === 503 && cause.code === "unavailable";
}

/**
 * The `invite-rate-limited` panel's sentence, for the wait still left. It blames no one: step 2
 * counts this account and step 3 counts the address, and which of the two refused is not told
 * apart (`codes.ts`), so it names both, which also tells a player on a shared network why they are
 * waiting with tries of their own left. The server's own sentence sits in `invite-error` just above
 * and already says what happened, so this one line says who and when, not "too many" a second time.
 */
function waitText(leftMs: number | null): string {
  if (leftMs === null) return "This account or network can try again in a few minutes.";
  return `This account or network can try again in ${waitInWords(leftMs)}.`;
}

/** A status as it was read, and when (this device's clock), so its waits become deadlines. */
type StatusRead = { status: CodeStatusResponse; at: number };

/** The deadlines a status states: the breaker's reopening, and a try coming back. */
function statusDeadlines(read: StatusRead | null): { pausedUntil: number | null; triesBackAt: number | null } {
  if (read === null) return { pausedUntil: null, triesBackAt: null };
  const { status, at } = read;
  const pausedUntil = status.redemptionEnabled ? null : at + Math.max(0, status.retryAfterMs);
  const out = status.attemptsRemaining !== undefined && status.attemptsRemaining <= 0;
  // A server from before R192's wait sends none: the whole window is the upper bound.
  const triesBackAt = out
    ? at + Math.max(0, status.attemptsRetryAfterMs ?? CODE_ATTEMPT_WINDOW_SECONDS * MS_PER_SECOND)
    : null;
  return { pausedUntil, triesBackAt };
}

/**
 * When to read the status again: the soonest deadline it stated, but never sooner than
 * `CODE_STATUS_RECHECK_FLOOR_SECONDS` after it was read, or null when it stated none that matters.
 */
function recheckAt(read: StatusRead | null): number | null {
  const { pausedUntil, triesBackAt } = statusDeadlines(read);
  const due = [pausedUntil, triesBackAt].filter((deadline): deadline is number => deadline !== null);
  if (read === null || due.length === 0) return null;
  return Math.max(Math.min(...due), read.at + CODE_STATUS_RECHECK_FLOOR_SECONDS * MS_PER_SECOND);
}

/** Milliseconds from now to `deadline`, never negative; null for no deadline. */
function msUntil(deadline: number | null, now: number): number | null {
  return deadline === null ? null : Math.max(0, deadline - now);
}

/**
 * Runs `onDue` once `deadline` (epoch ms) has passed: from a timer, and at once when the page is
 * shown again after it passed, since a sleeping tab's timers are frozen. Once due, showing the page
 * again runs it again (at most once per `CODE_STATUS_RECHECK_FLOOR_SECONDS`), so a re-read that
 * failed is not the last word.
 */
function useWhenDue(deadline: number | null, onDue: () => void): void {
  const latest = useRef(onDue);
  latest.current = onDue;
  const lastRun = useRef<number | null>(null);

  useEffect(() => {
    if (deadline === null) return;
    let timer: number | undefined;
    const check = (): void => {
      window.clearTimeout(timer);
      const now = Date.now();
      if (now < deadline) {
        timer = window.setTimeout(check, Math.min(deadline - now, LONGEST_TIMER_MS));
        return;
      }
      if (lastRun.current !== null && now - lastRun.current < CODE_STATUS_RECHECK_FLOOR_SECONDS * MS_PER_SECOND) return;
      lastRun.current = now;
      latest.current();
    };
    const onWake = (): void => {
      if (document.visibilityState !== "hidden") check();
    };
    check();
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("pageshow", onWake);
    window.addEventListener("focus", onWake);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("pageshow", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, [deadline]);
}

/** What the player's own "Check again" found (see AN UNVERIFIED EMAIL). */
type EmailCheck = "idle" | "checking" | "unchanged" | "failed";

export type InviteRouteProps = {
  /** The gate's own read of the account. Without it (a test rendering the screen alone), the screen reads it. */
  account?: { token: string; me: MeResponse };
};

export default function InviteRoute({ account }: InviteRouteProps = {}) {
  // Keyed by the account, so another account gets a fresh screen (see ONE ACCOUNT'S STATE).
  if (account !== undefined) {
    return (
      <InviteScreen
        key={account.me.profile.id}
        account={{ kind: "ready", token: account.token, me: account.me }}
      />
    );
  }
  return <StandaloneInvite />;
}

function StandaloneInvite() {
  const account = useAccount();
  // A fresh screen only when one account gives way to ANOTHER, not when the first read arrives
  // (that would redraw a screen the player may already be using).
  const readyId = account.kind === "ready" ? account.me.profile.id : null;
  const [seen, setSeen] = useState<{ id: string | null; generation: number }>({ id: null, generation: 0 });
  if (readyId !== null && readyId !== seen.id) {
    setSeen({ id: readyId, generation: seen.id === null ? seen.generation : seen.generation + 1 });
  }
  return <InviteScreen key={seen.generation} account={account} />;
}

/** R145's code-dependent refusal: the one sentence for a missing, expired or exhausted code. */
function isCodeRefusal(cause: unknown): boolean {
  return cause instanceof ApiRequestError && cause.code === "invalid_code";
}

/** §9.4 step 1: the account's email is not confirmed (or the server could not tell that it is). */
function isUnverifiedRefusal(cause: unknown): boolean {
  return cause instanceof ApiRequestError && cause.code === "email_unverified";
}

/** The provider's interval that a resend this browser remembers started, while it still runs. */
function runningResend(): { address: string; deadline: number } | null {
  const entry = pendingEmailEntry();
  if (entry === null) return null;
  const deadline = deadlineAfter(AUTH_EMAIL_RESEND_COOLDOWN_SECONDS, entry.at);
  return deadline > Date.now() ? { address: entry.address, deadline } : null;
}

function InviteScreen({ account }: { account: Account }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [statusRead, setStatusRead] = useState<StatusRead | null>(null);
  const status = statusRead?.status ?? null;
  const [submitting, setSubmitting] = useState(false);
  const [rateLimit, setRateLimit] = useState<RateLimit | null>(null);
  /** Bumped after every refusal, so the attempts count is read again (B21). */
  const [statusReads, setStatusReads] = useState(0);
  /** The code R145's error just refused: Redeem stays off while the field still holds it. */
  const [refusedCode, setRefusedCode] = useState<string | null>(null);
  /** §9.4 step 1 refused a redemption for this account's unconfirmed email. */
  const [unverifiedRefusal, setUnverifiedRefusal] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);
  const [resendNotice, setResendNotice] = useState<string | null>(null);
  const [initialResend] = useState(runningResend);
  const resendCooldown = useAddressCooldown(initialResend);
  const leaving = useSigningOut();
  const [emailCheck, setEmailCheck] = useState<EmailCheck>("idle");
  /** The player's own check found the address confirmed, ahead of the gate's re-read. */
  const [confirmedHere, setConfirmedHere] = useState(false);
  /** The code on screen, for an answer that arrives after it was edited. */
  const codeRef = useRef(code);
  codeRef.current = code;
  /** Set when a refusal should put the caret back in the field once it is unlocked. */
  const focusField = useRef(false);
  /** The code was redeemed: the screen says so, with the way on (A CODE THAT WORKED SAYS SO). */
  const [redeemed, setRedeemed] = useState(false);
  const redeemedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (redeemed) redeemedRef.current?.focus();
  }, [redeemed]);

  const me = account.kind === "ready" ? account.me : null;
  // A fresh read of the account decides again whether its email is confirmed.
  useEffect(() => {
    setUnverifiedRefusal(false);
    setConfirmedHere(false);
    setEmailCheck((check) => (check === "checking" ? check : "idle"));
  }, [me]);

  useEffect(() => {
    if (submitting || !focusField.current) return;
    focusField.current = false;
    document.getElementById(INVITE_CODE_INPUT)?.focus();
  }, [submitting]);

  useEffect(() => {
    if (account.kind !== "anonymous") return;
    navigate(account.reason === "expired" ? loginPath({ reason: "expired" }) : loginPath(), {
      replace: true,
    });
  }, [account]);

  const token = account.kind === "ready" ? account.token : null;

  useEffect(() => {
    if (token === null) return;
    let cancelled = false;
    // Optional: a screen that cannot read the breaker still takes a code, and the refusal it gets
    // back is the server's own. A read that fails keeps the last status: nothing is inferred from
    // the failure, and a known "No tries left" is not forgotten because a re-read fell over. One
    // refused as unauthorised is renewed and read again (R194).
    callWithRenewal(token, getCodeStatus)
      .then((outcome) => {
        if (cancelled) return;
        if (outcome.kind === "ok") setStatusRead({ status: outcome.value, at: Date.now() });
        else if (outcome.kind === "signedOut") {
          navigate(outcome.expired ? loginPath({ reason: "expired" }) : loginPath(), { replace: true });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [token, statusReads]);

  // "No tries left" and "paused" lift by themselves: the status is read again when its wait runs
  // out, on the clock (see NOTHING WAITS FOR A RELOAD).
  useWhenDue(recheckAt(statusRead), () => {
    setStatusReads((count) => count + 1);
  });

  // The stated wait runs out: submit comes back, and the tries left are read again.
  useWhenDue(rateLimit?.until ?? null, () => {
    setRateLimit(null);
    setError(null);
    setStatusReads((count) => count + 1);
  });

  // Every wait's sentence is read from the clock: re-render while one runs, and on waking.
  const { pausedUntil, triesBackAt } = statusDeadlines(statusRead);
  const lastDeadline = Math.max(pausedUntil ?? 0, triesBackAt ?? 0, rateLimit?.until ?? 0);
  useSecondsUntil(lastDeadline > 0 ? lastDeadline : null);
  const now = Date.now();
  const pausedLeftMs = msUntil(pausedUntil, now);
  const triesBackInMs = msUntil(triesBackAt, now);
  const rateLimitLeftMs = msUntil(rateLimit?.until ?? null, now);

  const complete = readCodeInput(code, INVITE_CODE_FORMAT).complete;
  const paused = status !== null && !status.redemptionEnabled;
  const active = account.kind === "ready" && !account.me.needsInviteCode;
  /** Nothing left to redeem: the form, the tries and the "no code yet" line give way. */
  const done = active || redeemed;
  const attemptsRemaining = status?.attemptsRemaining;
  const outOfAttempts = attemptsRemaining !== undefined && attemptsRemaining <= 0;
  const refusedAgain = refusedCode !== null && code === refusedCode;
  const canSubmit =
    token !== null &&
    complete &&
    !paused &&
    !submitting &&
    !outOfAttempts &&
    rateLimit === null &&
    !done &&
    !refusedAgain;
  const email = me?.email ?? null;
  const unverified =
    me !== null && me.needsInviteCode && ((!me.emailVerified && !confirmedHere) || unverifiedRefusal);
  const resendWait = email === null ? 0 : resendCooldown.secondsFor(email);

  /**
   * "Check again": this screen's own read of the account (see AN UNVERIFIED EMAIL). A confirmed
   * address is announced, so the gate (and every screen) reads the account again; the answer is
   * shown here either way, and a read that fails leaves the screen as it is.
   */
  function checkAgain(): void {
    if (token === null || emailCheck === "checking") return;
    setEmailCheck("checking");
    callWithRenewal(token, getMe)
      .then((outcome) => {
        if (outcome.kind === "signedOut") {
          navigate(outcome.expired ? loginPath({ reason: "expired" }) : loginPath(), { replace: true });
          return;
        }
        // Another account now (callWithRenewal has told every screen to read it again).
        if (outcome.kind === "switched") {
          setEmailCheck("idle");
          return;
        }
        if (outcome.value.emailVerified) {
          setConfirmedHere(true);
          setUnverifiedRefusal(false);
          setEmailCheck("idle");
          announceAccountChange();
          return;
        }
        setEmailCheck("unchanged");
      })
      .catch(() => {
        setEmailCheck("failed");
      });
  }

  /**
   * One redemption; a token the API refuses as unauthorised is renewed and sent once more (R194).
   * After a sign-out meanwhile it is not sent again, and never as another account.
   */
  async function redeemWithRenewal(bearer: string, sent: string): Promise<"redeemed" | "stopped"> {
    const outcome = await callWithRenewal(bearer, (token) => redeemCode(token, sent));
    if (outcome.kind === "ok") return "redeemed";
    if (outcome.kind === "signedOut") {
      navigate(outcome.expired ? loginPath({ reason: "expired" }) : loginPath(), { replace: true });
    }
    return "stopped";
  }

  function submit(): void {
    if (token === null || !canSubmit) return;
    const sent = code;
    setSubmitting(true);
    setError(null);
    redeemWithRenewal(token, sent)
      .then((outcome) => {
        // Said here, with the way on. The gate on `/decks` reads the account afresh (its own key),
        // so it sees it active.
        if (outcome === "redeemed") setRedeemed(true);
      })
      .catch((cause: unknown) => {
        if (isCodeRefusal(cause)) {
          // Never shown under a code that was not the one sent (the field is locked meanwhile).
          if (codeRef.current !== sent) {
            setStatusReads((count) => count + 1);
            return;
          }
          setRefusedCode(sent);
          focusField.current = true;
        }
        if (isUnverifiedRefusal(cause)) setUnverifiedRefusal(true);
        // Verbatim. R145's distinction between a code failure and an account-state failure lives
        // entirely in this string, so rewriting it would flatten the two into one. A rate limit's
        // sentence is the server's too (R192); only the wait beside it is the client's.
        setError(cause instanceof Error ? cause.message : String(cause));
        if (isRateLimited(cause)) {
          const wait = retryAfterMsOf(cause);
          setRateLimit({ retryAfterMs: wait, until: wait === null ? null : Date.now() + wait });
        }
        // Paused: Redeem goes off now; the status read below says for how long (or that it is over).
        if (isPausedRefusal(cause)) {
          setStatusRead((read) => ({
            status: { ...(read?.status ?? { retryAfterMs: 0 }), redemptionEnabled: false, retryAfterMs: 0 },
            at: Date.now(),
          }));
        }
        // The account is no longer pending (redeemed in another tab): read it again, and the
        // screen becomes "already active" with the way on.
        if (cause instanceof ApiRequestError && cause.status === 409) announceAccountChange();
        setStatusReads((count) => count + 1);
      })
      .finally(() => {
        setSubmitting(false);
      });
  }

  function resend(): void {
    if (email === null || resendBusy || resendWait > 0) return;
    const address = email;
    setResendBusy(true);
    setResendNotice(null);
    resendConfirmation(address)
      .then(() => {
        // The same neutral sentence as the sign-in screen's (R192), and the same interval.
        setResendNotice(AUTH_NOTICES.resendSent);
        resendCooldown.startUntil(address, deadlineAfter(AUTH_EMAIL_RESEND_COOLDOWN_SECONDS, Date.now()));
      })
      .catch((cause: unknown) => {
        setResendNotice(cause instanceof AuthError ? cause.message : AUTH_MESSAGES.service);
      })
      .finally(() => {
        setResendBusy(false);
      });
  }

  const helpId = `${INVITE_CODE_INPUT}-help`;

  return (
    <div className="app-shell invite-screen tavern">
      <div className="invite-screen__top">
        <BackLink />
        <div className="invite-screen__account">
          {account.kind === "ready" ? (
            <span className="invite-screen__who">
              Signed in as{" "}
              <span className="invite-screen__email" data-testid={inviteTestid.accountEmail}>
                {email ?? "an account with no email address"}
              </span>
            </span>
          ) : null}
          <button
            type="button"
            className="link-button"
            data-testid={inviteTestid.signOut}
            disabled={leaving}
            aria-busy={leaving}
            onClick={() => {
              signOut();
            }}
          >
            {signOutLabel(leaving)}
          </button>
        </div>
      </div>

      {/* Two parts, so a phone held sideways can set them side by side (auth/tavern.css): the title
          and what stands in the way beside the code field. Elsewhere they are one column. */}
      <section className="panel panel--auth panel--split">
        <div className="auth-board__head">
          <div className="brand">
            <h1>JackiOh</h1>
          </div>
          <h2>{redeemed ? "You\u2019re in" : active ? "You\u2019re all set" : "Enter your invite code"}</h2>

          {redeemed ? (
            <div className="notice" data-testid={inviteTestid.redeemed} role="status" tabIndex={-1} ref={redeemedRef}>
              <p>Your invite code worked: online play is open. Build your decks, then find a match.</p>
              <a
                className="button-primary"
                href={paths.decks}
                data-testid={inviteTestid.goToDecks}
                onClick={followInApp(paths.decks)}
              >
                Build your decks
              </a>
            </div>
          ) : null}

          {account.kind === "error" ? (
            <div className="notice" role="alert">
              <p>{account.message}</p>
              <button
                type="button"
                onClick={() => {
                  account.retry?.();
                }}
              >
                Try again
              </button>
            </div>
          ) : null}

          {active && !redeemed ? (
            <div className="notice">
              <p data-testid={INVITE_NOT_NEEDED}>This account is already active and needs no invite code.</p>
              <a
                className="button-primary"
                href={paths.decks}
                data-testid={inviteTestid.goToDecks}
                onClick={followInApp(paths.decks)}
              >
                Go to your decks
              </a>
            </div>
          ) : null}

          {paused && !done ? (
            <p
              className="notice"
              data-testid={INVITE_PAUSED}
              data-retry-after-ms={String(status?.retryAfterMs ?? 0)}
            >
              {pausedLeftMs !== null && pausedLeftMs > 0
                ? `Invite code redemption is paused. Try again in ${waitInWords(pausedLeftMs)}.`
                : "Invite code redemption is paused. Please try again later."}
            </p>
          ) : null}

          {unverified && !done ? (
            <div className="notice invite-screen__unverified" data-testid={inviteTestid.unverified} role="status">
              <p>
                Confirm your email address first: open the link we emailed to{" "}
                <strong>{email === null ? "your address" : <Address value={email} />}</strong>, then check again here. If you already have,
                check again in a moment.
              </p>
              <div className="invite-screen__actions">
                <button
                  type="button"
                  data-testid={inviteTestid.checkAgain}
                  disabled={emailCheck === "checking"}
                  aria-busy={emailCheck === "checking"}
                  onClick={checkAgain}
                >
                  {emailCheck === "checking" ? "Checking…" : "Check again"}
                </button>
                <button
                  type="button"
                  className="link-button"
                  data-testid={inviteTestid.resend}
                  disabled={email === null || resendBusy || resendWait > 0}
                  onClick={resend}
                >
                  {resendBusy
                    ? "Sending…"
                    : resendWait > 0
                      ? `Send again in ${String(resendWait)} s`
                      : "Resend the confirmation email"}
                </button>
              </div>
              {emailCheck === "unchanged" || emailCheck === "failed" ? (
                <p data-testid={inviteTestid.checkResult} data-result={emailCheck} role="status">
                  {emailCheck === "unchanged"
                    ? "Still not confirmed. Open the link we emailed, then check again."
                    : "Couldn’t check just now. Try again in a moment."}
                </p>
              ) : null}
              {resendNotice === null ? null : <p data-testid={inviteTestid.resendNotice}>{resendNotice}</p>}
            </div>
          ) : null}
        </div>

        <div className="auth-board__body">
          {done ? null : (
            <form
              className="form-card invite-screen__form"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              {/* Named for a screen reader; on screen the title right above already says it. */}
              <label className="invite-screen__label" htmlFor={INVITE_CODE_INPUT}>
                Invite code
              </label>
              <CodeField
                id={INVITE_CODE_INPUT}
                value={code}
                describedBy={helpId}
                // Locked while a code is being redeemed, so the answer is about the code on screen.
                disabled={submitting}
                onChange={(next) => {
                  setCode(next.formatted);
                  // The refusal was about the code as it was; a rate limit's wait still stands.
                  if (rateLimit === null) setError(null);
                  // A rate limit that stated no wait lasts until the player changes the code; the
                  // server still decides, this only stops the button looking dead forever.
                  if (rateLimit !== null && rateLimit.retryAfterMs === null) {
                    setRateLimit(null);
                    setError(null);
                  }
                }}
              />
              {/* One short line between the field and Redeem: the four groups and the count under
                  them already show the shape, so this only says what a paste may carry. */}
              <p className="invite-screen__help" id={helpId} data-testid={inviteTestid.help}>
                Paste it as is: case and dashes don&rsquo;t matter.
              </p>

              {attemptsRemaining === undefined || rateLimit !== null ? null : (
                <p
                  className="invite-screen__attempts"
                  data-testid={inviteTestid.attempts}
                  data-remaining={String(attemptsRemaining)}
                >
                  {attemptsText(
                    attemptsRemaining,
                    // A wait only when the server stated one; the window's upper bound is not said.
                    outOfAttempts && status?.attemptsRetryAfterMs !== undefined ? triesBackInMs : null,
                  )}
                </p>
              )}

              <button
                type="submit"
                data-testid={INVITE_SUBMIT}
                disabled={!canSubmit}
                aria-busy={submitting}
              >
                {submitting ? "Redeeming…" : "Redeem"}
              </button>
            </form>
          )}

          {error === null && rateLimit === null ? null : (
            // One message: what the server said, then (for a rate limit) how long to wait.
            <div className="invite-screen__refusal">
              {error === null ? null : (
                <p className="notice" data-testid={INVITE_ERROR} role="alert">
                  {error}
                </p>
              )}
              {rateLimit === null ? null : (
                <div
                  className="notice notice--error invite-screen__wait"
                  data-testid={inviteTestid.rateLimited}
                  {...(rateLimit.retryAfterMs === null
                    ? {}
                    : { "data-retry-after-ms": String(rateLimit.retryAfterMs) })}
                >
                  {waitText(rateLimitLeftMs)}
                </div>
              )}
            </div>
          )}

          {refusedAgain ? (
            // The client's own sentence beside R145's, the same for every refused code: it says
            // nothing about which of the three kinds of failure this was.
            <p className="invite-screen__help" data-testid={inviteTestid.refused}>
              Change the code to try again: the same code would be refused again, and each try counts.
            </p>
          ) : null}

          {done ? null : (
            // For whoever has no code yet: under Redeem, set apart like the sign-in board's links,
            // so it never stands between the field and the button.
            <p className="invite-screen__where" data-testid={inviteTestid.whereFrom}>
              No code yet? Online play is invite-only for now, and the JackiOh team hands out the
              codes. In the meantime,{" "}
              <a href={paths.practice} data-testid={inviteTestid.playAi} onClick={followInApp(paths.practice)}>
                play vs AI
              </a>
              , which needs no code.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
