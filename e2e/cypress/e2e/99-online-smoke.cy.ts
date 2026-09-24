/**
 * The deployed stack, in a real Chromium, with two real accounts.
 *
 * Every other spec here drives a LOCAL client against fixtures: specs 01-04 and 07-12 run the
 * engine in the tab with no server at all, and 05, 06, 09 and 10 seed
 * `localStorage["jackioh.e2e.session"]` because ASSUMPTION A6 hands them ready-made tokens. None
 * of that exercises the thing that actually breaks in a deployment — Vercel serving the bundle,
 * Supabase issuing a token to a real password, Render verifying it, and Postgres behind Render.
 * This spec signs in through the form like a person does and asserts each of those in turn.
 *
 * SKIPPED BY DEFAULT. CI runs `cypress run` over every spec against localhost, where none of this
 * exists, so the suite is behind `--env online=true` and is never part of the M8 gate.
 *
 * Run it with:
 *   E2E_BASE_URL=https://jackioh.vercel.app pnpm exec cypress run --browser chrome \
 *     --spec cypress/e2e/99-online-smoke.cy.ts --env online=true,...
 */

/** Cypress 16: `Cypress.env()` is gone; spec-visible values come from `expose`. */
function exposed(key: string, fallback = ""): string {
  const value: unknown = Cypress.expose(key);
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

const ONLINE = exposed("online") === "true";
const SUPABASE_URL = exposed("supabaseUrl");
const SUPABASE_KEY = exposed("supabaseKey");
const SERVER = exposed("serverUrl");
const PASSWORD = exposed("testPassword");
const P1 = exposed("player1", "player1@example.com");
const P2 = exposed("player2", "player2@example.com");

/** A token straight from the auth provider, the same grant the login form uses (SPEC §9.2). */
function tokenFor(email: string): Cypress.Chainable<string> {
  return cy
    .request({
      method: "POST",
      url: `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      body: { email, password: PASSWORD },
    })
    .then((res) => {
      expect(res.status, `${email} signs in`).to.eq(200);
      return String(res.body.access_token);
    });
}

/**
 * Clears queue AND match state, so the spec is re-runnable.
 *
 * Cancelling the queue is not enough and the second run proved it: the first run left both
 * accounts in a live match and every later `POST /api/rooms` came back `409 Conflict`, because
 * `assertNotInMatch` guards both room endpoints and the queue. There is no HTTP route out of a
 * match — only the socket's `concede`, R79's clocks, or the reaper — and `/api/auth/me` does not
 * return the match id a concede would need. So the reset goes through the database
 * (`support/tasks/onlineReset.ts`), which is inert unless `E2E_DATABASE_URL` is set.
 */
function resetOnlineState(): void {
  cy.task("onlineReset").then((result) => {
    const r = result as { ok: boolean; skipped?: string; error?: string; cleared?: unknown };
    if (!r.ok) {
      throw new Error(
        `onlineReset did not run: ${r.skipped ?? r.error ?? "unknown"}. ` +
          "Set E2E_DATABASE_URL so the spec can clear match state between runs.",
      );
    }
    cy.task("log", `onlineReset cleared ${JSON.stringify(r.cleared)}`);
  });
}

/** Signs in through the real form, from a clean session, and waits for the gate to settle. */
function signInThroughForm(email: string): void {
  cy.visit("/login", {
    onBeforeLoad(win) {
      // A different account in the same browser: drop whatever token is there first.
      win.localStorage.removeItem("jackioh.session");
      win.localStorage.removeItem("jackioh.e2e.session");
    },
  });
  cy.get('[data-testid="login-email"]').clear().type(email);
  cy.get('[data-testid="login-password"]').clear().type(PASSWORD, { log: false });
  cy.get('[data-testid="login-submit"]').click();
  cy.location("pathname", { timeout: 40_000 }).should("eq", "/decks");
}

(ONLINE ? describe : describe.skip)("the deployed stack, two real accounts", () => {
  before(() => {
    expect(SUPABASE_URL, "supabaseUrl env").to.not.eq("");
    expect(SERVER, "serverUrl env").to.not.eq("");
    expect(PASSWORD, "testPassword env").to.not.eq("");
  });

  it("serves the client and the deep links the SPA router needs", () => {
    for (const path of ["/", "/login", "/decks", "/play"]) {
      cy.request({ url: path, failOnStatusCode: false }).then((res) => {
        expect(res.status, `GET ${path}`).to.eq(200);
      });
    }
  });

  it("the client it serves is pointed at the deployed server, not localhost", () => {
    cy.request("/").then((res) => {
      const main = /\/assets\/index-[A-Za-z0-9_-]+\.js/.exec(String(res.body))?.[0];
      expect(main, "a main bundle is referenced").to.be.a("string");
      cy.request(String(main)).then((js) => {
        const body = String(js.body);
        expect(body, "the Render URL is compiled in").to.contain(SERVER);
        expect(body, "the localhost fallback is not in use").to.not.contain("localhost:8787");
      });
    });
  });

  it("player 1 signs in THROUGH THE FORM and lands past the invite gate", () => {
    cy.visit("/login");
    cy.get('[data-testid="login-email"]').type(P1);
    cy.get('[data-testid="login-password"]').type(PASSWORD, { log: false });
    cy.get('[data-testid="login-submit"]').click();

    // The gate sends an active account to /decks; a pending one would be bounced to /invite.
    cy.location("pathname", { timeout: 40_000 }).should("eq", "/decks");
    cy.get('[data-testid="login-error"]').should("not.exist");
  });

  it("the collection and the three seeded decks come back from Render", () => {
    tokenFor(P1).then((token) => {
      cy.request({ url: `${SERVER}/api/collection`, headers: { Authorization: `Bearer ${token}` } })
        .then((res) => {
          expect(res.status).to.eq(200);
          expect(res.body.entries, "cards owned").to.have.length.greaterThan(0);
        });
      cy.request({ url: `${SERVER}/api/loadout`, headers: { Authorization: `Bearer ${token}` } })
        .then((res) => {
          expect(res.status).to.eq(200);
          expect(res.body.loadout, "a saved loadout").to.not.eq(null);
        });
    });
  });

  it("two accounts meet in one match through a room code", () => {
    let code = "";
    let t1 = "";
    let t2 = "";

    resetOnlineState();
    tokenFor(P1).then((token) => {
      t1 = token;
    });
    tokenFor(P2).then((token) => {
      t2 = token;
    });

    // Player 1 opens the room.
    cy.then(() =>
      cy
        .request({
          method: "POST",
          url: `${SERVER}/api/rooms`,
          headers: { Authorization: `Bearer ${t1}` },
          body: { deckIndex: 1 },
        })
        .then((res) => {
          expect(res.status, "room created").to.eq(200);
          code = String(res.body.code ?? res.body.roomCode ?? "");
          expect(code, "a 6-character room code (R79)").to.have.length(6);
        }),
    );

    // Player 2 claims it. §9.5: this is the atomic join that flips the match live.
    cy.then(() =>
      cy
        .request({
          method: "POST",
          url: `${SERVER}/api/rooms/${code}/join`,
          headers: { Authorization: `Bearer ${t2}` },
          body: { deckIndex: 1 },
        })
        .then((res) => {
          expect(res.status, "room joined").to.eq(200);
          expect(String(res.body.matchId ?? ""), "the join returns a match id").to.have.length
            .greaterThan(0);
        }),
    );
  });

  /**
   * Both accounts in the browser, not just on the wire: sign in through the form, open a room on
   * one, claim it on the other, and require the real board to render for each.
   *
   * Sequential rather than two tabs because Cypress drives one browser, and it costs nothing
   * here: `play.tsx`'s own comment says "Nothing yet tells the host when the room is claimed, so
   * the match id has to come from the joiner", so the host does not navigate on its own anyway.
   * That gap is the reason step 5 visits /match/<id> directly instead of waiting for a redirect.
   */
  it("both accounts reach the real board in the browser", () => {
    let code = "";
    let matchId = "";

    resetOnlineState();

    // Player 1 signs in and opens a room, through the UI.
    signInThroughForm(P1);
    cy.visit("/play");
    cy.get('[data-testid="play-create-room"]').click();
    cy.get('[data-testid="play-room-code"]', { timeout: 40_000 })
      .invoke("text")
      .then((text) => {
        code = String(text).trim();
        expect(code, "a 6-character room code (R79)").to.have.length(6);
      });

    // Player 2, a different account in the same browser, claims it through the UI.
    cy.then(() => {
      signInThroughForm(P2);
      cy.visit("/play");
      cy.get('[data-testid="play-join-code"]').type(code);
      cy.get('[data-testid="play-join-submit"]').click();

      // The joiner is the one the client navigates.
      cy.location("pathname", { timeout: 60_000 }).should("match", /^\/match\//);
      cy.location("pathname").then((path) => {
        matchId = path.replace("/match/", "");
        expect(matchId, "a match id in the URL").to.have.length.greaterThan(0);
      });
      cy.get('[data-testid="board"]', { timeout: 60_000 }).should("exist");
    });

    // Player 1 opens the same match and gets their own seat's view.
    cy.then(() => {
      signInThroughForm(P1);
      cy.visit(`/match/${matchId}`);
      cy.get('[data-testid="board"]', { timeout: 60_000 }).should("exist");
    });
  });

  /**
   * The ranked queue, which returned 500 to the SECOND player on every pair until the duplicate
   * `matches.create` was removed (`startPairedMatch` wrote the row and then
   * `createMatchRegistry.start` wrote it again). The match was created correctly and the caller
   * was told nothing, so the client never learned the match id — which is why this asserts the
   * RESPONSE, not just the database.
   */
  it("the ranked queue pairs two accounts and tells the second one the match id", () => {
    resetOnlineState();

    let t1 = "";
    let t2 = "";
    tokenFor(P1).then((token) => {
      t1 = token;
    });
    tokenFor(P2).then((token) => {
      t2 = token;
    });

    cy.then(() =>
      cy
        .request({
          method: "POST",
          url: `${SERVER}/api/queue`,
          headers: { Authorization: `Bearer ${t1}` },
          body: { deckIndex: 1 },
        })
        .then((res) => {
          expect(res.status, "first enqueue").to.eq(200);
          expect(res.body.status, "nobody to pair with yet").to.eq("open");
          expect(res.body.matchId, "and so no match").to.eq(null);
        }),
    );

    cy.then(() =>
      cy
        .request({
          method: "POST",
          url: `${SERVER}/api/queue`,
          headers: { Authorization: `Bearer ${t2}` },
          body: { deckIndex: 1 },
        })
        .then((res) => {
          // This is the assertion the bug broke: a 500 here still left a live match behind.
          expect(res.status, "second enqueue — 500 was the bug").to.eq(200);
          expect(String(res.body.matchId ?? ""), "the pairing is reported to the caller").to.have
            .length.greaterThan(0);
        }),
    );
  });

  /**
   * The player who WAITED gets into the match without being told the id by anyone.
   *
   * This is the gap that made two-player play impossible in practice. Only one side's HTTP
   * response carried the match id — the joiner of a room, or whoever enqueued second — so the
   * other player sat on /play while their opponent sat on the board, and the only way to actually
   * play was to paste the URL across. `/api/auth/me` now reports the caller's own
   * `currentMatchId` (§9.5, cleared by every ending) and `/play` waits on it.
   *
   * Player 1 queues IN THE BROWSER and is never handed an id; player 2 is paired from outside the
   * browser entirely. Nothing but the poll can move player 1, so arriving on the board is proof
   * the fix works.
   */
  it("the player who waited is taken to the board with no id handed to them", () => {
    resetOnlineState();

    signInThroughForm(P1);
    cy.visit("/play");
    cy.get('[data-testid="play-queue"]').click();
    // Queued, with nobody to pair against: the old build stopped here forever.
    cy.get('[data-testid="play-status"]', { timeout: 30_000 }).should("exist");
    cy.location("pathname").should("eq", "/play");

    // Player 2 joins the queue from outside the browser; player 1's tab is told nothing.
    tokenFor(P2).then((t2) => {
      cy.request({
        method: "POST",
        url: `${SERVER}/api/queue`,
        headers: { Authorization: `Bearer ${t2}` },
        body: { deckIndex: 1 },
      }).then((res) => {
        expect(res.status, "player 2 enqueues").to.eq(200);
      });
    });

    // Only the poll can do this.
    cy.location("pathname", { timeout: 60_000 }).should("match", /^\/match\//);
    cy.get('[data-testid="board"]', { timeout: 60_000 }).should("exist");
  });

  /**
   * The account screen, which did not exist: a signed-in player could not see which address they
   * were signed in as, could not see a record, and could not sign out at all.
   */
  it("the account screen shows who you are signed in as, and your record", () => {
    signInThroughForm(P1);
    cy.visit("/account");

    cy.get('[data-testid="account-email"]', { timeout: 40_000 }).should("contain.text", P1);
    cy.get('[data-testid="account-status"]').should("have.attr", "data-status", "active");
    // Seeded accounts have played during these runs, so the record is real data off `results`.
    cy.get('[data-testid="account-rating"]').invoke("text").should("match", /^\d+$/);
    cy.get('[data-testid="account-record"]').invoke("text").should("match", /^\d+–\d+–\d+$/);
    cy.get('[data-testid="account-win-rate"]').should("exist");
  });

  it("signing out clears the session and an anonymous visitor is sent back to sign in", () => {
    signInThroughForm(P1);
    cy.visit("/account");
    cy.get('[data-testid="account-sign-out"]', { timeout: 40_000 }).click();

    // A real navigation, so the token is gone from storage as well as from memory.
    cy.location("pathname", { timeout: 40_000 }).should("eq", "/");
    cy.window().then((win) => {
      expect(win.localStorage.getItem("jackioh.session"), "the token is cleared").to.eq(null);
    });

    // And the gate now refuses a guarded screen.
    cy.visit("/decks");
    cy.location("pathname", { timeout: 40_000 }).should("eq", "/login");
  });

  it("every inner screen offers a way back, and the landing offers the account", () => {
    signInThroughForm(P1);

    for (const path of ["/play", "/account"]) {
      cy.visit(path);
      cy.get('[data-testid="nav-back"], [data-testid="account-screen"]', { timeout: 40_000 }).should(
        "exist",
      );
    }

    cy.visit("/play");
    cy.get('[data-testid="nav-back"]').click();
    cy.location("pathname", { timeout: 40_000 }).should("eq", "/");
    cy.get('[data-testid="landing-account"]').should("exist");
  });

  it("the password can be revealed while typing it", () => {
    cy.visit("/login");
    cy.get('[data-testid="login-password"]').should("have.attr", "type", "password");
    cy.get('[data-testid="login-password"]').type("hunter22222");
    cy.get('[data-testid="login-toggle-password"]').click();
    cy.get('[data-testid="login-password"]')
      .should("have.attr", "type", "text")
      .and("have.value", "hunter22222");
  });
});
