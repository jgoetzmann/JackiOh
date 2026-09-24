// Polish task 2 (docs/polish/2-sound.md), behaviour B45: `gen-voice.mjs` in its default, generate
// mode (B37 covers `--check`).
//
//   B45  Off macOS, or without `say`, `afconvert` and `afinfo`, it exits 2 and prints
//        `gen-voice: needs macOS say and afconvert`. On macOS it is idempotent by input hash: on an
//        unchanged tree it renders nothing and writes nothing; it deletes an orphan file and an
//        orphan manifest entry; and after one line is edited it renders that key alone and records
//        its new hash, leaving every other file and entry as it was.
//
// Every run points `--root` at a copy of the tree in a temp dir, never at the committed files. The
// macOS cases need the real `say`, so they run only on a Mac; CI (Linux) runs the first case.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(here, "../..");
const GEN_VOICE = join(WEB, "scripts/gen-voice.mjs");
const REL_LINES = join("src", "audio", "voice-lines.json");
const REL_MANIFEST = join("src", "audio", "voice-manifest.json");
const REL_VOICE_DIR = join("public", "audio", "voice");
const RUN_TIMEOUT_MS = 120_000;

type Manifest = { version: 1; format: string; files: Record<string, { hash: string; bytes: number }> };
type Persona = { say: string; rate: number; pbas: number; pmod: number };
type Entry = { kind: string; persona: string; rate?: number; pbas?: number; pmod?: number } & Record<string, unknown>;
type Lines = { personas: Record<string, Persona>; cards: Record<string, Entry> };

function hasTool(name: string): boolean {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}

const ON_MAC = process.platform === "darwin" && ["say", "afconvert", "afinfo"].every(hasTool);

/** The Surface's formula, recomputed here rather than imported from the script. */
function voiceHash(values: { say: string; rate: number; pbas: number; pmod: number; text: string }): string {
  const { say, rate, pbas, pmod, text } = values;
  return createHash("sha1").update(JSON.stringify({ v: 1, say, rate, pbas, pmod, text })).digest("hex").slice(0, 16);
}

function run(root: string, env: NodeJS.ProcessEnv = process.env): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [GEN_VOICE, "--root", root], { encoding: "utf8", env, timeout: RUN_TIMEOUT_MS });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

let scratch = "";
let copies = 0;

/** A fresh copy of everything `--root` reads and writes. */
function copyTree(): string {
  copies += 1;
  const root = join(scratch, `tree-${String(copies)}`);
  mkdirSync(join(root, "src", "audio"), { recursive: true });
  cpSync(join(WEB, REL_LINES), join(root, REL_LINES));
  cpSync(join(WEB, REL_MANIFEST), join(root, REL_MANIFEST));
  cpSync(join(WEB, REL_VOICE_DIR), join(root, REL_VOICE_DIR), { recursive: true });
  return root;
}

function readManifest(root: string): Manifest {
  return JSON.parse(readFileSync(join(root, REL_MANIFEST), "utf8")) as Manifest;
}

function mtimes(root: string, manifest: Manifest): Map<string, number> {
  return new Map(Object.keys(manifest.files).map((key) => [key, statSync(join(root, REL_VOICE_DIR, `${key}.m4a`)).mtimeMs]));
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "jackioh-gen-voice-generate-"));
});

afterAll(() => {
  if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
});

describe("B45 gen-voice.mjs generate mode", () => {
  it(
    "B45 exits 2 with the needs-macOS line when say, afconvert or afinfo cannot be found",
    () => {
      const root = copyTree();
      const before = readFileSync(join(root, REL_MANIFEST), "utf8");

      // A PATH holding one empty directory: `which` itself cannot be found, so neither can `say`.
      const empty = join(scratch, "empty-path");
      mkdirSync(empty, { recursive: true });
      const result = run(root, { ...process.env, PATH: empty });

      expect(result.status, result.output).toBe(2);
      expect(result.output).toContain("gen-voice: needs macOS say and afconvert");
      expect(readFileSync(join(root, REL_MANIFEST), "utf8")).toBe(before);
    },
    RUN_TIMEOUT_MS,
  );

  it.runIf(ON_MAC)(
    "B45 on an unchanged tree renders nothing and writes nothing",
    () => {
      const root = copyTree();
      const text = readFileSync(join(root, REL_MANIFEST), "utf8");
      const manifest = readManifest(root);
      const before = mtimes(root, manifest);

      const result = run(root);

      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain(`rendered 0, kept ${String(before.size)}`);
      expect(result.output).not.toMatch(/gen-voice: (rendered core-|wrote )/);
      expect(readFileSync(join(root, REL_MANIFEST), "utf8")).toBe(text);
      expect(mtimes(root, manifest)).toEqual(before);
    },
    RUN_TIMEOUT_MS,
  );

  it.runIf(ON_MAC)(
    "B45 deletes an orphan file and an orphan manifest entry",
    () => {
      const root = copyTree();
      const text = readFileSync(join(root, REL_MANIFEST), "utf8");
      const orphanFile = join(root, REL_VOICE_DIR, "core-999-play.m4a");
      writeFileSync(orphanFile, "not audio");
      const manifest = readManifest(root);
      manifest.files["core-998-death"] = { hash: "0123456789abcdef", bytes: 1 };
      writeFileSync(join(root, REL_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);

      const result = run(root);

      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain("removed orphan core-999-play.m4a");
      expect(existsSync(orphanFile)).toBe(false);
      expect(readFileSync(join(root, REL_MANIFEST), "utf8")).toBe(text);
    },
    RUN_TIMEOUT_MS,
  );

  it.runIf(ON_MAC)(
    "B45 an edited line renders only its own key and records its new hash",
    () => {
      const root = copyTree();
      const lines = JSON.parse(readFileSync(join(root, REL_LINES), "utf8")) as Lines;
      const entry = lines.cards["core-004"];
      const persona = entry === undefined ? undefined : lines.personas[entry.persona];
      if (entry === undefined || persona === undefined) throw new Error("core-004 and its persona should be in the table");
      entry.play = "Let it ride, baby!";
      writeFileSync(join(root, REL_LINES), `${JSON.stringify(lines, null, 2)}\n`);
      const manifest = readManifest(root);
      const before = mtimes(root, manifest);

      const result = run(root);

      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain("gen-voice: rendered core-004-play");
      expect(result.output).toContain(`rendered 1, kept ${String(before.size - 1)}`);

      const after = readManifest(root);
      const hash = voiceHash({
        say: persona.say,
        rate: entry.rate ?? persona.rate,
        pbas: entry.pbas ?? persona.pbas,
        pmod: entry.pmod ?? persona.pmod,
        text: "Let it ride, baby!",
      });
      expect(after.files["core-004-play"]).toEqual({
        hash,
        bytes: statSync(join(root, REL_VOICE_DIR, "core-004-play.m4a")).size,
      });
      expect(hash).not.toBe(manifest.files["core-004-play"]?.hash);
      const { "core-004-play": _edited, ...rest } = after.files;
      const { "core-004-play": _original, ...unchanged } = manifest.files;
      expect(rest).toEqual(unchanged);

      const touched = [...mtimes(root, after)].filter(([key, at]) => at !== before.get(key)).map(([key]) => key);
      expect(touched).toEqual(["core-004-play"]);

      const check = spawnSync(process.execPath, [GEN_VOICE, "--check", "--root", root], { encoding: "utf8" });
      expect(check.status, `${check.stdout}\n${check.stderr}`).toBe(0);
    },
    RUN_TIMEOUT_MS,
  );
});
