/** Real Electron verification for the usage request page and offline model catalogue controls. */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { catalogModelFor } from "@plume/core/model-catalog";
import { zhCN } from "../src/i18n/messages/zh-CN.ts";
import { startApp, type RunningApp } from "./app.ts";
import { seedSessions, type FixtureRecord, type FixtureSession } from "./session-fixture.ts";

let app: RunningApp;

interface ReplyFixture {
	provider: string;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total: number; source?: "provider" };
}

function reply(seq: number, at: number, fixture: ReplyFixture): FixtureRecord {
	const usage = {
		input: fixture.input,
		output: fixture.output,
		cacheRead: fixture.cacheRead,
		cacheWrite: fixture.cacheWrite,
		reasoning: fixture.reasoning,
		total: fixture.input + fixture.output + fixture.cacheRead + fixture.cacheWrite,
		cost: fixture.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const message = {
		role: "assistant",
		content: [{ type: "text", text: "usage fixture" }],
		api: "openai-responses",
		provider: fixture.provider,
		model: fixture.model,
		usage,
		stopReason: "stop",
		timestamp: at,
	};
	return { seq, ts: at, type: "message", message };
}

function configuredModel(providerId: string, modelId: string, name: string) {
	return {
		id: `${providerId}/${modelId}`,
		providerId,
		modelId,
		name,
		contextWindow: 200_000,
		maxOutputTokens: 16_384,
		supportsThinking: true,
		supportsImages: true,
		supportsTools: true,
		pricing: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.375, source: "manual" },
	};
}

function fixtureFor(index: number, tokens: number): ReplyFixture {
	const output = Math.round(tokens * 0.08);
	const cacheRead = Math.round(tokens * 0.68);
	const cacheWrite = Math.round(tokens * 0.06);
	const input = tokens - output - cacheRead - cacheWrite;
	switch (index % 5) {
		case 0:
			return { provider: "relay", model: "gemini-3-0", input, output, cacheRead, cacheWrite, reasoning: Math.round(output / 3) };
		case 1:
			return {
				provider: "house",
				model: "claude-0",
				input,
				output,
				cacheRead,
				cacheWrite,
				reasoning: Math.round(output / 4),
				cost: { input: 0.003, output: 0.004, cacheRead: 0.001, cacheWrite: 0.002, total: 0.01, source: "provider" },
			};
		case 2:
			return { provider: "openai", model: "gpt-5.2", input, output, cacheRead, cacheWrite, reasoning: Math.round(output / 2) };
		case 3:
			return { provider: "legacy", model: "retired-model", input, output, cacheRead, cacheWrite, reasoning: 0, cost: { total: 0.006 } };
		default:
			return { provider: "unknown", model: "unpriced-model", input, output, cacheRead, cacheWrite, reasoning: 0 };
	}
}

async function seed(home: string): Promise<void> {
	const root = join(home, "project");
	await mkdir(root, { recursive: true });
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1440, height: 900, x: 0, y: 0 }));
	const day = 24 * 60 * 60 * 1000;
	const sessions: FixtureSession[] = [];
	for (let session = 0; session < 40; session++) {
		const projectId = `usage${session}`.padEnd(16, "0");
		const records: FixtureRecord[] = [];
		for (let daysAgo = 29; daysAgo >= 10; daysAgo--) {
			const at = Date.now() - daysAgo * day;
			for (let turn = 0; turn < 90; turn++) {
				const tokens = 4_000 + ((daysAgo * 7_919 + session * 104_729 + turn * 31) % 46_000);
				records.push(reply(records.length + 1, at, fixtureFor(daysAgo + session + turn, tokens)));
			}
		}
		const empty = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		sessions.push({
			meta: { id: `session-${session}`, title: `session-${session}`, cwd: root, projectId, projectName: "project", createdAt: Date.now() - 29 * day, updatedAt: Date.now() - 10 * day, modelId: "relay/gemini-3-0", messageCount: records.length, usage: empty, seq: 0 },
			records,
		});
	}
	seedSessions(home, sessions);
	await writeFile(join(home, "settings.json"), JSON.stringify({
		version: 1,
		providers: [
			{ id: "relay", name: "Relay", baseUrl: "https://relay.example/v1", api: "openai-responses", apiKey: "x", enabled: true, models: [configuredModel("relay", "gemini-3-0", "Gemini 3")] },
			{ id: "house", name: "Claude Team", baseUrl: "https://relay.example/v1", api: "anthropic-messages", apiKey: "y", enabled: true, models: [configuredModel("house", "claude-0", "Claude") ] },
			{ id: "openai", name: "OpenAI 官方", baseUrl: "https://api.openai.com/v1", api: "openai-responses", apiKey: "z", enabled: true, models: [] },
		],
		mcpServers: [],
		projects: [{ id: "e2e", name: "project", path: root, pinned: true, lastOpenedAt: 1 }],
		defaultModelId: "relay/gemini-3-0",
		permissionMode: "auto",
		thinking: "medium",
		retryAttempts: 1,
		hooks: [],
		scheduledTasks: [],
		disabledPlugins: [],
		alwaysAllow: [],
	}));
}

before(async () => {
	app = await startApp({ port: 9711, seed });
	await app.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
});

after(async () => {
	await app?.stop();
});

afterEach(async (context) => {
	if (context.passed) return;
	await shot("usage-dashboard-failure");
	context.diagnostic(await app.evaluate<string>("document.body.innerText.slice(-5000)"));
});

async function shot(name: string): Promise<void> {
	const directory = process.env.PLUME_E2E_ARTIFACTS;
	if (!directory) return;
	await mkdir(directory, { recursive: true });
	const result = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(directory, `${name}.png`), Buffer.from(result.data, "base64"));
}

const UI = `
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const label = (element) => element.innerText.replace(/\\s+/g, " ").trim();
	const named = (element, text) => {
		const visible = label(element);
		const aria = (element.getAttribute("aria-label") || "").trim();
		const tip = (element.dataset.lyTip || "").trim();
		return visible === text || aria === text || tip === text;
	};
	const click = (element) => { if (!element) throw new Error("nothing to click"); element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); };
	const byText = (selector, text) => [...document.querySelectorAll(selector)].find((element) => element.checkVisibility({ visibilityProperty: true }) && named(element, text));
	// A provider's row leads with its initial (「R Relay」), so it is found by how its name ends.
	const provider = (name) => [...document.querySelectorAll("button")].find((element) => element.checkVisibility({ visibilityProperty: true }) && label(element).endsWith(name));
	const heatmap = () => {
		const scroller = [...document.querySelectorAll("div")].find((d) => d.className.includes("justify-content:safe_center"));
		if (!scroller) throw new Error("heatmap scroller not found");
		return scroller;
	};
	const heatmapBox = () => {
		const scroller = heatmap(), outer = scroller.getBoundingClientRect(), inner = scroller.firstElementChild.getBoundingClientRect();
		return { left: inner.left - outer.left, right: outer.right - inner.right, card: outer.width,
			grid: inner.width, scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth,
			scrollLeft: scroller.scrollLeft, justify: getComputedStyle(scroller).justifyContent };
	};
	const typeValue = (input, value) => {
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
		setter.call(input, value);
		input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
	};
	const openUsage = async () => {
		click(document.querySelector("[data-ly-open-settings]"));
		await wait(500);
		const nav = byText("nav button", "使用统计");
		if (!nav) throw new Error("no 使用统计 nav item");
		return nav;
	};
`;

function ui<T>(body: string): Promise<T> {
	return app.evaluate<T>(`(async () => { ${UI} ${body} })()`);
}

/** A range button: they are the first row of the page. */
const RANGE = (value: string) => `document.querySelector('[data-usage-requests] > div:first-child [data-segment="${value}"]')`;
/** The chart card has no hook of its own: it is the card right after the KPIs. */
const CHART_CARD = `document.querySelector('[data-usage-request-kpis]')?.nextElementSibling`;

test("the request page paints a skeleton, then shows priced, cached and unpriced requests", async () => {
	const seen = await ui<{ frames: number; sawSkeleton: boolean; landed: boolean; kpis: string; footer: string; slots: number; series: number; overflow: number; chartHeight: number; metricColumns: number }>(`
		click(await openUsage());
		let frames = 0;
		let sawSkeleton = false;
		let landed = false;
		/*
		 * 等到它读完，按秒数算，不按帧数算。
		 *
		 * 这里原本是「五百帧还没画出来就算了」。五百帧读起来像很多，其实是八秒出头——而这一屏
		 * 要把四十个会话、七万二千条记录整个扫一遍才有读数，本机空着的时候正好是八秒半，刚刚
		 * 好落在外面。更糟的是帧数根本不等于时间：窗口被别的窗口盖住时 requestAnimationFrame
		 * 会降频，五百帧能拖上半分钟，于是同一份代码在同一台机器上时红时绿。
		 *
		 * 这条断言要的是「先骨架、后读数」，不是「八秒内读完」——性能是另一回事，不该在这里
		 * 借着一个凑出来的帧数上限偷偷断言。上限留三十秒：够慢的机器读完，也仍在 CDP 那一次
		 * 调用的四十秒之内。
		 */
		const deadline = performance.now() + 30_000;
		await new Promise((resolve) => {
			const step = () => {
				frames += 1;
				if (document.querySelector('[aria-busy="true"]')) sawSkeleton = true;
				landed = Boolean(document.querySelector('[data-usage-requests="true"]'));
				if (landed || performance.now() > deadline) resolve(); else requestAnimationFrame(step);
			};
			requestAnimationFrame(step);
		});
		// 默认区间是「今天」，而 fixture 落在 10 到 29 天前。
		click(${RANGE("all")});
		await wait(400);
		const chart = ${CHART_CARD}.querySelector("[data-usage-bars]");
		const metrics = document.querySelector('[data-usage-request-kpis]');
		const metricRows = new Set([...metrics.children].map((element) => Math.round(element.getBoundingClientRect().top)));
		return {
			frames,
			sawSkeleton,
			landed,
			kpis: label(metrics),
			footer: label(document.querySelector("[data-usage-request-footer]")),
			slots: chart?.querySelectorAll("[data-bar-slot]").length || 0,
			series: document.querySelectorAll("[data-usage-series]").length,
			overflow: document.documentElement.scrollWidth - window.innerWidth,
			chartHeight: Math.round(chart?.getBoundingClientRect().height || 0),
			metricColumns: Math.max(1, Math.ceil(metrics.children.length / metricRows.size)),
		};
	`);

	assert.ok(seen.landed, JSON.stringify(seen));
	assert.ok(seen.sawSkeleton, `no skeleton across ${seen.frames} painted frames`);
	// 40 个会话 × 20 天 × 90 条。
	assert.match(seen.kpis, /请求 72,000/, JSON.stringify(seen));
	// 每五条里有一条是 unknown/unpriced-model：查不到价，费用只是下限。
	assert.match(seen.kpis, /费用 ≥\$[\d,.]+/, JSON.stringify(seen));
	assert.match(seen.kpis, /14,?400 个请求查不到价格/, JSON.stringify(seen));
	assert.match(seen.kpis, /缓存命中率 \d+\.\d%/, JSON.stringify(seen));
	assert.match(seen.footer, /72,000 个请求 · .*缓存写入 .*缓存读取 /, JSON.stringify(seen));
	assert.ok(seen.slots >= 20, JSON.stringify(seen));
	assert.ok(seen.series >= 4, JSON.stringify(seen));
	assert.ok(seen.chartHeight >= 150, JSON.stringify(seen));
	assert.equal(seen.metricColumns, 5, JSON.stringify(seen));
	assert.ok(seen.overflow <= 0, JSON.stringify(seen));
	await shot("usage-requests-1440x900");
});

test("range, metric, split and refresh controls update without blanking the page", async () => {
	const result = await ui<{ emptyText: string; costChart: boolean; providers: string[]; refreshed: boolean; remained: boolean; requests: string }>(`
		click(${RANGE("today")});
		await wait(300);
		const emptyText = label(document.querySelector('[data-usage-requests="true"]'));
		click(${RANGE("all")});
		await wait(300);
		const card = ${CHART_CARD};
		click(card.querySelector('[data-segment="cost"]'));
		await wait(100);
		const costChart = Boolean(card.querySelector('[data-usage-bars="cost"]'));
		click(card.querySelector('[data-segment="provider"]'));
		await wait(100);
		const providers = [...document.querySelectorAll("[data-usage-series]")].map((element) => element.dataset.usageSeries);
		click(card.querySelector('[data-segment="modelProvider"]'));
		await wait(100);
		const refresh = document.querySelector('button[aria-label="刷新用量统计"]');
		click(refresh);
		for (let index = 0; index < 100 && refresh.disabled; index++) await wait(20);
		const kpis = document.querySelector("[data-usage-request-kpis]");
		return {
			emptyText,
			costChart,
			providers,
			refreshed: !refresh.disabled,
			remained: Boolean(document.querySelector('[data-usage-requests="true"]')),
			// 刷新不把区间打回「今天」：读数还是全部那七万二千条。
			requests: kpis ? label(kpis.children[1].children[1]) : "",
		};
	`);

	/*
	 * 一条记录都没有的区间：一分钱没花，不是「算不出多少钱」。
	 *
	 * 「暂无价格」说的是有用量、但这些模型查不到价；空区间里那个数是确定的 ≈$0.00。文案从 zh-CN
	 * 读：这条上一次红，就是因为测试里抄了一份已经改掉的句子。
	 */
	const text = (key: keyof typeof zhCN) => new RegExp(zhCN[key].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	assert.match(result.emptyText, /请求 0 /);
	assert.match(result.emptyText, /费用 ≈\$0\.00/);
	assert.doesNotMatch(result.emptyText, text("usage.noPrice"));
	assert.match(result.emptyText, text("usage.noRequests"));
	assert.ok(result.costChart, JSON.stringify(result));
	assert.ok(result.providers.includes("relay") && result.providers.includes("house"), JSON.stringify(result));
	assert.ok(result.refreshed, JSON.stringify(result));
	assert.ok(result.remained, JSON.stringify(result));
	assert.equal(result.requests, "72,000", JSON.stringify(result));
});

/*
 * 右边那一列是开关，以及换口径时柱子是不是自己长过去的。
 *
 * 都只能在真窗口里问：补间有没有跑，只有逐帧量那些柱子才知道，等一会儿再看则永远只看得到终点，
 * 而终点在有没有动画时是同一个。
 */
test("the series list toggles bars, and switching the metric moves them rather than swapping them", async (t) => {
	const seen = await ui<{ shapes: number; pressedBefore: string | null; pressedAfter: string | null; barsBefore: number; barsAfter: number; axisMoved: boolean; railMoved: boolean }>(`
		const card = ${CHART_CARD};
		click(card.querySelector('[data-segment="cost"]'));
		await wait(400);
		const svg = () => card.querySelector("[data-usage-bars] svg");
		const axis = () => [...svg().querySelectorAll("text")].map((element) => element.textContent).join("|");
		const busiest = () => [...svg().querySelectorAll("g[data-bar-slot]")].find((slot) => slot.querySelectorAll("rect").length > 0);

		/*
		 * 在费用这一侧关掉排第一的那个系列：费用差得开，关掉最大的，刻度必须跟着重画。按 Token
		 * 这批 fixture 每个系列差不多大，纵轴可能纹丝不动，那不能算这件事没做。
		 */
		const first = document.querySelector("[data-usage-series]");
		const pressedBefore = first.getAttribute("aria-pressed");
		const barsBefore = busiest().querySelectorAll("rect").length;
		const axisBefore = axis();
		click(first);
		await wait(500);
		const pressedAfter = first.getAttribute("aria-pressed");
		const barsAfter = busiest().querySelectorAll("rect").length;
		const axisAfter = axis();
		click(first);
		await wait(400);

		// 换口径，逐帧记每一格的高度：补间跑过就会留下一串互不相同的中间形状。
		const rail = () => card.querySelector('[data-segment="tokens"]').parentElement.querySelector("[data-segment-rail]");
		const railBefore = rail()?.style.transform ?? "";
		const shape = () => [...svg().querySelectorAll("g[data-bar-slot]")].map((slot) => Math.round(slot.getBoundingClientRect().height)).join(",");
		const shapes = [];
		click(card.querySelector('[data-segment="tokens"]'));
		await new Promise((resolve) => {
			let frames = 0;
			const step = () => {
				shapes.push(shape());
				if (++frames < 28) requestAnimationFrame(step);
				else resolve();
			};
			requestAnimationFrame(step);
		});
		await wait(300);
		const railAfter = rail()?.style.transform ?? "";
		return {
			shapes: new Set(shapes).size,
			pressedBefore,
			pressedAfter,
			barsBefore,
			barsAfter,
			axisMoved: axisBefore !== axisAfter,
			railMoved: railBefore !== railAfter && railAfter !== "",
		};
	`);

	t.diagnostic(JSON.stringify(seen));
	// 三个以上互不相同的形状：一帧到位的切换只会留下两种（切之前和切之后）。
	assert.ok(seen.shapes >= 3, `换口径时柱子是跳过去的，不是长过去的：${JSON.stringify(seen)}`);
	assert.equal(seen.pressedBefore, "true");
	assert.equal(seen.pressedAfter, "false", `点一下要真的关掉它：${JSON.stringify(seen)}`);
	assert.equal(seen.barsAfter, seen.barsBefore - 1, `关掉的系列要从每根柱子里退掉：${JSON.stringify(seen)}`);
	assert.ok(seen.axisMoved, `关掉最大的系列之后纵轴要按剩下的重新分配：${JSON.stringify(seen)}`);
	assert.ok(seen.railMoved, `分段控件那块底要滑到新的位置：${JSON.stringify(seen)}`);
	await shot("usage-requests-bars");
});

test("the request page reflows in a narrow desktop window without horizontal overflow", async () => {
	await app.send("Emulation.setDeviceMetricsOverride", { width: 760, height: 900, deviceScaleFactor: 1, mobile: false });
	await app.evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
	const geometry = await app.evaluate<{ overflow: number; page: number; chart: number; metricColumns: number }>(`(() => {
		const page = document.querySelector('[data-usage-requests="true"]');
		const chart = ${CHART_CARD}.querySelector("[data-usage-bars]");
		const metrics = document.querySelector('[data-usage-request-kpis]');
		const children = [...metrics.children];
		const tops = new Set(children.map((element) => Math.round(element.getBoundingClientRect().top)));
		return {
			overflow: document.documentElement.scrollWidth - window.innerWidth,
			page: Math.round(page.getBoundingClientRect().width),
			chart: Math.round(chart.getBoundingClientRect().width),
			metricColumns: Math.max(1, Math.ceil(children.length / tops.size)),
		};
	})()`);
	assert.ok(geometry.overflow <= 0, JSON.stringify(geometry));
	assert.ok(geometry.page > 300 && geometry.page <= 760, JSON.stringify(geometry));
	assert.ok(geometry.chart > 280 && geometry.chart <= geometry.page, JSON.stringify(geometry));
	assert.equal(geometry.metricColumns, 2, JSON.stringify(geometry));
	await shot("usage-requests-760x900");
	await app.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
});

interface HeatmapBox {
	left: number;
	right: number;
	card: number;
	grid: number;
	scrollWidth: number;
	clientWidth: number;
	scrollLeft: number;
	justify: string;
}

test("the heatmap centres when it fits and keeps both ends reachable when narrow", async (t) => {
	const viewport = await app.evaluate<{ width: number; height: number }>("({ width: innerWidth, height: innerHeight })");
	try {
		// A requested native window size can be clamped to the CI display; set the layout viewport.
		await app.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
		const wide = await ui<HeatmapBox>(`
			click(${RANGE("all")});
			await new Promise(requestAnimationFrame);
			heatmap().scrollIntoView({ block: "center" });
			return heatmapBox();
		`);
		assert.match(wide.justify, /safe center/);
		assert.ok(wide.card > wide.grid, `the wide card fits the grid: ${JSON.stringify(wide)}`);
		assert.ok(Math.abs(wide.left - wide.right) <= 2, `equal margins: ${JSON.stringify(wide)}`);
		assert.ok(wide.left > 0);
		await shot("heatmap-wide");

		await app.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
		const recent = await ui<HeatmapBox>(`
			heatmap().scrollLeft = 0;
			heatmap().scrollIntoView({ block: "center" });
			await new Promise(requestAnimationFrame);
			return heatmapBox();
		`);
		assert.ok(recent.scrollWidth > recent.clientWidth, `the narrow card scrolls: ${JSON.stringify(recent)}`);
		assert.ok(Math.abs(recent.right) <= 1 && recent.left < 0, `the recent end starts visible: ${JSON.stringify(recent)}`);
		await shot("heatmap-narrow-recent");

		const oldest = await ui<HeatmapBox>(`
			heatmap().scrollLeft = -heatmap().scrollWidth;
			await new Promise(requestAnimationFrame);
			return heatmapBox();
		`);
		assert.ok(oldest.scrollLeft < 0 && Math.abs(oldest.left) <= 1, `the oldest end remains reachable: ${JSON.stringify(oldest)}`);
		await shot("heatmap-narrow-oldest");
		t.diagnostic(JSON.stringify({ wide, recent, oldest }));
	} finally {
		await app.send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1, mobile: false });
	}
});

interface Reading {
	shown: boolean;
	text: string;
	inBody: boolean;
	visible: boolean;
	zIndex: string;
	tip: { left: number; top: number; right: number; bottom: number };
	chart: { top: number; bottom: number };
	/** The centre of the highlighted slot: the bars the bubble is describing. -1 when nothing is lit. */
	slot: number;
	viewport: { width: number; height: number };
	legacyTip: boolean;
	/** What the pointer actually landed on, so a miss says why rather than just "no bubble". */
	hit: string;
	at: [number, number];
}

/**
 * Read the chart with a real mouse, at a fraction of the plot's width and of the chart's height.
 *
 * The share is of the plot, not of the SVG: the axis gutter on the left reads nothing, by design.
 * The constants are `CHART` in `usage-chart-hover.ts` — left 52, right 12 of a 640-wide viewBox.
 */
async function hoverChart(share: number, height = 0.3): Promise<Reading> {
	const box = await app.evaluate<{ left: number; top: number; width: number; height: number }>(`(() => {
		const r = document.querySelector("[data-usage-bars] svg").getBoundingClientRect();
		return { left: r.left, top: r.top, width: r.width, height: r.height };
	})()`);
	const x = Math.round(box.left + (box.width * (52 + Math.min(share, 0.995) * 576)) / 640);
	const y = Math.round(box.top + box.height * height);
	await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0, pointerType: "mouse" });
	// Two frames: one for the pointer's state update, one for the layout effect that places the bubble.
	await app.evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
	const read = () => app.evaluate<Reading>(`(() => {
		const tip = document.querySelector('[data-chart-tip]');
		const svgElement = document.querySelector("[data-usage-bars] svg");
		const lit = svgElement.querySelector(':scope > rect[pointer-events="none"]');
		const rect = tip ? tip.getBoundingClientRect() : { left: 0, top: 0, right: 0, bottom: 0 };
		const svg = svgElement.getBoundingClientRect();
		const band = lit ? lit.getBoundingClientRect() : null;
		const legacy = document.querySelector('.ly-tooltip');
		return {
			chart: { top: svg.top, bottom: svg.bottom },
			shown: Boolean(tip),
			text: tip ? tip.innerText.replace(/\\s+/g, " ").trim() : "",
			inBody: tip ? tip.parentElement === document.body : false,
			visible: tip ? tip.checkVisibility({ visibilityProperty: true }) : false,
			zIndex: tip ? getComputedStyle(tip).zIndex : "",
			tip: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
			slot: band ? band.left + band.width / 2 : -1,
			viewport: { width: innerWidth, height: innerHeight },
			legacyTip: Boolean(legacy) && !legacy.hidden,
			hit: (document.elementFromPoint(${x}, ${y})?.tagName || "none") + " " + (document.elementFromPoint(${x}, ${y})?.className?.baseVal ?? document.elementFromPoint(${x}, ${y})?.className ?? "").toString().slice(0, 60),
			at: [${x}, ${y}],
		};
	})()`);

	const first = await read();
	if (first.shown) return first;
	/*
	 * One retry, because the window sits at the desktop's origin: a real hand moving a real mouse
	 * across it delivers its own pointermove, and the last one wins. A reading that is genuinely
	 * broken is broken twice.
	 */
	await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0, pointerType: "mouse" });
	await app.evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
	return read();
}

function onScreen(reading: Reading): boolean {
	const { tip, viewport } = reading;
	return tip.left >= 0 && tip.top >= 0 && tip.right <= viewport.width && tip.bottom <= viewport.height && tip.right > tip.left && tip.bottom > tip.top;
}

/** The bubble annotates the lit slot; sitting on top of it hides the bars being read. */
function clearOfSlot(reading: Reading): boolean {
	return reading.slot >= 0 && (reading.tip.left >= reading.slot || reading.tip.right <= reading.slot);
}

/** Over the chart and nothing else: the metric and split switches sit just above it. */
function overThePlot(reading: Reading): boolean {
	return reading.tip.top >= reading.chart.top - 1 && reading.tip.bottom <= reading.chart.bottom + 1;
}

/** Scroll the settings pane back to the top, so the chart is where a person would first see it. */
const TO_TOP = `
	const chart = document.querySelector("[data-usage-bars]");
	const pane = [...document.querySelectorAll("div")].find((el) => el.scrollHeight > el.clientHeight + 40 && el.contains(chart));
	if (pane) pane.scrollTop = 0;
	await wait(200);
`;

test("the bar chart answers a real pointer anywhere in the plot, and the reading escapes the card that clips it", async (t) => {
	await app.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
	await ui(`
		click(${RANGE("all")});
		await wait(300);
		click(${CHART_CARD}.querySelector('[data-segment="cost"]'));
		await wait(200);
		${TO_TOP}
	`);

	// Empty space in the upper half of the plot, above the bars: the slot is read by column, not by bar.
	const middle = await hoverChart(0.5, 0.15);
	assert.ok(middle.shown, `hovering the plot must read the day: ${JSON.stringify(middle)}`);
	assert.match(middle.text, /^\d{4}\/\d{2}\/\d{2} /, JSON.stringify(middle));
	assert.match(middle.text, /Relay/, JSON.stringify(middle));
	assert.match(middle.text, /合计/, JSON.stringify(middle));
	assert.ok(middle.inBody, "the bubble must be portalled to the body, or the overflow-hidden card cuts it off");
	assert.ok(middle.visible, JSON.stringify(middle));
	assert.equal(middle.zIndex, "200", "the same layer as the app's own tooltips");
	assert.ok(middle.slot > 0, `the slot being read is lit: ${JSON.stringify(middle)}`);
	assert.ok(onScreen(middle), JSON.stringify(middle));
	assert.ok(clearOfSlot(middle), JSON.stringify(middle));
	assert.ok(overThePlot(middle), `pointing near the top must not push the bubble over the switches: ${JSON.stringify(middle)}`);
	assert.ok(!middle.legacyTip, "the app's ordinary tooltip must not fire as well");
	await shot("usage-bars-hover-middle");

	// Today, the last column: nothing was spent, and it says so instead of showing an empty bubble.
	const last = await hoverChart(1, 0.5);
	assert.ok(last.shown, JSON.stringify(last));
	assert.match(last.text, /没有请求/, JSON.stringify(last));
	assert.ok(onScreen(last), `the bubble stays on screen at the right edge: ${JSON.stringify(last)}`);
	assert.ok(clearOfSlot(last), JSON.stringify(last));
	await shot("usage-bars-hover-last");

	// The oldest day, where there is room on the right.
	const first = await hoverChart(0, 0.95);
	assert.ok(first.shown && onScreen(first), JSON.stringify(first));
	assert.ok(first.tip.left > first.slot, `it stays clear of the slot: ${JSON.stringify(first)}`);
	assert.ok(overThePlot(first), `pointing near the bottom must not hang the bubble below the card: ${JSON.stringify(first)}`);
	assert.notEqual(first.text, last.text, "different days must read differently");
	const along = await hoverChart(0.1, 0.5);
	assert.notEqual(along.text.slice(0, 10), first.text.slice(0, 10), "moving across the plot must move through days, not stick on one");
	t.diagnostic(JSON.stringify({ middle: middle.text, last: last.text, first: first.text, along: along.text }));

	// Away from the chart, the reading goes.
	await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 20, y: 20, buttons: 0, pointerType: "mouse" });
	await app.evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
	assert.equal(await app.evaluate<boolean>("Boolean(document.querySelector('[data-chart-tip]'))"), false, "the bubble must leave with the pointer");
});

test("the reading stays inside a narrow window and does not survive a scroll", async () => {
	try {
		await app.send("Emulation.setDeviceMetricsOverride", { width: 760, height: 640, deviceScaleFactor: 1, mobile: false });
		await ui(`document.querySelector("[data-usage-bars]").scrollIntoView({ block: "end" }); await wait(200);`);

		let rightmost: Reading | null = null;
		for (const share of [0, 0.5, 1]) {
			const reading = await hoverChart(share, 0.9);
			assert.ok(reading.shown, `share ${share}: ${JSON.stringify(reading)}`);
			assert.ok(onScreen(reading), `share ${share} must stay within 760x640: ${JSON.stringify(reading)}`);
			assert.ok(clearOfSlot(reading), `share ${share} must not cover the slot it annotates: ${JSON.stringify(reading)}`);
			rightmost = reading;
		}
		// At 760 the series list drops below the chart and the chart runs to the window's edge, so the last day is the case that has to flip.
		assert.ok(rightmost && rightmost.tip.right <= rightmost.slot, `the bubble flips to the left when the right runs out: ${JSON.stringify(rightmost)}`);
		await shot("usage-bars-hover-narrow");

		const afterScroll = await app.evaluate<{ moved: boolean; shown: boolean; delta: number; chart: number[]; tip: unknown }>(`(async () => {
			const chart = document.querySelector("[data-usage-bars]");
			const pane = [...document.querySelectorAll("div")].find((el) => el.scrollHeight > el.clientHeight + 40 && el.contains(chart)) ?? document.scrollingElement;
			const before = pane.scrollTop;
			pane.scrollTop += 60;
			await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			const tip = document.querySelector('[data-chart-tip]');
			const box = chart.getBoundingClientRect();
			return { moved: pane.scrollTop !== before, shown: Boolean(tip), delta: pane.scrollTop - before, chart: [box.top, box.bottom], tip: tip ? [tip.getBoundingClientRect().top, tip.innerText.slice(0, 40)] : null };
		})()`);
		assert.ok(afterScroll.moved, `the page must actually scroll for this to prove anything: ${JSON.stringify(afterScroll)}`);
		assert.equal(afterScroll.shown, false, `a bubble fixed to the window must not survive the chart scrolling away under it: ${JSON.stringify({ afterScroll, rightmost })}`);
	} finally {
		await app.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
	}
});

test("the chart fills the height the series list gives it, instead of leaving a band of empty card", async (t) => {
	await app.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
	await app.evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
	const layout = await app.evaluate<{ chart: number; list: number; slackUnderChart: number; series: number; svg: number; sideBySide: boolean }>(`(() => {
		const chart = document.querySelector("[data-usage-bars]");
		const list = document.querySelector("[data-usage-series-list]");
		const svg = chart.querySelector("svg").getBoundingClientRect();
		const c = chart.getBoundingClientRect(), l = list.getBoundingClientRect();
		return {
			chart: Math.round(c.height),
			list: Math.round(l.height),
			slackUnderChart: Math.round(c.bottom - svg.bottom),
			series: list.querySelectorAll("[data-usage-series]").length,
			svg: Math.round(svg.height),
			sideBySide: Math.abs(c.top - l.top) <= 1 && c.right <= l.left,
		};
	})()`);

	t.diagnostic(JSON.stringify(layout));
	assert.ok(layout.series >= 4, JSON.stringify(layout));
	assert.ok(layout.sideBySide, `at 1440 the list sits beside the chart: ${JSON.stringify(layout)}`);
	// 一个格子一行，行高由高的那个说了算；列表封顶 300 加内衬，图要跟着长到那么高，而不是停在自己的最小高度。
	assert.ok(Math.abs(layout.chart - layout.list) <= 2, `the chart and the list share a row: ${JSON.stringify(layout)}`);
	assert.ok(layout.slackUnderChart <= 24, `the chart must reach the bottom of its card: ${JSON.stringify(layout)}`);
	assert.ok(layout.svg >= 200, `and take the height it was given: ${JSON.stringify(layout)}`);
	await ui(TO_TOP);
	await shot("usage-requests-series-list");
});

test("the model editor follows catalogue values and offers upstream references for relays", async () => {
	const expected = catalogModelFor({ id: "openai", baseUrl: "https://api.openai.com/v1" }, "gpt-5.2");
	assert.ok(expected);
	const values = await ui<{ context: string; output: string; input: string; outputPrice: string; cacheRead: string; cacheWrite: string; source: string; manualSource: string; relayMatched: boolean }>(`
		click(byText("nav button", "模型设置"));
		await wait(300);
		click(provider("OpenAI 官方"));
		await wait(200);
		click(byText("button", "添加模型"));
		await wait(200);
		const field = (text) => [...document.querySelectorAll("label")].find((element) => label(element).startsWith(text));
		const modelInput = field("模型 ID").querySelector("input");
		typeValue(modelInput, "gpt-5.2");
		await wait(150);
		const suggested = [...document.querySelectorAll('[aria-label="模型目录搜索结果"] button')].find((element) => label(element).startsWith("按模型 ID 找到"));
		if (!suggested) throw new Error("catalogue did not suggest gpt-5.2");
		click(suggested);
		await wait(100);
		const read = (text) => field(text).querySelector("input").value;
		const result = {
			context: read("上下文窗口"),
			output: read("最大输出"),
			input: read("输入价格"),
			outputPrice: read("输出价格"),
			cacheRead: read("缓存命中价格"),
			cacheWrite: read("缓存写入价格"),
			source: [...document.querySelectorAll("p")].find((element) => label(element).includes("价格从 pi.dev"))?.innerText || "",
		};
		typeValue(field("输入价格").querySelector("input"), "9.9");
		await wait(100);
		const manualSource = [...document.querySelectorAll("p")].find((element) => label(element).includes("当前使用手动填写的价格"))?.innerText || "";
		click(byText("button", "取消"));
		await wait(150);
		click(provider("Relay"));
		await wait(150);
		click(byText("button", "添加模型"));
		await wait(150);
		const relayInput = field("模型 ID").querySelector("input");
		typeValue(relayInput, "gpt-5.2");
		await wait(100);
		return { ...result, manualSource, relayMatched: [...document.querySelectorAll('[aria-label="模型目录搜索结果"] button')].some((element) => label(element).startsWith("按模型 ID 找到")) };
	`);

	assert.equal(values.context, String(expected.model.contextWindow));
	assert.equal(values.output, String(expected.model.maxOutputTokens));
	assert.equal(values.input, String(expected.model.inputPrice));
	assert.equal(values.outputPrice, String(expected.model.outputPrice));
	assert.equal(values.cacheRead, expected.model.cacheReadPrice === undefined ? "" : String(expected.model.cacheReadPrice));
	assert.equal(values.cacheWrite, expected.model.cacheWritePrice === undefined ? "" : String(expected.model.cacheWritePrice));
	assert.match(values.source, /pi\.dev/);
	assert.match(values.manualSource, /手动填写的价格/);
	assert.equal(values.relayMatched, true);
});
