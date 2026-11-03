/**
 * TeX to HTML, via KaTeX.
 *
 * KaTeX over the browser's own MathML: Chromium renders MathML, but its fraction bars, radical
 * extenders and large operators are visibly less carefully set than KaTeX's, and this application
 * is not one where that is acceptable.
 *
 * The returned string is the one place markup is injected rather than built as elements. It is
 * KaTeX's own output — the TeX source never reaches the DOM as markup, because KaTeX parses it
 * into a tree and escapes every leaf. `trust` stays off, which is what disables `\href`,
 * `\includegraphics` and the rest of the commands that could emit a URL of the author's choosing.
 */

import type { KatexOptions } from "katex";

/*
 * KaTeX is fetched the first time a formula is drawn, not at startup.
 *
 * It is about 1MB, and was imported here statically — so every launch parsed and ran it, for the
 * minority of replies that contain any maths. Until it arrives `renderMath` answers `undefined` and
 * the caller shows the TeX as written, the same thing it shows for TeX that does not parse; the
 * formula is typeset as soon as the module lands (`onMathReady`).
 */
let typeset: ((tex: string, options: KatexOptions) => string) | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function loadMath(): void {
	loading ??= import("katex").then(
		(module) => {
			typeset = module.renderToString ?? module.default.renderToString;
			for (const listener of listeners) listener();
		},
		// A failed fetch leaves the source on screen and lets the next formula try again.
		() => { loading = null; },
	);
}

/** Whether KaTeX has arrived — for `useSyncExternalStore`, with `onMathReady`. */
export const mathReady = (): boolean => typeset !== null;

export function onMathReady(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

/*
 * Rendering the same formula twice is common — React re-renders a message on every token that
 * streams in after it, and KaTeX parsing is not cheap. Bounded, because a long session would
 * otherwise accumulate every formula it ever showed.
 */
const cache = new Map<string, string>();
const LIMIT = 400;

/**
 * Returns null when the TeX does not parse, and undefined while KaTeX is still loading — in both
 * cases the caller shows the source instead.
 */
export function renderMath(tex: string, display: boolean): string | null | undefined {
	const key = `${display ? "d" : "i"}:${tex}`;
	const hit = cache.get(key);
	if (hit !== undefined) return hit || null;
	if (!typeset) {
		loadMath();
		return undefined;
	}

	let html: string;
	try {
		html = typeset(tex, {
			displayMode: display,
			throwOnError: true,
			trust: false,
			// Unicode and \newcommand in a pull request body are not errors worth a console warning.
			strict: false,
		});
	} catch {
		/*
		 * A failed parse is stored as empty rather than not stored.
		 *
		 * Text that merely looks like TeX is the common case, and it is re-rendered on every keypress
		 * while a message streams; without a negative entry each of those pays for a full parse and a
		 * thrown exception.
		 */
		html = "";
	}

	if (cache.size >= LIMIT) cache.clear();
	cache.set(key, html);
	return html || null;
}
