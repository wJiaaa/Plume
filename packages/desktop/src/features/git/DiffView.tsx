import { translate } from "../../i18n/translate.ts";
import { useRef } from "react";

import type { DiffHunk } from "@plume/core";
import { OverlayScrollbar } from "../../ui/scroll/OverlayScrollbar.tsx";
import { MarkNumber } from "../../ui/primitives/MarkNumber.tsx";
import { useDiffHighlight } from "./diff-highlight.ts";
import { useDiffCommenting, type DiffCommenting } from "./DiffComments.tsx";

const GUTTER = "ly-diff-gutter sticky left-0 z-[1] w-[42px] shrink-0 pr-2 text-right text-ink-faint/70 select-none";

/**
 * Unified diff: a gutter of line numbers, a green rail on additions and a red rail on removals,
 * and the code itself syntax-coloured underneath both.
 *
 * The two colour systems answer different questions and do not compete — the row's tint and rail
 * say whether a line changed, the glyphs say what the line is. This used to paint whole added
 * lines green and whole removed lines red, which said "changed" a second time in the one channel
 * that could have carried syntax, and left a review to be read as three colours of prose. The
 * tint alone already marks the change; nothing is lost by letting the text mean something else.
 *
 * Long lines scroll sideways, and that is the whole reason for the layering here. The rows sit
 * on a layer as wide as the longest line, so a tint or a separator runs the full length of what
 * it belongs to instead of stopping at the fold. The line numbers and the rail are pinned to the
 * left edge, because the moment a line is long enough to need scrolling is the moment you most
 * want to know which line you are on. Everything that is metadata rather than code — the hunk
 * headers, the truncation notice — is pinned as well, since scrolling it away helps nobody.
 */
export function DiffView({
	hunks,
	path,
	showPath = false,
	maxLines = 600,
}: {
	hunks: DiffHunk[];
	/**
	 * Which file this is, which is two separate things it is needed for.
	 *
	 * The grammar comes from its extension, so a diff without a path can only be plain text —
	 * and this used to be passed only where the path was also being *displayed*, which is why
	 * a review had no syntax colours while the same patch in a tool card did. Whether to draw
	 * the header is `showPath`, and it is a question about layout, not about the file.
	 */
	path?: string;
	/** Draw the path above the hunks. Off where the caller already shows it on its own row. */
	showPath?: boolean;
	maxLines?: number;
}) {
	let emitted = 0;
	const scroller = useRef<HTMLDivElement>(null);
	// Null until the grammar has loaded, and for anything there is no grammar for. Rows fall back
	// to plain text in both cases, so a diff is never waiting on a parser to be readable.
	const coloured = useDiffHighlight(hunks, path);
	// Only the changes view can be commented on; everywhere else the line numbers stay plain text.
	const commenting = useDiffCommenting();

	return (
		<div className="ly-diff-host relative">
			{/* `text-code`, not the UI scale: this is code, and it follows 代码字号 like every other
			    place code is read. It used to be a UI step with a hand-written leading on top, so
			    the same patch came out one size in a review and another in a chat transcript. */}
			<div ref={scroller} className="ly-diff-scroll overflow-x-auto font-mono text-code">
				<div className="w-max min-w-full">
					{showPath && path && (
						<div className="sticky left-0 w-max border-b border-line-soft px-3 py-1.5 text-caption text-ink-faint">
							{path}
						</div>
					)}

					{hunks.map((hunk, hunkIndex) => (
						<div key={hunkIndex} className="border-b border-line-soft last:border-b-0">
							{hunkIndex > 0 && (
								<div className="sticky left-0 w-max bg-shell/60 px-3 py-0.5 text-caption text-ink-faint">
									@@ -{hunk.oldStart} +{hunk.newStart} @@
								</div>
							)}

							{hunk.lines.map((line, lineIndex) => {
								if (emitted >= maxLines) return null;
								// The colours are generated in the same order these rows are drawn, so
								// the running count doubles as the index into them.
								const tokens = coloured?.[emitted];
								emitted += 1;
								const added = line.type === "add";
								const removed = line.type === "remove";
								return (
									<div
										key={lineIndex}
										className={`flex ${added ? "ly-diff-add bg-ok/8" : removed ? "ly-diff-remove bg-danger/8" : ""}`}
									>
										{/* Pinned columns need an opaque fill of their own: the row's tint is
										    translucent, and the code would otherwise show through as it passes. */}
										{commenting && path ? (
											<DiffGutterButton commenting={commenting} path={path} hunk={hunk} lineIndex={lineIndex} />
										) : (
											<span className={GUTTER}>{line.newLine ?? line.oldLine ?? ""}</span>
										)}
										<span
											className={`sticky left-[42px] z-[1] w-[3px] shrink-0 ${
												added ? "bg-ok/70" : removed ? "bg-danger/70" : "ly-diff-rail"
											}`}
										/>
										{/*
										 * The rail and background convey changes even before the grammar loads.
										 * Neutral fallback text avoids flashing an entirely green or red file.
										 */}
										<span
											className="shrink-0 px-2.5 whitespace-pre text-ink"
										>
											{tokens?.length
												? tokens.map((token, index) => (
														// noArrayIndexKey 在这里不适用（本仓库用 oxlint，不认 biome 的抑制注释，所以这只是一句说明）: runs are positional
														<span key={index} className={token.className}>
															{token.text}
														</span>
													))
												: line.text || " "}
										</span>
									</div>
								);
							})}
						</div>
					))}

					{emitted >= maxLines && (
						<div className="sticky left-0 w-max px-3 py-1.5 text-caption text-ink-faint">
							{translate("diffView.truncated")}
						</div>
					)}
				</div>
			</div>

			{/*
			 * Drawn rather than native, and always there while there is more to the right: macOS hides
			 * overlay scrollbars until something moves, and a long line running off the edge with no bar
			 * reads as truncated. Sticky, because a diff can be hundreds of rows long — see `placement`.
			 */}
			<OverlayScrollbar viewport={scroller} orientation="horizontal" placement="sticky" />
		</div>
	);
}

/**
 * The line number as the place to leave a comment on that line — see `DiffCommentsProvider`.
 *
 * Out of the tab order: a diff is hundreds of these, and tabbing through every line number to reach
 * the next file is worse than not reaching them by keyboard at all.
 */
function DiffGutterButton({ commenting, path, hunk, lineIndex }: { commenting: DiffCommenting; path: string; hunk: DiffHunk; lineIndex: number }) {
	const line = hunk.lines[lineIndex]!;
	const number = line.newLine ?? line.oldLine ?? "";
	const note = commenting.noteOf(path, line);
	return (
		<button
			type="button"
			tabIndex={-1}
			aria-label={translate("diffComment.pick", { line: number })}
			data-diff-note={note ? (note.draft ? "draft" : "saved") : undefined}
			className={`${GUTTER} ly-diff-pick cursor-pointer`}
			onMouseDown={(event) => {
				if (event.button !== 0) return;
				// Dragging or shift-clicking here picks lines; left alone it would also select the code beside them.
				event.preventDefault();
				commenting.press({ path, hunk, lineIndex }, event.currentTarget, event.shiftKey);
			}}
			onMouseEnter={(event) => commenting.enter({ path, hunk, lineIndex }, event.currentTarget)}
		>
			{note?.last ? <MarkNumber n={note.n} className="align-middle" /> : number}
		</button>
	);
}
