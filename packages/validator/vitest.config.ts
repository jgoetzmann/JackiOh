import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "validator",
    include: ["test/**/*.test.ts"],
  },
});
