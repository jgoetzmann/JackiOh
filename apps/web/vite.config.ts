import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The client is a pure `PlayerView` renderer (CLAUDE.md rule 7, SPEC §10.8): it sends intent
// and draws what the engine hands it. Nothing here bundles rules.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: {
    // `src/game/engine.real.ts` is reached only through an unanalyzed dynamic import
    // (see `src/game/engine.ts`), so it stays out of the production graph until the engine
    // compiles. Rollup warns about nothing else, so keep warnings fatal.
    rollupOptions: { onwarn: (warning, warn) => warn(warning) },
  },
});
