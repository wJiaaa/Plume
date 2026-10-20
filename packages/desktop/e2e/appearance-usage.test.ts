/**
 * The three things you can only check by looking: how wide the conversation is drawn, what a tab's
 * menu does to the strip, and whether the usage page has numbers in it.
 *
 * Widths are measured off the real element rather than read back out of the setting that set them.
 * A setting that stores 960 and renders 640 is the failure this is for, and it is invisible to
 * every other kind of test.
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startApp, type RunningApp } from "./app.ts";
import { seedSessions } from "./session-fixture.ts";

let app: RunningApp;
let project: string;

/** One assistant reply, as the log stores it, so the usage page has something real to read. */
function replyRecord(seq: number, at: number, tokens: number) {
	const message = {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "openai-responses",
		provider: "relay",
		model: "grok-4.6",
		usage: {
			input: tokens,
			output: Math.round(tokens / 10),
			cacheRead: 0,
			cacheWrite: 0,
			total: tokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
		},
		stopReason: "stop",
		timestamp: at,
	};
	return { seq, ts: at, type: "message" as const, message };
}

async function seed(home: string): Promise<void> {
	const root = join(home, "project");
	await mkdir(root, { recursive: true });
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1440, height: 900, x: 0, y: 0 }));

	/*
	 * A conversation log with usage in it, written straight to the database.
	 *
	 * The page reads the logs rather than any live state, so seeding one is the whole fixture —
	 * and it means the numbers asserted below are numbers this test put there.
	 */
	const projectId = "aaaaaaaaaaaaaaaa";
	const yesterday = Date.now() - 24 * 60 * 60 * 1000;
	const meta = {
		id: "seeded",
		title: "seeded",
		cwd: root,
		projectId,
		projectName: "project",
		createdAt: yesterday,
		updatedAt: Date.now(),
		modelId: "relay/grok-4.6",
		messageCount: 2,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		seq: 3,
	};
	seedSessions(home, [
		{
			meta,
			records: [{ seq: 1, ts: yesterday, type: "meta", meta }, replyRecord(2, yesterday, 1000), replyRecord(3, Date.now(), 2000)],
		},
	]);

	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			version: 1,
			providers: [
				{
					id: "relay",
					name: "Relay",
					baseUrl: "http://127.0.0.1:1/v1",
					api: "openai-responses",
					apiKey: "x",
					enabled: true,
					models: [
						{
							id: "relay/grok-4.6",
							providerId: "relay",
							modelId: "grok-4.6",
							name: "grok-4.6",
							contextWindow: 128000,
							maxOutputTokens: 8192,
							supportsThinking: true,
							supportsImages: false,
							supportsTools: true,
						},
					],
				},
				{
					id: "house",
					name: "House",
					baseUrl: "http://127.0.0.1:1/v1",
					api: "openai-responses",
					apiKey: "y",
					enabled: true,
					models: [
						{
							id: "house/grok-4.6",
							providerId: "house",
							modelId: "grok-4.6",
							name: "grok-4.6",
							contextWindow: 200000,
							maxOutputTokens: 8192,
							supportsThinking: true,
							supportsImages: true,
							supportsTools: true,
						},
					],
				},
			],
			mcpServers: [],
			projects: [{ id: "e2e", name: "project", path: root, pinned: true, lastOpenedAt: 1 }],
			defaultModelId: "relay/grok-4.6",
			permissionMode: "auto",
			thinking: "medium",
			retryAttempts: 1,
			hooks: [],
			scheduledTasks: [],
			disabledPlugins: [],
			alwaysAllow: [],
		}),
	);
}

before(async () => {
	app = await startApp({ port: 9493, seed });
	// The CI display can clamp BrowserWindow below the widths this suite exercises.
	await app.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
	project = join(app.home, "project");
});

after(async () => {
	await app?.stop();
});

const UI = `
	const wait = (ms) => new Promise((r) => setTimeout(r, ms));
	const label = (el) => el.innerText.replace(/\\s+/g, " ").trim();
	const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
	/*
	 * The width the conversation column is actually drawn at.
	 *
	 * Measured off the composer, which is part of that column and is on screen whether or not a
	 * conversation is open — the transcript itself only exists once there is one to draw.
	 */
	const measure = () => {
		const box = document.querySelector("textarea")?.closest('[class*="max-w-[var(--ly-content)]"]');
		return box ? Math.round(box.getBoundingClientRect().width) : null;
	};
`;

function ui<T>(body: string): Promise<T> {
	return app.evaluate<T>(`(async () => { ${UI} const P = ${JSON.stringify(project)}; ${body} })()`);
}

test("the welcome composer is a 672px column", async () => {
	// 宽度不再是设置项：欢迎页是 `max-w-2xl`，对话里按窗格宽度分三档（见 composer.css）。
	const width = await ui<number | null>(`return measure();`);
	assert.equal(width, 672);
});

test("the usage page reports what is in the logs", async () => {
	const page = await ui<{ tiles: string[]; bars: number; series: string[]; heading: string | null }>(`
		// Settings → 使用统计, the way it is reached: the settings door in the sidebar's footer.
		const gear = document.querySelector("[data-ly-open-settings]");
		if (gear) { click(gear); await wait(500); }
		const nav = [...document.querySelectorAll("button")].find((b) => label(b) === "使用统计");
		if (!nav) throw new Error("使用统计 nav item not found");
		click(nav);
		// The first scan reads every log; give it room.
		for (let i = 0; i < 100 && !document.querySelector('[data-usage-requests="true"]'); i++) await wait(100);
		// One reply is yesterday's and the page opens on today; widen the range to 全部.
		click(document.querySelector('[data-usage-requests] > div:first-child [data-segment="all"]'));
		await wait(400);

		// 指标格按它的无障碍名字找，不按圆角类名：d1a93db6 把 rounded-[12px] 收成 rounded-xl 时这里就断过。
		const tiles = [...(document.querySelector("[aria-label='用量指标']")?.children ?? [])].map((d) => label(d));
		const bars = [...document.querySelectorAll("[data-bar-slot] rect")].filter((r) => r.getBoundingClientRect().height > 0).length;
		const series = [...document.querySelectorAll("[data-usage-series]")].map((d) => label(d));
		const headings = [...document.querySelectorAll("h1")].filter(el => el.checkVisibility({ visibilityProperty: true })).map(label).filter(Boolean);
		return { tiles, bars, series, heading: headings.join(" / ") || null };
	`);

	assert.equal(page.heading, "使用统计");
	const [tokens, requests, cost, hit, speed] = page.tiles;
	const joined = page.tiles.join(" | ");
	// 1000 + 2000 input, 100 + 200 output across the two seeded replies; nothing cached.
	assert.match(tokens ?? "", /^Token 3,300 输入 3,000 · 输出 300 · 缓存写入 0$/, joined);
	// 3,300 fresh tokens over two requests.
	assert.match(requests ?? "", /^请求 2 平均每次 1,650 Token$/, joined);
	// Each reply recorded $0.01.
	assert.match(cost ?? "", /^费用 ≈\$0\.02 按记录价与目录价估算$/, joined);
	assert.match(hit ?? "", /^缓存命中率 0\.0% 缓存读取 0$/, joined);
	// The fixture has no stream timing, so there is no speed to report — a dash, not 0.
	assert.match(speed ?? "", /^输出速度 — 暂无计时$/, joined);
	assert.equal(page.bars, 2, `one bar for yesterday, one for today: ${joined}`);
	assert.ok(page.series.some((m) => m.startsWith("grok-4.6 · Relay")), `the series list names the model: ${page.series.join(" / ")}`);
});
