// The one place this package names another package's file.
//
// BUILD §2: the deck constants live in the engine's config and nothing restates them, so L2 and L3
// read DECK_SIZE and MAX_COPIES from there. The import is the engine's `config` module directly
// rather than `@jackioh/engine`, because the engine's package exports only its barrel and that
// barrel re-exports modules still under construction (`./playChoices`, `./prompts`, `./triggers`,
// `./traps`, `./viewFor`, `subsystems/fuse`, `subsystems/heroPower` at the time of writing), so
// importing it would make this package fail to load in the client, the server and vitest alike —
// over two constants that have been settled since M1.
//
// Collapse this file into `import { DECK_SIZE, MAX_COPIES } from "@jackioh/engine"` once the engine
// barrel compiles, or keep it and add `"./config": "./src/config.ts"` to the engine's export map so
// the specifier can be `@jackioh/engine/config`.
export { DECK_SIZE, MAX_COPIES } from "../../engine/src/config";
