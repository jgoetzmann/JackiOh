// How a lesson starts: the practice start config that plays it (SPEC §9.10, R291).
//
// A lesson game is a practice game whose `lesson` names it. The worker's core then plays the
// lesson's own two decks with the tutorial handicap (`AI_TUTORIAL`, R290) and ignores `deck` and
// `difficulty`'s handicap, so those two carry placeholders here: the config type needs them, and no
// lesson reads them. The seed and the seat are the lesson's own, so a lesson deals the same hands
// every time; the page never lets `?seed=` override them.

import type { PracticeStartConfig } from "../practice/protocol.ts";
import type { TutorialLesson } from "./lessons.ts";

export function lessonStartConfig(lesson: TutorialLesson): PracticeStartConfig {
  return {
    seed: lesson.seed,
    difficulty: "easy",
    humanSeat: lesson.humanSeat,
    deck: { kind: "random" },
    lesson: lesson.id,
  };
}
