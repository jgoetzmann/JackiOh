// BUILD M8 spec 10 — "Pending account".
//
// Key assertions (BUILD M8, quoted verbatim):
//
//     "code screen shown; bad code error identical for three failure kinds; good code activates"
//
// THE IDENTICAL ERROR IS A SECURITY PROPERTY, not a cosmetic one. SPEC §9.4: "Missing, expired
// and exhausted codes return an identical error in identical time", and §9.8's "Invite code brute
// force" row makes 80-bit hashed codes worth it only if nothing else leaks. A difference in the
// message, in the status, in one extra `details` field or in the wall clock is an oracle: it tells
// a scanner that a guessed code EXISTS, which is most of the search. So this spec asserts the
// three responses are identical as bytes and bounded in time, not merely "all errors".
//
// R107 is what makes "identical time" observable rather than aspirational: every redemption
// response — the successes and the breaker's 503 too — is padded to
// `REDEMPTION_RESPONSE_FLOOR_MS`, a floor comfortably above the §9.4 transaction's own work, so
// the work each branch did is invisible from outside. The floor is imported from
// `apps/server/src/config.ts`; no number here is a literal.
//
// BUILD M6-T1 owns the tight version of the timing claim ("the three failure responses within
// 5 ms of each other over 50 samples") and that belongs in a unit test with an injected clock:
// 50 samples is ten times §9.4's per-profile attempt limit, and an e2e sample carries HTTP
// transport on top. What this spec can prove, and does, is that the floor is really there and
// that the three kinds do not separate across it.
//
// THE ATTEMPT BUDGET. §9.4 step 2 rejects a profile that "made more than 5 attempts in the last
// hour", and `apps/server/src/config.ts` spells out that the 6th attempt is the first rejection.
// This file spends exactly four logged attempts: three failures plus the good code. The
// already-active re-redemption at the end is rejected at step 1, before step 4's log, so it costs
// nothing. Adding a fifth sample would put the file one attempt from its own rate limit, which is
// why there are three failure kinds here and not four.
//
// R111 is the other half of "good code activates": the launch grant is "one copy of every
// non-token card, written by a trigger on the pending → active transition and idempotent, so a
// repeated redemption cannot double a collection". So activation is asserted twice — once for the
// grant, once for its idempotence — and then by the thing the grant exists for: R111 notes that
// one copy of every non-token card is, with MAX_COPIES = 1 and three decks of 20, exactly enough
// for a legal loadout, so a freshly activated account must be able to save one.
//
// ORDER MATTERS in this file. The gate and the failure kinds are asserted while the fixture
// account is still pending; the last `it` flips it to active and burns the good code. Cypress
// runs `it`s in order, so that is fine within a run — but the `E2E=1` server must reseed
// `e2e-pending` and its invite codes between runs (see the hand-off report).
//
// Needs: M6-T1 (auth, invite gate) and the code screen. See e2e/README.md.

import {
  CODE_ALPHABET,
  CODE_ATTEMPTS_PER_PROFILE_PER_HOUR,
  INVITE_CODE_GROUP_SIZE,
  INVITE_CODE_LENGTH,
  INVITE_CODE_SEPARATOR,
  REDEMPTION_IDENTICAL_ERROR,
  REDEMPTION_RESPONSE_FLOOR_MS,
} from "../../../apps/server/src/config.ts";
import { CARD_NAMES, cardId } from "../../support/cards.ts";
import { accounts, constants, inviteCodes, routes, seedFor, server } from "../../support/config.ts";
import type { FixtureDeck } from "../../support/types.ts";

// ---------------------------------------------------------------------------------------------
// Local scaffolding. Items marked ASK belong in `e2e/support/**` and are in the hand-off report.
// ---------------------------------------------------------------------------------------------

/** ASK (support/commands.ts + support/config.ts): `cy.signIn(account)` and the session key. */
const SESSION_STORAGE_KEY = "jackioh.e2e.session";

/**
 * NOT A SPEC VALUE, and deliberately not R107's floor. The floor is the assertion; this only
 * bounds how far apart two localhost round trips may land before the spread stops being
 * transport. BUILD M6-T1's 5 ms is the tight claim and lives in its unit test (see the header).
 */
const TRANSPORT_JITTER_MS = 100;

/** SPEC §8 numbers 100 Core cards, and R111 grants one copy of each non-token one. */
const CORE_CARD_COUNT = Object.keys(CARD_NAMES).length;

function api(path: string): string {
  return `${server.http()}${path}`;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function pendingToken(): string {
  return accounts.pending().token;
}

type MeBody = {
  profile: { id: string; status: string; rating: number };
  needsInviteCode: boolean;
  emailVerified: boolean;
};

type RedeemBody = {
  status?: string;
  needsInviteCode?: boolean;
  error?: { code: string; message: string; details?: unknown };
};

type CollectionBody = {
  catalogVersion: string;
  entries: { cardId: string; quantity: number }[];
};

function redeem(code: string): Cypress.Chainable<Cypress.Response<RedeemBody>> {
  return cy.request<RedeemBody>({
    method: "POST",
    url: api("/api/codes/redeem"),
    headers: bearer(pendingToken()),
    body: { code },
    failOnStatusCode: false,
  });
}

function me(token: string): Cypress.Chainable<Cypress.Response<MeBody>> {
  return cy.request<MeBody>({
    method: "GET",
    url: api("/api/auth/me"),
    headers: bearer(token),
    failOnStatusCode: false,
  });
}

function visitAs(token: string, path: string): void {
  cy.visit(path, {
    onBeforeLoad(win) {
      win.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken: token }));
    },
  });
}

/** §9.4: "16 characters (80 bits) ... formatted XXXX-XXXX-XXXX-XXXX", over R104's alphabet. */
function expectWellFormedInviteCode(formatted: string): void {
  const groups = formatted.split(INVITE_CODE_SEPARATOR);
  expect(
    groups.length,
    `§9.4: ${String(INVITE_CODE_LENGTH / INVITE_CODE_GROUP_SIZE)} groups of ${String(INVITE_CODE_GROUP_SIZE)}`,
  ).to.eq(INVITE_CODE_LENGTH / INVITE_CODE_GROUP_SIZE);
  for (const group of groups) {
    expect(group.length, `§9.4: groups of ${String(INVITE_CODE_GROUP_SIZE)}`).to.eq(
      INVITE_CODE_GROUP_SIZE,
    );
  }
  const bare = groups.join("");
  expect(bare.length, `§9.4: ${String(INVITE_CODE_LENGTH)} characters, 80 bits over 32 symbols`).to.eq(
    INVITE_CODE_LENGTH,
  );
  for (const character of bare) {
    expect(
      CODE_ALPHABET.includes(character),
      `R104: "${character}" is in the code alphabet ${CODE_ALPHABET}`,
    ).to.eq(true);
  }
}

// ---------------------------------------------------------------------------------------------

describe("10 invite gate — a pending account", () => {
  // BUILD M8: every spec sets a seed. No game is started here, so the seed pins the scenario's
  // identity and lets CI re-run the file with `--expose seed=`.
  const seed = seedFor("10-invite-gate");

  before(() => {
    expect(seed, "BUILD M8: every spec sets a seed").to.be.a("string").and.not.eq("");
    // The suite's own fixture codes have to be codes §9.4 would mint, or a rejection could be
    // "malformed" rather than one of the three kinds under test.
    for (const code of [
      inviteCodes.good(),
      inviteCodes.missing(),
      inviteCodes.expired(),
      inviteCodes.exhausted(),
    ]) {
      expectWellFormedInviteCode(code);
    }
  });

  it("the code screen is shown, and a pending account can reach nothing else", () => {
    // §9.4: "A pending account can log in, verify its email and see the code screen, and nothing
    // else: no collection, loadout, queue or match."
    me(pendingToken()).should((response) => {
      expect(response.status, "`/api/auth/me` is `auth: \"user\"` — this *is* the code screen's read").to.eq(
        200,
      );
      expect(response.body.profile.status).to.eq("pending");
      expect(response.body.needsInviteCode, "so the client knows to show the code screen").to.eq(
        true,
      );
      expect(response.body.emailVerified, "§9.4 makes a verified email a precondition").to.eq(true);
    });

    // The code screen's other read, so it can say "redemption is paused" instead of guessing.
    cy.request<{ redemptionEnabled: boolean; retryAfterMs: number }>({
      method: "GET",
      url: api("/api/codes/status"),
      headers: bearer(pendingToken()),
    }).should((response) => {
      expect(response.status).to.eq(200);
      expect(response.body.redemptionEnabled, "§9.4's circuit breaker is closed").to.eq(true);
      expect(response.body.retryAfterMs).to.eq(0);
    });

    // "and nothing else". One 403 per door §9.4 names.
    const gated: { method: "GET" | "PUT" | "POST"; path: string; body?: Record<string, unknown> }[] = [
      { method: "GET", path: "/api/collection" },
      { method: "GET", path: "/api/loadout" },
      { method: "PUT", path: "/api/loadout", body: { catalogVersion: "whatever", decks: [] } },
      { method: "POST", path: "/api/queue", body: { deckIndex: 0 } },
    ];
    for (const door of gated) {
      cy.request<{ error: { code: string } }>({
        method: door.method,
        url: api(door.path),
        headers: bearer(pendingToken()),
        body: door.body,
        failOnStatusCode: false,
      }).should((response) => {
        expect(response.status, `§9.4's gate closes ${door.method} ${door.path}`).to.eq(403);
        expect(response.body.error.code, "and says why, without naming a rule").to.eq(
          "account_pending",
        );
      });
    }

    // The browser half that needs no new testid: a gated route sends a pending account to the
    // code screen. ASK (support/testids.ts + apps/web): `invite-code-input`, `invite-submit` and
    // `invite-error`, without which the screen's own contents and the typed-in-a-bad-code path
    // cannot be asserted from a spec (see the hand-off report).
    visitAs(pendingToken(), routes.deckbuilder());
    cy.location("pathname").should("eq", routes.invite());

    visitAs(pendingToken(), routes.invite());
    cy.location("pathname").should("eq", routes.invite());
  });

  it("R107 — a missing, an expired and an exhausted code are indistinguishable", () => {
    const kinds: { name: string; code: string }[] = [
      { name: "missing", code: inviteCodes.missing() },
      { name: "expired", code: inviteCodes.expired() },
      { name: "exhausted", code: inviteCodes.exhausted() },
    ];
    expect(
      kinds.length,
      `three samples keeps the file inside §9.4's ${String(CODE_ATTEMPTS_PER_PROFILE_PER_HOUR)}-attempt-per-hour budget`,
    ).to.be.lessThan(CODE_ATTEMPTS_PER_PROFILE_PER_HOUR);

    const bodies: string[] = [];
    const statuses: number[] = [];
    const durations: number[] = [];

    for (const kind of kinds) {
      redeem(kind.code).then((response) => {
        // Asserted per kind as well as across them, so a failure names which kind broke.
        expect(response.status, `${kind.name}: §9.4's rejection is a 400 invalid_code`).to.eq(400);
        expect(response.body.error?.code, `${kind.name}: the same error code`).to.eq("invalid_code");
        expect(response.body.error?.message, `${kind.name}: the one client-facing sentence`).to.eq(
          REDEMPTION_IDENTICAL_ERROR,
        );
        expect(
          response.body.error?.details,
          `${kind.name}: no \`details\` — §9.4 keeps the operator-facing reason in code_attempts, "never returned to the client"`,
        ).to.eq(undefined);
        expect(
          response.duration,
          `${kind.name}: R107 pads every redemption response to ${String(REDEMPTION_RESPONSE_FLOOR_MS)} ms`,
        ).to.be.at.least(REDEMPTION_RESPONSE_FLOOR_MS);

        statuses.push(response.status);
        durations.push(response.duration);
        bodies.push(JSON.stringify(response.body));
      });
    }

    cy.then(() => {
      expect(
        new Set(bodies).size,
        `§9.4: "an identical error" — one response body for all three kinds:\n  ${bodies.join("\n  ")}`,
      ).to.eq(1);
      expect(new Set(statuses).size, "and one status").to.eq(1);

      const spread = Math.max(...durations) - Math.min(...durations);
      expect(
        spread,
        `§9.4: "in identical time" — R107's ${String(REDEMPTION_RESPONSE_FLOOR_MS)} ms floor leaves only transport between them (${durations.join(", ")} ms)`,
      ).to.be.at.most(TRANSPORT_JITTER_MS);
    });
  });

  it("R111 — a good code activates, grants one copy of every non-token card, and is idempotent", () => {
    let granted = "";

    redeem(inviteCodes.good()).should((response) => {
      expect(response.status, "§9.4: redemption flips pending to active").to.eq(200);
      expect(response.body.status).to.eq("active");
      expect(response.body.needsInviteCode, "so the code screen goes away").to.eq(false);
      expect(
        response.duration,
        `R107 pads the success too, or the floor itself would be the oracle (${String(REDEMPTION_RESPONSE_FLOOR_MS)} ms)`,
      ).to.be.at.least(REDEMPTION_RESPONSE_FLOOR_MS);
    });

    me(pendingToken()).should((response) => {
      expect(response.body.profile.status).to.eq("active");
      expect(response.body.needsInviteCode).to.eq(false);
    });

    // R111: "one copy of every non-token card". §9.1: "Everyone owns every card at launch; keep
    // the ledger anyway", which is why this is read from the ledger and not assumed.
    cy.request<CollectionBody>({
      method: "GET",
      url: api("/api/collection"),
      headers: bearer(pendingToken()),
    }).should((response) => {
      expect(response.status, "the gate is open now").to.eq(200);
      const entries = response.body.entries;
      const owned = new Set(entries.map((entry) => entry.cardId));
      const expected = new Set(
        Array.from({ length: CORE_CARD_COUNT }, (_, index) => cardId(index + 1)),
      );

      expect(
        owned.size,
        `R111 grants the ${String(CORE_CARD_COUNT)} non-token cards of SPEC §8 and no token`,
      ).to.eq(expected.size);
      for (const id of expected) {
        expect(owned.has(id), `R111 granted ${id}`).to.eq(true);
      }
      for (const entry of entries) {
        expect(
          entry.quantity,
          `R111 grants one copy, which with MAX_COPIES = ${String(constants.MAX_COPIES)} is exactly enough: ${entry.cardId}`,
        ).to.eq(constants.MAX_COPIES);
      }
      granted = JSON.stringify(entries);
    });

    // Idempotence: "a repeated redemption cannot double a collection" (R111). §9.4 only makes
    // redemption the pending → active transition, so an active account asking again is a
    // conflict — distinguishable from the three code failures on purpose, because it is not one.
    redeem(inviteCodes.good()).should((response) => {
      expect(response.status, "an already-active account is 409, not a code failure").to.eq(409);
      expect(
        response.body.error?.message,
        "§9.4's identical error covers the three code kinds, not the account's own state",
      ).to.not.eq(REDEMPTION_IDENTICAL_ERROR);
    });

    cy.then(() => {
      cy.request<CollectionBody>({
        method: "GET",
        url: api("/api/collection"),
        headers: bearer(pendingToken()),
      }).should((response) => {
        expect(
          JSON.stringify(response.body.entries),
          "R111 is idempotent: the second redemption changed nothing",
        ).to.eq(granted);
      });
    });

    // R111's stated rationale, end to end: the grant is exactly enough for a legal loadout.
    cy.fixture<FixtureDeck>("decks/10-invite-gate-a.json").then((deck) => {
      const used = new Set(deck.cards);
      const spare = Array.from({ length: CORE_CARD_COUNT }, (_, index) => cardId(index + 1)).filter(
        (id) => !used.has(id),
      );
      const size = constants.DECK_SIZE;
      const decks = [[...deck.cards], spare.slice(0, size), spare.slice(size, size * 2)];

      cy.request<{ catalogVersion: string }>({
        method: "GET",
        url: api("/api/loadout"),
        headers: bearer(pendingToken()),
      }).then((current) => {
        cy.request({
          method: "PUT",
          url: api("/api/loadout"),
          headers: bearer(pendingToken()),
          body: { catalogVersion: current.body.catalogVersion, decks },
        })
          .its("status")
          .should("eq", 200);
      });
    });

    // And the screen the gate used to bounce now stays open.
    visitAs(pendingToken(), routes.deckbuilder());
    cy.location("pathname").should("eq", routes.deckbuilder());
  });
});
