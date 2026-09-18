import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // CLAUDE.md's command list says `pnpm test` covers engine, cards, validator and server.
    projects: ["packages/*", "apps/server", "apps/web"],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      // Project-relative, NOT repo-relative: with `projects`, coverage resolves these against each
      // project's own root, so a file in packages/engine is seen as `src/...`. The repo-relative
      // globs this used to carry matched nothing, and a threshold over 0/0 files reports "Unknown%"
      // and PASSES — a floor that measured nothing at all. Scope comes from the command instead:
      // `test:coverage` runs the two projects BUILD §4 names.
      include: ["**/src/**"],
      // BUILD §4: 90% line coverage floor for engine and cards.
      thresholds: { lines: 90 },
    },
  },
});
