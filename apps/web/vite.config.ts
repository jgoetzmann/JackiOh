import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The client is a pure `PlayerView` renderer (CLAUDE.md rule 7, SPEC §10.8): it sends intent
// and draws what the engine hands it. The page's own bundle holds no rules; two chunks do, each
// kept off the page: `src/game/engine.real.ts` (hotseat and replay, a dynamic import) and the
// practice worker, which bundles the engine, the cards and the AI and runs them off the page's
// thread (SPEC §9.9, R187).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // The practice worker (`src/practice/practice.worker.ts`) is a module worker; "es" keeps its
  // chunk an ES module, so a dynamic import inside it cannot break the build the way it would an
  // IIFE worker bundle.
  worker: { format: "es" },
  build: {
    // `src/game/engine.real.ts` is reached only through an unanalyzed dynamic import
    // (see `src/game/engine.ts`), so it stays out of the production graph until the engine
    // compiles. Rollup warns about nothing else, so keep warnings fatal.
    rollupOptions: { onwarn: (warning, warn) => warn(warning) },
  },
});
