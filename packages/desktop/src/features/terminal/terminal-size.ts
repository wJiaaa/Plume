/**
 * The terminal's last measured size, kept for the next launch's prewarmed shell (`prewarm.ts`).
 *
 * Apart from the prewarm so the pane can record it without importing the module that preloads the pane.
 */

/** Where the last measured pane size is kept, so a prediction can be made at the right width. */
const SIZE_KEY = "plume.terminal.size";

/**
 * The size to start a shell at before any pane has been measured.
 *
 * A guess, but not a blind one: it is roughly what the dock's default width comes to at the code
 * font. Only ever used on the very first launch — every mount after that has recorded a real
 * measurement, and `attach` resizes the pty to the real size regardless.
 */
const FALLBACK = { cols: 60, rows: 24 };

/**
 * Remember how big the terminal actually is, for the next launch's prediction.
 *
 * A shell wraps its output to the width it was born at and nothing can re-wrap what it has already
 * written, so a prewarmed shell started at the wrong width would have its prompt folded in the
 * wrong place — the one thing the prediction is supposed to make look effortless. Written on every
 * mount rather than on resize: it is one small string, and the value wanted is the size the pane
 * settles at, which is what it has whenever it is built.
 */
export function rememberTerminalSize(cols: number, rows: number): void {
	if (cols < 2 || rows < 2) return;
	try {
		localStorage.setItem(SIZE_KEY, JSON.stringify({ cols, rows }));
	} catch {}
}

/** The last measured pane size, or a first-launch guess. */
export function lastTerminalSize(): { cols: number; rows: number } {
	try {
		const raw = localStorage.getItem(SIZE_KEY);
		if (!raw) return FALLBACK;
		const parsed = JSON.parse(raw) as { cols?: unknown; rows?: unknown };
		const cols = Number(parsed.cols);
		const rows = Number(parsed.rows);
		if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 2 || rows < 2) return FALLBACK;
		return { cols, rows };
	} catch {
		return FALLBACK;
	}
}
