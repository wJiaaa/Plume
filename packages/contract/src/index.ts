/**
 * The boundary between the renderer and the main process.
 *
 * `methods.ts` is what can be called and on which channel; `api.ts` is what each call takes and
 * answers, put together from one file per subject. The values are the method tables and the one
 * constant below; everything else is types, and so is everything this package takes from core.
 */

export { CHANNELS, METHODS } from "./methods.ts";

/**
 * 一个会话旁边最早的那个侧边聊天。
 *
 * 侧边栏点开就是它；后开的那些由界面起 id（`panel-instance.ts`），记在侧边聊天会话的 `sideId` 上。
 */
export const DEFAULT_SIDE_CHAT_ID = "default";

export type * from "./api.ts";
export type * from "./agent.ts";
export type * from "./extensions.ts";
export type * from "./files.ts";
export type * from "./forge.ts";
export type * from "./git.ts";
export type * from "./release.ts";
export type * from "./screenshot.ts";
export type * from "./session.ts";
export type * from "./sessions.ts";
export type * from "./settings.ts";
export type * from "./system.ts";
export type * from "./usage.ts";
export type * from "./windows.ts";
export type * from "./worktree.ts";
