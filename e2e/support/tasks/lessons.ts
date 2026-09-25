// `cy.task("tutorialLessons")`: the tutorial's lessons as the web source states them (SPEC §9.10).
//
// Specs 22 and 23 assert that a lesson plays with its own seed, seat and two fixed decks (R291) and
// the tutorial handicap (R290). Those lists are content another team edits, so a spec never copies
// them: this task reads apps/web/src/tutorial/lessons.ts (and AI_TUTORIAL, and the catalog's
// Quickdraw tag) at spec time, in a child process under the repo's own tsx, exactly as the
// replayHash task folds a log (replay.ts). The client under test must be built from the same
// source, which is why the README says to rebuild after a lesson changes.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export type TutorialLessonData = {
  id: string;
  /** 1-based: the path's order. */
  number: number;
  title: string;
  seed: string;
  humanSeat: "p1" | "p2";
  humanDeck: string[];
  aiDeck: string[];
};

export type TutorialData = {
  /** In path order. */
  lessons: TutorialLessonData[];
  /** AI_TUTORIAL (packages/engine/src/config.ts, R290). */
  aiTutorial: Record<string, number>;
  /** Catalog ids tagged Quickdraw. */
  quickdraw: string[];
};

type RunnerEnvelope = ({ ok: true } & TutorialData) | { ok: false; error: string };

export function tutorialLessons(projectRoot: string): TutorialData {
  const repoRoot = path.resolve(projectRoot, "..");
  const tsx = path.join(repoRoot, "node_modules", ".bin", "tsx");
  if (!existsSync(tsx)) {
    throw new Error(`tutorialLessons: ${tsx} is missing. Run pnpm install at the repo root.`);
  }
  const runner = path.join(projectRoot, "support", "tasks", "lessons-runner.ts");

  let stdout: string;
  try {
    stdout = execFileSync(tsx, [runner], { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    const detail = error instanceof Error && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
    throw new Error(`tutorialLessons: the lesson reader failed to run.\n${detail || String(error)}`, { cause: error });
  }

  const line = stdout.trim().split("\n").at(-1) ?? "";
  let envelope: RunnerEnvelope;
  try {
    envelope = JSON.parse(line) as RunnerEnvelope;
  } catch {
    throw new Error(`tutorialLessons: could not read the lesson reader's output:\n${stdout}`);
  }
  if (!envelope.ok) throw new Error(`tutorialLessons: ${envelope.error}`);
  return { lessons: envelope.lessons, aiTutorial: envelope.aiTutorial, quickdraw: envelope.quickdraw };
}
