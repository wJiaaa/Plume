/**
 * 一段 Markdown 画到叶子（链接、图片）时还要知道的两件事。单放一个文件：`Markdown.tsx` 提供它们，
 * `MarkdownLink.tsx`、`MarkdownImage.tsx` 读它们，谁也不必回头引谁。
 */

import { createContext } from "react";

/**
 * What this text is, beyond the characters in it.
 *
 * Only pictures need it, and only two facts about them: where a relative `src` points, and whether
 * this document is one whose remote references may be fetched. A context rather than a prop chain
 * because everything between the component and an `<img>` is a plain function — `renderBlock`,
 * `renderToken` — and threading two values through nine of them to reach one leaf is nine places
 * for them to be dropped.
 *
 * The default is the strict one. A caller that says nothing gets what every caller got before this
 * existed: relative paths unresolved and remote pictures shown as named links.
 */
export interface DocumentContext {
	/** The directory the text was read from, if it was read from one. */
	baseDir?: string;
	/** Whether an https `src` may be fetched (through the main process) and drawn. */
	remoteImages: boolean;
	/** Whether a path with no `baseDir` may be drawn from this machine's disk — see `localImages`. */
	localImages?: boolean;
}

export const Doc = createContext<DocumentContext>({ remoteImages: false });

/**
 * 这条回复还在写（字还在来，或者还没演完）。和 `fade` 分开，因为减弱动效时 `fade` 不亮，而界面块
 * 写完之前不给点这件事不能跟着动效一起关：从前减弱动效时选项还在长，就已经点得动了。
 */
export const Writing = createContext(false);
