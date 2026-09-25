// Spec 27 — the tutorial kept on the account (SPEC §9.10, R320–R322), and the email link (R323, R324).
//
// What it proves, against the `E2E=1` server and a `build:e2e` client:
//
//   * a lesson this device has won reaches a signed-in, active account (`PUT /api/tutorial`), and a
//     device that has never seen the tutorial (its `localStorage` empty) finds that lesson completed
//     on the path once the account's copy is read (R320, R321);
//   * Hide tutorial folds the path to one Show tutorial button, focused, and the choice reaches the
//     account; a fresh device opens with the path hidden; Show brings it back, on the account too,
//     and a fresh device then opens with the path shown — the newest choice wins (R321, R322).
//   * at 390x844 both buttons are 44px touch targets and the hidden path scrolls nothing sideways;
//   * an emailed link's PKCE code opened where it was not asked for (no verifier on this device)
//     lands on `/login` with the code scrubbed from the address bar, and says "Your email is
//     confirmed. Sign in to continue." rather than an error (R323, R324).
//
// The account is `e2e-p1`. The E2E server keeps its store for its whole life, and tutorial progress
// only ever grows (R320), so nothing here assumes the account starts empty: every assertion is
// "contains", and each test starts by making an explicit Show choice through the API, which is the
// newest choice by the time the page makes its own.
//
// House rules (BUILD M8): no fixed waits — each read and write the page makes is awaited as the
// intercepted request, the account is read back only after the write it should hold has answered,
// and everything else is a retried assertion on the DOM; every selector comes from
// support/testids.ts. Nothing here starts a game, so there is no seed to set.

import { accounts, server, timeouts, TUTORIAL_PROGRESS_VERSION } from "../../support/config.ts";
import { TUTORIAL_HIDE, TUTORIAL_PATH, TUTORIAL_PATH_HIDDEN, TUTORIAL_SHOW, ts, tutorialLessonId } from "../../support/testids.ts";
import { loginTestid } from "../../../apps/web/src/auth/testids.ts";

/** `/login`'s notices (apps/web/src/auth/testids.ts, as spec 14 reads them). */
const LOGIN_CONFIRMED = loginTestid.confirmed;
const LOGIN_LINK_ERROR = loginTestid.linkError;
import type { TutorialData } from "../../support/tasks/lessons.ts";
import { PRACTICE_PATH, TUTORIAL_BOOT_TIMEOUT, storedProgress, visitTutorial } from "../../support/tutorial.ts";

/** `TutorialProgressView` in apps/server/src/api/tutorial.ts. */
type AccountProgress = { completed: string[]; hiddenChoice: { hidden: boolean; at: number } | null };

/** How long the page may take to read or write the account after it boots. */
const SYNC_TIMEOUT = 20_000;

/** The phone the layout check runs at (docs/polish/7-mobile-ux.md), as spec 23's. */
const PHONE = { width: 390, height: 844 } as const;

/** The smallest touch target the client draws (docs/polish/7-mobile-ux.md). */
const TOUCH_TARGET_PX = 44;

const account = accounts.p1;

function headers(): Record<string, string> {
  return { authorization: `Bearer ${account().token}` };
}

function readAccount(): Cypress.Chainable<AccountProgress> {
  return cy
    .request<{ progress: AccountProgress }>({ method: "GET", url: `${server.http()}/api/tutorial`, headers: headers() })
    .its("body.progress");
}

/** The page's own requests to the account, spied on (never answered by the spec). */
function spyOnTheAccount(): void {
  cy.intercept("GET", "**/api/tutorial").as("load");
  cy.intercept("PUT", "**/api/tutorial").as("save");
}

/** An explicit Show, made now through the API: the newest choice once the page makes its own. */
function showOnTheAccount(): void {
  cy.request({
    method: "PUT",
    url: `${server.http()}/api/tutorial`,
    headers: headers(),
    body: { completed: [], hiddenChoice: { hidden: false, at: Date.now() } },
  });
}

function firstLesson(): Cypress.Chainable<string> {
  return cy.task<TutorialData>("tutorialLessons", undefined, { timeout: timeouts.task }).then((data) => {
    const first = data.lessons[0];
    expect(first, "the tutorial has a first lesson").to.not.eq(undefined);
    return (first as TutorialData["lessons"][number]).id;
  });
}

/** `/practice` as `e2e-p1`, the device holding `completed` (none: a device that never saw the tutorial). */
function visitPractice(completed: string[] | null): void {
  cy.signIn(account());
  visitTutorial(PRACTICE_PATH, {
    progress: completed === null ? null : { v: TUTORIAL_PROGRESS_VERSION, completed },
  });
}

describe("27 — the tutorial kept on the account (R320–R322)", () => {
  beforeEach(() => {
    showOnTheAccount();
  });

  it("a lesson won on this device reaches the account, and a device that never saw the tutorial finds it there", () => {
    firstLesson().then((lessonId) => {
      spyOnTheAccount();
      visitPractice([lessonId]);
      cy.get(ts(tutorialLessonId(lessonId)), { timeout: TUTORIAL_BOOT_TIMEOUT }).should(
        "have.attr",
        "data-status",
        "completed",
      );
      // R321: on load the page reads the account and sends up what it lacks — unless an earlier run
      // against this server already put the lesson there, when there is nothing to send.
      cy.wait("@load", { timeout: SYNC_TIMEOUT }).then((load) => {
        const before = (load.response?.body as { progress: AccountProgress } | undefined)?.progress;
        expect(before, "GET /api/tutorial answered").to.not.eq(undefined);
        if (before?.completed.includes(lessonId) === true) return;
        cy.wait("@save", { timeout: SYNC_TIMEOUT }).its("request.body.completed").should("include", lessonId);
      });
      readAccount().then((progress) => {
        expect(progress.completed, "the account keeps the lesson").to.include(lessonId);
      });

      // A fresh device: nothing in localStorage. The account's copy fills the path in.
      visitPractice(null);
      cy.get(ts(tutorialLessonId(lessonId)), { timeout: TUTORIAL_BOOT_TIMEOUT }).should(
        "have.attr",
        "data-status",
        "completed",
      );
      storedProgress().should((stored) => {
        expect((stored as { completed?: string[] } | null)?.completed ?? [], "the device now keeps it too").to.include(
          lessonId,
        );
      });
    });
  });

  it("Hide tutorial follows the account to a fresh device, and Show brings the path back everywhere", () => {
    spyOnTheAccount();
    visitPractice(null);
    cy.get(ts(TUTORIAL_PATH), { timeout: TUTORIAL_BOOT_TIMEOUT }).should("be.visible");
    cy.wait("@load", { timeout: SYNC_TIMEOUT });
    cy.get(ts(TUTORIAL_HIDE)).should("be.visible").click();

    // R322: one Show tutorial button where the path was, holding the focus.
    cy.get(ts(TUTORIAL_PATH)).should("not.exist");
    cy.get(ts(TUTORIAL_PATH_HIDDEN)).should("be.visible");
    cy.get(ts(TUTORIAL_SHOW)).should("be.focused").and("contain.text", "Show tutorial");
    cy.wait("@save", { timeout: SYNC_TIMEOUT }).its("request.body.hiddenChoice.hidden").should("eq", true);
    readAccount().its("hiddenChoice.hidden").should("eq", true);

    // A fresh device opens with the path hidden: the account's Hide is the newest choice.
    visitPractice(null);
    cy.wait("@load", { timeout: SYNC_TIMEOUT });
    cy.get(ts(TUTORIAL_PATH_HIDDEN), { timeout: TUTORIAL_BOOT_TIMEOUT }).should("be.visible");
    cy.get(ts(TUTORIAL_PATH)).should("not.exist");

    // Show: the path is back, and the Hide button holds the focus.
    cy.get(ts(TUTORIAL_SHOW)).click();
    cy.get(ts(TUTORIAL_PATH)).should("be.visible");
    cy.get(ts(TUTORIAL_HIDE)).should("be.focused");
    cy.wait("@save", { timeout: SYNC_TIMEOUT }).its("request.body.hiddenChoice.hidden").should("eq", false);
    readAccount().its("hiddenChoice.hidden").should("eq", false);

    // And a fresh device again: an older Hide (this test's) does not undo the newer Show.
    visitPractice(null);
    cy.get(ts(TUTORIAL_PATH), { timeout: TUTORIAL_BOOT_TIMEOUT }).should("be.visible");
    cy.get(ts(TUTORIAL_PATH_HIDDEN)).should("not.exist");
  });

  it("on a phone, Hide and Show are full-size touch targets and the hidden path scrolls nothing sideways", () => {
    cy.viewport(PHONE.width, PHONE.height);
    spyOnTheAccount();
    visitPractice(null);
    cy.wait("@load", { timeout: SYNC_TIMEOUT });
    cy.get(ts(TUTORIAL_HIDE), { timeout: TUTORIAL_BOOT_TIMEOUT })
      .should("be.visible")
      .then(($hide) => {
        expect($hide[0]?.getBoundingClientRect().height ?? 0, "Hide is a 44px touch target").to.be.at.least(TOUCH_TARGET_PX);
      })
      .click();
    cy.get(ts(TUTORIAL_SHOW))
      .should("be.visible")
      .then(($show) => {
        const box = $show[0]?.getBoundingClientRect();
        expect(box?.height ?? 0, "Show is a 44px touch target").to.be.at.least(TOUCH_TARGET_PX);
        expect(box?.right ?? Infinity, "Show fits the screen").to.be.at.most(PHONE.width);
      });
    cy.document().then((doc) => {
      expect(doc.documentElement.scrollWidth, "no horizontal scroll").to.be.at.most(doc.documentElement.clientWidth);
    });
    cy.wait("@save", { timeout: SYNC_TIMEOUT }).its("request.body.hiddenChoice.hidden").should("eq", true);
    cy.get(ts(TUTORIAL_SHOW)).click();
    cy.get(ts(TUTORIAL_PATH)).should("be.visible");
    cy.wait("@save", { timeout: SYNC_TIMEOUT }).its("request.body.hiddenChoice.hidden").should("eq", false);
  });
});

describe("27 — the email link (R323, R324)", () => {
  // A `build:e2e` bundle has no auth provider (no `VITE_SUPABASE_URL`, as spec 14 says), so no code
  // can be exchanged here: the exchange, the mailers' challenge and the implicit-flow fallback are
  // proved by the web client's unit tests (auth/pkce.test.ts, net/auth-flows.test.ts,
  // auth/redirect.test.ts, routes/login-flows.test.tsx), which drive the provider's answers. What a
  // real browser adds is the landing: the code is read and scrubbed before anything renders, and a
  // code this browser keeps no verifier for is the cross-device case, which needs no provider.

  /** A GoTrue auth code: a UUID. */
  const CODE = "3f9c6c1e-5a6b-4c2d-9e8f-0a1b2c3d4e5f";
  /** `AUTH_NOTICES.emailConfirmed` (apps/web/src/net/auth.ts), the sentence R324 asks for. */
  const CONFIRMED = "Your email is confirmed. Sign in to continue.";

  it("R324 a link's code opened on another device lands on /login, scrubbed, and says the email is confirmed, not an error", () => {
    // The Site URL fallback (`/`) is where a link lands when `redirect_to` misses the allow-list.
    cy.visit(`/?code=${CODE}`, {
      onBeforeLoad(win) {
        win.localStorage.clear();
      },
    });
    cy.location("pathname").should("eq", "/login");
    cy.location("search").should("eq", "");
    cy.location("href").should("not.contain", CODE);
    cy.get(ts(LOGIN_CONFIRMED)).should("be.visible").and("have.text", CONFIRMED);
    cy.get(ts(LOGIN_LINK_ERROR)).should("not.exist");
    cy.get('[role="alert"]').should("not.exist");
  });
});
