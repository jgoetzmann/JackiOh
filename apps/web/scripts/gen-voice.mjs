#!/usr/bin/env node
// Renders every voice line in src/audio/voice-lines.json to public/audio/voice/<key>.m4a with macOS
// `say` and `afconvert`, and records each file in src/audio/voice-manifest.json (docs/polish/2-sound.md,
// "gen-voice.mjs"; SPEC §10.11).
//
//   node apps/web/scripts/gen-voice.mjs [--check] [--force] [--only <defId>] [--root <webDir>]
//   pnpm --filter @jackioh/web gen:voice
//
// Generate (the default) needs macOS. It is idempotent by input, never by output bytes: legacy voices
// such as Fred are not byte-deterministic from run to run, so a key is rendered again only when its
// voiceHash (voice, rate, pitch base, pitch modulation and text) differs from the manifest's, or its
// file is missing or has the wrong size. `--force` renders every key again and `--only <defId>` limits
// rendering to one card. Orphan files and manifest entries are always removed, and the manifest is
// rewritten only when its content changes, so a second run with no input change writes nothing.
//
// `--check` runs on any OS and touches nothing. It is what CI runs (B37): one line per problem, each
// starting with the key it concerns, and exit 1; or `gen-voice: ok, <n> files, <bytes> bytes` and exit 0.
//
// Exit codes: 0 ok, 1 a problem was found, 2 bad arguments or no `say`/`afconvert` on this machine.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Bump when the encoding flags below change, so every file renders again. */
const HASH_VERSION = 1;
const HASH_CHARS = 16;
const FORMAT = "m4af aac@22050 mono 32000";
const AFCONVERT_FLAGS = ["-f", "m4af", "-d", "aac@22050", "-c", "1", "-b", "32000"];
/** VOICE_BUDGET_BYTES in src/audio/constants.ts: the whole set, counted in whole disk blocks. */
const BUDGET_BYTES = 3 * 1024 * 1024;
const BLOCK_BYTES = 4096;
/** VOICE_FILE_MAX_MS in src/audio/constants.ts, measured here by `afinfo` (voice-assets.test.ts reads the MP4 header). */
const MAX_SECONDS = 4.0;
/** Concurrent say/afconvert pairs; the machine is shared, so a few are plenty. */
const JOBS = 4;
const LINES_BY_KIND = { unit: ["play", "death"], spell: ["cast"], trap: ["cast"] };
const KIND_OF_TYPE = { Unit: "unit", Spell: "spell", "Field Spell": "spell", Trap: "trap", "Field Trap": "trap" };
const USAGE = "usage: node scripts/gen-voice.mjs [--check] [--force] [--only <defId>] [--root <webDir>]";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
/** Found from the script, not from `--root`, so a temp copy of the web dir is still checked against it. */
const CATALOG = path.resolve(SCRIPT_DIR, "../../../packages/cards/catalog.json");

function usage(message) {
  console.error(`gen-voice: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { check: false, force: false, only: null, root: path.resolve(SCRIPT_DIR, "..") };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") opts.check = true;
    else if (arg === "--force") opts.force = true;
    else if (arg === "--only" || arg === "--root") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) usage(`${arg} needs a value`);
      if (arg === "--only") opts.only = value;
      else opts.root = path.resolve(value);
    } else usage(`unknown argument ${arg}`);
  }
  return opts;
}

/** sha1(JSON.stringify({ v, say, rate, pbas, pmod, text })) in exactly that key order, first 16 hex chars. */
function voiceHash({ say, rate, pbas, pmod, text }) {
  const input = JSON.stringify({ v: HASH_VERSION, say, rate, pbas, pmod, text });
  return createHash("sha1").update(input).digest("hex").slice(0, HASH_CHARS);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function fileSize(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

function onDisk(bytes) {
  return Math.ceil(bytes / BLOCK_BYTES) * BLOCK_BYTES;
}

/** Every key the lines table expects, with its effective persona values and hash. */
function expectedKeys(table, problems) {
  const expected = new Map();
  const personas = table.personas ?? {};
  for (const [defId, entry] of Object.entries(table.cards ?? {})) {
    const lines = LINES_BY_KIND[entry?.kind];
    if (!lines) {
      problems.push(`${defId}: unknown kind ${JSON.stringify(entry?.kind)}`);
      continue;
    }
    const persona = personas[entry.persona];
    if (!persona || typeof persona.say !== "string" || persona.say === "") {
      problems.push(`${defId}: unknown persona ${JSON.stringify(entry.persona)}`);
      continue;
    }
    for (const line of lines) {
      const key = `${defId}-${line}`;
      const text = entry[line];
      if (typeof text !== "string" || text.trim() === "") {
        problems.push(`${key}: no ${line} line`);
        continue;
      }
      const values = {
        say: persona.say,
        rate: entry.rate ?? persona.rate,
        pbas: entry.pbas ?? persona.pbas,
        pmod: entry.pmod ?? persona.pmod,
        text,
      };
      expected.set(key, { defId, line, ...values, hash: voiceHash(values) });
    }
  }
  return expected;
}

function catalogProblems(catalog, table) {
  const problems = [];
  const cards = table.cards ?? {};
  const ids = new Set();
  for (const [id, card] of Object.entries(catalog)) {
    ids.add(id);
    const entry = cards[id];
    if (!entry) problems.push(`${id}: missing from voice-lines.json`);
    else if (entry.kind !== KIND_OF_TYPE[card.type]) {
      problems.push(`${id}: kind ${JSON.stringify(entry.kind)}, but the catalog type is ${card.type}`);
    }
  }
  for (const id of Object.keys(cards)) if (!ids.has(id)) problems.push(`${id}: not in the catalog`);
  return problems;
}

function load(root) {
  const files = {
    lines: path.join(root, "src/audio/voice-lines.json"),
    manifest: path.join(root, "src/audio/voice-manifest.json"),
    voiceDir: path.join(root, "public/audio/voice"),
  };
  const dataProblems = [];
  let table = {};
  try {
    table = readJson(files.lines);
    if (table.version !== 1) dataProblems.push(`voice-lines.json: version ${JSON.stringify(table.version)}, expected 1`);
  } catch (err) {
    dataProblems.push(`voice-lines.json: ${err.message}`);
  }
  const expected = expectedKeys(table, dataProblems);

  dataProblems.push(...catalogProblems(readJson(CATALOG), table));

  const manifestProblems = [];
  let manifest = { version: 1, format: FORMAT, files: {} };
  const manifestText = readText(files.manifest);
  if (manifestText === null) manifestProblems.push("voice-manifest.json: missing");
  else {
    try {
      manifest = JSON.parse(manifestText);
      if (manifest.version !== 1) manifestProblems.push(`voice-manifest.json: version ${JSON.stringify(manifest.version)}, expected 1`);
      if (manifest.format !== FORMAT) manifestProblems.push(`voice-manifest.json: format ${JSON.stringify(manifest.format)}, expected "${FORMAT}"`);
      if (!manifest.files || typeof manifest.files !== "object") manifest.files = {};
    } catch (err) {
      manifestProblems.push(`voice-manifest.json: ${err.message}`);
      manifest = { version: 1, format: FORMAT, files: {} };
    }
  }
  return { files, table, expected, dataProblems, manifest, manifestText, manifestProblems };
}

function dirEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Anything in the voice dir that is not an expected `<key>.m4a`, named by its key where it has one. */
function orphans(dir, expected) {
  const out = [];
  for (const entry of dirEntries(dir)) {
    const key = entry.name.endsWith(".m4a") ? entry.name.slice(0, -".m4a".length) : null;
    if (key !== null && expected.has(key) && entry.isFile()) continue;
    out.push({ name: entry.name, label: key ?? entry.name, isFile: entry.isFile() || entry.isSymbolicLink() });
  }
  return out;
}

function totals(dir, expected) {
  let bytes = 0;
  let blocks = 0;
  let count = 0;
  for (const key of expected.keys()) {
    const size = fileSize(path.join(dir, `${key}.m4a`));
    if (size === null) continue;
    count++;
    bytes += size;
    blocks += onDisk(size);
  }
  return { bytes, blocks, count };
}

function budgetProblem(blocks) {
  return blocks > BUDGET_BYTES ? `budget: ${blocks} bytes on disk (4 KiB blocks) is over ${BUDGET_BYTES}` : null;
}

function report(problems) {
  for (const problem of problems) console.log(problem);
  console.error(`gen-voice: ${problems.length} problem${problems.length === 1 ? "" : "s"}`);
}

function check(ctx) {
  const { expected, manifest, files } = ctx;
  const problems = [...ctx.dataProblems, ...ctx.manifestProblems];
  const entries = manifest.files;
  for (const [key, want] of expected) {
    const record = entries[key];
    const size = fileSize(path.join(files.voiceDir, `${key}.m4a`));
    if (!record) problems.push(`${key}: missing from the manifest`);
    else if (record.hash !== want.hash) problems.push(`${key}: stale hash`);
    if (size === null) problems.push(`${key}: missing file`);
    else if (record && record.bytes !== size) problems.push(`${key}: file is ${size} bytes, the manifest says ${record.bytes}`);
  }
  for (const key of Object.keys(entries)) if (!expected.has(key)) problems.push(`${key}: orphan manifest entry`);
  for (const orphan of orphans(files.voiceDir, expected)) problems.push(`${orphan.label}: orphan file`);
  const sum = totals(files.voiceDir, expected);
  const over = budgetProblem(sum.blocks);
  if (over) problems.push(over);

  if (problems.length > 0) {
    report(problems);
    return 1;
  }
  console.log(`gen-voice: ok, ${sum.count} files, ${sum.bytes} bytes`);
  return 0;
}

function hasTool(name) {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: err.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr: stderr.trim() }));
  });
}

async function pool(items, jobs, work) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, worker));
}

async function render(key, want, tmp, voiceDir) {
  const aiff = path.join(tmp, `${key}.aiff`);
  const m4a = path.join(tmp, `${key}.m4a`);
  const spoken = `[[rate ${want.rate}]] [[pbas ${want.pbas}]] [[pmod ${want.pmod}]] ${want.text}`;
  const said = await run("say", ["-v", want.say, "-o", aiff, spoken]);
  if (said.code !== 0 || fileSize(aiff) === null) return `say failed (${said.code}) ${said.stderr}`.trim();
  const converted = await run("afconvert", [...AFCONVERT_FLAGS, aiff, m4a]);
  if (converted.code !== 0 || fileSize(m4a) === null) return `afconvert failed (${converted.code}) ${converted.stderr}`.trim();
  fs.copyFileSync(m4a, path.join(voiceDir, `${key}.m4a`));
  return null;
}

async function durationSeconds(file) {
  const info = await run("afinfo", [file]);
  const match = /estimated duration:\s*([\d.]+)\s*sec/.exec(info.stdout);
  return match ? Number(match[1]) : null;
}

function sortedObject(record) {
  const out = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key];
  return out;
}

async function generate(ctx, opts) {
  if (process.platform !== "darwin" || !hasTool("say") || !hasTool("afconvert") || !hasTool("afinfo")) {
    console.error("gen-voice: needs macOS say and afconvert");
    return 2;
  }
  const { expected, manifest, files } = ctx;
  // Never render or delete anything from a lines table that doesn't hold together.
  if (ctx.dataProblems.length > 0) {
    report(ctx.dataProblems);
    return 1;
  }
  if (opts.only !== null && ![...expected.values()].some((want) => want.defId === opts.only)) {
    usage(`--only ${opts.only}: no such card in voice-lines.json`);
  }
  fs.mkdirSync(files.voiceDir, { recursive: true });

  // Manifest entries for keys that are no longer expected are orphans and are dropped here.
  const entries = {};
  for (const key of expected.keys()) if (manifest.files[key]) entries[key] = manifest.files[key];

  const todo = [];
  let kept = 0;
  for (const [key, want] of expected) {
    if (opts.only !== null && want.defId !== opts.only) continue;
    const record = entries[key];
    const size = fileSize(path.join(files.voiceDir, `${key}.m4a`));
    if (!opts.force && record && record.hash === want.hash && size !== null && size === record.bytes) {
      kept++;
      continue;
    }
    todo.push([key, want]);
  }

  const problems = [];
  let rendered = 0;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gen-voice-"));
  try {
    await pool(todo, JOBS, async ([key, want]) => {
      const failure = await render(key, want, tmp, files.voiceDir);
      if (failure) {
        delete entries[key];
        fs.rmSync(path.join(files.voiceDir, `${key}.m4a`), { force: true });
        problems.push(`${key}: ${failure}`);
        return;
      }
      entries[key] = { hash: want.hash, bytes: fileSize(path.join(files.voiceDir, `${key}.m4a`)) };
      rendered++;
      console.log(`gen-voice: rendered ${key}`);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  for (const orphan of orphans(files.voiceDir, expected)) {
    if (orphan.isFile) {
      fs.rmSync(path.join(files.voiceDir, orphan.name), { force: true });
      console.log(`gen-voice: removed orphan ${orphan.name}`);
    } else problems.push(`${orphan.label}: unexpected directory ${orphan.name} in the voice dir`);
  }

  const next = { version: 1, format: FORMAT, files: sortedObject(entries) };
  const nextText = `${JSON.stringify(next, null, 2)}\n`;
  if (nextText !== ctx.manifestText) {
    fs.mkdirSync(path.dirname(files.manifest), { recursive: true });
    fs.writeFileSync(files.manifest, nextText);
    console.log(`gen-voice: wrote ${path.relative(process.cwd(), files.manifest) || files.manifest}`);
  }

  const du = spawnSync("du", ["-sk", files.voiceDir], { encoding: "utf8" });
  if (du.status === 0) console.log(`gen-voice: du -sk ${du.stdout.trim()}`);

  const present = [...expected.keys()].filter((key) => fileSize(path.join(files.voiceDir, `${key}.m4a`)) !== null);
  await pool(present, JOBS, async (key) => {
    const seconds = await durationSeconds(path.join(files.voiceDir, `${key}.m4a`));
    if (seconds === null) problems.push(`${key}: afinfo reports no duration`);
    else if (seconds > MAX_SECONDS) problems.push(`${key}: ${seconds.toFixed(2)} s is longer than ${MAX_SECONDS.toFixed(1)} s`);
  });

  const sum = totals(files.voiceDir, expected);
  const over = budgetProblem(sum.blocks);
  if (over) problems.push(over);

  console.log(`gen-voice: rendered ${rendered}, kept ${kept}, ${sum.count} files, ${sum.bytes} bytes`);
  if (problems.length > 0) {
    report(problems.sort());
    return 1;
  }
  return 0;
}

const opts = parseArgs(process.argv.slice(2));
const ctx = load(opts.root);
process.exitCode = opts.check ? check(ctx) : await generate(ctx, opts);
