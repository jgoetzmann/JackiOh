// BUILD M8: Cypress runs against apps/web in `E2E=1` mode (the hotseat route plus a test server
// with fixture accounts). Thirteen specs, every one seeded, no fixed waits.

import react from "@vitejs/plugin-react";
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
      // 99-online-smoke.cy.ts only. It drives the DEPLOYED stack with real accounts, so it is
      // skipped unless `online` is "true" and every value comes from the environment — nothing
      // here is committed, and CI (which sets none of them) runs the spec as a skip.
      online: process.env.E2E_ONLINE ?? "",
      supabaseUrl: process.env.E2E_SUPABASE_URL ?? "",
      supabaseKey: process.env.E2E_SUPABASE_KEY ?? "",
      serverUrl: process.env.E2E_SERVER_URL ?? "",
      testPassword: process.env.E2E_TEST_PASSWORD ?? "",
      player1: process.env.E2E_PLAYER1 ?? "",
      player2: process.env.E2E_PLAYER2 ?? "",
    },
    setupNodeEvents(on, config) {
      registerTasks(on, config);
      return config;
    },
  },

  // -------------------------------------------------------------------------------- component ---
  //
  // BUILD M5-T1's acceptance: "a snapshot test renders a fixture `PlayerView` with 10 units, 10
  // backrow cards and a stacked pile **without layout overflow at 1280x720 and 390x844**".
  //
  // The snapshot half is `apps/web/src/game/Board.test.tsx`. The pixel half had nowhere to run:
  // jsdom has no layout engine, and the fullest board the twelve e2e specs can PLAY into existence
  // is six occupied zones (see the block at the end of cypress/e2e/12-rotation-and-swaps.cy.ts) —
  // no deck fixture holds more than one settable backrow card, and /dev/hotseat has no state
  // injection, so 10 units and 10 backrow cards are not reachable from a seeded game. The 10/10
  // board is the case the acceptance names, and it is the case that overflows if anything does.
  //
  // Component testing is the one runner that can put THAT fixture in front of a real layout engine:
  // it mounts `apps/web/src/test/fixtures.ts` `fullBoardView()` — the very fixture the acceptance
  // describes — in a browser, at both viewports. This block is separate from `e2e` in every way
  // that matters to M8: its own `specPattern`, its own support file, its own index page. The e2e
  // suite stays at thirteen files and `cypress run` (no flag) still runs exactly those thirteen.
  component: {
    devServer: {
      framework: "react",
      bundler: "vite",
      viteConfig: {
        // The one plugin apps/web/vite.config.ts uses, so a spec compiles the client the way the
        // client is built rather than through a second, nearly-identical pipeline.
        plugins: [react()],
        // ONE React in the page. `cypress/react` resolves `react` and `react-dom/client` from
        // e2e/node_modules; apps/web/src resolves them from apps/web/node_modules. Two copies of
        // the same version are still two dispatchers, and the first `useState` in `Game.tsx`
        // rendered by the other copy's root throws "Invalid hook call". `dedupe` makes Vite
        // resolve these two ids from the dev-server root (this directory) whatever imports them.
        resolve: { dedupe: ["react", "react-dom"] },
        server: {
          // The specs import apps/web/src/**, which is outside this Vite root. Vite's default
          // allow-list is the workspace root it detects, and e2e/ is deliberately its own pnpm
          // root (e2e/pnpm-workspace.yaml), so that detection stops here and the repo root has to
          // be named. Vite resolves these entries against the Vite root, so ".." is the repo root.
          fs: { allow: [".."] },
          // NOT Vite's default 5173, which is the client's port (apps/web/vite.config.ts, and
          // `vite preview --port 5173` in the CI e2e job). Measured, not guessed: with a client
          // preview server already up, this dev server took 5173 on the IPv4 loopback while the
          // preview held the IPv6 one, Electron resolved `localhost` to 127.0.0.1 and passed, and
          // Chrome resolved it to ::1, fetched `/__cypress/src/support/component.tsx` from the
          // CLIENT, got a 404 and failed the whole spec with "Failed to fetch dynamically imported
          // module". Same trap the e2e job's readiness probe documents. `strictPort` makes a
          // future collision an immediate, legible bind error instead of that.
          port: Number(process.env.E2E_COMPONENT_PORT ?? 5273),
          strictPort: true,
        },
      },
    },
    // `.cy.tsx`, and only under cypress/component: the e2e glob is `cypress/e2e/**/*.cy.ts` and
    // the two cannot collide.
    specPattern: "cypress/component/**/*.cy.tsx",
    supportFile: "support/component.tsx",
    indexHtmlFile: "support/component-index.html",
    // NOT the e2e run's `artifacts/screenshots`: Cypress trashes its screenshots folder at the
    // start of every run, so sharing one would mean a component run silently deleting the
    // evidence a red e2e run had just left behind.
    screenshotsFolder: "artifacts/component/screenshots",
    videosFolder: "artifacts/component/videos",
    video: false,
    screenshotOnRunFailure: true,
    // BUILD M5-T1's first viewport, matching the e2e block above. Nothing measured depends on it:
    // the spec calls `cy.viewport()` for BOTH sizes explicitly rather than inheriting one of them,
    // so a change here cannot quietly move what was measured.
    viewportWidth: 1280,
    viewportHeight: 720,
    // A mounted fixture is deterministic — there is no server, no socket and no seed — so a retry
    // could only ever hide a real layout regression behind a second roll of the same dice.
    retries: { runMode: 0, openMode: 0 },
    // No `testIsolation` here: Cypress rejects the option outright for component testing, where a
    // test is isolated by construction — each one mounts a fresh `fullBoardView()` of its own.
    setupNodeEvents(on) {
      on("task", {
        /**
         * Print a measured layout row in the terminal. Cypress swallows `console.log` from the
         * browser and does not print `cy.log` in run mode, so a number that is only asserted is a
         * number nobody ever reads: this is how the measurement reaches the run output (and the
         * CI log) rather than living and dying inside an assertion.
         */
        "layout:report"(row: unknown) {
          console.log(`[M5-T1 layout] ${JSON.stringify(row)}`);
          return null;
        },
      });
    },
  },
});
