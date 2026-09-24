// The `ai` project's setup file (vitest `setupFiles`): registers the Core catalog and card scripts
// before any test file loads. `packages/ai/src` never imports `@jackioh/cards` (docs/polish/3-ai.md,
// "callers register the catalog"), so the test project is the caller that does it, once, for every
// file, including the gate files, which reach the engine only through `../src/index`.
import { registerAll } from "@jackioh/cards";

registerAll();
