// Spec 14: the landing page and the way in (docs/polish/5-sign-in.md, end to end for B16-B18, B22,
// B23, B29-B31, B37 and B40).
//
// NO SERVER AND NO PROVIDER. Every `${apiUrl}/api/*` call is answered by `cy.intercept` (matched on
// the path, so the host the bundle was built against does not matter), sessions are seeded under
// the fixture key in `onBeforeLoad`, and emailed links are visited as `/login#…` or `/login?…`. A
// `build:e2e` bundle has no `VITE_SUPABASE_URL`, so nothing here ever submits to the auth provider:
// every form below is either refused by client-side validation or never submitted.
//
// The API is cross-origin (the client on :5175, the API on its own port) and every call carries a
// bearer token, so the browser preflights it. The catch-all below answers the preflight itself
// with the CORS headers, and every stub sets `access-control-allow-origin`, so the spec does not
// lean on how Cypress treats preflights.
//
// Paste is a dispatched `ClipboardEvent` carrying a `DataTransfer`, built in the page's own realm.
// An untrusted paste event has no default action, so only a paste the field recognises as a code
// (and fills itself) is observable here; the fall-through path is the unit tests' job.
//
// Run it:
//   pnpm build:e2e
//   pnpm --dir apps/web exec vite preview --port 5175 --strictPort
//   E2E_BASE_URL=http://localhost:5175 pnpm --dir e2e exec cypress run \
//     --spec cypress/e2e/14-landing-and-sign-in.cy.ts

import {
  AUTH_PASSWORD_MIN_LENGTH,
  CODE_ALPHABET,
  CODE_ATTEMPT_WINDOW_SECONDS,
  INVITE_CODE_GROUP_SIZE,
  INVITE_CODE_LENGTH,
  INVITE_CODE_SEPARATOR,
  REDEMPTION_IDENTICAL_ERROR,
} from "../../../apps/server/src/config.ts";
import {
  codeFieldTestid,
  inviteTestid,
  landingTestid,
  loginTestid,
  resetTestid,
  shellTestid,
} from "../../../apps/web/src/auth/testids.ts";
import {
  SESSION_STORAGE_KEY,
  rememberPendingEmail,
  rememberPendingReset,
} from "../../../apps/web/src/net/session.ts";
import { SESSION_STORAGE_KEY as FIXTURE_SESSION_KEY, routes } from "../../support/config.ts";

// ---------------------------------------------------------------------------------------------
// values, all built from config
// ---------------------------------------------------------------------------------------------

const TOKEN = "e2e-token-spec-14";
const EMAIL = "e2e-spec14@jackioh.test";

/** R104's alphabet has letters enough for a whole code with no digit in it. */
const LETTERS = CODE_ALPHABET.replace(/[0-9]/g, "");
const BARE_CODE = LETTERS.slice(0, INVITE_CODE_LENGTH);

function grouped(characters: string, separator = INVITE_CODE_SEPARATOR): string {
  const groups: string[] = [];
  for (let index = 0; index < characters.length; index += INVITE_CODE_GROUP_SIZE) {
    groups.push(characters.slice(index, index + INVITE_CODE_GROUP_SIZE));
  }
  return groups.join(separator);
}

const FULL_CODE = grouped(BARE_CODE);

/** ASCII letters and digits the alphabet leaves out: R104's 0, 1, I and O. */
const EXCLUDED = [..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"].filter((c) => !CODE_ALPHABET.includes(c));

/** Stands for whatever sentence the server's 429 carries; the screen must relay it verbatim. */
const SERVER_RATE_SENTENCE = "Too many attempts. Wait, then try again. (spec 14 stub)";
const WINDOW_MS = CODE_ATTEMPT_WINDOW_SECONDS * 1000;

/** Provider text that must never reach the page (R193). */
const PROVIDER_TEXT = "PROVIDER-SAYS-7f3a Email link is invalid or has expired";

/**
 * The routes support/config.ts does not carry. `paths` in apps/web/src/net/navigate.ts is the
 * source; it is spelled here because navigate.ts is a React module and e2e type-checks on its own.
 */
const LANDING = "/";
const PRACTICE = "/practice";
const RESET_PASSWORD = "/reset-password";

function byTestid(testid: string): string {
  return `[data-testid="${testid}"]`;
}

// ---------------------------------------------------------------------------------------------
// the stubbed API
// ---------------------------------------------------------------------------------------------

type MeState = "pending" | "active" | "banned" | "failing";

type Api = {
  me: MeState;
  attemptsRemaining: number;
  redeem: "rateLimited" | "invalid";
  /**
   * Who the "server" says a token belongs to, for a token whose payload says otherwise (a forged
   * one). Any other token is answered with the address its own payload names, and a fixture token
   * (not a JWT) with EMAIL: the real server verifies every token, so two tokens are two accounts.
   */
  accounts: Record<string, string>;
};

function corsHeaders(origin: unknown): Record<string, string> {
  return {
    "access-control-allow-origin": typeof origin === "string" ? origin : "*",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-expose-headers": "retry-after",
    "access-control-max-age": "600",
    "content-type": "application/json",
  };
}

function meBody(status: "pending" | "active" | "banned", email: string = EMAIL) {
  return {
    profile: { id: "profile-spec-14", status, rating: 1000 },
    needsInviteCode: status === "pending",
    emailVerified: true,
    currentMatchId: null,
    email,
  };
}

/** The `email` claim of an unsigned JWT's payload, or null for anything else (a fixture token). */
function payloadEmail(token: string): string | null {
  const payload = token.split(".")[1];
  if (payload === undefined || payload.length === 0) return null;
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4))) as { email?: unknown };
    return typeof claims.email === "string" ? claims.email : null;
  } catch {
    return null;
  }
}

/** The bearer token a stubbed request carried. */
function bearerOf(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? (header[0] ?? "") : (header ?? "");
  return value.replace(/^Bearer /, "");
}

/**
 * Stubs every `/api/*` call. The returned object is live: a test changes a field inside `cy.then`
 * and the next request sees it (React's StrictMode may read twice, so a counter would not do).
 */
function stubApi(initial: Partial<Api> = {}): Api {
  const api: Api = { me: "pending", attemptsRemaining: 5, redeem: "rateLimited", accounts: {}, ...initial };

  // Oldest first: Cypress tries the newest matching route first, so this only answers what the
  // routes below do not, preflights included.
  cy.intercept({ pathname: /^\/api\// }, (req) => {
    const headers = corsHeaders(req.headers.origin);
    if (req.method === "OPTIONS") {
      req.reply({ statusCode: 204, headers });
      return;
    }
    req.reply({
      statusCode: 404,
      headers,
      body: { error: { code: "not_found", message: `spec 14 has no stub for ${req.url}` } },
    });
  });

  cy.intercept({ method: "GET", pathname: "/api/auth/me" }, (req) => {
    const headers = corsHeaders(req.headers.origin);
    if (api.me === "failing") {
      req.reply({ statusCode: 500, headers, body: { error: { code: "internal", message: "the server fell over" } } });
      return;
    }
    const bearer = bearerOf(req.headers.authorization);
    const email = api.accounts[bearer] ?? payloadEmail(bearer) ?? EMAIL;
    req.reply({ statusCode: 200, headers, body: meBody(api.me, email) });
  }).as("me");

  cy.intercept({ method: "GET", pathname: "/api/codes/status" }, (req) => {
    req.reply({
      statusCode: 200,
      headers: corsHeaders(req.headers.origin),
      body: { redemptionEnabled: true, retryAfterMs: 0, attemptsRemaining: api.attemptsRemaining },
    });
  }).as("status");

  cy.intercept({ method: "POST", pathname: "/api/codes/redeem" }, (req) => {
    const headers = corsHeaders(req.headers.origin);
    if (api.redeem === "invalid") {
      req.reply({
        statusCode: 400,
        headers,
        body: { error: { code: "invalid_code", message: REDEMPTION_IDENTICAL_ERROR } },
      });
      return;
    }
    req.reply({
      statusCode: 429,
      headers: { ...headers, "retry-after": String(Math.ceil(WINDOW_MS / 1000)) },
      body: { error: { code: "rate_limited", message: SERVER_RATE_SENTENCE, details: { retryAfterMs: WINDOW_MS } } },
    });
  }).as("redeem");

  return api;
}

/** Nothing may be sent to the auth provider. A bundle with no provider URL never tries. */
function forbidProvider(): void {
  cy.intercept({ pathname: /\/auth\/v1\// }, () => {
    throw new Error("spec 14 must never reach the auth provider");
  }).as("provider");
}

function visitSignedIn(path: string): void {
  cy.visit(path, {
    onBeforeLoad(win) {
      win.localStorage.setItem(FIXTURE_SESSION_KEY, JSON.stringify({ accessToken: TOKEN }));
    },
  });
}

function sessionKeysIn(win: Window): { real: string | null; fixture: string | null } {
  return {
    real: win.localStorage.getItem(SESSION_STORAGE_KEY),
    fixture: win.localStorage.getItem(FIXTURE_SESSION_KEY),
  };
}

// ---------------------------------------------------------------------------------------------
// emailed links
// ---------------------------------------------------------------------------------------------

function base64url(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** An unsigned three-part JWT whose payload carries an email; the client never verifies it. */
function unsignedJwt(email: string): string {
  const header = base64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ sub: "user-spec-14", email, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 }),
  );
  return `${header}.${payload}.unsigned`;
}

function tokenLink(type: string, accessToken: string): string {
  const params = new URLSearchParams({
    access_token: accessToken,
    refresh_token: "refresh-spec-14",
    expires_at: String(Math.floor(Date.now() / 1000) + 3600),
    expires_in: "3600",
    token_type: "bearer",
    type,
  });
  return `${routes.login()}#${params.toString()}`;
}

function errorLink(params: Record<string, string>, where: "fragment" | "query"): string {
  const encoded = new URLSearchParams(params).toString();
  return where === "fragment" ? `${routes.login()}#${encoded}` : `${routes.login()}?${encoded}`;
}

function expectScrubbed(secret: string): void {
  cy.location("hash").should("eq", "");
  cy.location("href").should("not.contain", secret);
}

// ---------------------------------------------------------------------------------------------
// the code field
// ---------------------------------------------------------------------------------------------

function codeInput(): Cypress.Chainable<JQuery<HTMLElement>> {
  return cy.get(byTestid(inviteTestid.input));
}

function paste(text: string): void {
  codeInput().then(($input) => {
    const input = $input[0];
    if (input === undefined) throw new Error("the code input is not mounted");
    const win = input.ownerDocument.defaultView;
    if (win === null) throw new Error("the code input has no window");
    const data = new win.DataTransfer();
    data.setData("text/plain", text);
    input.focus();
    input.dispatchEvent(new win.ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
}

function openInviteScreen(api: Partial<Api> = {}): Api {
  const live = stubApi({ me: "pending", ...api });
  visitSignedIn(routes.invite());
  codeInput().should("be.visible");
  return live;
}

// =============================================================================================
// B37: the landing page
// =============================================================================================

describe("B37 the landing page", () => {
  it("B37 anonymous: the three CTAs link to /practice, /play and /decks, and the corner offers sign-in", () => {
    stubApi();
    cy.visit(LANDING);

    cy.get(byTestid(landingTestid.root)).should("be.visible");
    cy.get(byTestid(landingTestid.playAi)).should("be.visible").closest("a").should("have.attr", "href", PRACTICE);
    cy.get(byTestid(landingTestid.playOnline)).should("be.visible").closest("a").should("have.attr", "href", routes.play());
    cy.get(byTestid(landingTestid.buildDecks)).should("be.visible").closest("a").should("have.attr", "href", routes.deckbuilder());
    cy.get(byTestid(landingTestid.signIn)).should("be.visible");
    cy.get(byTestid(landingTestid.account)).should("not.exist");

    cy.get(byTestid(landingTestid.signIn)).click();
    cy.location("pathname").should("eq", routes.login());
    cy.get(byTestid(loginTestid.form)).should("be.visible");
  });

  it("B37 signed in: the corner offers landing-account and no sign-in", () => {
    stubApi({ me: "active" });
    visitSignedIn(LANDING);

    cy.get(byTestid(landingTestid.account)).should("be.visible");
    cy.get(byTestid(landingTestid.signIn)).should("not.exist");
  });

  it("B37 Build decks while anonymous goes through the gate to /login", () => {
    stubApi();
    cy.visit(LANDING);
    cy.get(byTestid(landingTestid.buildDecks)).click();
    cy.location("pathname").should("eq", routes.login());
  });

  it("B37 Play vs AI moves the URL to /practice", () => {
    stubApi();
    cy.visit(LANDING);
    cy.get(byTestid(landingTestid.playAi)).click();
    cy.location("pathname").should("eq", PRACTICE);
  });
});

// =============================================================================================
// B16-B18: typing and pasting a code
// =============================================================================================

describe("B16-B18 the code field", () => {
  it("B16 typing eight lower-case letters shows two upper-case groups, the separator added, caret at the end", () => {
    openInviteScreen();
    const eight = BARE_CODE.slice(0, 2 * INVITE_CODE_GROUP_SIZE);

    codeInput().type(eight.toLowerCase());

    codeInput().should("have.value", grouped(eight));
    codeInput().should(($input) => {
      const input = $input[0] as HTMLInputElement | undefined;
      expect(input?.selectionStart, "the caret is at the end").to.eq(input?.value.length);
    });
    cy.get(byTestid(codeFieldTestid.root)).should("have.attr", "data-complete", "false");
  });

  it("B17 pasting an invite sentence fills the field with the one code in it", () => {
    openInviteScreen();

    paste(`Your invite: ${FULL_CODE.toLowerCase()}.`);

    codeInput().should("have.value", FULL_CODE);
    cy.get(byTestid(codeFieldTestid.root)).should("have.attr", "data-complete", "true");
    cy.get(byTestid(inviteTestid.submit)).should("be.enabled");
  });

  it("B17 a padded paste longer than the old 19-character field is never cut short", () => {
    openInviteScreen();
    const padded = ` ${grouped(BARE_CODE.toLowerCase(), " - ")} `;
    expect(padded.length, "the premise: longer than the old maxLength of 19").to.be.greaterThan(19);

    paste(padded);

    codeInput().should("have.value", FULL_CODE);
    cy.get(byTestid(codeFieldTestid.root)).should("have.attr", "data-complete", "true");
  });

  it("B18 typing an excluded character leaves the value alone and names it; the next accepted key clears the hint", () => {
    openInviteScreen();
    const three = BARE_CODE.slice(0, INVITE_CODE_GROUP_SIZE - 1);

    codeInput().type(`${three.toLowerCase()}0`);

    codeInput().should("have.value", three);
    cy.get(byTestid(codeFieldTestid.hint))
      .should("be.visible")
      .and("have.attr", "data-kind", "excluded")
      .invoke("text")
      .then((text) => {
        for (const character of EXCLUDED) expect(text, `the hint names ${character}`).to.contain(character);
      });
    cy.get(byTestid(codeFieldTestid.root)).should("have.attr", "data-problem", "excluded");

    const fourth = BARE_CODE.charAt(INVITE_CODE_GROUP_SIZE - 1);
    codeInput().type(fourth.toLowerCase());

    codeInput().should("have.value", BARE_CODE.slice(0, INVITE_CODE_GROUP_SIZE));
    cy.get(byTestid(codeFieldTestid.hint)).should("not.exist");
  });

  it("B18 each of R104's excluded characters, in either case, is refused and named", () => {
    openInviteScreen();
    for (const character of EXCLUDED) {
      for (const typed of new Set([character, character.toLowerCase()])) {
        codeInput().clear();
        codeInput().type(`${BARE_CODE.charAt(0).toLowerCase()}${typed}`);
        codeInput().should("have.value", BARE_CODE.charAt(0));
        cy.get(byTestid(codeFieldTestid.hint)).should("have.attr", "data-kind", "excluded");
        cy.get(byTestid(codeFieldTestid.hint)).should("contain.text", character);
      }
    }
  });
});

// =============================================================================================
// B22: a rate limit is a rate limit (R192)
// =============================================================================================

describe("B22 a rate-limited redemption", () => {
  it("B22 shows the server's sentence and the wait, disables submit, and never shows R145's error", () => {
    const api = openInviteScreen({ redeem: "rateLimited" });
    paste(FULL_CODE);
    cy.get(byTestid(inviteTestid.submit)).should("be.enabled");
    cy.then(() => {
      api.attemptsRemaining = 4;
    });

    cy.get(byTestid(inviteTestid.submit)).click();

    cy.wait("@redeem").its("request.body").should("deep.equal", { code: FULL_CODE });
    cy.get(byTestid(inviteTestid.error)).should("have.text", SERVER_RATE_SENTENCE);
    cy.get(byTestid(inviteTestid.rateLimited))
      .should("be.visible")
      .and("have.attr", "data-retry-after-ms", String(WINDOW_MS));
    cy.get(byTestid(inviteTestid.submit)).should("be.disabled");
    cy.get("body").should("not.contain.text", REDEMPTION_IDENTICAL_ERROR);
  });

  it("B22 an invalid code still reads R145's identical sentence, with no rate-limit panel", () => {
    openInviteScreen({ redeem: "invalid" });
    paste(FULL_CODE);
    cy.get(byTestid(inviteTestid.submit)).click();

    cy.wait("@redeem");
    cy.get(byTestid(inviteTestid.error)).should("have.text", REDEMPTION_IDENTICAL_ERROR);
    cy.get(byTestid(inviteTestid.rateLimited)).should("not.exist");
  });
});

// =============================================================================================
// B23: the code screen always has a way out
// =============================================================================================

/** `navTestid.back` in `apps/web/src/routes/nav.tsx`, which is JSX and stays out of this bundle. */
const NAV_BACK = "nav-back";

describe("B23 the invite screen's way out", () => {
  it("B23 offers back, the account's email and sign-out; sign-out clears both keys and lands on /", () => {
    stubApi({ me: "pending" });
    cy.visit(routes.invite(), {
      onBeforeLoad(win) {
        win.localStorage.setItem(FIXTURE_SESSION_KEY, JSON.stringify({ accessToken: TOKEN }));
        win.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken: TOKEN }));
      },
    });
    codeInput().should("be.visible");

    cy.get(byTestid(NAV_BACK)).should("be.visible");
    cy.get(byTestid(inviteTestid.accountEmail)).should("have.text", EMAIL);
    cy.get(byTestid(inviteTestid.signOut)).should("be.visible").click();

    cy.location("pathname").should("eq", LANDING);
    cy.get(byTestid(landingTestid.root)).should("be.visible");
    cy.get(byTestid(landingTestid.signIn)).should("be.visible");
    cy.window().then((win) => {
      expect(sessionKeysIn(win)).to.deep.equal({ real: null, fixture: null });
    });
  });
});

// =============================================================================================
// B29, B30: emailed links (R193)
// =============================================================================================

describe("B29 a confirmation link", () => {
  it("R193 B29 whose email matches the sign-up this browser started still signs nothing in: the player signs in with their password", () => {
    // An address someone else registered first keeps their password when the player signs up
    // again (the provider leaves an unconfirmed account alone), so the link is never proof of it.
    stubApi({ me: "pending" });
    forbidProvider();
    const jwt = unsignedJwt(EMAIL);

    cy.visit(tokenLink("signup", jwt), {
      onBeforeLoad() {
        // Spec and page share an origin, so this writes the page's own storage, as a sign-up would.
        rememberPendingEmail(EMAIL);
      },
    });

    cy.get(byTestid(loginTestid.confirmed)).should("be.visible");
    cy.location("pathname").should("eq", routes.login());
    cy.get(byTestid(loginTestid.password)).should("be.visible").and("have.value", "");
    expectScrubbed(jwt);
    cy.window().then((win) => {
      expect(sessionKeysIn(win)).to.deep.equal({ real: null, fixture: null });
      expect(win.localStorage.getItem(SESSION_STORAGE_KEY)).to.eq(null);
    });
  });

  it("B29 with no sign-up remembered stores nothing, says the email is confirmed and fills in nothing", () => {
    stubApi();
    forbidProvider();
    const jwt = unsignedJwt(EMAIL);

    cy.visit(tokenLink("signup", jwt));

    cy.get(byTestid(loginTestid.confirmed)).should("be.visible");
    // A link can be anyone's: an address from it, filled in, would arm this browser's guard.
    cy.get(byTestid(loginTestid.email)).should("have.value", "");
    cy.location("pathname").should("eq", routes.login());
    expectScrubbed(jwt);
    cy.window().then((win) => {
      expect(sessionKeysIn(win)).to.deep.equal({ real: null, fixture: null });
    });
  });

  it("B29 whose email differs from the remembered sign-up stores nothing (login CSRF)", () => {
    stubApi();
    forbidProvider();
    const jwt = unsignedJwt("attacker@jackioh.test");

    cy.visit(tokenLink("signup", jwt), {
      onBeforeLoad() {
        rememberPendingEmail(EMAIL);
      },
    });

    cy.get(byTestid(loginTestid.confirmed)).should("be.visible");
    cy.location("pathname").should("eq", routes.login());
    expectScrubbed(jwt);
    cy.window().then((win) => {
      expect(sessionKeysIn(win)).to.deep.equal({ real: null, fixture: null });
    });
  });

  it("R193 a token whose payload names the remembered address, but which the server says is another account's, stores nothing", () => {
    const api = stubApi();
    forbidProvider();
    // The payload is readable, never verified: it claims the victim's address.
    const jwt = unsignedJwt(EMAIL);
    api.accounts[jwt] = "attacker@jackioh.test";

    cy.visit(tokenLink("signup", jwt), {
      onBeforeLoad() {
        rememberPendingEmail(EMAIL);
      },
    });

    cy.get(byTestid(loginTestid.confirmed)).should("be.visible");
    cy.location("pathname").should("eq", routes.login());
    cy.get(byTestid(loginTestid.email)).should("have.value", "");
    expectScrubbed(jwt);
    cy.window().then((win) => {
      expect(sessionKeysIn(win)).to.deep.equal({ real: null, fixture: null });
    });
  });
});

describe("B30 a recovery link and an expired link", () => {
  it("B30 a recovery link goes to /reset-password, shows the address, and keeps the session out of storage", () => {
    stubApi();
    forbidProvider();
    const jwt = unsignedJwt(EMAIL);

    // R193: only a reset this browser asked for is accepted.
    cy.visit(tokenLink("recovery", jwt), {
      onBeforeLoad() {
        rememberPendingReset(EMAIL);
      },
    });

    cy.location("pathname").should("eq", RESET_PASSWORD);
    cy.get(byTestid(resetTestid.email)).should("contain.text", EMAIL);
    expectScrubbed(jwt);
    cy.window().then((win) => {
      expect(sessionKeysIn(win)).to.deep.equal({ real: null, fixture: null });
    });
  });

  it("R193 a recovery link this browser never asked for holds nothing until the player types the address it was sent to", () => {
    stubApi();
    forbidProvider();
    const jwt = unsignedJwt("attacker@jackioh.test");

    cy.visit(tokenLink("recovery", jwt));

    cy.get(byTestid(loginTestid.recoveryClaim)).should("be.visible");
    cy.get(byTestid(loginTestid.form)).should("have.attr", "data-mode", "claimReset");
    cy.get(byTestid(loginTestid.email)).should("have.value", "");
    cy.location("pathname").should("eq", routes.login());
    expectScrubbed(jwt);

    // Someone sent another person's link types their own address: refused beside the field.
    cy.get(byTestid(loginTestid.email)).type(EMAIL);
    cy.get(byTestid(loginTestid.submit)).click();
    cy.get(byTestid(loginTestid.emailError)).should("be.visible");
    cy.location("pathname").should("eq", routes.login());
    cy.window().then((win) => {
      expect(sessionKeysIn(win)).to.deep.equal({ real: null, fixture: null });
    });
  });

  it("R193 a reset asked for on another device works here once the player types its address", () => {
    stubApi();
    forbidProvider();
    const jwt = unsignedJwt(EMAIL);

    cy.visit(tokenLink("recovery", jwt));

    cy.get(byTestid(loginTestid.recoveryClaim)).should("be.visible");
    cy.get(byTestid(loginTestid.email)).type(EMAIL.toUpperCase());
    cy.get(byTestid(loginTestid.submit)).click();
    cy.location("pathname").should("eq", RESET_PASSWORD);
    cy.get(byTestid(resetTestid.email)).should("contain.text", EMAIL);
    cy.window().then((win) => {
      expect(sessionKeysIn(win)).to.deep.equal({ real: null, fixture: null });
    });
  });

  for (const where of ["fragment", "query"] as const) {
    it(`B30 an otp_expired link in the ${where} shows the link error, resend and forgot, and never the provider's text`, () => {
      stubApi();
      forbidProvider();

      cy.visit(
        errorLink({ error: "access_denied", error_code: "otp_expired", error_description: PROVIDER_TEXT }, where),
      );

      cy.get(byTestid(loginTestid.linkError)).should("be.visible");
      cy.get(byTestid(loginTestid.resend)).should("be.visible");
      cy.get(byTestid(loginTestid.forgot)).should("be.visible");
      cy.get("body").should("not.contain.text", "PROVIDER-SAYS-7f3a");
      cy.location("pathname").should("eq", routes.login());
      cy.location("hash").should("eq", "");
      cy.location("search").should("eq", "");
    });
  }

  it("B30 another link error shows the same link error, and markup in its description is never rendered", () => {
    stubApi();
    forbidProvider();

    cy.visit(
      errorLink(
        {
          error: "server_error",
          error_code: "unexpected_failure",
          error_description: '<img src="x" data-spec14="xss" onerror="window.__spec14Xss = true">',
        },
        "fragment",
      ),
    );

    cy.get(byTestid(loginTestid.linkError)).should("be.visible");
    cy.get('[data-spec14="xss"]').should("not.exist");
    cy.get("body").should("not.contain.text", "onerror");
    cy.window().should("not.have.property", "__spec14Xss");
    cy.location("hash").should("eq", "");
  });

  it("B30 the forgot action beside a link error opens the forgot form", () => {
    stubApi();
    forbidProvider();
    cy.visit(errorLink({ error: "access_denied", error_code: "otp_expired" }, "fragment"));

    cy.get(byTestid(loginTestid.forgot)).click();

    cy.get(byTestid(loginTestid.form)).should("have.attr", "data-mode", "forgot");
  });
});

// =============================================================================================
// B31: /reset-password
// =============================================================================================

describe("B31 the reset screen", () => {
  function openWithRecoveryLink(): void {
    stubApi();
    forbidProvider();
    cy.visit(tokenLink("recovery", unsignedJwt(EMAIL)), {
      onBeforeLoad() {
        rememberPendingReset(EMAIL);
      },
    });
    cy.location("pathname").should("eq", RESET_PASSWORD);
    cy.get(byTestid(resetTestid.form)).should("be.visible");
  }

  it("B31 refuses a password shorter than AUTH_PASSWORD_MIN_LENGTH without sending it", () => {
    openWithRecoveryLink();
    const short = "p".repeat(AUTH_PASSWORD_MIN_LENGTH - 1);

    cy.get(byTestid(resetTestid.password)).type(short);
    cy.get(byTestid(resetTestid.confirm)).type(short);
    cy.get(byTestid(resetTestid.submit)).click();

    cy.get(byTestid(resetTestid.passwordError)).should("be.visible");
    cy.get(byTestid(resetTestid.password)).should("have.attr", "aria-invalid", "true");
    cy.location("pathname").should("eq", RESET_PASSWORD);
    cy.window().then((win) => {
      expect(sessionKeysIn(win)).to.deep.equal({ real: null, fixture: null });
    });
  });

  it("B31 refuses a confirmation that does not match, without sending it", () => {
    openWithRecoveryLink();
    const password = "p".repeat(AUTH_PASSWORD_MIN_LENGTH + 4);

    cy.get(byTestid(resetTestid.password)).type(password);
    cy.get(byTestid(resetTestid.confirm)).type(`${password}x`);
    cy.get(byTestid(resetTestid.submit)).click();

    cy.get(byTestid(resetTestid.confirmError)).should("be.visible");
    cy.location("pathname").should("eq", RESET_PASSWORD);
    cy.window().then((win) => {
      expect(sessionKeysIn(win)).to.deep.equal({ real: null, fixture: null });
    });
  });

  it("B31 the new password can be shown and hidden", () => {
    openWithRecoveryLink();
    cy.get(byTestid(resetTestid.password)).should("have.attr", "type", "password");
    cy.get(byTestid(resetTestid.togglePassword)).click();
    cy.get(byTestid(resetTestid.password)).should("have.attr", "type", "text");
    cy.get(byTestid(resetTestid.togglePassword)).click();
    cy.get(byTestid(resetTestid.password)).should("have.attr", "type", "password");
  });

  it("B31 without a recovery session it shows reset-no-link; request-new opens the forgot form", () => {
    stubApi();
    cy.visit(RESET_PASSWORD);

    cy.get(byTestid(resetTestid.noLink)).should("be.visible");
    cy.get(byTestid(resetTestid.form)).should("not.exist");
    cy.get(byTestid(resetTestid.requestNew)).click();

    cy.location("pathname").should("eq", routes.login());
    cy.get(byTestid(loginTestid.form)).should("have.attr", "data-mode", "forgot");
  });

  it("B31 without a recovery session, back-to-sign-in goes to /login", () => {
    stubApi();
    cy.visit(RESET_PASSWORD);

    cy.get(byTestid(resetTestid.backToSignIn)).click();

    cy.location("pathname").should("eq", routes.login());
    cy.get(byTestid(loginTestid.form)).should("be.visible");
  });
});

// =============================================================================================
// B40: no dead ends in the shell
// =============================================================================================

describe("B40 the shell's exits", () => {
  it("B40 the gate's error panel offers retry, home and sign-out; retry opens the gate once /api/auth/me answers", () => {
    const api = stubApi({ me: "failing" });
    visitSignedIn(routes.invite());

    cy.get(byTestid(shellTestid.error)).should("be.visible");
    cy.get(byTestid(shellTestid.retry)).should("be.visible");
    cy.get(byTestid(shellTestid.home)).should("be.visible");
    cy.get(byTestid(shellTestid.signOut)).should("be.visible");

    cy.then(() => {
      api.me = "pending";
    });
    cy.get(byTestid(shellTestid.retry)).click();

    codeInput().should("be.visible");
    cy.get(byTestid(shellTestid.error)).should("not.exist");
    cy.location("pathname").should("eq", routes.invite());
  });

  it("B40 gate-home on the error panel goes to the landing page", () => {
    stubApi({ me: "failing" });
    visitSignedIn(routes.deckbuilder());

    cy.get(byTestid(shellTestid.home)).click();

    cy.location("pathname").should("eq", LANDING);
    cy.get(byTestid(landingTestid.root)).should("be.visible");
  });

  it("B40 the banned panel offers home and sign-out; sign-out clears the session and loads /", () => {
    stubApi({ me: "banned" });
    visitSignedIn(routes.deckbuilder());

    cy.get(byTestid(shellTestid.home)).should("be.visible");
    cy.get(byTestid(shellTestid.signOut)).should("be.visible").click();

    cy.location("pathname").should("eq", LANDING);
    cy.get(byTestid(landingTestid.root)).should("be.visible");
    cy.get(byTestid(landingTestid.signIn)).should("be.visible");
    cy.window().then((win) => {
      expect(sessionKeysIn(win)).to.deep.equal({ real: null, fixture: null });
    });
  });

  it("B40 the 404 panel says so in a player's words and offers a way home", () => {
    stubApi();
    cy.visit("/no-such-screen");

    cy.get(byTestid(shellTestid.notFound)).should("be.visible").and("contain.text", "That page doesn’t exist.");
    cy.get(byTestid(shellTestid.notFoundHome)).click();

    cy.location("pathname").should("eq", LANDING);
    cy.get(byTestid(landingTestid.root)).should("be.visible");
  });
});
