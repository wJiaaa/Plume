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

import { Fragment, memo, type ReactNode, useContext, useMemo, useRef } from "react";
import { CodeBlock } from "./CodeBlock.tsx";
import { isMermaid, MermaidBlock } from "./MermaidBlock.tsx";
import { InterfaceBlock } from "./interface/InterfaceBlock.tsx";
import { isInterface } from "./interface/interface-text.ts";
import { MarkdownTable } from "./MarkdownTable.tsx";
import { Disclosure } from "../../ui/layout/Disclosure.tsx";
import type { Block, ListItem } from "../../lib/markdown/blocks.ts";
import { parseMarkdown, parseMarkdownChunks } from "../../lib/markdown/blocks.ts";
import { filePathInCode } from "../../lib/markdown/file-link.ts";
import { groupTokens, HUGE_BLOCK } from "../../lib/markdown/slice.ts";
import { type Inline, parseInline } from "../../lib/markdown/inline.ts";
import { renderMath } from "../../lib/markdown/math.ts";
import { stripEmoji } from "../../lib/markdown/strip-emoji.ts";
import { withoutFollowups } from "@plume/core/followups";
import { completeTailHeld } from "../../lib/markdown/stream-tail.ts";
import { useSmoothText } from "./useSmoothText.ts";
import { BlockScan, FadeIn, FadeScope, FadeText } from "./FadeText.tsx";
import { OverlayScrollbar } from "../../ui/scroll/OverlayScrollbar.tsx";
import { Doc, Writing } from "./context.ts";
import { Link } from "./MarkdownLink.tsx";
import { Image, ImagePending } from "./MarkdownImage.tsx";

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
	const doc = useMemo(() => ({ baseDir, remoteImages, localImages }), [baseDir, remoteImages, localImages]);
	/*
	 * 新挂上的一段字按位置分辨哪些字是刚放出来的（见 `FadeText`）：`clean` 从 `from` 起是最近淡入时长内
	 * 放出来的。改同一个对象，不换引用，否则每个 `FadeText` 每帧都跟着重画。补尾巴、去表情让 `clean`
	 * 和放出来的原文差几个字，边界也就差几个字——肉眼看不出。
	 */
	const scope = useRef({ from: Number.POSITIVE_INFINITY }).current;
	scope.from = active ? Math.max(0, clean.length - recent) : Number.POSITIVE_INFINITY;
	const blocks = useMemo(() => {
		// 每一块的原文在 `clean` 里从哪开始：块的原文就是源文的一段，依次找过去。
		let cursor = 0;
		return parseMarkdownChunks(clean).map(({ block, raw }, index) => {
			const found = clean.indexOf(raw, cursor);
			const start = found < 0 ? cursor : found;
			cursor = start + raw.length;
			return <BlockView key={index} block={block} raw={raw} start={start} fade={active} />;
		});
	}, [clean, active]);

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
	function BlockView({ block, raw, start, fade }: { block: Block; raw: string; start: number; fade: boolean }) {
		// 每画一次从头找：块里的每段字按文档顺序在原文里找自己的位置，见 `FadeText`。
		const scan = { raw, start, cursor: 0 };
		// oxlint-disable-next-line react/jsx-no-constructed-context-values -- 游标就是要每画一次归零；块已经按原文 memo，不会多画
		return <BlockScan.Provider value={scan}>{renderBlock(block, fade)}</BlockScan.Provider>;
	},
	(before, after) => before.raw === after.raw && before.start === after.start && before.fade === after.fade,
);

function renderBlocks(source: string, fade = false): ReactNode {
	return parseMarkdown(source).map((block, index) => <Fragment key={index}>{renderBlock(block, fade)}</Fragment>);
}

/** `fade`：这块字还在输出，新字淡入。见 `FadeText`。 */
function renderBlock(block: Block, fade = false): ReactNode {
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
						<Fragment key={index}>{renderBlock(child, fade)}</Fragment>
					))}
				</div>
			);
		case "paragraph":
			// 大到会把浏览器按住不放的那种，切开画；正常的一段走原路，一行代码都不多跑。
			if (block.text.length > HUGE_BLOCK) return <HugeParagraph text={block.text} />;
			return <p>{inline(block.text, fade)}</p>;
		case "code":
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
			return <blockquote>{renderBlocks(block.text, fade)}</blockquote>;
		case "math":
			return <MathBlock tex={block.tex} />;
		case "details":
			return <Details summary={block.summary} blocks={block.children} fade={fade} />;
		case "list": {
			const Tag = block.ordered ? "ol" : "ul";
			return (
				<Tag>
					{block.items.map((item, index) => (
						<Item key={index} item={item} fade={fade} />
					))}
				</Tag>
			);
		}
		case "table":
			return <MarkdownTable block={block} inline={fade ? fadingInline : inline} />;
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

function Item({ item, fade }: { item: ListItem; fade: boolean }) {
	const body = (
		<>
			{inline(item.text, fade)}
			{item.children.map((child, index) => (
				<Fragment key={index}>{renderBlock(child, fade)}</Fragment>
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
				<Fragment key={index}>{renderBlock(child, fade)}</Fragment>
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
			// 行内代码写完才出现（见 `completeTail`），整枚一起淡入。
			const box = "[box-decoration-break:clone] [-webkit-box-decoration-break:clone]";
			const code = fade ? <FadeIn as="code" className={box}>{token.text}</FadeIn> : <code className={box}>{token.text}</code>;
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
			return fade ? <FadeIn as="span" className="ly-math" dangerouslySetInnerHTML={{ __html: html }} /> : <span className="ly-math" dangerouslySetInnerHTML={{ __html: html }} />;
		}
		case "link":
			return <Link href={token.href}>{renderTokens(token.children, fade)}</Link>;
		case "image":
			return <Image src={token.src} alt={token.alt} width={token.width} height={token.height} />;
		default:
			return null;
	}
}
