// Polish task 2 (docs/polish/2-sound.md), behaviours B35, B36 and B37: the pre-rendered voice set
// on disk, its manifest, its size budget and `gen-voice.mjs --check`.
//
//   B35  the 153 expected files exist under apps/web/public/audio/voice/, each an MP4 with `ftyp` at
//        byte 4 and brand `M4A ` at byte 8; the manifest lists exactly those keys with each file's
//        size and its recomputed voiceHash; the directory holds nothing else.
//        Each file's MP4 header (moov/mvhd) also puts it within VOICE_FILE_MAX_MS.
//   B36  sum over the files of ceil(bytes / 4096) * 4096 <= VOICE_BUDGET_BYTES (3 MiB).
//   B37  `node apps/web/scripts/gen-voice.mjs --check` exits 0 on the committed tree; with `--root`
//        on a temp copy whose core-004 play line was edited it exits 1 and prints a line starting
//        `core-004-play`.
//
// The Surface's `--check` contract (every expected key has a manifest entry whose hash matches and
// a file of that size, no orphan files or entries; otherwise one line per problem, each starting
// with the key, and exit 1) is what the further B37 cases below exercise, one broken thing at a
// time, each in its own copy of the tree.
//
// voiceHash = sha1(JSON.stringify({ v: 1, say, rate, pbas, pmod, text })).hex.slice(0, 16), keys in
// exactly that order, rate/pbas/pmod the EFFECTIVE values (card override ?? persona). It is
// recomputed here from the Surface's formula, never imported, so the script and this test cannot
// share a mistake.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { VOICE_BUDGET_BYTES, VOICE_FILE_MAX_MS } from "./constants.ts";

const here = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(here, "../..");
const REPO = resolve(WEB, "../..");
const CATALOG_PATH = join(REPO, "packages/cards/catalog.json");
const LINES_PATH = join(here, "voice-lines.json");
const MANIFEST_PATH = join(here, "voice-manifest.json");
const VOICE_DIR = join(WEB, "public/audio/voice");
const GEN_VOICE = join(WEB, "scripts/gen-voice.mjs");

/** Where `--root` expects each file, relative to the web dir it is pointed at (Surface). */
const REL_LINES = join("src", "audio", "voice-lines.json");
const REL_MANIFEST = join("src", "audio", "voice-manifest.json");
const REL_VOICE_DIR = join("public", "audio", "voice");

const EXPECTED_FILE_COUNT = 153;
const BLOCK = 4096;
const CHECK_TIMEOUT_MS = 60_000;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): Json {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(value)) throw new Error(`${path}: expected a JSON object`);
  return value;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// ------------------------------------------------------------------------------ expectations ---

const CATALOG = readJson(CATALOG_PATH) as Record<string, { type?: unknown }>;

/** A play and a death line per Unit (tokens included), one cast line per everything else. */
const EXPECTED_KEYS: readonly string[] = Object.entries(CATALOG).flatMap(([id, card]) =>
  card.type === "Unit" ? [`${id}-play`, `${id}-death`] : [`${id}-cast`],
);
const EXPECTED_FILES: readonly string[] = EXPECTED_KEYS.map((key) => `${key}.m4a`);

const LINES = readJson(LINES_PATH);
const MANIFEST = readJson(MANIFEST_PATH);
const MANIFEST_FILES: Json = isRecord(MANIFEST.files) ? MANIFEST.files : {};

/** "<defId>-<line>", parsed from the END because defIds contain "-" (types.ts). */
function splitKey(key: string): { defId: string; line: string } {
  const at = key.lastIndexOf("-");
  return { defId: key.slice(0, at), line: key.slice(at + 1) };
}

function voiceHash(input: { say: unknown; rate: unknown; pbas: unknown; pmod: unknown; text: unknown }): string {
  const { say, rate, pbas, pmod, text } = input;
  return createHash("sha1")
    .update(JSON.stringify({ v: 1, say, rate, pbas, pmod, text }))
    .digest("hex")
    .slice(0, 16);
}

/** The hash `key` must carry, from a voice-lines table (the committed one unless given). */
function expectedHash(key: string, lines: Json = LINES): string | null {
  const { defId, line } = splitKey(key);
  const cards = isRecord(lines.cards) ? lines.cards : {};
  const personas = isRecord(lines.personas) ? lines.personas : {};
  const entry = cards[defId];
  if (!isRecord(entry)) return null;
  const personaName = entry.persona;
  if (typeof personaName !== "string") return null;
  const persona = personas[personaName];
  if (!isRecord(persona)) return null;
  const text = entry[line];
  if (typeof text !== "string") return null;
  return voiceHash({
    say: persona.say,
    rate: entry.rate ?? persona.rate,
    pbas: entry.pbas ?? persona.pbas,
    pmod: entry.pmod ?? persona.pmod,
    text,
  });
}

function voicePath(key: string, voiceDir = VOICE_DIR): string {
  return join(voiceDir, `${key}.m4a`);
}

function sizeOnDisk(key: string): number | null {
  const path = voicePath(key);
  return existsSync(path) ? statSync(path).size : null;
}

/** The box `type` among the ISO BMFF boxes in [start, end), or null; handles 64-bit and to-end sizes. */
function findBox(buf: Buffer, type: string, start: number, end: number): { body: number; end: number } | null {
  let at = start;
  while (at + 8 <= end) {
    let size = buf.readUInt32BE(at);
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) size = end - at;
    if (size < header) return null;
    if (buf.toString("latin1", at + 4, at + 8) === type) return { body: at + header, end: at + size };
    at += size;
  }
  return null;
}

/** moov/mvhd duration / timescale. afconvert writes no edit list, so this counts the AAC priming and
 *  padding frames too: about 0.13 s over `afinfo`'s estimate, and never under what a decoder yields. */
function movieSeconds(buf: Buffer): number | null {
  const moov = findBox(buf, "moov", 0, buf.length);
  const mvhd = moov && findBox(buf, "mvhd", moov.body, moov.end);
  if (!mvhd) return null;
  const v1 = buf[mvhd.body] === 1;
  const timescale = buf.readUInt32BE(mvhd.body + (v1 ? 20 : 12));
  const duration = v1 ? Number(buf.readBigUInt64BE(mvhd.body + 24)) : buf.readUInt32BE(mvhd.body + 16);
  return timescale > 0 ? duration / timescale : null;
}

// -------------------------------------------------------------------------------- the script ---

type CheckRun = { status: number | null; output: string; lines: string[]; error: string };

function runCheck(extraArgs: readonly string[] = []): CheckRun {
  const result = spawnSync(process.execPath, [GEN_VOICE, "--check", ...extraArgs], {
    cwd: REPO,
    encoding: "utf8",
    timeout: CHECK_TIMEOUT_MS - 5_000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return {
    status: result.status,
    output,
    lines: output.split(/\r?\n/).filter((line) => line.length > 0),
    error: result.error === undefined ? "" : String(result.error),
  };
}

/** A problem line starts with the key it is about (Surface: "each starting with the key"). */
const KEY_AT_START = /^(core-[a-z0-9]+(?:-[a-z0-9]+)*-(?:play|death|cast))(?![a-z0-9])/;

/** The keys the run reported a problem for, sorted and deduplicated. */
function reportedKeys(run: CheckRun): string[] {
  const keys = new Set<string>();
  for (const line of run.lines) {
    const key = KEY_AT_START.exec(line)?.[1];
    if (key !== undefined) keys.add(key);
  }
  return [...keys].sort();
}

function describeRun(run: CheckRun): string {
  return `exit ${String(run.status)}${run.error === "" ? "" : ` (${run.error})`}; output:\n${run.output}`;
}

let scratch = "";
let copies = 0;

/** A fresh copy of everything `--root` reads, under the suite's temp dir. */
function copyWebTree(): string {
  copies += 1;
  const root = join(scratch, `web-${String(copies)}`);
  mkdirSync(join(root, "src", "audio"), { recursive: true });
  mkdirSync(join(root, "public", "audio"), { recursive: true });
  copyFileSync(LINES_PATH, join(root, REL_LINES));
  copyFileSync(MANIFEST_PATH, join(root, REL_MANIFEST));
  cpSync(VOICE_DIR, join(root, REL_VOICE_DIR), { recursive: true });
  return root;
}

function editLines(root: string, edit: (lines: Json) => void): void {
  const path = join(root, REL_LINES);
  const lines = readJson(path);
  edit(lines);
  writeJson(path, lines);
}

function editManifest(root: string, edit: (files: Json) => void): void {
  const path = join(root, REL_MANIFEST);
  const manifest = readJson(path);
  const files = isRecord(manifest.files) ? manifest.files : {};
  edit(files);
  manifest.files = files;
  writeJson(path, manifest);
}

function cardsOf(lines: Json): Record<string, Json> {
  if (!isRecord(lines.cards)) throw new Error("voice-lines.json: no cards table");
  return lines.cards as Record<string, Json>;
}

function personasOf(lines: Json): Record<string, Json> {
  if (!isRecord(lines.personas)) throw new Error("voice-lines.json: no personas table");
  return lines.personas as Record<string, Json>;
}

/** Expect `--check --root root` to exit 1 reporting exactly `keys`. */
function expectReported(root: string, keys: readonly string[]): void {
  const run = runCheck(["--root", root]);
  expect(run.status, describeRun(run)).toBe(1);
  for (const key of keys) {
    expect(
      run.lines.some((line) => line.startsWith(key)),
      `a line starting "${key}"; ${describeRun(run)}`,
    ).toBe(true);
  }
  expect(reportedKeys(run), `only the broken keys are reported; ${describeRun(run)}`).toEqual([...keys].sort());
}

// ------------------------------------------------------------------------------------ B35 ---

describe("the committed voice files (B35)", () => {
  it("B35 expects 153 files: a play and a death line per unit, one cast line per spell and trap", () => {
    expect(EXPECTED_KEYS).toHaveLength(EXPECTED_FILE_COUNT);
    expect(new Set(EXPECTED_KEYS).size, "no key twice").toBe(EXPECTED_FILE_COUNT);
  });

  it("B35 leaves no expected voice file missing from public/audio/voice", () => {
    const missing = EXPECTED_KEYS.filter((key) => !existsSync(voicePath(key)));
    expect(missing, `keys with no file under ${VOICE_DIR}`).toEqual([]);
  });

  it("B35 gives every voice file an MP4 header: ftyp at byte 4 and brand 'M4A ' at byte 8", () => {
    const wrong: string[] = [];
    for (const key of EXPECTED_KEYS) {
      const path = voicePath(key);
      if (!existsSync(path)) {
        wrong.push(`${key}: missing`);
        continue;
      }
      const head = readFileSync(path).subarray(0, 12);
      const box = head.subarray(4, 8).toString("latin1");
      const brand = head.subarray(8, 12).toString("latin1");
      if (box !== "ftyp" || brand !== "M4A ") {
        wrong.push(`${key}: box ${JSON.stringify(box)}, brand ${JSON.stringify(brand)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("B35 keeps every voice file within VOICE_FILE_MAX_MS by its MP4 header, priming frames included", () => {
    const wrong: string[] = [];
    for (const key of EXPECTED_KEYS) {
      const path = voicePath(key);
      if (!existsSync(path)) {
        wrong.push(`${key}: missing`);
        continue;
      }
      const seconds = movieSeconds(readFileSync(path));
      if (seconds === null) wrong.push(`${key}: no moov/mvhd box`);
      else if (seconds * 1000 > VOICE_FILE_MAX_MS) wrong.push(`${key}: ${seconds.toFixed(2)} s`);
    }
    expect(wrong, `files longer than ${VOICE_FILE_MAX_MS} ms`).toEqual([]);
  });

  it("B35 has a version 1 manifest with an entry for every expected key", () => {
    expect(MANIFEST.version, "voice-manifest.json version").toBe(1);
    expect(isRecord(MANIFEST.files), "voice-manifest.json files is an object").toBe(true);
    const missing = EXPECTED_KEYS.filter((key) => !isRecord(MANIFEST_FILES[key]));
    expect(missing, "expected keys the manifest does not list").toEqual([]);
  });

  it("B35 has no manifest entry for a key outside the expected set", () => {
    const expected = new Set(EXPECTED_KEYS);
    const extra = Object.keys(MANIFEST_FILES).filter((key) => !expected.has(key));
    expect(extra, "manifest entries no catalog card speaks").toEqual([]);
  });

  it("B35 records each file's size on disk as its manifest bytes", () => {
    const wrong: string[] = [];
    for (const key of EXPECTED_KEYS) {
      const entry = MANIFEST_FILES[key];
      const size = sizeOnDisk(key);
      const bytes = isRecord(entry) ? entry.bytes : undefined;
      if (size === null || bytes !== size) {
        wrong.push(`${key}: manifest bytes ${JSON.stringify(bytes)}, on disk ${String(size)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("B35 records the voiceHash of each line's effective persona and text", () => {
    const wrong: string[] = [];
    for (const key of EXPECTED_KEYS) {
      const entry = MANIFEST_FILES[key];
      const hash = isRecord(entry) ? entry.hash : undefined;
      const recomputed = expectedHash(key);
      if (recomputed === null) {
        wrong.push(`${key}: voice-lines.json has no text or persona for it`);
      } else if (hash !== recomputed) {
        wrong.push(`${key}: manifest ${JSON.stringify(hash)}, recomputed ${recomputed}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("B35 keeps nothing in the voice directory but the 153 expected files", () => {
    expect(existsSync(VOICE_DIR), `${VOICE_DIR} exists`).toBe(true);
    const expected = new Set(EXPECTED_FILES);
    const present = readdirSync(VOICE_DIR);
    const orphans = present.filter((name) => !expected.has(name)).sort();
    expect(orphans, `entries in ${VOICE_DIR} that are not an expected voice file`).toEqual([]);
    expect(present, "exactly the expected files").toHaveLength(EXPECTED_FILE_COUNT);
  });
});

// ------------------------------------------------------------------------------------ B36 ---

describe("the voice budget (B36)", () => {
  it("B36 fits the whole set into VOICE_BUDGET_BYTES (3 MiB), counted in 4 KiB blocks", () => {
    expect(VOICE_BUDGET_BYTES, "the budget the Surface fixes").toBe(3 * 1024 * 1024);
    const sizes = EXPECTED_KEYS.map((key) => sizeOnDisk(key));
    expect(sizes.filter((size) => size === null), "every expected file exists to be measured").toEqual([]);
    const onDisk = sizes.reduce<number>((sum, size) => sum + Math.ceil((size ?? 0) / BLOCK) * BLOCK, 0);
    expect(onDisk, "sum of ceil(bytes / 4096) * 4096").toBeLessThanOrEqual(VOICE_BUDGET_BYTES);
  });
});

// ------------------------------------------------------------------------------------ B37 ---

describe("gen-voice.mjs --check (B37)", () => {
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "jackioh-gen-voice-"));
  });

  afterAll(() => {
    if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
  });

  it(
    "B37 exits 0 on the committed tree and reports 153 files and their bytes",
    () => {
      const run = runCheck();
      expect(run.status, describeRun(run)).toBe(0);
      const ok = /gen-voice: ok, (\d+) files, (\d+) bytes/.exec(run.output);
      expect(ok, `the "gen-voice: ok, <n> files, <bytes> bytes" line; ${describeRun(run)}`).not.toBeNull();
      expect(Number(ok?.[1]), "files counted").toBe(EXPECTED_FILE_COUNT);
      const total = EXPECTED_KEYS.reduce((sum, key) => sum + (sizeOnDisk(key) ?? 0), 0);
      expect(Number(ok?.[2]), "bytes counted").toBe(total);
      expect(reportedKeys(run), "no key reported as a problem").toEqual([]);
    },
    CHECK_TIMEOUT_MS,
  );

  it(
    "B37 exits 0 with --root on an unedited copy of the tree",
    () => {
      const root = copyWebTree();
      const run = runCheck(["--root", root]);
      expect(run.status, describeRun(run)).toBe(0);
      expect(reportedKeys(run)).toEqual([]);
    },
    CHECK_TIMEOUT_MS,
  );

  it(
    "B37 exits 1 and prints a line starting core-004-play when that line was edited",
    () => {
      const root = copyWebTree();
      editLines(root, (lines) => {
        const entry = cardsOf(lines)["core-004"];
        if (!isRecord(entry)) throw new Error("voice-lines.json: no core-004 entry to edit");
        const before = entry.play;
        entry.play = before === "Double or nothing, pal!" ? "Double or nothing, baby!" : "Double or nothing, pal!";
      });
      expectReported(root, ["core-004-play"]);
    },
    CHECK_TIMEOUT_MS,
  );

  it(
    "B37 exits 1 naming the key when an expected voice file is missing",
    () => {
      const root = copyWebTree();
      unlinkSync(voicePath("core-004-death", join(root, REL_VOICE_DIR)));
      expectReported(root, ["core-004-death"]);
    },
    CHECK_TIMEOUT_MS,
  );

  it(
    "B37 exits 1 naming the key when a file's size differs from its manifest bytes",
    () => {
      const root = copyWebTree();
      appendFileSync(voicePath("core-004-death", join(root, REL_VOICE_DIR)), Buffer.from([0]));
      expectReported(root, ["core-004-death"]);
    },
    CHECK_TIMEOUT_MS,
  );

  it(
    "B37 exits 1 naming the key when an orphan voice file sits in the directory",
    () => {
      const root = copyWebTree();
      const voiceDir = join(root, REL_VOICE_DIR);
      // core-004 is a unit, so it has no cast line: a well-formed key no catalog card expects.
      copyFileSync(voicePath("core-004-play", voiceDir), voicePath("core-004-cast", voiceDir));
      expectReported(root, ["core-004-cast"]);
    },
    CHECK_TIMEOUT_MS,
  );

  it(
    "B37 exits 1 naming the key when the manifest carries an orphan entry",
    () => {
      const root = copyWebTree();
      editManifest(root, (files) => {
        files["core-004-cast"] = { hash: "0123456789abcdef", bytes: 1024 };
      });
      expectReported(root, ["core-004-cast"]);
    },
    CHECK_TIMEOUT_MS,
  );

  it(
    "B37 exits 1 naming the key when an expected key has no manifest entry",
    () => {
      const root = copyWebTree();
      editManifest(root, (files) => {
        delete files["core-004-death"];
      });
      expectReported(root, ["core-004-death"]);
    },
    CHECK_TIMEOUT_MS,
  );

  it(
    "B37 exits 1 naming every key that speaks in a persona whose rate changed",
    () => {
      const root = copyWebTree();
      const committedCards = cardsOf(LINES);
      const persona = committedCards["core-008"]?.persona;
      expect(typeof persona, "core-008 names a persona").toBe("string");
      // Every key of every card in that persona goes stale, except a card whose own rate override
      // already decides its effective rate.
      const stale = EXPECTED_KEYS.filter((key) => {
        const entry = committedCards[splitKey(key).defId];
        return isRecord(entry) && entry.persona === persona && !("rate" in entry);
      });
      expect(stale, "the persona speaks at least core-008's two lines").toEqual(
        expect.arrayContaining(["core-008-play", "core-008-death"]),
      );
      editLines(root, (lines) => {
        const target = personasOf(lines)[String(persona)];
        const rate = isRecord(target) ? target.rate : undefined;
        if (!isRecord(target) || typeof rate !== "number") throw new Error("persona has no rate");
        target.rate = rate >= 350 ? rate - 10 : rate + 10;
      });
      expectReported(root, stale);
    },
    CHECK_TIMEOUT_MS,
  );

  it(
    "B37 exits 1 naming a card's keys when it gains a rate override (hashes use effective values)",
    () => {
      const root = copyWebTree();
      editLines(root, (lines) => {
        const entry = cardsOf(lines)["core-004"];
        if (!isRecord(entry)) throw new Error("no core-004 entry");
        const persona = personasOf(lines)[String(entry.persona)];
        const override = entry.rate;
        const base = typeof override === "number" ? override : isRecord(persona) ? persona.rate : undefined;
        if (typeof base !== "number") throw new Error("core-004 has no effective rate");
        entry.rate = base >= 350 ? base - 5 : base + 5;
      });
      expectReported(root, ["core-004-death", "core-004-play"]);
    },
    CHECK_TIMEOUT_MS,
  );
});
