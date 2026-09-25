// Every lesson's coach script, by lesson id (SPEC §9.10). The page loads these; the practice worker
// never does (it needs only the decks, lessons.ts).

import type { LessonScript } from "../coach.ts";
import { script as advanced } from "./advanced.ts";
import { script as basics } from "./basics.ts";
import { script as spells } from "./spells.ts";
import { script as traps } from "./traps.ts";

export const LESSON_SCRIPTS: Readonly<Record<string, LessonScript>> = { basics, spells, traps, advanced };

export function scriptFor(lessonId: string): LessonScript | undefined {
  return LESSON_SCRIPTS[lessonId];
}
