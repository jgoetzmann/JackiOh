// `/practice` with the tutorial (SPEC §9.10): the lesson path tops the lobby, a lesson starts as a
// practice game that names it, and plays under the tutorial's HUD with the coach over the board.
//
// Every seam is injected as in practice.test.tsx — the account, the host that would start a worker,
// the e2e pacing — plus the lesson's coach script, so these tests use a small fake script rather
// than the real lessons', and the fake host decides the game's outcome.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { opponentOf } from "@jackioh/shared";
import type { PlayerId } from "@jackioh/shared";

import type { Account } from "../net/gate.ts";
import { PRACTICE_PACING_FAST } from "../practice/config.ts";
import type { PracticeHost } from "../practice/host.ts";
import type { PracticeRequestBody, PracticeResponse, PracticeSnapshot, PracticeStartConfig } from "../practice/protocol.ts";
import { practiceTestid } from "../practice/testids.ts";
import { baseView, card, emptySide } from "../test/fixtures.ts";
import type { LessonScript } from "../tutorial/coach.ts";
import { TUTORIAL_LESSONS, type TutorialLesson } from "../tutorial/lessons.ts";
import { __resetTutorialProgressForTests, markLessonComplete, readTutorialProgress } from "../tutorial/progress.ts";
import { tutorialTestid } from "../tutorial/testids.ts";
import PracticeRoute from "./practice.tsx";

const ANONYMOUS: Account = { kind: "anonymous" };

function lesson(number: number): TutorialLesson {
  const found = TUTORIAL_LESSONS.find((candidate) => candidate.number === number);
  if (found === undefined) throw new Error(`no lesson ${String(number)}`);
  return found;
}

/** Every lesson gets this script: a welcome that holds the AI, then "end your turn". */
const FAKE_SCRIPT: LessonScript = {
  lessonId: "fake",
  steps: [
    { id: "welcome", kind: "info", title: "Welcome", text: "This is the board.", anchor: { kind: "hand" }, holdAi: true },
    {
      id: "end",
      kind: "act",
      title: "End your turn",
      text: "Press End turn.",
      anchor: { kind: "endTurn" },
      done: (ctx, since) => ctx.view.turn !== since.turn,
    },
    { id: "last", kind: "info", title: "Well played", text: "Finish the game.", final: true },
  ],
  tips: [],
};

// ---------------------------------------------------------------------------------------------
// the scripted host: `endTurn` wins the game for the human, `concede` loses it
// ---------------------------------------------------------------------------------------------

type HostOptions = { aiToAct?: boolean };

type RouteHost = {
  factory: () => PracticeHost;
  requests: PracticeRequestBody[];
  starts(): PracticeStartConfig[];
};

function snapshotFor(human: PlayerId, aiToAct: boolean, over: Partial<PracticeSnapshot["view"]> = {}): PracticeSnapshot {
  const ai = opponentOf(human);
  return {
    view: baseView({
      viewer: human,
      turn: 1,
      active: aiToAct ? ai : human,
      phase: "main",
      you: emptySide(human, { hand: [card({ instanceId: "h1", defId: "core-008", cost: 1 })] }),
      opponent: emptySide(ai, { hand: { count: 4 } }),
      ...over,
    }),
    legal: aiToAct ? [] : [{ type: "endTurn" }, { type: "concede" }],
    aiToAct,
    error: null,
  };
}

function routeHost(options: HostOptions = {}): RouteHost {
  const requests: PracticeRequestBody[] = [];
  let id = 0;
  let human: PlayerId = "p1";
  const host: PracticeHost = {
    request(body) {
      requests.push(body);
      id += 1;
      const mine = id;
      let response: PracticeResponse;
      switch (body.type) {
        case "start":
          human = body.config.humanSeat;
          response = {
            id: mine,
            type: "started",
            snapshot: snapshotFor(human, options.aiToAct ?? false),
            defs: {},
            aiSeat: opponentOf(human),
          };
          break;
        case "act":
          response = {
            id: mine,
            type: "snapshot",
            snapshot:
              body.action.type === "endTurn"
                ? { ...snapshotFor(human, false, { turn: 2, result: { winner: human, reason: "hero-death" } }), legal: [] }
                : body.action.type === "concede"
                  ? { ...snapshotFor(human, false, { result: { winner: opponentOf(human), reason: "concede" } }), legal: [] }
                  : snapshotFor(human, false),
          };
          break;
        case "aiStep":
          response = { id: mine, type: "snapshot", snapshot: snapshotFor(human, false) };
          break;
        case "catalog":
          response = { id: mine, type: "catalog", defs: {} };
          break;
        case "debug":
          response = {
            id: mine,
            type: "debug",
            debug: {
              seed: "s",
              decks: [[], []],
              handicaps: {},
              log: [],
              state: {},
              hash: "0",
              difficulty: "easy",
              humanSeat: human,
              lesson: "basics",
            },
          };
          break;
      }
      return Promise.resolve(response);
    },
    dispose() {},
  };
  return {
    factory: () => host,
    requests,
    starts: () => requests.flatMap((body) => (body.type === "start" ? [body.config] : [])),
  };
}

function renderRoute(host: RouteHost): ReturnType<typeof render> {
  return render(
    <PracticeRoute
      hostFactory={host.factory}
      pacing={PRACTICE_PACING_FAST}
      account={ANONYMOUS}
      loadDecks={vi.fn(() => Promise.reject(new Error("an anonymous page has no decks")))}
      coachScript={() => FAKE_SCRIPT}
    />,
  );
}

function visit(search: string): void {
  window.history.replaceState(null, "", `/practice${search}`);
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

function before(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

beforeEach(() => {
  visit("");
  window.localStorage.clear();
  __resetTutorialProgressForTests();
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("practice needs no server"))));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete window.__jackiohPractice;
  delete window.__jackiohTutorial;
  window.localStorage.clear();
  __resetTutorialProgressForTests();
  window.history.replaceState(null, "", "/");
});

describe("the lesson path on /practice", () => {
  it("sits at the very top of the lobby: under Back, above the practice header and its setup", async () => {
    renderRoute(routeHost());
    await settle();
    const back = screen.getByTestId("nav-back");
    const path = screen.getByTestId(tutorialTestid.path);
    const header = screen.getByRole("heading", { level: 1, name: "Practice against the AI" });
    const setup = screen.getByTestId(practiceTestid.setup);
    expect(before(back, path)).toBe(true);
    expect(before(path, header)).toBe(true);
    expect(before(path, setup)).toBe(true);
  });

  it("Start sends a practice start that names the lesson, on the lesson's own seed and seat", async () => {
    visit("?seed=mine&seat=p2");
    const host = routeHost();
    renderRoute(host);
    await settle();
    fireEvent.click(screen.getByTestId(tutorialTestid.lessonStart(lesson(1).id)));
    await settle();
    expect(host.starts()).toEqual([
      { seed: lesson(1).seed, difficulty: "easy", humanSeat: lesson(1).humanSeat, deck: { kind: "random" }, lesson: lesson(1).id },
    ]);
  });

  it("a locked lesson's button starts nothing", async () => {
    const host = routeHost();
    renderRoute(host);
    await settle();
    fireEvent.click(screen.getByTestId(tutorialTestid.lessonStart(lesson(2).id)));
    await settle();
    expect(host.starts()).toEqual([]);
    expect(screen.getByTestId(tutorialTestid.path)).toBeInTheDocument();
  });
});

describe("?lesson= starts a lesson at once", () => {
  it("?lesson=<id> autostarts it, and neither ?seed= nor ?seat= overrides the lesson's", async () => {
    visit(`?lesson=${lesson(2).id}&seed=other&seat=p2&pace=fast`);
    const host = routeHost();
    renderRoute(host);
    await settle();
    expect(host.starts()).toHaveLength(1);
    expect(host.starts()[0]).toMatchObject({ seed: lesson(2).seed, humanSeat: lesson(2).humanSeat, lesson: lesson(2).id });
    expect(screen.getByTestId(tutorialTestid.hud)).toHaveAttribute("data-lesson", lesson(2).id);
  });

  it("an unknown lesson id is dropped: the lobby shows, and nothing starts", async () => {
    visit("?lesson=no-such-lesson");
    const host = routeHost();
    renderRoute(host);
    await settle();
    expect(host.starts()).toEqual([]);
    expect(screen.getByTestId(tutorialTestid.path)).toBeInTheDocument();
  });
});

describe("a lesson plays under the tutorial HUD with the coach", () => {
  async function startLesson(number = 1, options: HostOptions = {}): Promise<RouteHost> {
    visit(`?lesson=${lesson(number).id}`);
    const host = routeHost(options);
    renderRoute(host);
    await settle();
    return host;
  }

  it("the HUD names the lesson and the step, and the practice HUD is not drawn", async () => {
    await startLesson();
    const hud = screen.getByTestId(tutorialTestid.hud);
    expect(hud).toHaveTextContent(`Tutorial ·Lesson 1: ${lesson(1).title}`);
    expect(screen.getByTestId(tutorialTestid.step)).toHaveTextContent("Step 1 of 3");
    expect(screen.queryByTestId(practiceTestid.hud)).toBeNull();
    expect(screen.getByTestId("game")).toBeInTheDocument();
    expect(screen.getByTestId(tutorialTestid.coach)).toHaveAttribute("data-coach-step", "welcome");
  });

  it("Skip step in the HUD and in the bubble each move the coach on", async () => {
    await startLesson();
    fireEvent.click(screen.getByTestId(tutorialTestid.skip));
    expect(screen.getByTestId(tutorialTestid.step)).toHaveTextContent("Step 2 of 3");
    expect(screen.getByTestId(tutorialTestid.coach)).toHaveAttribute("data-coach-step", "end");
    fireEvent.click(screen.getByTestId(tutorialTestid.coachSkip));
    expect(screen.getByTestId(tutorialTestid.step)).toHaveTextContent("Step 3 of 3");
  });

  it("a holdAi step holds the AI until Got it", async () => {
    const host = await startLesson(1, { aiToAct: true });
    await settle();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(host.requests.some((body) => body.type === "aiStep")).toBe(false);

    fireEvent.click(screen.getByTestId(tutorialTestid.coachAck));
    await waitFor(() => {
      expect(host.requests.some((body) => body.type === "aiStep")).toBe(true);
    });
  });

  it("Exit tutorial asks first mid-lesson; Keep playing stays, Leave goes back to the lesson path", async () => {
    await startLesson();
    const exit = screen.getByTestId(tutorialTestid.exit);
    expect(exit).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(exit);
    const leave = screen.getByTestId(practiceTestid.leave);
    expect(leave).toHaveTextContent("go back to the lessons");
    fireEvent.click(within(leave).getByTestId(practiceTestid.leaveStay));
    expect(screen.queryByTestId(practiceTestid.leave)).toBeNull();
    expect(screen.getByTestId(tutorialTestid.hud)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(tutorialTestid.exit));
    fireEvent.click(screen.getByTestId(practiceTestid.leaveConfirm));
    await settle();
    expect(screen.queryByTestId(tutorialTestid.hud)).toBeNull();
    expect(screen.getByTestId(tutorialTestid.path)).toBeInTheDocument();
  });

  it("a win completes the lesson at once; the dialog opens the next lesson on its own seed", async () => {
    const host = await startLesson(1);
    fireEvent.click(screen.getByTestId("end-turn"));
    await settle();
    expect(readTutorialProgress().completed).toEqual([lesson(1).id]);

    const dialog = await screen.findByTestId(tutorialTestid.result);
    expect(dialog).toHaveAttribute("data-outcome", "win");
    expect(dialog).toHaveTextContent(`Lesson 2: ${lesson(2).title} is unlocked.`);
    expect(screen.queryByTestId(practiceTestid.result)).toBeNull();

    // Closed, it comes back from the HUD's outcome chip; once over, Exit leaves without asking.
    fireEvent.click(screen.getByTestId(tutorialTestid.viewBoard));
    expect(screen.queryByTestId(tutorialTestid.result)).toBeNull();
    fireEvent.click(screen.getByTestId(tutorialTestid.outcome));
    expect(screen.getByTestId(tutorialTestid.result)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(tutorialTestid.next));
    await settle();
    expect(host.starts().at(-1)).toMatchObject({ seed: lesson(2).seed, lesson: lesson(2).id });
    expect(screen.getByTestId(tutorialTestid.hud)).toHaveAttribute("data-lesson", lesson(2).id);
  });

  it("a loss offers the lesson's tip and Retry, which plays the same lesson on the same seed", async () => {
    const host = await startLesson(1);
    // Concede asks first now (ConfirmConcede): the dialog's own Concede concedes.
    fireEvent.click(screen.getByTestId("concede"));
    fireEvent.click(screen.getByTestId("concede-confirm"));
    const dialog = await screen.findByTestId(tutorialTestid.result);
    expect(dialog).toHaveAttribute("data-outcome", "loss");
    expect(dialog).toHaveTextContent("You conceded this one.");
    expect(dialog).toHaveTextContent(`Tip: ${lesson(1).retryTip}`);
    expect(readTutorialProgress().completed).toEqual([]);

    fireEvent.click(screen.getByTestId(tutorialTestid.retry));
    await settle();
    const starts = host.starts();
    expect(starts).toHaveLength(2);
    expect(starts[1]).toEqual(starts[0]);
    expect(starts[1]).not.toBe(starts[0]);
  });

  it("Back to lessons shows the path with the lesson completed", async () => {
    await startLesson(1);
    fireEvent.click(screen.getByTestId("end-turn"));
    await settle();
    fireEvent.click(await screen.findByTestId(tutorialTestid.back));
    await settle();
    expect(screen.getByTestId(tutorialTestid.lesson(lesson(1).id))).toHaveAttribute("data-status", "completed");
    expect(screen.getByTestId(tutorialTestid.lesson(lesson(2).id))).toHaveAttribute("data-status", "unlocked");
  });

  it("after the last lesson, Play a practice game goes back to the lobby", async () => {
    for (const each of TUTORIAL_LESSONS.slice(0, -1)) markLessonComplete(each.id);
    await startLesson(TUTORIAL_LESSONS.length);
    fireEvent.click(screen.getByTestId("end-turn"));
    await settle();
    expect(await screen.findByTestId(tutorialTestid.result)).toHaveAccessibleName("Tutorial complete");
    fireEvent.click(screen.getByTestId(tutorialTestid.playPractice));
    await settle();
    expect(screen.getByTestId(practiceTestid.setup)).toBeInTheDocument();
    expect(screen.getByTestId(tutorialTestid.path)).toHaveAttribute("data-complete", "true");
  });

  it("the dev handles: __jackiohTutorial reads the coach live, and the practice handle still works", async () => {
    await startLesson(1);
    const handle = window.__jackiohTutorial;
    expect(handle?.lessonId).toBe(lesson(1).id);
    expect(handle?.display).toMatchObject({ mode: "step", id: "welcome" });
    expect(handle?.suggested).toBeNull();
    fireEvent.click(screen.getByTestId(tutorialTestid.coachAck));
    expect(handle?.display).toMatchObject({ mode: "step", id: "end" });
    expect(window.__jackiohPractice).toBeDefined();
    await expect(window.__jackiohPractice?.snapshot()).resolves.toMatchObject({ lesson: "basics" });

    cleanup();
    expect(window.__jackiohTutorial).toBeUndefined();
  });
});
