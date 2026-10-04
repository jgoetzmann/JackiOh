// Admin script: opens the build's season (R609) — the same path the server takes at boot.
//
// A season is named by the minor version of the newest patch (R375), so the first deploy of a
// new minor version starts one. Opening it is what runs R609's soft reset: every rated player's
// rating pulled partway to the mean and the deviation widened, in the same transaction as the
// season row — a season is either open and reset or neither.
//
// Run it ahead of such a deploy, against a copy of the live database first (R609):
//
//   pnpm --filter @jackioh/server db:season-start -- --dry-run
//
// `--dry-run` runs the identical path — open the season, reset every rated player — and rolls
// the transaction back, printing the report the real run would write. Without it the writes
// commit: the database now holds the season the next build's boot will find already open.
//
// The script never touches a season that is already open: `openSeasonInTx` answers
// `opened: false` and writes nothing, so the script is safe to re-run.

import { consoleLogger } from "../api/deps";
import {
  loadPatchVersion,
  openSeason,
  openSeasonInTx,
  type OpenedSeason,
  type SeasonDeps,
} from "../api/ranked";
import { systemTimers, type Store } from "../api/ports";
import { loadEnv } from "../env";
import { createPostgresStore } from "./store";

/** What `--dry-run` throws to roll its transaction back: an object only this module can raise. */
const ROLL_BACK = Symbol("season-start.dry-run");

export type SeasonStartOptions = { dryRun: boolean };

/** The one flag. Anything else is a usage error, named in the refusal. */
export function parseSeasonStartArgs(argv: readonly string[]): SeasonStartOptions {
  let dryRun = false;
  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else {
      throw new Error(`usage: db:season-start [--dry-run] — unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return { dryRun };
}

/**
 * R609's season open, through the same `openSeasonInTx` the boot path's `openSeason` calls. On a
 * dry run the report is read out of the transaction and then the transaction is thrown away, so
 * the answer describes exactly what a real run would have done and nothing it did survives.
 */
export async function startSeason(
  store: Store,
  deps: SeasonDeps,
  options: SeasonStartOptions,
): Promise<OpenedSeason> {
  if (!options.dryRun) return openSeason({ ...deps, store });
  let opened: OpenedSeason | undefined;
  try {
    await store.tx(async (t) => {
      opened = await openSeasonInTx(t, deps);
      throw ROLL_BACK;
    });
  } catch (error) {
    if (error !== ROLL_BACK) throw error;
  }
  if (opened === undefined) throw new Error("the dry run produced no report");
  return opened;
}

async function main(): Promise<void> {
  const options = parseSeasonStartArgs(process.argv.slice(2));
  const env = loadEnv();
  const store = createPostgresStore({ connectionString: env.DATABASE_URL });
  try {
    const opened = await startSeason(
      store,
      { patchVersion: await loadPatchVersion(), timers: systemTimers, log: consoleLogger },
      options,
    );
    process.stdout.write(`${JSON.stringify({
      season: opened.season.id,
      patchVersion: opened.season.patchVersion,
      opened: opened.opened,
      dryRun: options.dryRun,
      reset: opened.reset,
    })}\n`);
    process.stderr.write(
      `season-start: ${
        options.dryRun
          ? "dry run — every write above was rolled back"
          : opened.opened
            ? `season ${opened.season.id} opened`
            : `season ${opened.season.id} was already open; nothing written`
      }\n`,
    );
  } finally {
    await store.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
