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
// THE FORMAT IS CONFIG, NOT A LITERAL. §9.4: "16 characters (80 bits) from a 32-symbol alphabet
// without 0/O/1/I/l, formatted XXXX-XXXX-XXXX-XXXX". Every one of those numbers, the alphabet and
// the separator come from `apps/server/src/config.ts`, which is where R79/R104 put them and where
// `e2e/cypress/e2e/10-invite-gate.cy.ts` reads them from. R104 also settles the lowercase `l`: the
// alphabet is uppercase-only and input is normalised to upper case before it is read.
//
// THE ROUTE STAYS REACHABLE FOR BOTH STATUSES. Spec 10 visits it while pending and expects to
// stay; an active account that arrives is told it needs no code rather than bounced, because
// redemption is the pending → active transition and an active account asking again is a 409, not
// one of the three code failures.

import { useCallback, useEffect, useState } from "react";

import {
  CODE_ALPHABET,
  INVITE_CODE_GROUP_SIZE,
  INVITE_CODE_LENGTH,
  INVITE_CODE_SEPARATOR,
} from "../../../server/src/config.ts";
import { getCodeStatus, redeemCode, type CodeStatusResponse } from "../net/api.ts";
import { useAccount } from "../net/gate.ts";
import { navigate, paths } from "../net/navigate.ts";
import { BackLink } from "./nav.tsx";

export const INVITE_CODE_INPUT = "invite-code-input";
export const INVITE_SUBMIT = "invite-submit";
export const INVITE_ERROR = "invite-error";
/** §9.4's circuit breaker is open: the screen says so instead of guessing after a 503. */
export const INVITE_PAUSED = "invite-paused";
/** An active account reached the code screen; redemption is not for it. */
export const INVITE_NOT_NEEDED = "invite-not-needed";

/** §9.4's groups, as a shape rather than as the string `XXXX-XXXX-XXXX-XXXX`. */
export const INVITE_CODE_GROUPS = INVITE_CODE_LENGTH / INVITE_CODE_GROUP_SIZE;

/** `XXXX-XXXX-XXXX-XXXX`, built from the constants so no literal spells the format. */
export const INVITE_CODE_PLACEHOLDER = Array.from({ length: INVITE_CODE_GROUPS }, () =>
  "X".repeat(INVITE_CODE_GROUP_SIZE),
).join(INVITE_CODE_SEPARATOR);

/** The characters of a code, with everything the alphabet does not contain dropped (R104). */
export function inviteCodeCharacters(raw: string): string {
  const upper = raw.toUpperCase();
  let kept = "";
  for (const character of upper) {
    if (!CODE_ALPHABET.includes(character)) continue;
    kept += character;
    if (kept.length === INVITE_CODE_LENGTH) break;
  }
  return kept;
}

/** What the input shows: the alphabet's characters, grouped and separated per §9.4. */
export function formatInviteCode(raw: string): string {
  const kept = inviteCodeCharacters(raw);
  const groups: string[] = [];
  for (let at = 0; at < kept.length; at += INVITE_CODE_GROUP_SIZE) {
    groups.push(kept.slice(at, at + INVITE_CODE_GROUP_SIZE));
  }
  return groups.join(INVITE_CODE_SEPARATOR);
}

export default function InviteRoute() {
  const account = useAccount();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<CodeStatusResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (account.kind === "anonymous") navigate(paths.login, { replace: true });
  }, [account]);

  const token = account.kind === "ready" ? account.token : null;

  useEffect(() => {
    if (token === null) return;
    let cancelled = false;
    // Optional: a screen that cannot read the breaker still takes a code, and the refusal it gets
    // back is the server's own. Nothing is inferred from the read failing.
    getCodeStatus(token)
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const submit = useCallback(() => {
    if (token === null || code.length === 0) return;
    setSubmitting(true);
    setError(null);
    redeemCode(token, code)
      .then(() => {
        navigate(paths.decks);
      })
      .catch((cause: unknown) => {
        // Verbatim. R145's distinction between a code failure and an account-state failure lives
        // entirely in this string, so rewriting it would flatten the two into one.
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        setSubmitting(false);
      });
  }, [token, code]);

  const paused = status !== null && !status.redemptionEnabled;
  const active = account.kind === "ready" && !account.me.needsInviteCode;

  return (
    <div className="app-shell">
      <BackLink />
      <h1>JackiOh — invite code</h1>

      {active ? (
        <p className="notice" data-testid={INVITE_NOT_NEEDED}>
          This account is already active and needs no invite code.
        </p>
      ) : null}

      {paused ? (
        <p
          className="notice"
          data-testid={INVITE_PAUSED}
          data-retry-after-ms={String(status?.retryAfterMs ?? 0)}
        >
          Invite code redemption is paused. Please try again later.
        </p>
      ) : null}

      <form
        className="invite-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label htmlFor={INVITE_CODE_INPUT}>Invite code</label>
        <input
          id={INVITE_CODE_INPUT}
          data-testid={INVITE_CODE_INPUT}
          name="code"
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder={INVITE_CODE_PLACEHOLDER}
          // The separators are part of the format, so the box holds them too.
          maxLength={INVITE_CODE_LENGTH + (INVITE_CODE_GROUPS - 1) * INVITE_CODE_SEPARATOR.length}
          value={code}
          onChange={(event) => {
            setCode(formatInviteCode(event.target.value));
          }}
        />
        <button
          type="submit"
          data-testid={INVITE_SUBMIT}
          disabled={submitting || code.length === 0 || paused}
          aria-busy={submitting}
        >
          Redeem
        </button>
      </form>

      {error === null ? null : (
        <p className="notice" data-testid={INVITE_ERROR} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
