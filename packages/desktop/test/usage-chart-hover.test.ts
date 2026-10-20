/**
 * The arithmetic behind the bar chart's bubble and its coordinate space.
 *
 * A bubble that hangs off the side of the window, or a chart that grows every time the window is
 * narrowed, are both invisible in a test that only checks the component mounted.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { axisTicks, CHART, chartTipPlacement, plotHeightFor, viewHeightFor } from "../src/features/settings/usage-chart-hover.ts";

describe("viewHeightFor", () => {
	it("scales the viewBox to the box it was given, so a unit is the same size in both directions", () => {
		// 730x242 is the card at 1440: the shape the chart used to be locked to.
		assert.equal(viewHeightFor({ width: 730, height: 242 }), 212);
		assert.equal(viewHeightFor({ width: 730, height: 330 }), 289, "a taller card gets a taller chart, not a band of empty");
		assert.equal(plotHeightFor(viewHeightFor({ width: 730, height: 330 })), 289 - CHART.top - CHART.bottom);
	});

	it("keeps a floor under the plot and falls back before it has been laid out", () => {
		assert.equal(viewHeightFor({ width: 0, height: 0 }), CHART.height);
		assert.equal(viewHeightFor({ width: 730, height: 20 }), CHART.top + CHART.bottom + 80, "a sliver of a box still leaves room to draw in");
	});
});

describe("chartTipPlacement", () => {
	const tip = { width: 200, height: 120 };
	const viewport = { width: 1440, height: 900 };

	it("sits beside the crosshair, to its right, centred on the pointer", () => {
		const at = chartTipPlacement({ x: 700, y: 400 }, tip, viewport);
		assert.equal(at.left, 714, "14px clear of the line, so the bubble never covers it");
		assert.equal(at.top, 340);
	});

	it("flips to the left when the right would run past the window", () => {
		const at = chartTipPlacement({ x: 1400, y: 400 }, tip, viewport);
		assert.equal(at.left, 1400 - 14 - tip.width, "the most recent day is the one people point at, and it is at the edge");
		assert.ok(at.left + tip.width <= viewport.width - 8);
	});

	it("keeps both edges on screen when neither side fits", () => {
		const narrow = { width: 320, height: 900 };
		const right = chartTipPlacement({ x: 300, y: 400 }, tip, narrow);
		assert.ok(right.left >= 8 && right.left + tip.width <= narrow.width - 8, JSON.stringify(right));
		const left = chartTipPlacement({ x: 20, y: 400 }, tip, narrow);
		assert.ok(left.left >= 8 && left.left + tip.width <= narrow.width - 8, JSON.stringify(left));
	});

	it("follows the pointer only as far as the plot, rather than riding up over the legend and the controls", () => {
		const plot = { top: 300, bottom: 560 };
		assert.equal(chartTipPlacement({ x: 700, y: 430 }, tip, viewport, plot).top, 370, "in the middle it is simply centred on the pointer");
		assert.equal(chartTipPlacement({ x: 700, y: 310 }, tip, viewport, plot).top, 300, "near the top it stops at the chart's own top edge");
		assert.equal(chartTipPlacement({ x: 700, y: 550 }, tip, viewport, plot).top, 560 - tip.height, "and at the bottom, at its bottom edge");
	});

	it("is let out of a plot shorter than the bubble, which could not fit either way", () => {
		assert.equal(chartTipPlacement({ x: 700, y: 340 }, tip, viewport, { top: 300, bottom: 380 }).top, 280);
	});

	it("never lets the bubble hang off the top or the bottom", () => {
		assert.equal(chartTipPlacement({ x: 700, y: 10 }, tip, viewport).top, 8);
		assert.equal(chartTipPlacement({ x: 700, y: 895 }, tip, viewport).top, viewport.height - tip.height - 8);
	});

	it("shows the top of a bubble taller than the window rather than centring it", () => {
		const tall = { width: 200, height: 1000 };
		assert.equal(chartTipPlacement({ x: 700, y: 400 }, tall, viewport).top, 8);
	});
});

describe("axisTicks", () => {
	it("never splits a count, so a small one doesn't print the same label twice", () => {
		assert.deepEqual(axisTicks(2, true), [0, 1, 2]);
		assert.deepEqual(axisTicks(10, true), [0, 5, 10]);
	});

	it("rounds to a step people read and tops out at or just above the tallest bar", () => {
		assert.deepEqual(axisTicks(1_234_567, true), [0, 500_000, 1_000_000, 1_500_000]);
		const cost = axisTicks(0.03, false);
		assert.equal(cost.length, 4);
		assert.ok(Math.abs((cost.at(-1) ?? 0) - 0.03) < 1e-12);
	});

	it("an empty chart is a single zero line", () => {
		assert.deepEqual(axisTicks(0, true), [0]);
	});
});
