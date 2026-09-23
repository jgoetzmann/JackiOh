// The settings barrel (docs/polish/7-mobile-ux.md S8): every other slice imports from here.
export * from "./store.ts";
export * from "./slots.ts";
export { default as SettingsPanel, type SettingsPanelProps } from "./SettingsPanel.tsx";
export { default as SettingsButton, type SettingsButtonProps } from "./SettingsButton.tsx";
