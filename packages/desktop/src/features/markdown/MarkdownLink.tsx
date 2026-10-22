/**
 * 回复里的一条链接：网址开进浏览器，指着本机文件的画成文件签，悬停给出打开方式。
 */

import { translate } from "../../i18n/translate.ts";
import { ExternalLink, FolderOpen, Globe } from "../../ui/icons/index.ts";
import { type CSSProperties, isValidElement, type ReactNode, type SyntheticEvent, useContext, useState } from "react";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import { resolveAsset, isAbsolutePath } from "../../lib/markdown/assets.ts";
import { fileLinkCaption, splitLineSuffix, type LineRange } from "../../lib/markdown/file-link.ts";
import { bridge } from "../../services/index.ts";
import { useApp } from "../../store/index.ts";
import { openFilePane } from "../dock/index.ts";
import { useRevealLabel, withFileThere } from "../../store/open-targets.ts";
import { iconColour, lookFor } from "../../ui/fileIcon.tsx";
import { SessionScope, useDockScope, useScopedProjectPath } from "../../app/session-scope.tsx";
import { usePathMenu } from "./PathMenu.tsx";
import { useLocatedPaths } from "./located-path.ts";
import { FileChoices } from "./FileChoices.tsx";
import { WebLink } from "./WebLink.tsx";
import { Doc } from "./context.ts";

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
function FileLink({
	href,
	path,
	lines,
	choices,
	children,
}: {
	href: string;
	path: string;
	lines: LineRange | null;
	choices?: readonly string[];
	children: ReactNode;
}) {
	const revealLabel = useRevealLabel();
	const caption = fileLinkCaption(textOf(children), path, lines);
	// Only a trailing slash says folder without asking the disk; one written without it still opens right, see `openFilePane`.
	const look = lookFor(path.split(/[/\\]/).pop() || path, /[/\\]$/.test(href));
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
	const openFile = () => void openFilePane(path, screen ?? undefined, caption.lines);
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
				{caption.line && <span data-ly-file-line>:{caption.line}</span>}
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
				<FileChoices anchor={picking} paths={choices} root={project} onPick={(choice) => void openFilePane(choice, screen ?? undefined, caption.lines)} onClose={() => setPicking(null)} />
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

export function Link({ href, children }: { href: string; children: ReactNode }) {
	const { baseDir } = useContext(Doc);
	/*
	 * A relative path means the project of the conversation this text is in, which in a split is not
	 * necessarily the one with focus: resolved against the focused one, a `README.md` in one screen's
	 * reply opened the other project's. The path alone, as one subscription — a long transcript has a
	 * great many links.
	 */
	const project = useScopedProjectPath();
	const scoped = useContext(SessionScope);
	const local = !!scoped && href.startsWith(`ly-preview://${scoped}/`);
	const safe = local || href.startsWith("http://") || href.startsWith("https://");
	const { path: target, lines } = splitLineSuffix(href);
	const guess = safe ? null : resolveAsset(baseDir ?? project ?? (isAbsolutePath(href) ? "/" : undefined), target);
	/*
	 * `approvals.ts:125` joined to the working directory mostly names nothing: models write the bare
	 * name, or a path relative to some package. The one file in the project it can only mean wins; with
	 * several of that name the link lets the reader pick — see `located-path.ts`. Not under a `baseDir`:
	 * that is the document's own folder, and its relative paths are written for it.
	 */
	const located = useLocatedPaths(guess && !baseDir && project && !isAbsolutePath(target) ? project : null, target);
	const path = located.length === 1 ? located[0] : guess;
	if (!safe && !path) return <>{children}</>;
	if (path) return <FileLink href={href} path={path} lines={lines} choices={located.length > 1 ? located : undefined}>{children}</FileLink>;
	return <WebLink href={href}>{children}</WebLink>;
}
