// Every `data-testid` the sign-in, reset, invite, landing and shell screens render, in one plain
// TypeScript module so the Cypress `.ts` specs can import the same names the components use.
//
// PLAIN DATA ONLY. No React, no DOM, no import from the rest of `src`: `e2e/` compiles this file on
// its own, and anything more than string literals would drag the client into the Cypress bundle.
// The literal is fixed by docs/polish/5-sign-in.md ("Test ids"); a rename here is a rename in every
// spec that reads it.

export const landingTestid = {
  root: "landing",
  signIn: "landing-sign-in",
  account: "landing-account",
  playAi: "landing-play-ai",
  playOnline: "landing-play-online",
  buildDecks: "landing-build-decks",
  fan: "landing-card-fan",
  howItPlays: "landing-how-it-plays",
  hotseat: "landing-hotseat",
  inviteOnly: "landing-invite-only",
} as const;

/** `landing-fan-card-${index}`, 0..4. */
export function landingFanCardTestid(index: number): string {
  return `landing-fan-card-${String(index)}`;
}

/** `landing-step-${index}`, 0..3. */
export function landingStepTestid(index: number): string {
  return `landing-step-${String(index)}`;
}

export const loginTestid = {
  form: "login-form",
  email: "login-email",
  password: "login-password",
  submit: "login-submit",
  togglePassword: "login-toggle-password",
  error: "login-error",
  mode: "login-mode",
  notice: "login-notice",
  emailError: "login-email-error",
  passwordError: "login-password-error",
  forgot: "login-forgot",
  backToSignIn: "login-back-to-sign-in",
  resend: "login-resend",
  resendCooldown: "login-resend-cooldown",
  linkError: "login-link-error",
  linkErrorSignIn: "login-link-error-sign-in",
  confirmed: "login-confirmed",
  sessionExpired: "login-session-expired",
  recoveryRefused: "login-recovery-refused",
  recoveryClaim: "login-recovery-claim",
  confirmFirst: "login-confirm-first",
  checkingLink: "login-checking-link",
  linkUnchecked: "login-link-unchecked",
  invited: "login-invited",
  inviteOnly: "login-invite-only",
  checkingSlow: "login-checking-slow",
  recoveryUnchecked: "login-recovery-unchecked",
  linkRetry: "login-link-retry",
  signedInAs: "login-signed-in-as",
  signedInAccount: "login-signed-in-account",
  signedInSignOut: "login-signed-in-sign-out",
  resetCooldown: "login-reset-cooldown",
  resendLead: "login-resend-lead",
} as const;

export const resetTestid = {
  screen: "reset-screen",
  form: "reset-form",
  email: "reset-email",
  password: "reset-password",
  confirm: "reset-confirm",
  togglePassword: "reset-toggle-password",
  submit: "reset-submit",
  error: "reset-error",
  passwordError: "reset-password-error",
  confirmError: "reset-confirm-error",
  noLink: "reset-no-link",
  requestNew: "reset-request-new",
  backToSignIn: "reset-back-to-sign-in",
  username: "reset-username",
  replaces: "reset-replaces",
  leaveConfirm: "reset-leave-confirm",
  stay: "reset-stay",
  leave: "reset-leave",
} as const;

export const inviteTestid = {
  input: "invite-code-input",
  submit: "invite-submit",
  error: "invite-error",
  paused: "invite-paused",
  notNeeded: "invite-not-needed",
  attempts: "invite-attempts",
  rateLimited: "invite-rate-limited",
  accountEmail: "invite-account-email",
  signOut: "invite-sign-out",
  help: "invite-help",
  goToDecks: "invite-go-to-decks",
  redeemed: "invite-redeemed",
  whereFrom: "invite-where-from",
  playAi: "invite-play-ai",
  refused: "invite-refused",
  unverified: "invite-unverified",
  resend: "invite-resend",
  resendNotice: "invite-resend-notice",
  checkAgain: "invite-check-again",
  checkResult: "invite-check-result",
} as const;

export const codeFieldTestid = {
  root: "code-field",
  progress: "code-field-progress",
  hint: "code-field-hint",
} as const;

/** `code-field-segment-${index}`. */
export function codeFieldSegmentTestid(index: number): string {
  return `code-field-segment-${String(index)}`;
}

export const shellTestid = {
  loading: "gate-loading",
  error: "gate-error",
  retry: "gate-retry",
  home: "gate-home",
  signOut: "gate-sign-out",
  notFound: "not-found",
  notFoundHome: "not-found-home",
  slow: "gate-slow",
  loadFailed: "load-failed",
  reload: "load-failed-reload",
  loadFailedHome: "load-failed-home",
} as const;
