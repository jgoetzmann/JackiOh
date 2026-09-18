// Node-side tasks. Registered from cypress.config.ts's setupNodeEvents.

import { replayHash, type ReplayHashPayload } from "./replay.ts";
import { wsPlayer, type WsPlayerCommand } from "./wsPlayer.ts";

export function registerTasks(
  on: Cypress.PluginEvents,
  config: Cypress.PluginConfigOptions,
): void {
  on("task", {
    /** Spec 06 / M6 gate: the second player, driven from Node. */
    wsPlayer(command: WsPlayerCommand) {
      return wsPlayer(command);
    },
    /** Spec 01: fold the recorded log through the engine and compare state hashes. */
    replayHash(payload: ReplayHashPayload) {
      return replayHash(config.projectRoot, payload);
    },
    /** Surface a message in the terminal (Cypress swallows console.log from the browser). */
    log(message: unknown) {
      console.log(typeof message === "string" ? message : JSON.stringify(message));
      return null;
    },
  });

  // Every spec file starts from a clean set of sockets.
  on("before:spec", async () => {
    await wsPlayer({ action: "reset" });
  });
  on("after:spec", async () => {
    await wsPlayer({ action: "reset" });
  });
}
