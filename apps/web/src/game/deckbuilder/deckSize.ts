// The one place `apps/web` names the engine's deck constants.
//
// BUILD §2 puts `DECK_SIZE` and `MAX_COPIES` in `packages/engine/src/config.ts` and says nothing
// restates them, so the deckbuilder's counters and its test fixtures read them from there rather
// than spelling 20 and 1. The import is the engine's `config` module directly and not
// `@jackioh/engine`, for the same reason `packages/validator/src/config.ts` gives: the engine's
// barrel re-exports modules that do not typecheck in this client yet (`apps/web/tsconfig.json`
// excludes `src/game/engine.real.ts` over exactly that), and two settled constants must not drag
// them in.
//
// Collapse this into `import { DECK_SIZE, MAX_COPIES } from "@jackioh/engine"` the day
// `tsc -p packages/engine/tsconfig.json` is green, or add `"./config"` to the engine's export map.
export { DECK_SIZE, MAX_COPIES } from "../../../../../packages/engine/src/config.ts";
