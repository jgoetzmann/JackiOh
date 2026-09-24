// @jackioh/ai: the practice opponent (SPEC §9.9, docs/polish/3-ai.md). Pure and seeded like the
// engine (CLAUDE.md rule 4): every exported name below is unique across the package, because this
// barrel re-exports every module whole.

export * from "./types";
export * from "./config";
export * from "./observe";
export * from "./determinize";
export * from "./evaluate";
export * from "./candidates";
export * from "./simulate";
export * from "./lethal";
export * from "./search";
export * from "./reply";
export * from "./mulligan";
export * from "./decide";
export * from "./deck";
export * from "./shadowBan";
export * from "./baselines";
export * from "./match";
export * from "./gate";
export * from "./sweep";
