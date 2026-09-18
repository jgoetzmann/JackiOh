// BUILD M8: Cypress runs against apps/web in `E2E=1` mode (the hotseat route plus a test server
// with fixture accounts). Twelve specs, every one seeded, no fixed waits.

import { defineConfig } from "cypress";
import { registerTasks } from "./support/tasks/index.ts";

export default defineConfig({
  // The layout BUILD §1 fixes: e2e/cypress/e2e/*.cy.ts, e2e/fixtures/decks/*.json, e2e/support/.
  e2e: {
    baseUrl: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    specPattern: "cypress/e2e/**/*.cy.ts",
    supportFile: "support/e2e.ts",
    fixturesFolder: "fixtures",
    screenshotsFolder: "artifacts/screenshots",
    videosFolder: "artifacts/videos",
    downloadsFolder: "artifacts/downloads",
    video: false,
    screenshotOnRunFailure: true,
    // BUILD M5-T1 renders at 1280x720; the responsive case (390x844) is a component test there,
    // and specs that care set their own viewport with cy.viewport().
    viewportWidth: 1280,
    viewportHeight: 720,
    // Waits are assertions, so the command timeout is the only knob. Animations top out at 700 ms
    // (BUILD M5-T4 trapFired); a view push from the match actor is the slow case.
    defaultCommandTimeout: 8_000,
    requestTimeout: 10_000,
    responseTimeout: 20_000,
    // Seeded games are deterministic, so a retry only ever papers over a networked flake. Keep it
    // at one and treat a spec that needs the retry as a bug report.
    retries: { runMode: 1, openMode: 0 },
    testIsolation: true,
    // Cypress 16: spec-visible variables live in `expose` and are read with Cypress.expose(key)
    // (support/config.ts wraps them). Override on the CLI with `--expose wsUrl=…`.
    // `WS_PATH` is `/ws/match` (apps/server/src/match/wsServer.ts); a handshake off that path is
    // never upgraded. support/config.ts carries the same default for the browser side.
    expose: {
      apiUrl: process.env.E2E_API_URL ?? "http://localhost:8787",
      wsUrl: process.env.E2E_WS_URL ?? "ws://localhost:8787/ws/match",
    },
    setupNodeEvents(on, config) {
      registerTasks(on, config);
      return config;
    },
  },
});
