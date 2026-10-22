/**
 * The interface-block language, for whatever draws it: browser-safe, no imports outside this folder.
 *
 * The desktop renders from these so it agrees with the prompt and the check about every rule. What
 * only the runtime needs — the prompt section, the notes on the next turn — is not exported here.
 */

export { chartData, chartValue } from "./chart.ts";
export { COMPONENTS } from "./catalog.ts";
export { initialState, readProps } from "./check.ts";
export { evaluate, text } from "./expression.ts";
export { parseBlock, type ParsedBlock, type UiElement, type UiNode } from "./parse.ts";
