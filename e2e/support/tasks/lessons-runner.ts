// Run by support/tasks/lessons.ts under the repo's own tsx, from the repo root.
//
// Prints one JSON line: { ok: true, lessons, aiTutorial, quickdraw } | { ok: false, error }
//
//   lessons     apps/web/src/tutorial/lessons.ts's TUTORIAL_LESSONS, in path order: each lesson's
//               id, number, title, seed, seat and its two fixed decks (SPEC §9.10, R291);
//   aiTutorial  AI_TUTORIAL from packages/engine/src/config.ts, the tutorial opponent's handicap (R290);
//   quickdraw   the catalog ids tagged Quickdraw (packages/cards/catalog.json).
//
// Specs 22 and 23 compare what the page plays against these, so no card list is ever copied into a
// spec by hand. Like replay-runner.ts, this file is excluded from e2e/tsconfig.json on purpose: it
// is one of the two places in e2e/ that reach into apps/* and packages/*.

import { readFileSync } from "node:fs";

type Lesson = {
  id: string;
  number: number;
  title: string;
  seed: string;
  humanSeat: string;
  humanDeck: readonly string[];
  aiDeck: readonly string[];
};

type CatalogEntry = { id?: string; tags?: unknown };

async function main(): Promise<void> {
  const { TUTORIAL_LESSONS } = (await import("../../../apps/web/src/tutorial/lessons.ts")) as {
    TUTORIAL_LESSONS: readonly Lesson[];
  };
  const { AI_TUTORIAL } = (await import("../../../packages/engine/src/config.ts")) as {
    AI_TUTORIAL: Record<string, number>;
  };
  const catalog = JSON.parse(readFileSync("packages/cards/catalog.json", "utf8")) as Record<string, CatalogEntry>;
  const quickdraw = Object.entries(catalog)
    .filter(([, entry]) => Array.isArray(entry.tags) && entry.tags.includes("Quickdraw"))
    .map(([id]) => id);

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      lessons: TUTORIAL_LESSONS.map((lesson) => ({
        id: lesson.id,
        number: lesson.number,
        title: lesson.title,
        seed: lesson.seed,
        humanSeat: lesson.humanSeat,
        humanDeck: [...lesson.humanDeck],
        aiDeck: [...lesson.aiDeck],
      })),
      aiTutorial: { ...AI_TUTORIAL },
      quickdraw,
    })}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
});
