import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "cards",
    include: ["test/**/*.test.ts"],
    // Rebuilds `src/scripts/_generated.ts` from the files in `src/scripts/` before the tests load,
    // so adding a card script file is the only step a card agent takes (BUILD M4-T2).
    globalSetup: ["test/globalSetup.ts"],
  },
});
