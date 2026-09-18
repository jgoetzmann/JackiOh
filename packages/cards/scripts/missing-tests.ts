/**
 * Lists the catalog ids with no test file (BUILD M4-T3 acceptance, BUILD §5 definition of done:
 * "`missing-tests.ts` prints nothing"; CLAUDE.md rule 6: every card has one script file and one
 * test file).
 *
 *   pnpm exec tsx packages/cards/scripts/missing-tests.ts    # from the repo root
 *   tsx scripts/missing-tests.ts                             # from packages/cards
 *   pnpm --filter @jackioh/cards missing-tests
 *
 * stdout is the gate: one line per uncovered card, naming the test file it expects, and exit 1.
 * All 109 covered -> stdout is empty and the exit code is 0, so CI can gate a milestone on it.
 *
 * stderr carries two warnings that never change the exit code but stop a typo from hiding forever:
 *   - a card-shaped test filename that names no catalog card (`15-hit-job.test.ts`, unpadded), and
 *   - a test file that reaches the right card through a misspelled slug.
 *
 * Every path resolves from this file's own URL, never `process.cwd()`.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compareSortKeys, expectedBasename, resolveBasename, slugPrefixOf, sortKey } from "./naming";

const TEST_DIR_LABEL = "packages/cards/test";

const TEST_DIR = fileURLToPath(new URL("../test/", import.meta.url));
const CATALOG_PATH = fileURLToPath(new URL("../catalog.json", import.meta.url));

type CatalogEntry = { id: string; name: string };

export type MissingTest = {
  id: string;
  name: string;
  /** The file BUILD M4-T3 expects, package-relative. */
  expected: string;
};

export type TestFileNote = {
  basename: string;
  /** The card it reaches, or `undefined` when the filename names no shipped card. */
  id: string | undefined;
  /** Set when the file reaches a card but is not spelled the way the convention spells it. */
  expected?: string;
};

export type Audit = {
  missing: readonly MissingTest[];
  /** Card-shaped filenames that name no catalog card, plus misspelled slugs. */
  notes: readonly TestFileNote[];
  /** How many of the 109 have a test file. */
  covered: number;
  total: number;
};

/** The catalog read with fs: a script must not import `catalog.json` through the package. */
function catalogEntries(): readonly CatalogEntry[] {
  const raw: unknown = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${CATALOG_PATH}: expected a JSON object keyed by card id`);
  }
  return Object.entries(raw as Record<string, unknown>).map(([id, value]) => {
    const name = (value as { name?: unknown }).name;
    return { id, name: typeof name === "string" ? name : id };
  });
}

/**
 * A filename that is trying to be a card test: the convention starts every one of them with the
 * card's §5 index (`001-`, `051-1-`) or a shared-token prefix (`t-rush`). Anything else in `test/`
 * is a package test (`catalog.test.ts`, `registry.test.ts`, `query.test.ts`, `_harness.ts`) and is
 * none of this script's business.
 */
function looksLikeCardTest(basename: string): boolean {
  return /^\d/.test(basename) || /^t-/.test(basename);
}

export function auditTests(): Audit {
  const entries = catalogEntries();
  const ids = entries.map((entry) => entry.id);
  const nameOf = new Map(entries.map((entry) => [entry.id, entry.name]));

  let files: string[];
  try {
    files = readdirSync(TEST_DIR);
  } catch {
    files = []; // no test/ directory yet: every card is missing its test
  }

  const testedIds = new Set<string>();
  const notes: TestFileNote[] = [];

  for (const file of files) {
    if (!file.endsWith(".test.ts")) continue;
    const basename = file.slice(0, -".test.ts".length);
    // The prefix decides which card a file belongs to, so `resolveBasename` (longest matching id
    // prefix) is what maps file -> card: `051-1-…` is KY's Empty Notebook, not a slug of #51, and
    // `025-4-mana-7-7` is #25 even though its slug opens with a digit segment.
    const id = resolveBasename(basename, ids);
    if (id === undefined) {
      if (looksLikeCardTest(basename)) notes.push({ basename, id: undefined });
      continue;
    }
    testedIds.add(id);
    const expected = expectedBasename(id, nameOf.get(id) ?? id);
    if (basename !== expected) notes.push({ basename, id, expected: `${expected}.test.ts` });
  }

  const missing = entries
    .filter((entry) => !testedIds.has(entry.id))
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      expected: `test/${expectedBasename(entry.id, entry.name)}.test.ts`,
    }))
    .sort((a, b) =>
      compareSortKeys(sortKey(slugPrefixOf(a.id), a.id), sortKey(slugPrefixOf(b.id), b.id)),
    );

  return { missing, notes, covered: testedIds.size, total: entries.length };
}

function main(): void {
  let audit: Audit;
  try {
    audit = auditTests();
  } catch (error) {
    console.error(`missing-tests: FAILED to audit ${TEST_DIR_LABEL}`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  for (const note of audit.notes) {
    if (note.id === undefined) {
      console.error(
        `missing-tests: WARNING ${TEST_DIR_LABEL}/${note.basename}.test.ts names no catalog card` +
          ` — check the filename convention (NNN-slug, NNN-N-slug, t-slug; see scripts/naming.ts).`,
      );
    } else {
      console.error(
        `missing-tests: NOTE ${TEST_DIR_LABEL}/${note.basename}.test.ts covers ${note.id} but the` +
          ` convention spells it ${note.expected}.`,
      );
    }
  }

  if (audit.missing.length === 0) {
    // BUILD §5: the gate is "prints nothing". Say nothing at all on the happy path.
    return;
  }

  // One line per uncovered card, ordered by §5 index, with the file BUILD M4-T3 expects.
  for (const card of audit.missing) {
    console.log(`${card.id}  ${card.name}  ->  ${card.expected}`);
  }
  process.exit(1);
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) main();
