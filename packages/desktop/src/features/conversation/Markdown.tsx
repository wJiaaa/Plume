/**
 * Markdown renderer.
 *
 * Hand-written rather than `marked` + `dangerouslySetInnerHTML`: model output and other people's
 * pull request descriptions are both untrusted, and building React elements means every string
 * goes through React's escaping on the way in.
 *
 * This file is only the drawing. Which lines are a table and which characters are emphasis are
 * decided in `markdown-blocks.ts` and `markdown-inline.ts`, where they can be tested.
 */

import { translate } from "../../i18n/translate.ts";
import { ExternalLink, FolderOpen, Globe } from "../../ui/icons/index.ts";
import { createContext, type CSSProperties, Fragment, isValidElement, memo, type ReactNode, type SyntheticEvent, useContext, useEffect, useMemo, useRef, useState } from "react";
import { CodeBlock } from "./CodeBlock.tsx";
import { isMermaid, MermaidBlock } from "./MermaidBlock.tsx";
import { InterfaceBlock } from "./interface/InterfaceBlock.tsx";
import { isInterface } from "./interface/interface-text.ts";
import { MarkdownTable } from "./MarkdownTable.tsx";
import { Disclosure } from "../../ui/layout/Disclosure.tsx";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import type { Block, ListItem } from "../../lib/markdown/blocks.ts";
import { parseMarkdown, parseMarkdownChunks } from "../../lib/markdown/blocks.ts";
import { resolveAsset, isAbsolutePath } from "../../lib/markdown/assets.ts";
import { fileLinkCaption, filePathInCode } from "../../lib/markdown/file-link.ts";
import { groupTokens, HUGE_BLOCK } from "../../lib/markdown/slice.ts";
import { type Inline, parseInline } from "../../lib/markdown/inline.ts";
import { renderMath } from "../../lib/markdown/math.ts";
import { stripEmoji } from "../../lib/markdown/strip-emoji.ts";
import { withoutFollowups } from "@plume/core/followups";
import { completeTailHeld } from "../../lib/markdown/stream-tail.ts";
import { bridge } from "../../services/index.ts";
import { useApp } from "../../store/index.ts";
import { openFilePane } from "../dock/index.ts";
import { useRevealLabel, withFileThere } from "../../store/open-targets.ts";
import { iconColour, lookFor } from "../../ui/fileIcon.tsx";
import { SessionScope, useDockScope, useScopedProjectPath } from "../../app/session-scope.tsx";
import { useSmoothText } from "./useSmoothText.ts";
import { BlockScan, FadeScope, FadeText } from "./FadeText.tsx";
import { usePathMenu } from "./PathMenu.tsx";
import { useLocatedPaths } from "./located-path.ts";
import { FileChoices } from "./FileChoices.tsx";
import { WebLink } from "./WebLink.tsx";
import { OverlayScrollbar } from "../../ui/scroll/OverlayScrollbar.tsx";

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
interface DocumentContext {
	/** The directory the text was read from, if it was read from one. */
	baseDir?: string;
	/** Whether an https `src` may be fetched (through the main process) and drawn. */
	remoteImages: boolean;
	/** Whether a path with no `baseDir` may be drawn from this machine's disk — see `localImages`. */
	localImages?: boolean;
	preview?: boolean;
}

const Doc = createContext<DocumentContext>({ remoteImages: false });

/**
 * Memoised on the four values it is given, all of them primitives.
 *
 * Parsing is the expensive half of drawing a transcript, and it was being redone for reasons that
 * have nothing to do with the text: dragging the sidebar's edge re-renders every component that
 * reads the layout, which reaches the transcript, which reached here — so one drag re-parsed
 * several hundred kilobytes of markdown, forty-five times over. Nothing about a message changes
 * because a pane got wider, and a boundary that says so costs one shallow comparison.
 */
export const Markdown = memo(function Markdown({
	text,
	className = "",
	baseDir,
	remoteImages = false,
	localImages = false,
	preview = false,
	streaming = false,
}: {
	text: string;
	className?: string;
	/**
	 * Where this file lives, so `<img src="assets/logo.png">` can find `assets/logo.png`.
	 *
	 * Passed by the panes that opened a real file. A pull request body and a model's reply have no
	 * directory — a relative path in either refers to a checkout that may not be on this machine —
	 * so they pass nothing and those images stay links.
	 */
	baseDir?: string;
	/**
	 * Draw pictures this document points at over https.
	 *
	 * Off unless asked for, and asked for only by the file viewer. A README's badges are part of
	 * reading it; the same behaviour applied to a comment anybody can write would make opening a
	 * pull request a request to whatever host that comment named. The fetch happens in the main
	 * process either way — see `system:remoteImage`.
	 */
	remoteImages?: boolean;
	/**
	 * Draw pictures at paths on this disk even without a `baseDir`.
	 *
	 * For the agent's own replies. The `baseDir` note above holds for text written elsewhere; this agent
	 * runs here, and a path in its reply is one it just wrote on this machine — an absolute path, or one
	 * relative to the session's project, the same reading `Link` gives it. Left as a link, a QR code it
	 * generated was a chip to click before it could be scanned. The media protocol still decides what may
	 * be served; a refused one falls back to that link.
	 */
	localImages?: boolean;
	/** A bounded, non-interactive excerpt without code tools or image loading. */
	preview?: boolean;
	/**
	 * 这段字还在一个字一个字地进来。
	 *
	 * 开着时做三件事：出字按平滑的节奏走（见 `useSmoothText`），新字淡入（见 `FadeText`），最后
	 * 一段没写完的标记先补上（见 `completeTail`）。只由画正在输出的那条回复的地方打开；关掉之后
	 * 先把剩下的字放完、淡完，再画原文本身。
	 */
	streaming?: boolean;
}) {
	/*
	 * System emoji come out first.
	 *
	 * Everything that reaches this component was written somewhere else — a pull request
	 * description, a review comment, a model's reply — and a colour emoji dropped into a screen of
	 * single-weight line icons is drawn by the OS from another font, in colours from nobody's
	 * palette. One `🤖` in a description is the loudest thing on the page by accident.
	 *
	 * Here rather than at each call site, because this is the one door remote prose comes through.
	 */
	/*
	 * 去表情和解析都缓存住，否则每一次重渲染都把整段正文重扫一遍。
	 *
	 * 这两步原先都在 render body 里裸跑。对一段一两 KB 的回复无所谓，对一条 233KB 的消息就不是了：
	 * 本机有个会话里粘进来过一整个文件，打开它主线程占死两秒多。上面那条「一次拖动就重新解析了一遍」
	 * 的注释说的是同一件事——那次给 `doc` 加了 memo，正文这一半漏了。
	 *
	 * 这只省掉**重复**的那些次。第一次仍然要老老实实解析一遍，那一次的成本由 `CodeBlock` 的高亮
	 * 上限和下面的块数上限管。
	 */
	// 写完之后还要演完：没放出来的字放完、最后一个字淡完，`active` 才落下。见 `useSmoothText`。
	const { text: shown, active, recent } = useSmoothText(text, streaming);
	/*
	 * 回复末尾的下一步建议（`@plume/core/followups`）是给输入框的，不画：写完的整行拿掉，写到一半的
	 * 由 `completeTailHeld` 先藏着，所以先补尾巴再去标记。
	 */
	const { text: clean, heldImage } = useMemo(() => {
		const held = active ? completeTailHeld(stripEmoji(shown)) : { text: stripEmoji(shown), heldImage: false };
		return { text: withoutFollowups(held.text), heldImage: held.heldImage };
	}, [shown, active]);

	// The class rides alongside `prose-dw` rather than replacing it, so a caller can dial the
	// size or colour down — reasoning is secondary text — without losing the block styling.
	/*
	 * `min-w-0`, because this is often a flex child and its contents are not all shrinkable.
	 *
	 * A flex item defaults to `min-width: auto`, which means "at least as wide as my contents" —
	 * and a code block holding an unbroken 40-character hash has contents that do not wrap. Without
	 * this the item grows to fit it, `pre`'s own `overflow-x` never comes into play because there
	 * is nothing left to overflow, and the width is pushed up through every ancestor instead.
	 */
	// Memoised because a new object here re-renders every picture in the document on every keystroke
	// of a streaming reply — which for a remote one means dropping and re-requesting it.
	const doc = useMemo(() => ({ baseDir, remoteImages, localImages, preview }), [baseDir, remoteImages, localImages, preview]);
	// 减弱动效时 `active` 不会亮起：淡入的时长会被压成零，可还没轮到的字仍要等 `animation-delay`。
	const fade = active;
	/*
	 * 新挂上的一段字按位置分辨哪些字是刚放出来的（见 `FadeText`）：`clean` 从 `from` 起是最近淡入时长内
	 * 放出来的。改同一个对象，不换引用，否则每个 `FadeText` 每帧都跟着重画。补尾巴、去表情让 `clean`
	 * 和放出来的原文差几个字，边界也就差几个字——肉眼看不出。
	 */
	const scope = useRef({ from: Number.POSITIVE_INFINITY }).current;
	scope.from = fade ? Math.max(0, clean.length - recent) : Number.POSITIVE_INFINITY;
	const blocks = useMemo(() => {
		// 每一块的原文在 `clean` 里从哪开始：块的原文就是源文的一段，依次找过去。
		let cursor = 0;
		return parseMarkdownChunks(clean).map(({ block, raw }, index) => {
			const found = clean.indexOf(raw, cursor);
			const start = found < 0 ? cursor : found;
			cursor = start + raw.length;
			return <BlockView key={index} block={block} raw={raw} start={start} preview={preview} fade={fade} />;
		});
	}, [clean, preview, fade]);

	return (
		<Doc.Provider value={doc}>
			<Writing.Provider value={active || streaming}>
				<FadeScope.Provider value={scope}>
				<div className={`prose-dw min-w-0 ${className}`}>
					{blocks}
					{/*
					 * 图的地址还在写（本地路径动辄上百字）：先占住它要落的那一段，`)` 到了由 `Image` 接着占，加载完在原处显影。
					 * 接在一句话后面的图写完是在那一段里换行（独占一行，见 `fitsInLine`），不隔段间距——占位也不隔。
					 */}
					{heldImage && localImages && (
						<p data-ly-joined={/\n\s*$/.test(clean) ? undefined : ""}>
							<ImagePending />
						</p>
					)}
				</div>
				</FadeScope.Provider>
			</Writing.Provider>
		</Doc.Provider>
	);
});

/**
 * 这条回复还在写（字还在来，或者还没演完）。和 `fade` 分开，因为减弱动效时 `fade` 不亮，而界面块
 * 写完之前不给点这件事不能跟着动效一起关：从前减弱动效时选项还在长，就已经点得动了。
 */
const Writing = createContext(false);

function WrittenInterface({ code, open, fallback }: { code: string; open: boolean; fallback: ReactNode }) {
	const writing = useContext(Writing);
	return <InterfaceBlock source={code} writing={open && writing} fallback={fallback} />;
}

/**
 * 一个顶层块，原文没变就不重画。
 *
 * 流式输出时整条消息每帧都要重新解析，这本身不贵；贵的是随后把前面所有块——每个链接、每张表、
 * 每个代码块——再对一遍。原文相同的块画出来必然相同，所以只比原文：一条长回复写到后面，每帧重画的
 * 只有正在写的那一块。
 *
 * `fade` 在整条回复写完时一起关掉，所有块各重画一次，淡入用的 span 换回纯文本。
 */
const BlockView = memo(
	function BlockView({ block, raw, start, preview, fade }: { block: Block; raw: string; start: number; preview: boolean; fade: boolean }) {
		// 每画一次从头找：块里的每段字按文档顺序在原文里找自己的位置，见 `FadeText`。
		const scan = { raw, start, cursor: 0 };
		// oxlint-disable-next-line react/jsx-no-constructed-context-values -- 游标就是要每画一次归零；块已经按原文 memo，不会多画
		return <BlockScan.Provider value={scan}>{renderBlock(block, preview, fade)}</BlockScan.Provider>;
	},
	(before, after) => before.raw === after.raw && before.start === after.start && before.preview === after.preview && before.fade === after.fade,
);

function renderBlocks(source: string, preview = false, fade = false): ReactNode {
	return parseMarkdown(source).map((block, index) => <Fragment key={index}>{renderBlock(block, preview, fade)}</Fragment>);
}

/** `fade`：这块字还在输出，新字淡入。见 `FadeText`。 */
function renderBlock(block: Block, preview = false, fade = false): ReactNode {
	switch (block.kind) {
		case "heading": {
			const Tag = `h${Math.min(block.level, 4)}` as "h1" | "h2" | "h3" | "h4";
			return <Tag style={block.align ? { textAlign: block.align } : undefined}>{inline(block.text, fade)}</Tag>;
		}
		/*
		 * A `<div align="center">` and what it holds.
		 *
		 * `text-align` inherits, which is why nothing has to be pushed down into the children: one
		 * declaration on the box sets the picture, the badges and the tagline underneath it, exactly
		 * as the same three lines behave in a browser.
		 */
		case "html":
			return (
				<div className="ly-md-html" style={block.align ? { textAlign: block.align } : undefined}>
					{block.children.map((child, index) => (
						<Fragment key={index}>{renderBlock(child, preview, fade)}</Fragment>
					))}
				</div>
			);
		case "paragraph":
			// 大到会把浏览器按住不放的那种，切开画；正常的一段走原路，一行代码都不多跑。
			if (block.text.length > HUGE_BLOCK) return <HugeParagraph text={block.text} />;
			return <p>{inline(block.text, fade)}</p>;
		case "code":
			if (preview) return <pre><code>{block.code}</code></pre>;
			/*
			 * ```mermaid 画成图，画不出来就还是那段代码。
			 *
			 * `fallback` 由这里给而不是组件自己 import `CodeBlock`：那样会绕出一条十二个模块的循环
			 * 依赖（`Markdown → MermaidBlock → CodeBlock → dock → … → conversation/index → Markdown`），
			 * `pnpm arch` 拦得住。分工也因此更清楚——组件知道画没画成，「画不成时显示什么」是这段
			 * Markdown 的事。
			 */
			if (isMermaid(block.lang)) {
				return <MermaidBlock code={block.code} fallback={<CodeBlock lang={block.lang} code={block.code} fade={fade} />} />;
			}
			/*
			 * ```ui 画成界面（`InterfaceBlock`）。还在写、而且围栏没收口的那一块只给看不给点：写完之前，
			 * 它的选项还在一个一个长出来。画不出来时退回代码，理由同上。
			 */
			if (isInterface(block.lang)) {
				return <WrittenInterface code={block.code} open={Boolean(block.open)} fallback={<CodeBlock lang={block.lang} code={block.code} fade={fade} />} />;
			}
			return <CodeBlock lang={block.lang} code={block.code} fade={fade} />;
		case "rule":
			return <hr />;
		case "quote":
			return <blockquote>{renderBlocks(block.text, preview, fade)}</blockquote>;
		case "math":
			return <MathBlock tex={block.tex} />;
		case "details":
			return preview ? <p>{inline(block.summary)}</p> : <Details summary={block.summary} blocks={block.children} fade={fade} />;
		case "list": {
			const Tag = block.ordered ? "ol" : "ul";
			return (
				<Tag>
					{block.items.map((item, index) => (
						<Item key={index} item={item} preview={preview} fade={fade} />
					))}
				</Tag>
			);
		}
		case "table":
			return <MarkdownTable block={block} inline={fade ? fadingInline : inline} preview={preview} />;
		default:
			return null;
	}
}

/**
 * 一段大到画不动的正文。
 *
 * 现场是一条 12.26 MB 的消息：193 行，最长的一行 1.3 MB。装进一个 `<p>` 里，Chromium 要给一千
 * 三百万个字符算换行——实测 45 秒还没画完，整个窗口按住不动。这不是「慢」，是没法用。
 *
 * 切成小片、每片挂 `content-visibility: auto` 之后是 17 毫秒：屏幕外的片浏览器根本不去布局，滚到
 * 哪儿算哪儿。内容一个字不少地留在 DOM 里——能选、能复制、Ctrl+F 找得到（Chrome 会为查找自动展开
 * 跳过的片），不折叠、不聚合、不截断。
 *
 * **为什么是块级元素。** `content-visibility` 在 `inline-block` 上实测无效（同样 45 秒不出来），
 * 所以片必须是块级的，而块级元素之间浏览器复制时会插一个换行。`groupTokens` 因此尽量只在原本就有
 * 换行的地方开新片；只有单个 text token 自己就超过上限时才从中间断开，那一处复制会多一个换行。
 *
 * 解析仍然是整段一次（964 ms），不是逐片解析（1443 ms）——片边界会打断匹配，反而更慢。
 */
function HugeParagraph({ text }: { text: string }) {
	const groups = useMemo(() => groupTokens(parseInline(text)), [text]);
	return (
		<div className="ly-md-huge">
			{groups.map((group, index) => (
				<p key={index} className="ly-md-huge-slice">
					{renderTokens(group)}
				</p>
			))}
		</div>
	);
}

function Item({ item, preview, fade }: { item: ListItem; preview: boolean; fade: boolean }) {
	const body = (
		<>
			{inline(item.text, fade)}
			{item.children.map((child, index) => (
				<Fragment key={index}>{renderBlock(child, preview, fade)}</Fragment>
			))}
		</>
	);

	if (item.checked === undefined) return <li>{body}</li>;
	return (
		<li className="ly-task" data-done={item.checked}>
			{/* Drawn, not an <input>: this reflects what the author wrote, and is not a control. */}
			<span aria-hidden className="ly-task-box">
				{item.checked && (
					<svg viewBox="0 0 12 12" fill="none" aria-hidden>
						<path d="M2.5 6.2 4.8 8.5 9.5 3.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
					</svg>
				)}
			</span>
			<span>{body}</span>
		</li>
	);
}

/** `<details>`, folded the way every other section in the app folds rather than the browser's way. */
function Details({ summary, blocks, fade }: { summary: string; blocks: Block[]; fade: boolean }) {
	return (
		<Disclosure variant="framed" title={inline(summary, fade)}>
			{blocks.map((child, index) => (
				<Fragment key={index}>{renderBlock(child, false, fade)}</Fragment>
			))}
		</Disclosure>
	);
}

function MathBlock({ tex }: { tex: string }) {
	// A wide formula scrolls rather than wraps; its thumb is the code block's (see `CodeBlock`).
	const viewport = useRef<HTMLDivElement>(null);
	const html = renderMath(tex, true);
	// TeX that does not parse is shown as it was written; a red error box helps nobody read it.
	if (!html) return <pre className="ly-math-raw">{tex}</pre>;
	return (
		<div className="ly-math-frame ly-hscroll-own">
			{/* noDangerouslySetInnerHtml 在这里不适用（本仓库用 oxlint，不认 biome 的抑制注释，所以这只是一句说明）: KaTeX's own output, built from a parse tree it escapes. */}
			<div ref={viewport} className="ly-math-block" dangerouslySetInnerHTML={{ __html: html }} />
			<OverlayScrollbar viewport={viewport} orientation="horizontal" />
		</div>
	);
}

function inline(text: string, fade = false): ReactNode[] {
	return renderTokens(parseInline(text), fade);
}

/** 表格拿到的是一个函数；给它一个固定的，免得每次重画都是新的身份。 */
const fadingInline = (text: string) => inline(text, true);

function renderTokens(tokens: Inline[], fade = false): ReactNode[] {
	return tokens.map((token, index) => <Fragment key={index}>{renderToken(token, fade)}</Fragment>);
}

function renderToken(token: Inline, fade: boolean): ReactNode {
	switch (token.kind) {
		case "text":
			return fade ? <FadeText text={token.text} /> : token.text;
		case "code": {
			/*
			 * 行内代码写完才出现（见 `completeTail`），整枚一起淡入。`ly-fade-char` 的动画只在挂上时跑
			 * 一次，之后这枚代码跟着重画也不会再从头淡一遍。
			 */
			const code = (
				<code className={`[box-decoration-break:clone] [-webkit-box-decoration-break:clone]${fade ? " ly-fade-char" : ""}`}>{token.text}</code>
			);
			// 提示词让模型把路径写成 `path/to/file.ts:42` 以便点击；解析不到本机路径时 `Link` 原样还给这枚代码。
			const path = filePathInCode(token.text);
			return path ? <Link href={path}>{code}</Link> : code;
		}
		case "break":
			return <br />;
		case "strong":
			return <strong>{renderTokens(token.children, fade)}</strong>;
		case "em":
			return <em>{renderTokens(token.children, fade)}</em>;
		case "del":
			return <del>{renderTokens(token.children, fade)}</del>;
		case "tag": {
			const Tag = token.name;
			return <Tag>{renderTokens(token.children, fade)}</Tag>;
		}
		case "math": {
			const html = renderMath(token.tex, false);
			if (!html) return `$${token.tex}$`;
			// noDangerouslySetInnerHtml 在这里不适用（本仓库用 oxlint，不认 biome 的抑制注释，所以这只是一句说明）: KaTeX's own output, built from a parse tree it escapes.
			return <span className={fade ? "ly-math ly-fade-char" : "ly-math"} dangerouslySetInnerHTML={{ __html: html }} />;
		}
		case "link":
			return <Link href={token.href}>{renderTokens(token.children, fade)}</Link>;
		case "image":
			return <Image src={token.src} alt={token.alt} width={token.width} height={token.height} />;
		default:
			return null;
	}
}

/** Local artifacts use the bounded file reader; executable URI schemes never navigate the app. */
function textOf(node: ReactNode): string {
	if (node == null || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
	return "";
}

/**
 * The room the exit bar needs: a 28px card (22px buttons, 2px padding above and below, a 1px
 * hairline), a 4px gap, and 2px to spare. It is the same arithmetic as `[data-ly-file-actions]` in
 * `markdown.css` — change one and the other has to follow.
 */
const ACTIONS_CLEARANCE = 34;

/**
 * The `overflow` values that cut off whatever sticks out. Listed rather than written as "anything
 * but visible": where there is no computed value the answer is an empty string, and that is not a clip.
 */
const CLIPPING_OVERFLOW = /^(hidden|clip|auto|scroll|overlay)$/;

/**
 * Whether the exit bar goes above the chip or below it.
 *
 * Above by default: the line above has already been read, so covering a piece of it costs the least,
 * while the line below is the one about to be read — and the link's own path tooltip opens there too.
 * But reaching upward runs into whatever clips the chip. Every message row carries `contain: paint`
 * (`.group/msg` in `base.css`), so the part of the bar that leaves the row is never painted, and a
 * chip on a message's first line hits that every time; the top of the scroller and a table's
 * horizontal scroll box do the same. So measure: if it does not fit above and there is more room
 * below, go below.
 *
 * Measured once, as the pointer or focus arrives, with no listener kept: where the chip is at that
 * moment is where the bar will appear.
 */
function actionsSide(chip: HTMLElement): "above" | "below" {
	const box = chip.getBoundingClientRect();
	let top = 0;
	let bottom = window.innerHeight;
	for (let el = chip.parentElement; el && el !== document.body; el = el.parentElement) {
		const style = getComputedStyle(el);
		const clips =
			CLIPPING_OVERFLOW.test(style.overflowX) ||
			CLIPPING_OVERFLOW.test(style.overflowY) ||
			/paint|strict|content/.test(style.contain) ||
			style.contentVisibility === "auto";
		if (!clips) continue;
		const edge = el.getBoundingClientRect();
		top = Math.max(top, edge.top);
		bottom = Math.min(bottom, edge.bottom);
	}
	const above = box.top - top;
	return above >= ACTIONS_CLEARANCE || above >= bottom - box.bottom ? "above" : "below";
}

/**
 * How far the bar's left edge sits from the chip's: straight above where the pointer came in, but
 * never overhanging either end of the chip.
 *
 * Pinned to the top-right corner, a 300px filename put the bar 250px diagonally away from a pointer
 * that entered at the left end. Most of that path is off the chip, so only the grace period on
 * leaving kept the bar alive — and measured, it had faded out before the pointer got there. Above
 * the pointer, it is 20px straight up.
 *
 * Placed once, on entry, and not after: a bar that chases the pointer is wobbling, not waiting to be
 * pressed. A chip narrower than the bar gets it flush left rather than hanging off the left edge.
 */
function actionsOffset(chip: HTMLElement, pointerX: number): number {
	const box = chip.getBoundingClientRect();
	const width = chip.querySelector<HTMLElement>("[data-ly-file-actions-bar]")?.offsetWidth ?? 0;
	return Math.round(Math.max(0, Math.min(pointerX - box.left - width / 2, box.width - width)));
}

/**
 * A link to a file on this machine, plus two ways out that only appear when the pointer arrives.
 *
 * Clicking the link itself works as it always has — it opens in the built-in panel, the fastest way
 * to read a `.md` or a `.ts`. The trouble is the files it cannot open: click an `.exe` and the dock
 * panel is pushed aside in exchange for "binary file, cannot be shown as text". The reader gives up
 * what they were looking at to be told it cannot be opened, while the two things they actually wanted
 * — run it, see where it is — are both out of reach.
 *
 * So there are two exits beside it, rather than a change to what clicking means: a link that
 * sometimes opens the panel and sometimes Finder is unpredictable, and that makes people warier of
 * clicking than two extra icons do.
 *
 * They only show on hover, for the same reason as the `MessageActions` row: they repeat beside every
 * filename on the page, and left visible they would compete with the text. Where they show is a
 * small bar *above* the chip, not inside it:
 *
 * - They used to sit on the chip's right edge — 17px buttons, 11.5px icons — directly over the last
 *   30px of the filename. The gradient meant to hold the end up with the chip's own background held
 *   nothing: that background is itself a 5% translucent wash of ink, so the letters showed through
 *   between the icons and the two ran together.
 * - Growing the chip to the right to make room pushes the following words along and can re-wrap the
 *   line, so the text jumps under the pointer.
 *
 * The bar is out of flow, so not a pixel of the text moves, and the buttons can be the size small
 * icon buttons are everywhere else (`IconButton`'s `sm`: 22px, 14px icons) instead of being squeezed
 * into the height of a line. How it shows, how it hides and what happens on a device without hover
 * are all in `markdown.css`, under `[data-ly-file-actions]`.
 */
function FileLink({ href, path, choices, children }: { href: string; path: string; choices?: readonly string[]; children: ReactNode }) {
	const revealLabel = useRevealLabel();
	const caption = fileLinkCaption(textOf(children), path);
	const look = lookFor(path.split(/[/\\]/).pop() || path, false);
	// The file pane opens in the screen this link is drawn in: the keyboard reaches a link in a screen
	// without the press that would have given that screen the focus.
	const screen = useDockScope();
	// Right-click: the same menu a file the turn edited offers, with 打开 doing what a click does.
	const project = useScopedProjectPath();
	const pathMenu = usePathMenu(project);
	/*
	 * The name is in the project more than once — `ResponseSelector.java` in three modules. `path` is
	 * then only the working-directory guess, which names nothing; a click asks which one instead.
	 */
	const [picking, setPicking] = useState<HTMLElement | null>(null);
	const [side, setSide] = useState<"above" | "below">("above");
	/** Pixels from the chip's left edge to the bar's; `null` keeps it right, for focus, which has no pointer to face. */
	const [offset, setOffset] = useState<number | null>(null);
	const openFile = () => void openFilePane(path, screen ?? undefined);
	const fail = (error: unknown) => useApp.getState().notify(String(error), "error");
	// A page the agent wrote is something to look at, not only source to read: the click still opens the source.
	const page = /\.html?$/i.test(path);
	const scoped = useContext(SessionScope);
	const openPage = () => {
		const state = useApp.getState();
		void bridge.browser.command({ type: "open", url: path, sessionId: scoped === undefined ? state.activeSessionId : scoped, newTab: true }).catch(fail);
	};
	const place = (event: SyntheticEvent<HTMLElement>, pointerX?: number) => {
		// Already inside the bar: leave it where it is, or it moves out from under the pointer.
		if (event.target instanceof Element && event.target.closest("[data-ly-file-actions]")) return;
		setSide(actionsSide(event.currentTarget));
		setOffset(pointerX === undefined ? null : actionsOffset(event.currentTarget, pointerX));
	};
	/*
	 * Tooltips open away from the bar. With the bar above, the buttons' tips go up too rather than back
	 * down over the chip; with the bar below, the link's own path tip moves above so the two do not stack.
	 */
	const buttonTip = side === "above" ? "top" : "bottom";

	return (
		/*
		 * The geometry is `[data-ly-file-link]` in `markdown.css`; this only builds the DOM — link,
		 * filename, two exits. A name that is too long is ellipsised by the stylesheet, not cut here.
		 */
		<span
			data-ly-file-link
			data-ly-file-actions-side={side}
			style={offset === null ? undefined : ({ "--ly-file-actions-x": `${offset}px` } as CSSProperties)}
			onPointerEnter={(event) => place(event, event.clientX)}
			/*
			 * Only focus that arrives from the keyboard. Clicking the link focuses it too, and then the
			 * pointer is already on the chip with the bar lined up above it; placing the bar again as if
			 * there were no pointer makes it jump to the right end at the moment of the press.
			 */
			onFocus={(event) => {
				if (!event.currentTarget.matches(":hover")) place(event);
			}}
		>
			<a
				href={href}
				data-ly-tip={caption.tip}
				data-ly-tip-side={side === "below" ? "top" : undefined}
				onClick={(event) => {
					event.preventDefault();
					if (choices) setPicking(event.currentTarget);
					else openFile();
				}}
				onContextMenu={(event) => {
					if (!choices) return pathMenu.onContextMenu(event, { path, onOpen: openFile });
					event.preventDefault();
					setPicking(event.currentTarget);
				}}
			>
				<look.Icon size={13} strokeWidth={1.9} style={{ color: iconColour(look) }} />
				<span data-ly-file-name>{caption.text}</span>
			</a>
			{/* Both exits act on one file, and which one is the question the click asks. */}
			{!choices && (
				<span data-ly-file-actions>
					<span data-ly-file-actions-bar>
						{page && <FileLinkAction label={translate("openTarget.builtinBrowser")} tipSide={buttonTip} icon={<Globe size={14} />} onClick={openPage} />}
						<FileLinkAction
							label={translate("openTarget.defaultApp")}
							tipSide={buttonTip}
							icon={<ExternalLink size={14} />}
							onClick={() => void withFileThere(path, (there) => bridge.system.openPath(there))}
						/>
						<FileLinkAction
							label={revealLabel}
							tipSide={buttonTip}
							icon={<FolderOpen size={14} />}
							onClick={() => void withFileThere(path, (there) => bridge.system.openIn("reveal", there))}
						/>
					</span>
				</span>
			)}
			{pathMenu.element}
			{choices && picking && (
				<FileChoices anchor={picking} paths={choices} root={project} onPick={(choice) => void openFilePane(choice, screen ?? undefined)} onClose={() => setPicking(null)} />
			)}
		</span>
	);
}

/** One exit: the app's small icon button, which gives the tooltip and the accessible name together. */
function FileLinkAction({
	label,
	icon,
	tipSide,
	onClick,
}: {
	label: string;
	icon: ReactNode;
	tipSide: "top" | "bottom";
	onClick: () => void;
}) {
	return (
		<IconButton
			size="sm"
			label={label}
			icon={icon}
			tipSide={tipSide}
			onClick={(event) => {
				// Stop here: the link and the message row around it each give a click a meaning of their own.
				event.preventDefault();
				event.stopPropagation();
				onClick();
			}}
		/>
	);
}

function Link({ href, children }: { href: string; children: ReactNode }) {
	const { baseDir, preview } = useContext(Doc);
	/*
	 * A relative path means the project of the conversation this text is in, which in a split is not
	 * necessarily the one with focus: resolved against the focused one, a `README.md` in one screen's
	 * reply opened the other project's. The path alone, as one subscription — a long transcript has a
	 * great many links.
	 */
	const project = useScopedProjectPath();
	const safe = href.startsWith("http://") || href.startsWith("https://");
	const target = href.replace(/:\d+(?:-\d+)?$/, "");
	const guess = safe ? null : resolveAsset(baseDir ?? project ?? (isAbsolutePath(href) ? "/" : undefined), target);
	/*
	 * `approvals.ts:125` joined to the working directory mostly names nothing: models write the bare
	 * name, or a path relative to some package. The one file in the project it can only mean wins; with
	 * several of that name the link lets the reader pick — see `located-path.ts`. Not under a `baseDir`:
	 * that is the document's own folder, and its relative paths are written for it.
	 */
	const located = useLocatedPaths(guess && !baseDir && project && !isAbsolutePath(target) ? project : null, target);
	const path = located.length === 1 ? located[0] : guess;
	if (preview || (!safe && !path)) return <>{children}</>;
	if (path) return <FileLink href={href} path={path} choices={located.length > 1 ? located : undefined}>{children}</FileLink>;
	return <WebLink href={href}>{children}</WebLink>;
}

/**
 * A picture, drawn if there is a way to draw it and named if there is not.
 *
 * Three sources, three answers, and the page's `img-src` — `self data: blob:` — never moves:
 *
 * - `data:` and `blob:` go straight into `src`, as they always did.
 * - A path beside the file goes through `ly-media:`, the scheme the file panel already uses for
 *   images and video. Its handler re-checks that the path is inside an open project, so a README
 *   pointing at `../../../.ssh/id_rsa` gets a 403 rather than a picture.
 * - An https URL is fetched by the main process and comes back as a data URL, the same route
 *   avatars and registry logos take — and only for documents whose caller asked for it.
 *
 * Anything left over stays what it was: a named link that opens in the browser, which keeps the
 * reference and its filename instead of leaving a broken image behind.
 */
function Image({ src, alt, width, height }: { src: string; alt: string; width?: number; height?: number }) {
	const { baseDir, remoteImages, localImages, preview } = useContext(Doc);
	const project = useScopedProjectPath();
	/*
	 * 定在挂上那一刻：回复正在写时落下的图，先站在占位里、加载完再显影；写完的转录里的图直接就在，
	 * 否则每次滚回视野（重新挂载）都要再显影一遍。
	 */
	const [reveal] = useState(useContext(Writing));
	const [loaded, setLoaded] = useState<string | null>(null);
	const [small, setSmall] = useState(false);
	const remote = !preview && remoteImages && src.startsWith("https://") ? src : null;
	const fetched = useRemoteImage(remote);
	// A `src` that would not load — refused by the media protocol, or gone from the disk — is drawn as its link.
	const [broken, setBroken] = useState<string | null>(null);

	const direct = src.startsWith("data:") || src.startsWith("blob:") ? src : null;
	const base = baseDir ?? (localImages ? (project ?? (isAbsolutePath(src.trim()) ? "/" : undefined)) : undefined);
	const onDisk = direct || remote || preview ? null : resolveAsset(base, src);
	const checked = localImages && !baseDir ? onDisk : null;
	const version = useFileVersion(checked);
	const local = !onDisk ? null : !checked ? bridge.files.mediaUrl(onDisk) : typeof version === "number" ? bridge.files.mediaUrl(onDisk, version) : null;
	const resolved = direct ?? fetched ?? (local === broken ? null : local);

	if (preview) return <span>{alt || translate("markdown.image")}</span>;

	if (resolved) {
		const settling = reveal && checked !== null;
		const waiting = settling && loaded !== resolved;
		const picture = (
			<img
				src={resolved}
				alt={alt}
				loading="lazy"
				onError={() => setBroken(resolved)}
				onLoad={(event) => {
					setLoaded(resolved);
					if (checked) setSmall(fitsInLine(event.currentTarget, height));
				}}
				/*
				 * The author's `width` as a maximum, not as a width.
				 *
				 * `<img width="200">` in a README means "at most this big"; setting the attribute
				 * itself would also make it a minimum, and a 200px logo would then overflow a pane
				 * narrower than that rather than shrinking with everything else.
				 */
				style={{ maxWidth: width ? `min(100%, ${width}px)` : undefined, maxHeight: height ? `${height}px` : undefined }}
				className={`ly-md-image${checked && !small ? " ly-md-image-block" : ""}${waiting ? " ly-md-image-waiting" : settling ? " ly-image-reveal" : ""}`}
			/>
		);
		// 加载完之前图本身没有高度：占位留着，图在它旁边不占地方地加载。结构两头一样，图是同一个元素，不重新加载。
		return (
			<>
				{waiting && <ImagePending />}
				{picture}
			</>
		);
	}

	// In flight: a gap, not a link that is about to be replaced by the picture underneath it.
	if (remote && fetched === undefined) return null;
	if (checked && version === undefined) return reveal ? <ImagePending /> : null;

	const name = alt || decodeURIComponent(src.split("/").pop()?.split("?")[0] || translate("markdown.image"));
	return (
		<Link href={src}>
			<span className="ly-md-image-link">
				{/* The same size as the file chip's icon: two kinds of link prefix in one paragraph, and at 11.5px beside body text it is only x-height tall and reads as punctuation. */}
				<ExternalLink size={13} strokeWidth={1.9} />
				{name}
			</span>
		</Link>
	);
}

/**
 * 不超过两行字高的图留在字里，更高的独占一行。
 *
 * 只管回复里的本地图。`.ly-md-image` 默认行内是为了 README 的徽章排成一行，那些都在两行字高以内，
 * 照旧；二维码、截图跟在字里，会把一行字撑成图那么高、字悬在图中间。没加载完之前当它是大图：
 * 回复里的图多半是大的，先独占一行，小图标加载完再并回字里，比反过来跳得少。
 */
function fitsInLine(img: HTMLImageElement, height?: number): boolean {
	const line = Number.parseFloat(getComputedStyle(img).lineHeight) || 24;
	return Math.min(img.naturalHeight, height ?? Number.POSITIVE_INFINITY) <= line * 2;
}

/** 一张还没到的图站的位置：和生成图等图时同一块点阵底板（`.ly-canvas`）。 */
function ImagePending() {
	return <span className="ly-md-image-pending ly-canvas" aria-hidden="true" />;
}

/**
 * When a file on disk last changed, for the media URL — see `mediaUrl`.
 *
 * Read once per mount and per path: the agent overwriting a picture in place and then pointing a new
 * reply at it is the case this exists for, and that reply mounts a new `Image`. Same three states as
 * `useRemoteImage`; `null` is a file this window may not read, which stays a link. Only for a reply's
 * own paths — a file pane's documents are reread with the pane.
 */
function useFileVersion(path: string | null): number | null | undefined {
	const [read, setRead] = useState<{ path: string; version: number | null } | null>(null);

	useEffect(() => {
		if (!path) return;
		let alive = true;
		void bridge.files
			.read(path)
			.catch(() => null)
			.then((contents) => alive && setRead({ path, version: contents ? (contents.modifiedAt ?? 0) : null }));
		return () => {
			alive = false;
		};
	}, [path]);

	return path && read?.path === path ? read.version : undefined;
}

/**
 * One remote picture as a data URL.
 *
 * Three states, not two: `undefined` while the request is in flight, `null` once it has failed,
 * and the data URL when it arrived. The caller needs the distinction — a picture that has not
 * answered yet should leave a gap, and one that will never answer should fall back to its link, so
 * the reference is not silently lost.
 */
function useRemoteImage(url: string | null): string | null | undefined {
	const [data, setData] = useState<string | null | undefined>(undefined);

	useEffect(() => {
		if (!url) return;
		let alive = true;
		setData(undefined);
		void bridge.system
			.remoteImage(url)
			.then((result) => alive && setData(result))
			.catch(() => alive && setData(null));
		return () => {
			alive = false;
		};
	}, [url]);

	return url ? data : null;
}
