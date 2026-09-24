// The card presentation module's one public door (docs/polish/6-cards.md, Surface).
//
// Everything outside `src/cards/` imports from here. Inside `src/cards/`, files import each other
// by path and never through this barrel, so it cannot create an import cycle.

export { faceModel } from "./model.ts";
export type { FaceCost, FaceLayout, FaceModel, FaceSource, FaceStats, StatTone } from "./model.ts";

export { GLOSSARY, KEYWORD_MARK } from "./glossary.ts";
export type { GlossaryEntry, GlossaryTermId, TriggerTermId, VerbTermId } from "./glossary.ts";

export { glossaryFor, termsIn, tokenizeRules } from "./rules.ts";
export type { RulesToken } from "./rules.ts";

export { nameTier, textTier, useFitText } from "./fit.ts";
export type { LengthTier } from "./fit.ts";

export {
  FACE_ASPECT,
  FACE_TEXT_MIN_HEIGHT_PX,
  FIT_MIN,
  FIT_STEPS,
  NAME_TIER_MAX,
  TEXT_TIER_MAX,
  TIER_SCALE,
} from "./constants.ts";

export { CardFace } from "./CardFace.tsx";
export type { CardFaceProps } from "./CardFace.tsx";
export { MinionFace } from "./MinionFace.tsx";
export type { MinionFaceProps } from "./MinionFace.tsx";
export { CardBack } from "./CardBack.tsx";

// Slice A: art.
export { ART_MANIFEST, CardArt, artUrl } from "./art/index.ts";
export type { ArtManifest, ArtShape } from "./art/index.ts";

// Slice C: inspect.
export {
  CardDetail,
  closeInspect,
  INSPECT_CLOSE,
  INSPECT_DETAIL,
  INSPECT_FACE,
  INSPECT_FACE_BASE,
  INSPECT_FACE_RADIANT,
  INSPECT_GLOSSARY,
  INSPECT_HOVER,
  INSPECT_SCRIM,
  INSPECT_SHEET,
  useInspectTrigger,
} from "./inspect/index.ts";
export type { CardDetailProps, InspectBindings, InspectOptions, InspectSubject } from "./inspect/index.ts";

// Slice C: card settings, which task 7's panel mounts at integration.
export {
  CARD_SETTINGS_DEFAULTS,
  CARD_SETTINGS_FIELDS,
  CARD_SETTINGS_KEY,
  readCardSettings,
  subscribeCardSettings,
  useCardSettings,
  writeCardSettings,
} from "./settings.ts";
export type { CardSettings } from "./settings.ts";
