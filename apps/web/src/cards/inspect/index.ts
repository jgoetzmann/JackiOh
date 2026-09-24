// Inspect: hover preview, touch sheet and the deck builder's detail view (docs/polish/6-cards.md,
// Surface C). cards/index.ts re-exports the public names from here; nothing inside cards/ imports
// this barrel.

export { useInspectTrigger } from "./useInspectTrigger.tsx";
export type {
  InspectBindings,
  InspectHandlers,
  InspectOptions,
  InspectOverlayState,
  InspectRenderSubject,
  InspectSubject,
} from "./useInspectTrigger.tsx";
export { closeInspect } from "./store.ts";
export { CardDetail } from "./CardDetail.tsx";
export { CardListPreview, CardListSheet } from "./CardList.tsx";
export type { CardListEntry, CardListProps } from "./CardList.tsx";
export type { CardDetailProps } from "./CardDetail.tsx";
export { placePreview } from "./placement.ts";
export type { PreviewPrefer, Rect } from "./placement.ts";
export {
  CLICK_SUPPRESS_MS,
  HOVER_DELAY_MS,
  LIST_PREVIEW_MAX,
  LONG_PRESS_MS,
  LONG_PRESS_SLOP_PX,
  PREVIEW_GAP_PX,
  PREVIEW_HEIGHT_PX,
  PREVIEW_MARGIN_PX,
} from "./constants.ts";
export {
  INSPECT_CLOSE,
  INSPECT_DETAIL,
  INSPECT_FACE,
  INSPECT_FACE_BASE,
  INSPECT_FACE_RADIANT,
  INSPECT_GLOSSARY,
  INSPECT_HOVER,
  INSPECT_LIST_BACK,
  INSPECT_LIST_CARD,
  INSPECT_LIST_COUNT,
  INSPECT_LIST_DETAIL,
  INSPECT_LIST_HOVER,
  INSPECT_LIST_MORE,
  INSPECT_LIST_SHEET,
  INSPECT_SCRIM,
  INSPECT_SHEET,
} from "./testids.ts";
