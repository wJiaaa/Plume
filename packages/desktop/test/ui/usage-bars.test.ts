import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import type { UsageRequestBucket } from "@plume/contract";
import { barValueLabel, UsageBarChart } from "../../src/features/settings/usage-bars.tsx";
import { axisTicks, CHART } from "../../src/features/settings/usage-chart-hover.ts";
import { barsFor } from "../../src/features/settings/usage-requests.ts";
import { fire, mount } from "../helpers/mount.ts";

const SLOT = "2026-10-20 10";

function row(model: string, cost: number): UsageRequestBucket {
	return { hour: SLOT, provider: "relay", model, requests: 1, input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost, unpriced: 0, timed: 0, timedOutput: 0, streamMs: 0, firstTokens: 0, firstTokenMs: 0 };
}

test("cost readings keep small positive amounts distinct from zero and each other", () => {
	assert.deepEqual([0, 0.00000025, 0.00025, 0.001, 0.005, 0.0075, 0.01, 0.1234, 12.345].map((value) => barValueLabel(value, "cost")), ["$0", "$2.5e-7", "$0.00025", "$0.001", "$0.005", "$0.0075", "$0.01", "$0.123", "$12.35"]);
	for (const maximum of [0.000001, 0.001, 0.01, 0.1]) {
		const labels = axisTicks(maximum, false).map((value) => barValueLabel(value, "cost"));
		assert.equal(new Set(labels).size, labels.length, `${maximum}: ${labels.join(", ")}`);
	}
});

for (const [first, second, ticks] of [
	[0.00025, 0.00075, ["0", "$0.00025", "$0.0005", "$0.00075", "$0.001"]],
	[0.005, 0.005, ["0", "$0.0025", "$0.005", "$0.0075", "$0.01"]],
] as const) {
	test(`cost chart shows precise axis and hover amounts for a $${first + second} slot`, async () => {
		const bars = barsFor([row("first", first), row("second", second)], "model", "cost", [SLOT], true);
		const view = await mount(h(UsageBarChart, { bars, metric: "cost", hourly: true, hidden: new Set<string>(), labelOf: (key: string) => key }));
		try {
			assert.deepEqual(view.all('svg text[text-anchor="end"]').map((label) => label.textContent), [...ticks]);
			const svg = view.find("svg");
			// happy-dom 不做布局；给定坐标空间，只验证实际渲染的刻度和气泡文字。
			svg.getBoundingClientRect = () => new DOMRect(0, 0, CHART.width, CHART.height);
			await fire(view.find("[data-usage-bars]"), new MouseEvent("pointermove", { bubbles: true, clientX: 300, clientY: 100 }));
			const tip = document.querySelector("[data-chart-tip]");
			assert.ok(tip);
			const amounts = [...tip.querySelectorAll(".shrink-0.tabular-nums")].map((label) => label.textContent);
			assert.deepEqual(amounts, [barValueLabel(second, "cost"), barValueLabel(first, "cost"), barValueLabel(first + second, "cost")]);
			assert.doesNotMatch(tip.textContent ?? "", /</);
		} finally {
			await view.unmount();
		}
	});
}
