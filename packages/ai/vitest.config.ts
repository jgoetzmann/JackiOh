import { defineProject } from "vitest/config";

// The AI's own project (docs/polish/3-ai.md §Tests). The root `projects: ["packages/*", …]` picks it
// up, so `pnpm test` runs the decision tests and the gates at their smoke size; `pnpm ai:gate` runs
// the gate files alone at their full seed counts (JACKIOH_AI_GATE=full). `src/` never registers the
// catalog itself, so the setup file does it for every test file in the project.
export default defineProject({
  test: {
    name: "ai",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
  },
});
