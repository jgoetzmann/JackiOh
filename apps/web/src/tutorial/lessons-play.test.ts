// Scratch smoke test while the lessons are being written: every lesson plays to an end under the
// coach policy. The per-lesson tests replace this.

import { describe, expect, it } from "vitest";

import { TUTORIAL_LESSONS } from "./lessons.ts";
import { playLesson } from "./harness.ts";

describe("tutorial lessons (smoke)", () => {
  for (const lesson of TUTORIAL_LESSONS) {
    it(`plays ${lesson.id} to an end`, { timeout: 300_000 }, () => {
      const t0 = performance.now();
      const run = playLesson(lesson.id);
      console.log(lesson.id, run.winner, "human turns", run.humanTurns, "ms", Math.round(performance.now() - t0), JSON.stringify(run.outcomes));
      expect(run.winner).not.toBeNull();
    });
  }
});
