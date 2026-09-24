// `/login` — sign in, create an account, or ask for a password reset, against the auth provider
// directly (SPEC §9.2's first arrow out of the browser). `net/auth.ts` is the only thing here that
// talks to it; this file is the form.
//
// WHAT IT DOES NOT DECIDE. Nothing here judges whether a password is wrong, whether an email is
// verified, or whether the account is pending: `net/auth.ts` reduces every refusal to one of its own
// sentences (R160, R192), `/api/auth/me` answers the status, and the gate in `main.tsx` acts on it.
// Signing in sends the player to `/decks`; a pending account is bounced on to `/invite` from there.
// The checks in `auth/validation.ts` only save a round trip; the provider still has the last word.
//
// HOW THE SCREEN CAN BE OPENED.
//   - Plainly, from the landing page or the gate.
//   - `/login?reason=expired`: the gate's renewal was refused (R194), so say why the player is here.
//   - `/login?mode=forgot`: straight onto the forgot-password form (the reset screen's way back).
//   - From an emailed link (R193). `main.tsx` reads the tokens and scrubs them from the address bar
//     at boot, before anything renders, and sends a link that landed on any other path here;
//     `consumeAuthRedirect` hands this screen the cached reading.
//
// A LINK'S ADDRESS IS CHECKED BEFORE IT IS TRUSTED. The address in a link's token is only a claim:
// its payload is readable, not verified, and anyone can write a link whose token names any address
// next to a real refresh token of their own. So before a link's address decides anything, the
// server is asked who the token belongs to (`GET /api/auth/me`, which verifies every token it is
// given), and only that answer is compared. Then:
//   - A CONFIRMATION link never signs this browser in: the address is confirmed, and the player
//     signs in with the password they chose. Accepting a token from any link would let an attacker
//     sign a victim into the attacker's pending account (login CSRF). And even the link for the
//     sign-up this browser started is not proof of the password: the provider leaves an existing
//     unconfirmed account's password alone when the same address signs up again, so an attacker
//     who registered the victim's address first would keep their own password on the account the
//     victim confirmed and activated. Signing in by hand exposes that (the victim's password is
//     refused, and the reset that follows replaces the attacker's).
//   - A RECOVERY link is held (for this tab only, for `/reset-password`) for an address this
//     browser asked to reset (`pendingReset`). A reset asked for on another device, or in another
//     browser, is the common case, so any other recovery link asks the player to type their
//     account's address first, and is held only when that matches the checked address. Someone sent
//     another person's link types their own address, which does not match, so the guard against
//     being signed into someone else's account stands without a dead end for the owner. Nothing is
//     held until then, and leaving the question revokes the link.
//   - An INVITE sent from the provider's dashboard is for an account with no password yet, so it
//     opens the forgot-password form, never "sign in".
//   - A token the server refuses is a spent or broken link. One that could not be checked at all
//     (the server unreachable) decides nothing and says so; a recovery link is kept, for this
//     screen only, so "Try again" can check it once the server answers, since it works only once.
//     A check that runs past `GATE_SLOW_NOTICE_SECONDS` says why (a sleeping server) and asks the
//     player to wait for it.
// NOTHING FROM A LINK IS FILLED IN. Not even the checked address: a link can be anyone's, and a
// mailer form holding an address the player never typed arms this browser's guard with it at one
// click ("Send reset link" remembers the address as the reset this browser asked for), after which
// the same person's next link would be accepted. The player types their own address.
// A LINK IS RENEWED AS SOON AS IT IS READ. Its tokens came in a URL, and the browser's history keeps
// the URL a page loaded with, so the link's refresh token is spent (renewed once) before anything
// else, the server's check included: the copy in history is then worth nothing after the provider's
// reuse interval, whatever this tab does next (a tab closed while "Checking your link…" included).
// Everything after that (the check, holding, revoking) uses the renewal. A renewal the provider
// refuses means the link was opened before; one that cannot reach the provider leaves the link's
// own session in use, and a later "Try again" renews it then.
// A LINK'S SESSION THAT IS NOT KEPT IS REVOKED. A link this screen does not hold (every
// confirmation, someone else's reset, an invite, one the player moved on from, a confirmation that
// could not be checked, an unchecked or unclaimed reset the player left) is revoked at the
// provider, renewed first if its access token has run out (R194), since the provider refuses to
// revoke with an expired one.
// NOTHING IS PREFILLED FROM STORAGE either: `/login?mode=forgot` is a public link, and a reset
// address another person left on a shared computer is not this player's to see.
// ANOTHER ACCOUNT ON THIS BROWSER. Signing in replaces (and revokes) whatever session the browser
// holds, so the screen says which account that is, with its account screen and sign-out beside it.
// A failed link shows our own sentence and the two ways forward (resend, reset) right beside it,
// since mail scanners spend one-time links.
// The query is read BEFORE the scrub, and no destination is ever read from it (B35): every
// navigation out of this screen goes to a `paths` value.
//
// NO DEAD ENDS. `BackLink` is on the screen in every mode, the forgot form has its own way back,
// and the resend and reset mailers answer the same neutral sentence whether or not the address has
// an account (R192), then wait out the provider's per-address interval before offering again. That
// interval belongs to the ADDRESS: a sign-up starts it for the confirmation resend, and a corrected
// address can be sent to at once. It is counted on the clock from when the address was mailed
// (`auth/cooldown.ts`), so a reload, or a tab the phone put to sleep, neither restarts nor stalls it.
//
// WHAT HAPPENED IS SAID FIRST. The notice and the error sit above the form, and a sign-up that
// succeeded moves focus to its notice (the form it leaves behind reads "Sign in", which is the step
// after the inbox). A refused field takes focus. A sign-in goes back to the screen that sent the
// player here (`net/return-to.ts`), else to `/decks`.

import { useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";

import { AUTH_EMAIL_RESEND_COOLDOWN_SECONDS, GATE_SLOW_NOTICE_SECONDS } from "../../../server/src/config.ts";
import Address from "../auth/Address.tsx";
import { addressKey, deadlineAfter, useAddressCooldown } from "../auth/cooldown.ts";
import {
  clearConsumedAuthRedirect,
  consumeAuthRedirect,
  emailFromToken,
  holdRecoverySession,
  type SessionLinkType,
} from "../auth/redirect.ts";
import { loginTestid } from "../auth/testids.ts";
import { emailProblem, newPasswordProblem, normalizeEmail, requiredProblem } from "../auth/validation.ts";
import { ApiRequestError, getMe } from "../net/api.ts";
import {
  AUTH_MESSAGES,
  AUTH_NOTICES,
  AuthError,
  adoptSession,
  refreshSession,
  requestPasswordReset,
  resendConfirmation,
  revokeSignedOutSession,
  signIn,
  signUp,
} from "../net/auth.ts";
import { loginModeOf, loginReasonOf, navigate, paths } from "../net/navigate.ts";
import { takeReturnTo } from "../net/return-to.ts";
import {
  forgetPendingEmail,
  pendingEmail,
  pendingEmailEntry,
  pendingReset,
  pendingResetEntry,
  readSession,
  type PendingAddress,
  type Session,
} from "../net/session.ts";
import { signOut, signOutLabel, useSigningOut } from "./account.tsx";
import { BackLink, followInApp } from "./nav.tsx";

import "../auth/auth.css";
import "../auth/tavern.css";

/** Re-exported so every existing `import { loginTestid } from "./login.tsx"` keeps working. */
export { loginTestid };

/** `claimReset`: a recovery link asked for elsewhere, waiting for the player to type their address. */
type Mode = "signIn" | "signUp" | "forgot" | "claimReset";

/** An emailed link that carries a session, waiting for the server to say whose it is. */
type PendingLink =
  | { kind: "session"; session: Session; linkType: SessionLinkType }
  | { kind: "recovery"; session: Session };

/**
 * The link's session while this screen still answers for it: the link's own until it is renewed,
 * then the renewal. `session` is null once it has been held for the reset screen or revoked.
 */
type LinkState = { session: Session | null; renewed: boolean };

/** What renewing a link's session on arrival found. */
type LinkRenewal =
  /** The link's refresh token is spent, and `LinkState.session` is the renewal. */
  | "renewed"
  /** The provider refused the refresh token: the link was opened before (or was never real). */
  | "spent"
  /** No refresh token, or the provider could not be reached: the link's own session stays. */
  | "kept";

/**
 * Renews the link's session once (see A LINK IS RENEWED AS SOON AS IT IS READ). Concurrent calls
 * share one provider request (`refreshSession`), so StrictMode's second run gets the same renewal.
 * A session released meanwhile (the player moved on and it was revoked) is not brought back.
 */
async function renewLinkOnce(state: LinkState): Promise<LinkRenewal> {
  if (state.renewed) return "renewed";
  const session = state.session;
  const refreshToken = session?.refreshToken;
  if (session === null || typeof refreshToken !== "string" || refreshToken.length === 0) return "kept";
  try {
    const next = await refreshSession(refreshToken);
    if (!state.renewed && state.session === session) state.session = next;
    state.renewed = true;
    return "renewed";
  } catch (cause) {
    return cause instanceof AuthError && cause.failure === "sessionEnded" ? "spent" : "kept";
  }
}

/** The link's session is not kept: revoke it (see A LINK'S SESSION THAT IS NOT KEPT). */
function revokeLink(state: LinkState): void {
  const session = state.session;
  state.session = null;
  if (session !== null) void revokeSignedOutSession(session);
}

/** The link's session, handed over (to the reset screen): this screen no longer answers for it. */
function takeLink(state: LinkState): Session | null {
  const session = state.session;
  state.session = null;
  return session;
}

type Entry = {
  mode: Mode;
  sessionExpired: boolean;
  email: string;
  linkError: boolean;
  link: PendingLink | null;
};

/** What the server said about a link's token (`GET /api/auth/me`, which verifies it). */
type LinkCheck =
  | { kind: "verified"; email: string | null }
  /** The server refused the token: a spent, expired or forged link. */
  | { kind: "refused" }
  /** The server could not be reached or answered something else; nothing was learned. */
  | { kind: "unchecked" };

async function checkLink(accessToken: string): Promise<LinkCheck> {
  try {
    const me = await getMe(accessToken);
    return { kind: "verified", email: me.email };
  } catch (cause) {
    if (cause instanceof ApiRequestError && cause.status === 401) return { kind: "refused" };
    return { kind: "unchecked" };
  }
}

/** What a checked link leaves on this screen, when it does not move on from it. */
type LinkOutcome =
  | "none"
  | "checking"
  /** A confirmation link this browser did not start: the address is confirmed, sign in by hand. */
  | "confirmed"
  /** A recovery link whose account has no address to compare: nothing was held. */
  | "recoveryRefused"
  /** A recovery link asked for elsewhere: held back until the player types its address. */
  | "recoveryClaim"
  /** A dashboard invite: the account needs a password first. */
  | "invited"
  /** A confirmation link the server could not check. */
  | "unchecked"
  /** A recovery link the server could not check: kept, so it can be checked again. */
  | "recoveryUnchecked";

function sameAddress(a: string, b: string): boolean {
  return addressKey(a) === addressKey(b);
}

/** How the screen was opened. Runs once, in a state initializer, before the first render. */
function readEntry(): Entry {
  // The query first (a link is scrubbed with its query, though `/login`'s own never carries one).
  const search = window.location.search;
  const forgot = loginModeOf(search) === "forgot";
  const entry: Entry = {
    mode: forgot ? "forgot" : "signIn",
    sessionExpired: loginReasonOf(search) === "expired",
    // Empty, always: `mode=forgot` is a public link, and the address this browser last asked to
    // reset may be another person's (see NOTHING IS PREFILLED FROM STORAGE).
    email: "",
    linkError: false,
    link: null,
  };

  const link = consumeAuthRedirect();
  switch (link.kind) {
    case "none":
      break;
    case "session":
      // Decided once the server has said whose token it is (see A LINK'S ADDRESS IS CHECKED).
      entry.mode = "signIn";
      entry.link = { kind: "session", session: link.session, linkType: link.linkType };
      break;
    case "recovery":
      entry.mode = "signIn";
      entry.link = { kind: "recovery", session: link.session };
      break;
    case "error":
      // `linkExpired` and `linkDenied` read the same sentence; the ways forward are the same too.
      entry.mode = "signIn";
      entry.linkError = true;
      break;
  }
  return entry;
}

/**
 * The provider's per-address interval that a send this browser remembers (`pendingEmail`,
 * `pendingReset`) started, while it is still running: a reload does not forget it (R192).
 */
function runningInterval(entry: PendingAddress | null): { address: string; deadline: number } | null {
  if (entry === null) return null;
  const deadline = deadlineAfter(AUTH_EMAIL_RESEND_COOLDOWN_SECONDS, entry.at);
  return deadline > Date.now() ? { address: entry.address, deadline } : null;
}

/** Only our own sentences reach the screen; anything that is not an `AuthError` is a fault. */
function messageOf(cause: unknown): string {
  return cause instanceof AuthError ? cause.message : AUTH_MESSAGES.service;
}

/** True once `active` has held for `GATE_SLOW_NOTICE_SECONDS`, as the gate's own slow notice. */
function useRunningLong(active: boolean): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!active) {
      setLate(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setLate(true);
    }, GATE_SLOW_NOTICE_SECONDS * 1000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [active]);
  return active && late;
}

/**
 * The account this browser is signed in as when the screen opens, or null. Its address is the
 * stored token's own claim, shown back only to whoever holds the token; `""` when it names none
 * (the end-to-end fixture sessions).
 */
function signedInAddress(): string | null {
  const session = readSession();
  if (session === null) return null;
  return emailFromToken(session.accessToken) ?? "";
}

export default function LoginRoute(): ReactElement {
  const [entry] = useState(readEntry);
  const [mode, setMode] = useState<Mode>(entry.mode);
  const [email, setEmail] = useState(entry.email);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(entry.sessionExpired);
  const [linkOutcome, setLinkOutcome] = useState<LinkOutcome>(entry.link === null ? "none" : "checking");
  const [linkError, setLinkError] = useState(entry.linkError);
  const [resendOffered, setResendOffered] = useState(entry.linkError);
  const [resendBusy, setResendBusy] = useState(false);
  /** A failed sign-in for the address this browser just signed up with (R160 stands: local state only). */
  const [confirmFirst, setConfirmFirst] = useState(false);
  /** The player has used the form, so a link still being checked no longer decides anything. */
  const acted = useRef(false);
  /** Bumped by "Try again" on a recovery link that could not be checked. */
  const [checkRound, setCheckRound] = useState(0);
  /** The emailed link's session while this screen answers for it (see `LinkState`). */
  const linkState = useRef<LinkState>({ session: entry.link?.session ?? null, renewed: false });
  /** The checked address of a recovery link asked for elsewhere (`claimReset`). Never shown. */
  const claimAddress = useRef<string | null>(null);
  const mounted = useRef(false);
  const checkingLong = useRunningLong(linkOutcome === "checking");
  const [signedInAs] = useState(signedInAddress);
  const leaving = useSigningOut();
  const [resendRunning] = useState(() => runningInterval(pendingEmailEntry()));
  const [resetRunning] = useState(() => runningInterval(pendingResetEntry()));
  const resendCooldown = useAddressCooldown(resendRunning);
  const resetCooldown = useAddressCooldown(resetRunning);
  const resendWait = resendCooldown.secondsFor(email);
  const resetWait = resetCooldown.secondsFor(email);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  /** Set when a notice should take focus once it renders (a sign-up that moved the form on). */
  const focusNotice = useRef(false);

  useEffect(() => {
    if (notice === null || !focusNotice.current) return;
    focusNotice.current = false;
    noticeRef.current?.focus();
  }, [notice]);

  // A link this screen still answers for when it really unmounts (being checked, kept for "Try
  // again", or waiting for its address) is revoked (see A LINK'S SESSION THAT IS NOT KEPT). After
  // the unmount, so StrictMode's rehearsal (which remounts at once) does not.
  useEffect(() => {
    mounted.current = true;
    const state = linkState.current;
    return () => {
      mounted.current = false;
      if (state.session === null) return;
      window.setTimeout(() => {
        if (!mounted.current) revokeLink(state);
      }, 0);
    };
  }, []);

  // Act on an emailed link once mounted: renew it (spending the copy in history), then act only on
  // what the server says the renewed token is (R193). StrictMode's rehearsal runs this twice; the
  // first run's answer is dropped, and both share one renewal. The cached reading is released when
  // the screen really unmounts.
  useEffect(() => {
    const link = entry.link;
    const state = linkState.current;
    let cancelled = false;
    const run = async (): Promise<void> => {
      if (link === null) return;
      const renewal = await renewLinkOnce(state);
      if (cancelled) return;
      const session = state.session;
      // Let go meanwhile: the player moved on, and it has been revoked.
      if (session === null) return;
      const check: LinkCheck = renewal === "spent" ? { kind: "refused" } : await checkLink(session.accessToken);
      if (cancelled) return;
      if (acted.current) {
        // The player moved on before the answer came.
        revokeLink(state);
        return;
      }
      if (check.kind === "refused") {
        // A spent, expired or forged link. A renewal the server still refused is revoked; a link
        // whose own tokens were refused has nothing live to revoke.
        if (renewal === "renewed") revokeLink(state);
        else state.session = null;
        setLinkOutcome("none");
        setLinkError(true);
        setResendOffered(true);
        return;
      }
      if (check.kind === "unchecked") {
        if (link.kind === "recovery") {
          // Our server could not be reached, but the provider accepted this one-time link: keep
          // it on this screen so it can be checked again, rather than spend it on a network blip.
          setLinkOutcome("recoveryUnchecked");
          return;
        }
        revokeLink(state);
        setLinkOutcome("unchecked");
        setResendOffered(true);
        return;
      }
      const verified = check.email;
      if (link.kind === "session") {
        // R193: no link signs this browser in, the sign-up it started included (see A
        // CONFIRMATION link, above): the player signs in with their password.
        revokeLink(state);
        if (link.linkType === "invite") {
          setMode("forgot");
          setLinkOutcome("invited");
          return;
        }
        // The sign-up this browser was waiting on is confirmed: its "confirm first" hint is over.
        const pending = pendingEmail();
        if (verified !== null && pending !== null && sameAddress(verified, pending)) forgetPendingEmail();
        setLinkOutcome("confirmed");
        return;
      }
      if (verified === null) {
        // An account with no address has nothing to compare: nothing is held.
        revokeLink(state);
        setLinkOutcome("recoveryRefused");
        return;
      }
      // R193: a reset this browser asked for is held at once.
      const requested = pendingReset();
      if (requested !== null && sameAddress(verified, requested)) {
        const held = takeLink(state);
        if (held === null) return;
        holdRecoverySession(held, verified);
        navigate(paths.resetPassword, { replace: true });
        return;
      }
      // Asked for elsewhere (another device or browser, or before this browser signed in): held
      // only once the player types the address it was sent to (see A RECOVERY link, above).
      claimAddress.current = verified;
      setMode("claimReset");
      setLinkOutcome("recoveryClaim");
    };
    void run();
    return () => {
      cancelled = true;
      clearConsumedAuthRedirect();
    };
  }, [entry, checkRound]);

  /** A link this screen still answers for is let go (revoked) once the player moves on from it. */
  function releaseLink(): void {
    claimAddress.current = null;
    revokeLink(linkState.current);
  }

  function retryLinkCheck(): void {
    if (linkState.current.session === null) return;
    setLinkOutcome("checking");
    setCheckRound((round) => round + 1);
  }

  function switchMode(next: Mode): void {
    acted.current = true;
    releaseLink();
    setMode(next);
    setError(null);
    setNotice(null);
    setEmailError(null);
    setPasswordError(null);
    setLinkError(false);
    setSessionExpired(false);
    setLinkOutcome("none");
    setConfirmFirst(false);
  }

  function onResend(): void {
    if (resendBusy || resendWait > 0) return;
    const problem = emailProblem(email);
    if (problem !== null) {
      setEmailError(problem);
      return;
    }
    const address = normalizeEmail(email);
    setResendBusy(true);
    setError(null);
    setNotice(null);
    resendConfirmation(address)
      .then(() => {
        // One sentence whatever the provider answered (R192); `resendConfirmation` resolves on all.
        setNotice(AUTH_NOTICES.resendSent);
        resendCooldown.startUntil(address, deadlineAfter(AUTH_EMAIL_RESEND_COOLDOWN_SECONDS, Date.now()));
      })
      .catch((cause: unknown) => {
        setError(messageOf(cause));
      })
      .finally(() => {
        setResendBusy(false);
      });
  }

  /**
   * `claimReset`: a recovery link asked for elsewhere is held only for the address it was sent to.
   * A typo can be corrected (the link's holder can read its address anyway); leaving revokes it.
   */
  function claimReset(): void {
    const expected = claimAddress.current;
    if (expected === null || linkState.current.session === null) {
      // Nothing left to claim: back to the plain sign-in form, letting go of whatever is left.
      switchMode("signIn");
      return;
    }
    const problem = emailProblem(email);
    const mismatch = problem === null && !sameAddress(normalizeEmail(email), expected);
    const nextEmailError = problem ?? (mismatch ? AUTH_NOTICES.recoveryClaimMismatch : null);
    setEmailError(nextEmailError);
    if (nextEmailError !== null) {
      document.getElementById("login-email")?.focus();
      return;
    }
    const held = takeLink(linkState.current);
    claimAddress.current = null;
    if (held === null) return;
    holdRecoverySession(held, expected);
    navigate(paths.resetPassword, { replace: true });
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (busy) return;
    if (mode === "claimReset") {
      claimReset();
      return;
    }
    acted.current = true;
    releaseLink();
    if (linkOutcome === "checking") setLinkOutcome("none");
    setConfirmFirst(false);

    const address = normalizeEmail(email);
    let nextEmailError: string | null;
    let nextPasswordError: string | null = null;
    if (mode === "signUp") {
      nextEmailError = emailProblem(email);
      nextPasswordError = newPasswordProblem(password);
    } else if (mode === "signIn") {
      // An existing password is whatever the account has: sign-in only asks for something typed.
      nextEmailError = requiredProblem(address, "email");
      nextPasswordError = requiredProblem(password, "password");
    } else {
      nextEmailError = emailProblem(email);
    }
    setEmailError(nextEmailError);
    setPasswordError(nextPasswordError);
    if (nextEmailError !== null || nextPasswordError !== null) {
      // The first field to fix, for a keyboard or a screen reader.
      document.getElementById(nextEmailError !== null ? "login-email" : "login-password")?.focus();
      return;
    }

    if (mode === "forgot" && resetWait > 0) return;

    setBusy(true);
    setError(null);
    setNotice(null);
    const done = (): void => {
      setBusy(false);
    };

    if (mode === "signUp") {
      signUp(address, password)
        .then(() => {
          // §9.4 step 1 requires a verified email before a code can be redeemed, so the next step
          // is the inbox, not the game. Said identically whether or not the address was already
          // registered -- see `signUp`'s note on why the provider makes that true for free.
          setMode("signIn");
          setPassword("");
          // The form now reads "Sign in", which is the step after the inbox: the notice says so,
          // above it, and takes focus so it is what is read next.
          focusNotice.current = true;
          setNotice(AUTH_NOTICES.signUpSent);
          setResendOffered(true);
          // The sign-up just mailed this address, which starts the provider's per-address
          // interval: a resend now would be refused, and reported as sent (R192).
          resendCooldown.startUntil(address, deadlineAfter(AUTH_EMAIL_RESEND_COOLDOWN_SECONDS, Date.now()));
        })
        .catch((cause: unknown) => {
          setError(messageOf(cause));
        })
        .finally(done);
      return;
    }

    if (mode === "forgot") {
      requestPasswordReset(address)
        .then(() => {
          // Known address or not, sent or refused: one sentence (OWASP, R192).
          setNotice(AUTH_NOTICES.resetSent);
          resetCooldown.startUntil(address, deadlineAfter(AUTH_EMAIL_RESEND_COOLDOWN_SECONDS, Date.now()));
        })
        .catch((cause: unknown) => {
          setError(messageOf(cause));
        })
        .finally(done);
      return;
    }

    // Read before the attempt: a successful sign-in forgets it.
    const justSignedUp = pendingEmail();
    signIn(address, password)
      .then((result) => {
        // Replaces (and revokes) any other session this browser held (R194).
        adoptSession(result.session);
        // Back to the gated screen that sent the player here, else `/decks`, the first gated
        // screen; the one gate in `main.tsx` redirects from there, so this file needs no notion of
        // account status. Always a fixed `paths` value, never a URL from the query (B35).
        navigate(takeReturnTo() ?? paths.decks, { replace: true });
      })
      .catch((cause: unknown) => {
        setError(messageOf(cause));
        // An unconfirmed address reads as `credentials` (R160), so the way forward for it is
        // offered after any such refusal rather than only after a telling one. Not after a network
        // failure or a rate limit, which say nothing about the address and which a mailer would not
        // help (and, while rate-limited, would only add another request).
        if (cause instanceof AuthError && cause.failure === "credentials") setResendOffered(true);
        // The address this browser has just signed up with: most likely its confirmation link has
        // not been opened yet. Keyed on this browser's own state, never on the provider's answer.
        if (cause instanceof AuthError && cause.failure === "credentials" && justSignedUp !== null) {
          setConfirmFirst(sameAddress(address, justSignedUp));
        }
      })
      .finally(done);
  }

  const signingUp = mode === "signUp";
  const forgot = mode === "forgot";
  const signingIn = mode === "signIn";
  const claiming = mode === "claimReset";

  const title = signingUp ? "Create an account" : forgot || claiming ? "Reset your password" : "Sign in";

  let submitLabel: string;
  if (signingUp) {
    submitLabel = busy ? "Creating…" : "Create account";
  } else if (forgot) {
    // "Send", not "Send again": the interval may have been started before a reload.
    // The wait is said once, in the line under the button (as the confirmation resend says it),
    // so the button keeps its name while it is locked (integration QA: the countdown was twice).
    submitLabel = busy ? "Sending…" : "Send reset link";
  } else if (claiming) {
    submitLabel = "Continue";
  } else {
    submitLabel = busy ? "Signing in…" : "Sign in";
  }

  const forgotButton = (
    <button
      type="button"
      className="link-button"
      data-testid={loginTestid.forgot}
      onClick={() => {
        switchMode("forgot");
      }}
    >
      {claiming ? "Ask for a new link instead" : "Forgot your password?"}
    </button>
  );

  const resendControls = (
    <div className="auth-resend">
      {/* R160 makes an unconfirmed address and a wrong password read alike, so the button says
          who it is for rather than hinting at which one this was. */}
      <span className="auth-hint" data-testid={loginTestid.resendLead}>
        Just signed up? Confirm your email first:
      </span>
      <button
        type="button"
        className="link-button"
        data-testid={loginTestid.resend}
        disabled={resendBusy || resendWait > 0}
        onClick={onResend}
      >
        {resendBusy ? "Sending…" : "Resend the confirmation email"}
      </button>
      {resendWait > 0 ? (
        <span className="auth-cooldown" data-testid={loginTestid.resendCooldown} data-seconds={resendWait}>
          You can send another in {resendWait} s.
        </span>
      ) : null}
    </div>
  );

  return (
    <div className="app-shell auth-screen tavern">
      <BackLink />
      {/* Two parts, so a phone held sideways can set them side by side (auth/tavern.css): what is
          going on (the title and every notice) beside the form. Elsewhere they are one column. */}
      <section className="panel panel--auth panel--split">
        <div className="auth-board__head">
          <div className="brand">
            <h1>JackiOh</h1>
          </div>
          <h2>{title}</h2>

          {signingIn && sessionExpired ? (
            <p className="notice" data-testid={loginTestid.sessionExpired} role="status">
              {AUTH_NOTICES.sessionExpired}
            </p>
          ) : null}

          {signingIn && linkOutcome === "checking" ? (
            <p className="notice" data-testid={loginTestid.checkingLink} role="status">
              {AUTH_NOTICES.checkingLink}
            </p>
          ) : null}

          {signingIn && checkingLong ? (
            <p className="auth-hint" data-testid={loginTestid.checkingSlow}>
              {AUTH_NOTICES.checkingSlow}
            </p>
          ) : null}

          {signingIn && linkOutcome === "confirmed" ? (
            <p className="notice" data-testid={loginTestid.confirmed} role="status">
              {AUTH_NOTICES.emailConfirmed}
            </p>
          ) : null}

          {forgot && linkOutcome === "invited" ? (
            <p className="notice" data-testid={loginTestid.invited} role="status">
              {AUTH_NOTICES.inviteNeedsPassword}
            </p>
          ) : null}

          {claiming && linkOutcome === "recoveryClaim" ? (
            <p className="notice" data-testid={loginTestid.recoveryClaim} role="status">
              {AUTH_NOTICES.recoveryClaim}
            </p>
          ) : null}

          {signingIn && linkOutcome === "recoveryRefused" ? (
            <div className="auth-link-error">
              <p className="notice" data-testid={loginTestid.recoveryRefused} role="alert">
                {AUTH_NOTICES.recoveryElsewhere}
              </p>
              <div className="auth-actions">{forgotButton}</div>
            </div>
          ) : null}

          {signingIn && linkOutcome === "recoveryUnchecked" ? (
            <div className="auth-link-error">
              <p className="notice" data-testid={loginTestid.recoveryUnchecked} role="alert">
                {AUTH_NOTICES.recoveryUnchecked}
              </p>
              <div className="auth-actions">
                <button type="button" data-testid={loginTestid.linkRetry} onClick={retryLinkCheck}>
                  Try again
                </button>
                {forgotButton}
              </div>
            </div>
          ) : null}

          {signingIn && linkOutcome === "unchecked" ? (
            <div className="auth-link-error">
              <p className="notice" data-testid={loginTestid.linkUnchecked} role="alert">
                {AUTH_NOTICES.linkUnchecked}
              </p>
              <div className="auth-actions">
                {resendControls}
                {forgotButton}
              </div>
            </div>
          ) : null}

          {signingIn && linkError ? (
            <div className="auth-link-error">
              {/* Our sentence only: the link's `error_description` is never read (R193). */}
              <p className="notice" data-testid={loginTestid.linkError} role="alert">
                {AUTH_MESSAGES.linkExpired}
              </p>
              {/* Mail scanners open links before the player does: a confirmation link they spent
                  has still confirmed the address, and signing in is all that is left. */}
              <p className="auth-hint" data-testid={loginTestid.linkErrorSignIn}>
                If you already confirmed your email, just sign in below.
              </p>
              <div className="auth-actions">
                {resendControls}
                {forgotButton}
              </div>
            </div>
          ) : null}

          {notice !== null ? (
            <p className="notice" data-testid={loginTestid.notice} role="status" ref={noticeRef} tabIndex={-1}>
              {notice}
            </p>
          ) : null}

          {error !== null ? (
            <p className="notice" data-testid={loginTestid.error} role="alert">
              {error}
            </p>
          ) : null}

          {signingIn && error !== null && confirmFirst ? (
            <p className="auth-hint" data-testid={loginTestid.confirmFirst}>
              {AUTH_NOTICES.confirmFirst}
            </p>
          ) : null}

          {signedInAs !== null && (signingIn || signingUp) ? (
            // Never silently: a sign-in here replaces (and revokes) the session this browser holds.
            <div className="auth-signed-in" data-testid={loginTestid.signedInAs}>
              <p className="auth-hint">
                {signedInAs === "" ? (
                  "This browser is already signed in to an account."
                ) : (
                  <>
                    This browser is signed in as{" "}
                    <strong>
                      <Address value={signedInAs} />
                    </strong>
                    .
                  </>
                )}{" "}
                {signingUp ? "Creating an account does not change that." : "Signing in here signs it out of that account."}
              </p>
              <div className="auth-actions">
                <a
                  className="link-button"
                  href={paths.account}
                  data-testid={loginTestid.signedInAccount}
                  onClick={followInApp(paths.account)}
                >
                  Go to that account
                </a>
                <button
                  type="button"
                  className="link-button"
                  data-testid={loginTestid.signedInSignOut}
                  disabled={leaving}
                  onClick={() => {
                    signOut();
                  }}
                >
                  {signOutLabel(leaving)}
                </button>
              </div>
            </div>
          ) : null}

          {forgot ? (
            <p className="auth-hint">
              Enter the address you signed up with. If it has an account, we&rsquo;ll email a link to
              choose a new password.
            </p>
          ) : null}
          {signingUp ? (
            // Said before the player has an account, not after they have confirmed one.
            <p className="auth-hint" data-testid={loginTestid.inviteOnly}>
              {AUTH_NOTICES.inviteOnly}
            </p>
          ) : null}
        </div>

        <div className="auth-board__body">
          <form
            className="form-card"
            data-testid={loginTestid.form}
            data-mode={mode}
            onSubmit={onSubmit}
            // Our own messages, next to the field, rather than the browser's bubble.
            noValidate
          >
            <label htmlFor="login-email">{claiming ? "Your account's email" : "Email"}</label>
            <input
              id="login-email"
              data-testid={loginTestid.email}
              type="email"
              autoComplete="username"
              value={email}
              aria-invalid={emailError !== null}
              aria-describedby={emailError !== null ? "login-email-error" : undefined}
              onChange={(event) => {
                setEmail(event.target.value);
                setEmailError(null);
              }}
            />
            {emailError !== null ? (
              <p id="login-email-error" className="auth-field-error" data-testid={loginTestid.emailError}>
                {emailError}
              </p>
            ) : null}

            {signingIn || signingUp ? (
              <>
                <label htmlFor="login-password">Password</label>
                <div className="input-with-affix">
                  <input
                    id="login-password"
                    data-testid={loginTestid.password}
                    // The whole point of the toggle: a password you cannot read is a password you
                    // cannot check before submitting, which matters most while CREATING one.
                    type={showPassword ? "text" : "password"}
                    autoComplete={signingUp ? "new-password" : "current-password"}
                    // Shown as text, a phone keyboard would otherwise capitalise, correct and
                    // spell-check (remotely, with enhanced spell-check) the password.
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={password}
                    aria-invalid={passwordError !== null}
                    aria-describedby={passwordError !== null ? "login-password-error" : undefined}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      setPasswordError(null);
                    }}
                  />
                  <button
                    type="button"
                    className="affix-button"
                    data-testid={loginTestid.togglePassword}
                    // Announced, not just drawn: the icon alone tells a screen reader nothing.
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    aria-pressed={showPassword}
                    onClick={() => {
                      setShowPassword((shown) => !shown);
                    }}
                  >
                    {showPassword ? "Hide" : "Show"}
                  </button>
                </div>
                {passwordError !== null ? (
                  <p
                    id="login-password-error"
                    className="auth-field-error"
                    data-testid={loginTestid.passwordError}
                  >
                    {passwordError}
                  </p>
                ) : null}
              </>
            ) : null}

            <button
              type="submit"
              data-testid={loginTestid.submit}
              disabled={busy || (forgot && resetWait > 0)}
            >
              {submitLabel}
            </button>
            {forgot && resetWait > 0 ? (
              // Only the wait: whether a mail went out is the neutral notice's to say (R192).
              <p className="auth-hint" data-testid={loginTestid.resetCooldown} data-seconds={resetWait}>
                You can ask for another in {resetWait} s.
              </p>
            ) : null}
          </form>

          <div className="auth-links">
            {(signingIn &&
              !linkError &&
              linkOutcome !== "recoveryRefused" &&
              linkOutcome !== "unchecked" &&
              linkOutcome !== "recoveryUnchecked") ||
            claiming
              ? forgotButton
              : null}
            {forgot || claiming ? (
              <button
                type="button"
                className="link-button"
                data-testid={loginTestid.backToSignIn}
                onClick={() => {
                  switchMode("signIn");
                }}
              >
                Back to sign in
              </button>
            ) : (
              <button
                type="button"
                className="link-button"
                data-testid={loginTestid.mode}
                onClick={() => {
                  switchMode(signingUp ? "signIn" : "signUp");
                }}
              >
                {signingUp ? "Already have an account? Sign in" : "No account? Create one"}
              </button>
            )}
          </div>

          {signingIn && resendOffered && !linkError && linkOutcome !== "unchecked" ? resendControls : null}
        </div>
      </section>
    </div>
  );
}
