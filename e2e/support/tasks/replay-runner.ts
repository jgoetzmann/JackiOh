// Run by support/tasks/replay.ts under the repo's own tsx, from the repo root.
//
// Reads {seed, decks, log, state, handicaps?} as JSON on stdin and prints one JSON line:
//   { ok: true, replayHash, browserHash, errors } | { ok: false, error }
//
// This file is excluded from e2e/tsconfig.json on purpose: it is the one place in e2e/ that
// reaches into packages/*, and it must keep type-checking of the specs independent of whatever
// state the engine and cards packages are in.

import { readFileSync } from "node:fs";

type Payload = {
  seed: string;
  decks: [string[], string[]];
  log: unknown[];
  state: unknown;
  /** Spec 13's practice handicaps (R180, R187), passed through to `fold` untouched. */
  handicaps?: Partial<Record<"p1" | "p2", unknown>>;
};

async function main(): Promise<void> {
  const payload = JSON.parse(readFileSync(0, "utf8")) as Payload;

  let cards: { CATALOG: Record<string, unknown>; registerAll?: () => void };
  try {
    cards = (await import("../../../packages/cards/src/index.ts")) as typeof cards;
  } catch (error) {
    // Folding without the card scripts registered would diverge from the browser instead of
    // matching it, so this is a hard stop with a pointer at the real cause.
    throw new Error(
      "@jackioh/cards did not import, so the recorded log cannot be folded with the card " +
        `scripts registered (BUILD M4 must compile first): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const engine = (await import("../../../packages/engine/src/replay.ts")) as {
    fold: (input: {
      seed: string;
      decks: [string[], string[]];
      log: unknown[];
      catalog?: unknown;
      handicaps?: unknown;
    }) => {
      state: unknown;
      errors: unknown[];
    };
    hashState: (state: unknown) => string;
  };

  // Card scripts have to be registered or every Cry in the log fizzles differently than it did in
  // the browser (SPEC §10.9).
  if (typeof cards.registerAll === "function") cards.registerAll();

  const result = engine.fold({
    seed: payload.seed,
    decks: payload.decks,
    log: payload.log,
    catalog: cards.CATALOG,
    ...(payload.handicaps === undefined ? {} : { handicaps: payload.handicaps }),
  });

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      replayHash: engine.hashState(result.state),
      browserHash: engine.hashState(payload.state),
      errors: result.errors,
    })}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
});
