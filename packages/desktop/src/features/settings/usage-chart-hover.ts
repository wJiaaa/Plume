/**
 * The bar chart's coordinate space, and where its hover bubble goes.
 *
 * Kept apart from the component because this is the arithmetic worth testing, and a test for it
 * should not have to mount React or measure a layout that a test DOM does not perform. The bubble
 * is the part that is wrong invisibly: the slot people hover is usually the last one, hard against
 * the window's right edge, and the bubble has to flip to the left there.
 */

/**
 * The SVG's own coordinate space. Everything below is in these units until it reaches the screen.
 *
 * The width is fixed and the height is not. The chart shares a row with the series list beside it,
 * and a grid row is as tall as its tallest cell. The height therefore
 * follows the box the chart is given, at whatever scale the width implies, which keeps one unit
 * worth the same number of pixels in both directions: no stretched labels, no thickened strokes.
 */
export const CHART = { width: 640, height: 212, left: 52, right: 12, top: 12, bottom: 28 } as const;

/** The viewBox height for a rendered box, in the same units as the fixed width. */
export function viewHeightFor(box: { width: number; height: number }): number {
	if (!(box.width > 0) || !(box.height > 0)) return CHART.height;
	return Math.round(Math.max(CHART.top + CHART.bottom + 80, (CHART.width * box.height) / box.width));
}

export function plotHeightFor(viewHeight: number): number {
	return viewHeight - CHART.top - CHART.bottom;
}

/**
 * The value axis: a round step and a top that is a whole number of steps above the tallest bar.
 *
 * Splitting the tallest bar into quarters gives labels like 0.5 and 1.5 requests, which print as
 * "1" and "2" and repeat down the axis. A count can't be split, so `whole` keeps the step at one or
 * more (and skips 2.5); cost is the only metric that is fractional.
 */
export function axisTicks(maximum: number, whole: boolean): number[] {
	if (!(maximum > 0)) return [0];
	const raw = maximum / 4;
	const power = 10 ** Math.floor(Math.log10(raw));
	const steps = whole ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10];
	const step = Math.max(whole ? 1 : 0, (steps.find((each) => each * power >= raw) ?? 10) * power);
	const count = Math.ceil(maximum / step - 1e-9);
	return Array.from({ length: count + 1 }, (_, index) => index * step);
}

const GAP = 14;
const MARGIN = 8;

/**
 * Where the bubble goes: beside the crosshair, never over the pointer, never off screen.
 *
 * Beside rather than below, because the thing being read is a vertical line through the plot and a
 * bubble under the pointer covers the very marks it is describing. The preferred side is the right;
 * it flips to the left when the bubble would run past the window, which is the common case, since
 * the most recent day — the one people point at — is the rightmost.
 *
 * Vertically it follows the pointer, but only within `plot`. Free to follow, a reading taken near
 * the top of the chart rides up over the legend and the 费用/Token switch, and one taken near the
 * bottom hangs below the card: the bubble ends up covering the controls that are how you change
 * what it says. Held to the plot's own band it stays over the chart, where there is nothing to hide
 * but the chart it is describing. It is released again when it is taller than the plot, because a
 * bubble squeezed into a band shorter than itself has to lose an end.
 *
 * The viewport clamps are last and unconditional.
 */
export function chartTipPlacement(
	anchor: { x: number; y: number },
	tip: { width: number; height: number },
	viewport: { width: number; height: number },
	plot?: { top: number; bottom: number },
): { left: number; top: number } {
	const right = anchor.x + GAP;
	const left = anchor.x - GAP - tip.width;
	const fitsRight = right + tip.width <= viewport.width - MARGIN;
	const fitsLeft = left >= MARGIN;
	// When neither side fits, take the one with more room and let the clamp do the rest.
	const preferred = fitsRight ? right : fitsLeft ? left : anchor.x > viewport.width / 2 ? left : right;

	let top = anchor.y - tip.height / 2;
	if (plot && plot.bottom - plot.top >= tip.height) top = Math.max(plot.top, Math.min(top, plot.bottom - tip.height));
	return {
		left: Math.max(MARGIN, Math.min(preferred, Math.max(MARGIN, viewport.width - tip.width - MARGIN))),
		top: Math.max(MARGIN, Math.min(top, Math.max(MARGIN, viewport.height - tip.height - MARGIN))),
	};
}
