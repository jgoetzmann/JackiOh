// Lint fixture: must fail the purity ban (BUILD M1-T2).
export const today = (): string => new Date().toISOString();
