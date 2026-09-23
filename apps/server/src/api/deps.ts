/**
 * The one place that reads `src/config.ts`. Everything else takes `ServerConfig` and `ApiLimits`
 * from `ServerDeps`, so R79's numbers are stated once (in config.ts, which the db agent owns)
 * and a test can shrink a clock without editing a constant.
 */

import {
  API_REQUESTS_PER_MINUTE,
  CODE_ATTEMPTS_PER_IP_PER_HOUR,
  CODE_ATTEMPTS_PER_PROFILE_PER_HOUR,
  CODE_ATTEMPT_WINDOW_SECONDS,
  DECK_NAME_MAX_LENGTH,
  DISCONNECT_GRACE_SECONDS,
  ELO_K,
  ELO_START,
  MATCHMAKER_SWEEP_INTERVAL_SECONDS,
  MATCH_ACTIONS_PER_SECOND,
  MATCH_CEILING_MINUTES,
  MAX_LIBRARY_DECKS,
  PROMPT_CLOCK_SECONDS,
  RATING_WINDOW_START,
  RATING_WINDOW_UNCAPPED_AFTER_SECONDS,
  RATING_WINDOW_WIDEN_BY,
  RATING_WINDOW_WIDEN_EVERY_SECONDS,
  REDEMPTION_CIRCUIT_FAILURE_THRESHOLD,
  REDEMPTION_CIRCUIT_WINDOW_SECONDS,
  REDEMPTION_RESPONSE_FLOOR_MS,
  ROOM_CODE_LENGTH,
  TURN_CLOCK_SECONDS,
} from "../config";
import type { ApiLimits, Logger, ServerConfig } from "./ports";

export function defaultConfig(): ServerConfig {
  return {
    turnClockSeconds: TURN_CLOCK_SECONDS,
    promptClockSeconds: PROMPT_CLOCK_SECONDS,
    disconnectGraceSeconds: DISCONNECT_GRACE_SECONDS,
    matchCeilingMinutes: MATCH_CEILING_MINUTES,
    roomCodeLength: ROOM_CODE_LENGTH,
    eloK: ELO_K,
    eloStart: ELO_START,
  };
}

export function defaultLimits(): ApiLimits {
  return {
    redeemPerProfilePerHour: CODE_ATTEMPTS_PER_PROFILE_PER_HOUR,
    redeemPerIpPerHour: CODE_ATTEMPTS_PER_IP_PER_HOUR,
    redeemWindowMs: CODE_ATTEMPT_WINDOW_SECONDS * 1000,
    redeemConstantMs: REDEMPTION_RESPONSE_FLOOR_MS,
    breakerFailureThreshold: REDEMPTION_CIRCUIT_FAILURE_THRESHOLD,
    breakerWindowMs: REDEMPTION_CIRCUIT_WINDOW_SECONDS * 1000,
    breakerCooldownMs: REDEMPTION_CIRCUIT_WINDOW_SECONDS * 1000,
    queueWindowStart: RATING_WINDOW_START,
    queueWindowStep: RATING_WINDOW_WIDEN_BY,
    queueWindowStepMs: RATING_WINDOW_WIDEN_EVERY_SECONDS * 1000,
    queueWindowUncappedAfterMs: RATING_WINDOW_UNCAPPED_AFTER_SECONDS * 1000,
    queueSweepMs: MATCHMAKER_SWEEP_INTERVAL_SECONDS * 1000,
    roomCodeTtlMs: 15 * 60 * 1000,
    libraryDecks: MAX_LIBRARY_DECKS,
    deckNameMaxLength: DECK_NAME_MAX_LENGTH,
  };
}

/** §9.8: per-match and per-account flood limits, straight from config. */
export const floodLimits = {
  matchActionsPerSecond: MATCH_ACTIONS_PER_SECOND,
  apiRequestsPerMinute: API_REQUESTS_PER_MINUTE,
} as const;

/** One line of JSON per event: enough for a hosted log drain, nothing to configure. */
export const consoleLogger: Logger = {
  info: (event, data) => {
    console.log(JSON.stringify({ level: "info", event, ...data }));
  },
  warn: (event, data) => {
    console.warn(JSON.stringify({ level: "warn", event, ...data }));
  },
  alert: (event, data) => {
    console.error(JSON.stringify({ level: "alert", event, ...data }));
  },
};
