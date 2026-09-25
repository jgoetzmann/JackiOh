// `cy.task("replayHash", …)`: determinism check for spec 01.
//
// BUILD M8 spec 01 asserts "final state hash equals the vitest replay of the recorded actions",
// and BUILD M5-T3 asserts "the same seed and actions reproduce the same final state hash in the
// browser and in vitest". Both are the same claim: fold (seed, decks, log) through
// `packages/engine/src/replay.ts` outside the browser and compare `hashState`.
//
// The fold runs in a child process under the repo's own `tsx`, so this task needs neither a build
// step nor a workspace entry for e2e/ — it is the same source the vitest suite imports. The
// recorded log is also written to e2e/artifacts/<label>.json so the engine team can add a literal
// vitest replay over it later.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export type ReplayHashPayload = {
  label: string;
  seed: string;
  decks: [string[], string[]];
  log: unknown[];
  state: unknown;
  /**
   * R180: the game's handicaps, exactly as its `createGame` took them. Spec 13's practice game (R187)
   * needs them to accept the AI seat's 25- or 30-card deck and to replay its extra mana, opening
   * card and draws; spec 25's hotseat games carry a fixture's (`window.__jackioh.handicaps`, a 4- or
   * 60-card library, a bigger opening hand). Absent for every other spec, whose payload is unchanged.
   */
  handicaps?: Partial<Record<"p1" | "p2", unknown>>;
};

export type ReplayHashResult = {
  replayHash: string;
  browserHash: string;
  errors: unknown[];
  logFile: string;
};

type RunnerEnvelope =
  | { ok: true; replayHash: string; browserHash: string; errors: unknown[] }
  | { ok: false; error: string };

export function replayHash(projectRoot: string, payload: ReplayHashPayload): ReplayHashResult {
  const repoRoot = path.resolve(projectRoot, "..");
  const artifacts = path.join(projectRoot, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const logFile = path.join(artifacts, `${payload.label}.json`);
  writeFileSync(
    logFile,
    `${JSON.stringify(
      {
        seed: payload.seed,
        decks: payload.decks,
        log: payload.log,
        ...(payload.handicaps === undefined ? {} : { handicaps: payload.handicaps }),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const tsx = path.join(repoRoot, "node_modules", ".bin", "tsx");
  if (!existsSync(tsx)) {
    throw new Error(
      `replayHash: ${tsx} is missing. Run pnpm install at the repo root; the task folds the ` +
        "recorded log through packages/engine with the repo's own tsx.",
    );
  }
  const runner = path.join(projectRoot, "support", "tasks", "replay-runner.ts");

  let stdout: string;
  try {
    stdout = execFileSync(tsx, [runner], {
      cwd: repoRoot,
      input: JSON.stringify(payload),
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error instanceof Error && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
    throw new Error(`replayHash: the engine fold failed to run.\n${detail || String(error)}`, {
      cause: error,
    });
  }

  const line = stdout.trim().split("\n").at(-1) ?? "";
  let envelope: RunnerEnvelope;
  try {
    envelope = JSON.parse(line) as RunnerEnvelope;
  } catch {
    throw new Error(`replayHash: could not read the fold's output:\n${stdout}`);
  }
  if (!envelope.ok) throw new Error(`replayHash: ${envelope.error}`);

  return {
    replayHash: envelope.replayHash,
    browserHash: envelope.browserHash,
    errors: envelope.errors,
    logFile,
  };
}
