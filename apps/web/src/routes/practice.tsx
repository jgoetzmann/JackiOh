// `/practice`: a game against the AI, with no account and no server (SPEC §9.9, R187).
//
// The engine and the AI run in a Web Worker (`practice/host.ts`), and this route holds only what
// the worker answers: `viewFor(state, human)`, the human's `legalActions` and whether the AI owes an
// action (CLAUDE.md rule 7). The board is `Game.tsx`, unchanged, inside the catalog the worker sent.
//
// The tutorial lives here too (SPEC §9.10): its lesson path tops the lobby, and a lesson is a
// practice game whose config names it (`tutorial/start.ts`), played under the tutorial's HUD with
// the coach over the board, or on a phone in a panel above it (`tutorial/`).
//
// The route is NOT gated. It asks for the account only to offer an active player's saved decks, and
// an anonymous visitor makes no request at all: no session means no `/api/auth/me`, and no
// account means no `/api/decks`.
//
// URL params, all optional and dropped when invalid:
//   ?seed=<string>        the practice seed; otherwise 8 random hex characters per game
//   ?difficulty=easy|medium|hard, ?deck=random|preset:<id>|saved:<n>   preselect the setup; with a
//                         difficulty and a `random` or `preset:` deck the game starts at once
//   ?seat=p1|p2           the human's seat; otherwise a coin flip per game
//   ?lesson=<id>          start that tutorial lesson at once, on its own seed and seat (a `?seed=`
//                         or `?seat=` never overrides a lesson's)
//   ?pace=fast            e2e pacing, honoured only outside a production build

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";

import { DIFFICULTIES, type Difficulty } from "@jackioh/engine/config";
import type { ActionBody, CardDefs, PlayerId, PlayerView } from "@jackioh/shared";

import Game from "../game/Game.tsx";
import { reducedMotionNow } from "../game/animations.ts";
import { getFxSettings } from "../fx/settings.ts";
import { CatalogContext, lookupFromDefs } from "../game/catalog.ts";
import { getDecks, type DecksResponse } from "../net/api.ts";
import { useAccount, type Account } from "../net/gate.ts";
import { navigate, paths } from "../net/navigate.ts";
import { BackLink } from "./nav.tsx";
import {
  PRACTICE_DEFAULT_DIFFICULTY,
  PRACTICE_PACING,
  PRACTICE_PACING_FAST,
  PRACTICE_PACING_REDUCED,
  PRACTICE_SEED_BYTES,
  PRACTICE_SEED_MAX_LENGTH,
  PRACTICE_SETUP_KEY,
  PRACTICE_SHOWCASE_HOLD_MAX_MS,
  PRACTICE_VOICE_HOLD_MAX_MS,
  type PracticePacing,
} from "../practice/config.ts";
import {
  PRACTICE_IDLE_STATE,
  createPracticeController,
  type PracticeController,
  type PracticeControllerState,
} from "../practice/controller.ts";
import { deckChoiceFromValue, deckChoiceValue, isAutostartDeckValue, isDeckValue } from "../practice/decks.ts";
import { createPracticeHost, type PracticeHost } from "../practice/host.ts";
import type { PracticeDebug, PracticeDeckChoice, PracticeStartConfig } from "../practice/protocol.ts";
import { ModifierList } from "../practice/ModifierList.tsx";
import { PracticeLeave, type PracticeLeaveTo } from "../practice/PracticeLeave.tsx";
import { OUTCOME_TITLE, PracticeResult, outcomeOf } from "../practice/PracticeResult.tsx";
import { PracticeSetup, type PracticeSetupChoice, type SavedDecks } from "../practice/PracticeSetup.tsx";
import { practiceTestid } from "../practice/testids.ts";
import { ThinkIndicator } from "../practice/ThinkIndicator.tsx";
import { DIFFICULTY_LABEL, TierCrest } from "../practice/Tier.tsx";
import "../practice/practice.css";
import { Coach } from "../tutorial/Coach.tsx";
import type { LessonScript } from "../tutorial/coach.ts";
import { useTutorialDevHandle } from "../tutorial/devHandle.ts";
import { lessonById, nextLessonOf, type TutorialLesson } from "../tutorial/lessons.ts";
import { lessonStatus, markLessonComplete, readTutorialProgress } from "../tutorial/progress.ts";
import { scriptFor } from "../tutorial/scripts/index.ts";
import { lessonStartConfig } from "../tutorial/start.ts";
import { createCoachTracker, silentScript, type CoachTracker } from "../tutorial/tracker.ts";
import { TutorialHud } from "../tutorial/TutorialHud.tsx";
import { TutorialPath } from "../tutorial/TutorialPath.tsx";
import { TutorialResult } from "../tutorial/TutorialResult.tsx";

/** The dev handle exists only outside a production build, like `window.__jackioh`. */
const DEV_ONLY = import.meta.env.MODE !== "production";

// ---------------------------------------------------------------------------------------------
// the dev handle (spec 13's replay check)
// ---------------------------------------------------------------------------------------------

type PracticeDevHandle = {
  snapshot(): Promise<PracticeDebug>;
  readonly aiSeat: PlayerId | null;
  readonly thinking: boolean;
  readonly view: PlayerView | null;
};

declare global {
  interface Window {
    /** Set only when MODE !== "production". */
    __jackiohPractice?: PracticeDevHandle;
  }
}

// ---------------------------------------------------------------------------------------------
// URL params
// ---------------------------------------------------------------------------------------------

type PracticeParams = {
  seed?: string;
  difficulty?: Difficulty;
  deck?: string;
  seat?: PlayerId;
  /** A tutorial lesson's id (`tutorial/lessons.ts`). */
  lesson?: string;
  pace?: "fast";
};

function isDifficulty(value: unknown): value is Difficulty {
  return typeof value === "string" && (DIFFICULTIES as readonly string[]).includes(value);
}

/** Invalid values dropped. */
export function readPracticeParams(search: string): PracticeParams {
  const params = new URLSearchParams(search);
  const out: PracticeParams = {};

  const seed = params.get("seed");
  if (seed !== null && seed.length > 0 && seed.length <= PRACTICE_SEED_MAX_LENGTH) out.seed = seed;

  const difficulty = params.get("difficulty");
  if (isDifficulty(difficulty)) out.difficulty = difficulty;

  const deck = params.get("deck");
  if (deck !== null && isDeckValue(deck)) out.deck = deck;

  const seat = params.get("seat");
  if (seat === "p1" || seat === "p2") out.seat = seat;

  const lesson = params.get("lesson");
  if (lesson !== null && lessonById(lesson) !== undefined) out.lesson = lesson;

  if (params.get("pace") === "fast") out.pace = "fast";

  return out;
}

// ---------------------------------------------------------------------------------------------
// seeds, seats, pacing and the remembered setup
// ---------------------------------------------------------------------------------------------

function randomBytes(count: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(count));
}

function randomPracticeSeed(): string {
  return [...randomBytes(PRACTICE_SEED_BYTES)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomSeat(): PlayerId {
  const [byte = 0] = randomBytes(1);
  return (byte & 1) === 0 ? "p1" : "p2";
}

function pacingFor(params: PracticeParams): PracticePacing {
  if (DEV_ONLY && params.pace === "fast") return PRACTICE_PACING_FAST;
  // The media query or either reduce setting: nothing animates, so there is nothing to wait for.
  return reducedMotionNow() ? PRACTICE_PACING_REDUCED : PRACTICE_PACING;
}

type StoredSetup = { difficulty?: Difficulty; deck?: string };

function readStoredSetup(): StoredSetup {
  try {
    const raw = window.localStorage.getItem(PRACTICE_SETUP_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const { difficulty, deck } = parsed as { difficulty?: unknown; deck?: unknown };
    return {
      ...(isDifficulty(difficulty) ? { difficulty } : {}),
      ...(typeof deck === "string" && isDeckValue(deck) ? { deck } : {}),
    };
  } catch {
    // A private window, blocked site data or malformed JSON: nothing is remembered.
    return {};
  }
}

function writeStoredSetup(difficulty: Difficulty, deck: PracticeDeckChoice): void {
  try {
    window.localStorage.setItem(PRACTICE_SETUP_KEY, JSON.stringify({ difficulty, deck: deckChoiceValue(deck) }));
  } catch {
    // Remembering the setup is a convenience; a refusal costs nothing.
  }
}

function configFor(choice: PracticeSetupChoice, params: PracticeParams): PracticeStartConfig {
  return {
    seed: params.seed ?? randomPracticeSeed(),
    difficulty: choice.difficulty,
    humanSeat: params.seat ?? randomSeat(),
    deck: choice.deck,
  };
}

/**
 * `?lesson=` starts that lesson with no click, on the lesson's own seed and seat; otherwise
 * `?difficulty=` plus a `random` or `preset:` `?deck=` starts a practice game.
 */
function autostartConfig(params: PracticeParams): PracticeStartConfig | null {
  const lesson = params.lesson === undefined ? undefined : lessonById(params.lesson);
  if (lesson !== undefined) return lessonStartConfig(lesson);
  if (params.difficulty === undefined || params.deck === undefined) return null;
  if (!isAutostartDeckValue(params.deck)) return null;
  const deck = deckChoiceFromValue(params.deck, null);
  if (deck === null) return null;
  return configFor({ difficulty: params.difficulty, deck }, params);
}

// ---------------------------------------------------------------------------------------------
// hooks
// ---------------------------------------------------------------------------------------------

/**
 * What the account offers the deck picker: an active account's saved decks (`GET /api/decks`, by
 * name and oldest first, R250), or why there are none (`SavedDecks`), so the setup never tells a
 * signed-in player to sign in.
 */
function useSavedDecks(account: Account, loadDecks: (token: string) => Promise<DecksResponse>): SavedDecks {
  const [loaded, setLoaded] = useState<{ token: string; saved: SavedDecks } | null>(null);
  const token = account.kind === "ready" && account.me.profile.status === "active" ? account.token : null;
  const load = useRef(loadDecks);
  load.current = loadDecks;

  useEffect(() => {
    if (token === null) return;
    let cancelled = false;
    let pending: Promise<DecksResponse>;
    try {
      pending = load.current(token);
    } catch (cause) {
      pending = Promise.reject(cause instanceof Error ? cause : new Error(String(cause)));
    }
    pending.then(
      (response) => {
        if (cancelled) return;
        const decks = response.decks;
        const saved: SavedDecks =
          Array.isArray(decks) && decks.length > 0
            ? { kind: "ready", decks: decks.map((deck) => ({ name: deck.name, cards: [...deck.cards] })) }
            : { kind: "none" };
        setLoaded({ token, saved });
      },
      () => {
        // A failed read offers no saved decks, and says so.
        if (!cancelled) setLoaded({ token, saved: { kind: "unavailable" } });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [token]);

  switch (account.kind) {
    case "loading":
      return { kind: "checking" };
    case "anonymous":
      return { kind: "anonymous" };
    case "error":
      return { kind: "unavailable" };
    case "ready":
      if (token === null) return { kind: "inactive" };
      return loaded !== null && loaded.token === token ? loaded.saved : { kind: "checking" };
  }
}

/**
 * The public card data the setup previews decks with. No game exists yet, so it is asked of a
 * host of its own (a worker, like the game's), which is closed as soon as it answers; a game that
 * has started brings the same catalog (`state.defs`), so a later setup screen needs no second ask.
 */
function useLobbyCatalog(
  wanted: boolean,
  known: CardDefs | null,
  factory: () => PracticeHost,
): { defs: CardDefs | null; failed: boolean } {
  const [fetched, setFetched] = useState<CardDefs | null>(null);
  const [failed, setFailed] = useState(false);
  const make = useRef(factory);
  make.current = factory;
  const have = known ?? fetched;

  useEffect(() => {
    if (!wanted || have !== null || failed) return;
    let opened: PracticeHost;
    let cancelled = false;
    try {
      opened = make.current();
    } catch {
      setFailed(true);
      return;
    }
    opened.request({ type: "catalog" }).then(
      (response) => {
        opened.dispose();
        if (cancelled) return;
        if (response.type === "catalog") setFetched(response.defs);
        else setFailed(true);
      },
      () => {
        opened.dispose();
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
      opened.dispose();
    };
  }, [wanted, have, failed]);

  return { defs: have, failed: have === null && failed };
}

/**
 * Tell the controller whether the board is still animating, so the AI's next step waits for the
 * player to see the last one (practice/controller.ts). It reads the board's own contract rather
 * than reaching into `Game.tsx`: an element carries `data-animating` for exactly as long as the
 * runner holds a view back (BUILD M5-T4, `game/animations.ts`), which is also what `cy.settled()`
 * waits on.
 */
function useBoardBusy(root: HTMLElement | null, controller: PracticeController | null): void {
  useEffect(() => {
    if (controller === null || root === null || typeof MutationObserver !== "function") return;
    const report = (): void => {
      controller.setBoardBusy(root.querySelector("[data-animating]") !== null);
    };
    const observer = new MutationObserver(report);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-animating"] });
    report();
    return () => {
      observer.disconnect();
    };
  }, [root, controller]);
}

/**
 * Hold the AI's next step while an element anywhere in the page carries `attribute`, for at most
 * `maxMs` per mark (SPEC §9.9: AI turns are paced so the player can follow them). The contract with
 * the layer that marks is one attribute, as the board's is with `data-animating`: it is set while
 * the thing plays and dropped when it ends. A mark that is never cleared holds the AI for at most
 * `maxMs`, so a stuck mark can slow a turn but never stop the game; it is ignored from then on
 * until the page drops it.
 */
function useMarkHold(controller: PracticeController | null, reason: string, attribute: string, maxMs: number): void {
  useEffect(() => {
    if (controller === null || typeof MutationObserver !== "function") return;
    const root = document.documentElement;
    const selector = `[${attribute}]`;
    let cap: ReturnType<typeof setTimeout> | null = null;
    /** The cap ran out on this mark; it is ignored until the page drops it. */
    let expired = false;
    const release = (): void => {
      if (cap !== null) clearTimeout(cap);
      cap = null;
      controller.setHold(reason, false);
    };
    const report = (): void => {
      const marked = root.matches(selector) || root.querySelector(selector) !== null;
      if (!marked) {
        expired = false;
        release();
        return;
      }
      if (expired || cap !== null) return;
      controller.setHold(reason, true);
      cap = setTimeout(() => {
        expired = true;
        release();
      }, maxMs);
    };
    const observer = new MutationObserver(report);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: [attribute] });
    report();
    return () => {
      observer.disconnect();
      release();
    };
  }, [controller, reason, attribute, maxMs]);
}

/**
 * Hold the AI's next step while a voice line plays. The audio layer marks an element
 * `data-speaking` while a line plays and drops it when the line ends (polish task 2).
 */
function useVoiceHold(controller: PracticeController | null): void {
  useMarkHold(controller, "voice", "data-speaking", PRACTICE_VOICE_HOLD_MAX_MS);
}

/**
 * Hold the AI's next step while its last card is held up (game/showcase/CardShowcase.tsx marks the
 * showcase `data-showcase` for as long as it is up), so the AI never plays its next card over the
 * one the player is reading.
 */
function useShowcaseHold(controller: PracticeController | null): void {
  useMarkHold(controller, "showcase", "data-showcase", PRACTICE_SHOWCASE_HOLD_MAX_MS);
}

const noSubscribe = (): (() => void) => () => {};
const idleState = (): PracticeControllerState => PRACTICE_IDLE_STATE;

function useControllerState(controller: PracticeController | null): PracticeControllerState {
  return useSyncExternalStore(
    controller === null ? noSubscribe : controller.subscribe,
    controller === null ? idleState : controller.getState,
    controller === null ? idleState : controller.getState,
  );
}

// ---------------------------------------------------------------------------------------------
// the route
// ---------------------------------------------------------------------------------------------

export type PracticeRouteProps = {
  /** default createPracticeHost */
  hostFactory?: () => PracticeHost;
  /** default by ?pace / reduced motion */
  pacing?: PracticePacing;
  /** default useAccount() */
  account?: Account;
  /** default getDecks */
  loadDecks?: (token: string) => Promise<DecksResponse>;
  /** default the lessons' own coach scripts (`tutorial/scripts`) */
  coachScript?: (lessonId: string) => LessonScript | undefined;
};

type ScreenProps = Omit<PracticeRouteProps, "account"> & { account: Account };

function defaultHostFactory(): PracticeHost {
  return createPracticeHost();
}

/**
 * The setup, loading and failure screens are a centred reading column (`app-shell`); the game is
 * the full-width board (`app-shell--wide`), like `/dev/hotseat` and `/match/<id>`.
 */
function Shell({ variant, children }: { variant: "lobby" | "game"; children: ReactNode }): ReactElement {
  const shell = variant === "game" ? "app-shell app-shell--wide" : "app-shell";
  return <div className={`${shell} practice practice--${variant}`}>{children}</div>;
}

function PracticeScreen({ account, hostFactory, pacing, loadDecks, coachScript }: ScreenProps): ReactElement {
  const params = useMemo(() => readPracticeParams(window.location.search), []);
  const saved = useSavedDecks(account, loadDecks ?? getDecks);

  const initial = useMemo(() => {
    const stored = readStoredSetup();
    return {
      difficulty: params.difficulty ?? stored.difficulty ?? PRACTICE_DEFAULT_DIFFICULTY,
      deck: params.deck ?? stored.deck ?? "random",
    };
  }, [params]);

  /** The game to play, fixed (seed and seat included) when it is chosen; null shows the setup. */
  const [game, setGame] = useState<PracticeStartConfig | null>(() => autostartConfig(params));
  const [controller, setController] = useState<PracticeController | null>(null);
  /** A lesson's coach, fed by the controller from its first snapshot on; null for a practice game. */
  const [tracker, setTracker] = useState<CoachTracker | null>(null);

  // Read when a game starts, so a prop change mid-game does not tear the game down.
  const factory = useRef(hostFactory ?? defaultHostFactory);
  factory.current = hostFactory ?? defaultHostFactory;
  const scripts = useRef(coachScript ?? scriptFor);
  scripts.current = coachScript ?? scriptFor;

  /** The last catalog a game brought, so the next setup screen previews decks without asking. */
  const [gameDefs, setGameDefs] = useState<CardDefs | null>(null);
  const lobbyCatalog = useLobbyCatalog(game === null, gameDefs, hostFactory ?? defaultHostFactory);
  const pace = useRef(pacing ?? pacingFor(params));
  pace.current = pacing ?? pacingFor(params);

  useEffect(() => {
    if (game === null) return;
    const next = createPracticeController({ host: factory.current(), pacing: pace.current });
    // Subscribed before `start` is sent, so the coach reads every snapshot (tutorial/tracker.ts).
    const lessonId = game.lesson;
    const coach =
      lessonId === undefined ? null : createCoachTracker(next, scripts.current(lessonId) ?? silentScript(lessonId));
    setController(next);
    setTracker(coach);
    void next.start(game);
    return () => {
      coach?.dispose();
      next.dispose();
      setController((current) => (current === next ? null : current));
      setTracker((current) => (current === coach ? null : current));
    };
  }, [game]);

  const state = useControllerState(controller);
  const startedDefs = state.defs;
  useEffect(() => {
    if (startedDefs !== null) setGameDefs(startedDefs);
  }, [startedDefs]);
  // A callback ref held in state, so the watch starts when the board first renders, not before.
  const [boardRoot, setBoardRoot] = useState<HTMLDivElement | null>(null);
  useBoardBusy(boardRoot, controller);
  // `?pace=fast` is e2e pacing: a headless browser plays every voice line, and holding the AI for
  // each would only slow the spec. A player's game always waits for the line, and for the card the
  // AI has just played to be read.
  const held = DEV_ONLY && params.pace === "fast" ? null : controller;
  useVoiceHold(held);
  useShowcaseHold(held);

  // The dev handle for spec 13: the debug snapshot (seed, decks, handicaps, log, state, hash) for
  // the replay check, and the live view. Never in a production build.
  useEffect(() => {
    if (!DEV_ONLY || controller === null) return;
    const handle: PracticeDevHandle = {
      snapshot: () => controller.debug(),
      get aiSeat() {
        return controller.getState().aiSeat;
      },
      get thinking() {
        return controller.getState().thinking;
      },
      get view() {
        return controller.getState().snapshot?.view ?? null;
      },
    };
    window.__jackiohPractice = handle;
    return () => {
      if (window.__jackiohPractice === handle) delete window.__jackiohPractice;
    };
  }, [controller]);
  // The tutorial's own handle for the e2e lesson spec (tutorial/devHandle.ts), under the same rule.
  useTutorialDevHandle(tracker, game?.lesson ?? null);

  const onStart = useCallback(
    (choice: PracticeSetupChoice) => {
      writeStoredSetup(choice.difficulty, choice.deck);
      setGame(configFor(choice, params));
    },
    [params],
  );

  /** A lesson always plays on its own seed and seat, from the path, the URL or its result dialog. */
  const onStartLesson = useCallback((lesson: TutorialLesson) => {
    setGame(lessonStartConfig(lesson));
  }, []);

  /**
   * "New game" or "Menu" in the middle of a game asks first. The question belongs to the game it
   * was asked in, so a game that ends, or a fresh one, never inherits it.
   */
  const [leaveAskedFor, setLeaveAskedFor] = useState<{ game: PracticeStartConfig; to: PracticeLeaveTo } | null>(null);
  const onAskNewGame = useCallback(() => {
    if (game !== null) setLeaveAskedFor({ game, to: "setup" });
  }, [game]);
  const onAskMenu = useCallback(() => {
    if (game !== null) setLeaveAskedFor({ game, to: "menu" });
  }, [game]);
  const onStay = useCallback(() => {
    setLeaveAskedFor(null);
  }, []);

  const onNewGame = useCallback(() => {
    setLeaveAskedFor(null);
    setGame(null);
  }, []);

  const onMenu = useCallback(() => {
    setLeaveAskedFor(null);
    navigate(paths.landing);
  }, []);

  /** "Exit tutorial" in the middle of a lesson asks first, as "New game" does. */
  const onAskExitLesson = useCallback(() => {
    if (game !== null) setLeaveAskedFor({ game, to: "lessons" });
  }, [game]);

  /** "Play a practice game" after the last lesson: the lobby, scrolled to the practice setup. */
  const [scrollToSetup, setScrollToSetup] = useState(false);
  const onPlayPractice = useCallback(() => {
    setLeaveAskedFor(null);
    setScrollToSetup(true);
    setGame(null);
  }, []);
  const practiceHeader = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!scrollToSetup || game !== null) return;
    practiceHeader.current?.scrollIntoView?.({ block: "start" });
    setScrollToSetup(false);
  }, [scrollToSetup, game]);

  // A reload, a closed tab or a Back that leaves the page would end a game in progress without a
  // word (a practice game is not saved, §9.9), so the browser asks first, as it does for an unsent
  // form. A finished game, the setup and the failure screen let the page go.
  const inProgress = game !== null && state.phase === "playing";
  useEffect(() => {
    if (!inProgress) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      // Older engines show the prompt only when returnValue is set.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [inProgress]);

  /** The same difficulty and deck again, with a fresh seed and seat (unless the URL fixes them). */
  const onPlayAgain = useCallback(() => {
    if (game === null) return;
    setGame(configFor({ difficulty: game.difficulty, deck: game.deck }, params));
  }, [game, params]);

  /** The game whose result dialog the player closed to read the final board; null shows it. */
  const [resultClosedFor, setResultClosedFor] = useState<PracticeStartConfig | null>(null);
  /**
   * The game whose result dialog may open: the board plays its own game-over sequence first (task
   * 1's killing blow and Victory or Defeat), and the dialog waits for it rather than covering it.
   * With no effects to watch (reduced motion, effects off, e2e pacing) it opens at once.
   */
  const [resultReadyFor, setResultReadyFor] = useState<PracticeStartConfig | null>(null);
  // This game's own end: a Play again renders once with the old controller's finished state.
  const finished = state.config === game && state.snapshot?.view.result != null;
  useEffect(() => {
    if (!finished || game === null) return;
    const effectsOff = reducedMotionNow() || getFxSettings().intensity === "off";
    const delay = effectsOff ? 0 : (pace.current.resultDelayMs ?? 0);
    if (delay <= 0) {
      setResultReadyFor(game);
      return;
    }
    const timer = setTimeout(() => {
      setResultReadyFor(game);
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [finished, game]);
  const onViewBoard = useCallback(() => {
    setResultClosedFor(game);
  }, [game]);
  const onShowResult = useCallback(() => {
    setResultClosedFor(null);
    setResultReadyFor(game);
  }, [game]);

  const onAction = useCallback(
    (body: ActionBody) => {
      controller?.act(body);
    },
    [controller],
  );

  const defs = state.defs;
  const lookup = useMemo(() => (defs === null ? null : lookupFromDefs(defs)), [defs]);

  // A lesson won is a lesson completed on this device (R294), the moment the view says so, whether
  // or not its result dialog is ever seen.
  const lesson = game?.lesson === undefined ? undefined : lessonById(game.lesson);
  const lessonResult = lesson !== undefined && state.config === game ? (state.snapshot?.view ?? null) : null;
  const wonLesson =
    lesson !== undefined && lessonResult?.result != null && lessonResult.result.winner === lessonResult.viewer
      ? lesson.id
      : null;
  useEffect(() => {
    if (wonLesson !== null) markLessonComplete(wonLesson);
  }, [wonLesson]);
  /** The path as it stood when this game started, so the result can say what the win opened. */
  const progressAtStart = useMemo(() => (game === null ? null : readTutorialProgress()), [game]);

  if (game === null) {
    return (
      <Shell variant="lobby">
        <BackLink to={paths.landing} />
        <TutorialPath onStart={onStartLesson} />
        <header className="practice-lobby__header" ref={practiceHeader}>
          <p className="practice-lobby__eyebrow">Solo play · no account needed</p>
          <h1 className="practice-lobby__title">Practice against the AI</h1>
          <p className="practice-intro">
            A full game against a computer opponent, right here in your browser. It plays the same way at
            every difficulty; only its resources change.
          </p>
        </header>
        <PracticeSetup
          saved={saved}
          initial={initial}
          defs={lobbyCatalog.defs}
          defsFailed={lobbyCatalog.failed}
          onStart={onStart}
        />
      </Shell>
    );
  }

  if (state.phase === "failed") {
    return (
      <Shell variant="lobby">
        <div className="practice-stage">
          <h1 className="practice-stage__title">The practice game stopped</h1>
          <p className="notice" data-testid={practiceTestid.error} role="alert">
            {state.failure ?? "Something went wrong while the game was running."}
          </p>
          <button type="button" className="practice-play" data-testid={practiceTestid.newGame} onClick={onNewGame}>
            New game
          </button>
        </div>
      </Shell>
    );
  }

  const snapshot = state.snapshot;
  const config = state.config;
  if (controller === null || snapshot === null || config === null || state.phase === "idle" || state.phase === "starting") {
    return (
      <Shell variant="lobby">
        {/* A worker that never answers must not trap the page: back to the setup, which has its own
            way out (integration: every screen has a way back). */}
        <BackLink onPress={onNewGame} />
        <div className="practice-stage">
          <div className="practice-shuffle" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <p className="practice-stage__status" data-testid={practiceTestid.loading} role="status">
            Shuffling the decks…
          </p>
        </div>
      </Shell>
    );
  }

  const board = (
    // The result panel is practice's own dialog (PracticeResult), so the board keeps to its chip.
    // R345: a lesson keeps R82's automatic turn end on, since its coach is written around it.
    <Game
      view={snapshot.view}
      legal={snapshot.legal}
      onAction={onAction}
      error={snapshot.error}
      resultForm="chip"
      {...(config.lesson === undefined ? {} : { autoEndTurn: true })}
    />
  );
  const result = snapshot.view.result;
  const outcome = result === null ? null : outcomeOf(result, snapshot.view.viewer);
  // The lesson this board is playing: the controller's own config, so a screen that has just asked
  // for the next lesson still labels the game it shows until that one starts.
  const playing = config.lesson === undefined ? undefined : lessonById(config.lesson);
  const coached = playing !== undefined && tracker !== null ? { lesson: playing, tracker } : null;
  const nextLesson = coached === null ? undefined : nextLessonOf(coached.lesson.id);

  return (
    <Shell variant="game">
      {coached !== null ? (
        <TutorialHud
          lesson={coached.lesson}
          tracker={coached.tracker}
          view={snapshot.view}
          humanSeat={config.humanSeat}
          aiSeat={state.aiSeat}
          thinking={state.thinking}
          outcome={outcome}
          onShowResult={onShowResult}
          onExit={result === null ? onAskExitLesson : onNewGame}
        />
      ) : (
        <header
          className="practice-hud"
          data-testid={practiceTestid.hud}
          data-difficulty={config.difficulty}
          data-human-seat={config.humanSeat}
          data-ai-seat={state.aiSeat ?? ""}
          data-thinking={state.thinking ? "true" : "false"}
        >
          <span className="practice-hud__tier">
            <TierCrest tier={config.difficulty} size="sm" />
            <span className="practice-hud__label">
              <span className="practice-hud__mode">Practice</span>
              <strong>{DIFFICULTY_LABEL[config.difficulty]}</strong>
            </span>
          </span>
          {/* SPEC §2.1 step 5: p1 takes the first turn. */}
          <span className="practice-hud__seat">{config.humanSeat === "p1" ? "You go first" : "You go second"}</span>
          <span className="practice-hud__status">
            <ModifierList view={snapshot.view} />
            <ThinkIndicator thinking={state.thinking} />
            {outcome === null ? null : (
              <button
                type="button"
                className="practice-hud__outcome"
                data-testid={practiceTestid.outcome}
                data-outcome={outcome}
                onClick={onShowResult}
              >
                {OUTCOME_TITLE[outcome]}
              </button>
            )}
          </span>
          {/* A game in progress is one tap from gone, so leaving it asks first; a finished one does not. */}
          <button
            type="button"
            className="practice-hud__new"
            data-testid={practiceTestid.newGame}
            aria-haspopup={result === null ? "dialog" : undefined}
            onClick={result === null ? onAskNewGame : onNewGame}
          >
            New game
          </button>
          <button
            type="button"
            className="practice-hud__menu"
            data-testid={practiceTestid.menu}
            aria-haspopup={result === null ? "dialog" : undefined}
            aria-label="Main menu"
            title="Main menu"
            onClick={result === null ? onAskMenu : onMenu}
          >
            Menu
          </button>
        </header>
      )}
      {/* A lesson's coach comes between the HUD and the board: on a phone it is a panel in the page
          there, and the board takes the height that is left (tutorial/Coach.tsx); elsewhere it
          floats over the board, and this is only where the keyboard and a screen reader meet it. */}
      {coached === null ? null : <Coach tracker={coached.tracker} boardRoot={boardRoot} />}
      {/* `practice-table` holds the board and hands it the screen's height (practice.css, "the game
          screen"); the wrapper is also the root `useBoardBusy` watches. */}
      <div
        className="practice-board practice-table"
        ref={setBoardRoot}
        data-difficulty={config.difficulty}
        data-thinking={state.thinking ? "true" : "false"}
      >
        {lookup === null ? board : <CatalogContext.Provider value={lookup}>{board}</CatalogContext.Provider>}
      </div>
      {leaveAskedFor !== null && leaveAskedFor.game === game && result === null ? (
        <PracticeLeave
          to={leaveAskedFor.to}
          onStay={onStay}
          onLeave={leaveAskedFor.to === "menu" ? onMenu : onNewGame}
        />
      ) : null}
      {result === null || resultClosedFor === game || resultReadyFor !== game ? null : coached !== null ? (
        <TutorialResult
          result={result}
          viewer={snapshot.view.viewer}
          lesson={coached.lesson}
          next={nextLesson}
          unlockedNow={
            nextLesson !== undefined && progressAtStart !== null && lessonStatus(progressAtStart, nextLesson) === "locked"
          }
          onNext={() => {
            if (nextLesson !== undefined) onStartLesson(nextLesson);
          }}
          onRetry={() => {
            onStartLesson(coached.lesson);
          }}
          onBack={onNewGame}
          onPlayPractice={onPlayPractice}
          onViewBoard={onViewBoard}
        />
      ) : (
        <PracticeResult
          result={result}
          viewer={snapshot.view.viewer}
          difficulty={config.difficulty}
          onPlayAgain={onPlayAgain}
          onChangeSetup={onNewGame}
          onViewBoard={onViewBoard}
        />
      )}
    </Shell>
  );
}

function PracticeWithAccount(props: Omit<PracticeRouteProps, "account">): ReactElement {
  const account = useAccount();
  return <PracticeScreen {...props} account={account} />;
}

export default function PracticeRoute(props: PracticeRouteProps): ReactElement {
  // A component per source rather than a conditional hook: an injected account never touches the
  // session or the network.
  if (props.account !== undefined) return <PracticeScreen {...props} account={props.account} />;
  return <PracticeWithAccount {...props} />;
}
