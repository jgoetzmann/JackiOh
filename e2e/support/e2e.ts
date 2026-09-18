// Loaded before every spec (cypress.config.ts -> supportFile).

import "./commands.ts";

// BUILD M8: "No fixed `cy.wait(ms)`; waits are on `data-animating` clearing or on testids."
// The rule is enforced, not just documented: a numeric wait fails the spec that used it.
const refuseFixedWait = (
  originalFn: (...args: unknown[]) => unknown,
  ...args: unknown[]
): unknown => {
  if (typeof args[0] === "number") {
    throw new Error(
      "BUILD M8 forbids a fixed cy.wait(ms). Wait on `data-animating` clearing (cy.settled()) " +
        "or on a testid instead.",
    );
  }
  return originalFn(...args);
};

// `as never` only silences the overload gymnastics of Commands.overwrite; the guard itself is
// fully typed above.
Cypress.Commands.overwrite("wait", refuseFixedWait as never);

// Every TEST starts with no socket of its own and no match left running.
//
// `support/tasks/index.ts` already resets the Node clients in `before:spec` / `after:spec`, and
// that reset now concedes a match a spec left live (spec 05 ends with its match still running, on
// purpose). But those hooks fire once per spec FILE, not once per attempt — and `retries.runMode`
// is 1. So without this, attempt 2 of a networked spec opens against the match attempt 1 left
// behind: `POST /api/rooms` answers `409 already_in_match` and buries the real attempt-1 failure
// under a misleading one. For a spec that opened no socket this is a no-op.
beforeEach(() => {
  cy.task("wsPlayer", { action: "reset" }, { log: false });
});

// An uncaught error in the client is a spec failure; nothing here swallows it.
// (Cypress fails the test by default — this hook only makes the intent explicit for reviewers.)
Cypress.on("uncaught:exception", () => true);
