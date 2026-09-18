// The one place `apps/web` names the engine's deck constants.
//
// BUILD §2 puts `DECK_SIZE` and `MAX_COPIES` in `packages/engine/src/config.ts` and says nothing
// restates them, so the deckbuilder's counters and its test fixtures read them from there rather
// than spelling 20 and 1. The import is the engine's `"./config"` export and not its barrel: the
// barrel re-exports modules this client does not want to load for two settled numbers, which is
// what the deep relative path used to be working around.
export { DECK_SIZE, MAX_COPIES } from "@jackioh/engine/config";
