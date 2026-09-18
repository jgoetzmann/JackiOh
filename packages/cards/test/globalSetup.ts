// Vitest global setup for the cards project (BUILD M4-T2).
//
// Card scripts are plain files under `src/scripts/`. The registry cannot read a directory — `src/**`
// is pure (no fs, eslint enforces it) — so `src/scripts/_generated.ts` lists the script files, and
// `scripts/gen-registry.ts` rewrites that list from the directory. Regenerating it here means a
// card agent adds ONE file, runs its test, and the card is registered: nobody edits `src/index.ts`
// and nobody debugs a stale barrel.
//
// This runs once per test run, before any test module is loaded, and only writes when the content
// actually changed.

export async function setup(): Promise<void> {
  let generate: (() => unknown) | undefined;
  try {
    const mod: unknown = await import("../scripts/gen-registry");
    const exports = mod as Record<string, unknown>;
    const candidate = exports["generateBarrel"] ?? exports["generateRegistry"] ?? exports["default"];
    if (typeof candidate === "function") generate = candidate as () => unknown;
  } catch (error) {
    console.warn(
      `[cards] could not load scripts/gen-registry.ts (${String(error)}); ` +
        "src/scripts/_generated.ts is being used as committed",
    );
    return;
  }

  if (generate === undefined) {
    console.warn(
      "[cards] scripts/gen-registry.ts exports no generateBarrel(); " +
        "regenerate the script barrel by hand with `pnpm --filter @jackioh/cards run gen`",
    );
    return;
  }

  generate();
}
