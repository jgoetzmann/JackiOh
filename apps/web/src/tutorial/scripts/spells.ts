// Lesson "spells"'s coach script (SPEC §9.10): the steps the coach walks the player through, and the
// tips it shows when something new happens. Written against this lesson's fixed seed and decks
// (lessons.ts), so it may name the cards the seed deals.

import type { LessonScript } from "../coach.ts";
import { endTurn, info, keepHand } from "../steps.ts";

export const script: LessonScript = {
  lessonId: "spells",
  steps: [
    info({ id: "welcome", title: "Welcome", text: "Placeholder: this lesson's script is being written." }),
    keepHand({ id: "keep", title: "Keep your hand", text: "Press Confirm to keep all of these cards." }),
    endTurn({ id: "end-turn", title: "End your turn", text: "Press End turn." }),
    info({ id: "win", title: "Win the game", text: "Bring the enemy hero to 0 health.", final: true }),
  ],
  tips: [],
};
