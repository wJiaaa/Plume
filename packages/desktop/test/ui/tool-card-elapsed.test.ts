/**
 * How long the card says a command has been running.
 *
 * It used to count from its own mount — `useRef(Date.now())` — which is the same as the truth only
 * while the card stays mounted for the whole call, and it does not: scrolling it out of the
 * transcript and back, or any re-key of the list, restarted the count at zero. What that looked
 * like in the wild was a screenshot of a `git push` seven and a half minutes into a turn, with the
 * card underneath it reporting `142s`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";

import { ToolCard } from "../../src/features/conversation/ToolCard.tsx";
import { I18nProvider } from "../../src/i18n/index.ts";
import { click, mount } from "../helpers/mount.ts";

const running = (extra: Record<string, unknown>) =>
	h(ToolCard, {
		toolName: "bash",
		summary: "推送已确认的任务分支",
		args: { command: "git push origin HEAD" },
		status: "running" as const,
		...extra,
	} as never);

/** The elapsed counter is the only `\d+s` the header draws. */
const seconds = (text: string): number | null => {
	const match = text.match(/(\d+)s/);
	return match ? Number(match[1]) : null;
};

test("a card mounted late still counts from when the command started", async () => {
	// Mounted now, for a call that started three minutes ago — a card scrolled back into view.
	const view = await mount(running({ startedAt: Date.now() - 180_000 }));
	const shown = seconds(view.text());
	assert.ok(shown !== null, `no elapsed time drawn: ${view.text()}`);
	assert.ok(shown >= 179 && shown <= 182, `expected ~180s, got ${shown}s`);
	await view.unmount();
});

test("remounting does not restart the count", async () => {
	const startedAt = Date.now() - 300_000;
	const first = await mount(running({ startedAt }));
	await first.unmount();
	// The same call, drawn again by a fresh component — the exact case that produced `142s`.
	const second = await mount(running({ startedAt }));
	const shown = seconds(second.text());
	assert.ok(shown !== null && shown >= 299, `the count restarted: ${shown}s`);
	await second.unmount();
});

test("without a start time it has not started: no timer, and nothing to open", async () => {
	/*
	 * Every record carries `startedAt`; only a call with no record yet comes without one — still
	 * being written, or written and waiting for the rest of the reply. A command that queued for
	 * twelve seconds and ran for 32ms used to read `12s`, and opened onto 「等待输出…」.
	 */
	const card = (extra: Record<string, unknown>) => mount(h(I18nProvider, { locale: "zh-CN", children: running(extra) }));
	const queued = await card({});
	try {
		await new Promise((resolve) => setTimeout(resolve, 1100));
		const text = queued.text();
		assert.equal(seconds(text), null, `a call that has not started is counting: ${text}`);
		assert.equal(queued.all("button[aria-expanded]").length, 0, "a call that has not started can be opened");
		assert.ok(text.includes("推送已确认的任务分支"), `the row lost its words: ${text}`);
	} finally {
		await queued.unmount();
	}
	// Once it has started, the same card opens onto the command and says it is waiting.
	const started = await card({ startedAt: Date.now() });
	try {
		await click(started.find("button[aria-expanded]"));
		const text = started.text();
		assert.ok(text.includes("git push origin HEAD") && text.includes("等待输出"), text);
	} finally {
		await started.unmount();
	}
});

test("a finished call is not still counting", async () => {
	const view = await mount(
		h(ToolCard, {
			toolName: "bash",
			summary: "推送已确认的任务分支",
			args: { command: "git push origin HEAD" },
			status: "done" as const,
			startedAt: Date.now() - 180_000,
		} as never),
	);
	// Whatever it shows, it must not be advertising a live timer on something that has finished.
	assert.ok(!/\d+s/.test(view.text()), `a finished card is still counting: ${view.text()}`);
	await view.unmount();
});
