import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // CLAUDE.md's command list says `pnpm test` covers engine, cards, validator and server.
    projects: ["packages/*", "apps/server", "apps/web"],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      include: ["packages/engine/src/**", "packages/cards/src/**"],
      // BUILD §4: 90% line coverage floor for engine and cards.
      thresholds: { lines: 90 },
    },
  },
});
