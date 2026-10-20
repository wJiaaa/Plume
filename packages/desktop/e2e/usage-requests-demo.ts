/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 用量页「请求」那一栏，在真窗口里边点边录。
 *
 * 单测验的是算术（`test/usage-requests.test.ts`）和扫描（`test/usage-scan-requests.test.ts`）；这里补
 * 它们证不到的：柱子真的按小时画了 24 根、悬停真的出气泡、点掉一个系列柱子真的变矮、次数小的时候纵轴
 * 刻度不重复、导出的 CSV 里真的是筛出来的那些。
 *
 * 固件按「现在」往回铺：今天到当前这一小时每小时一批，过去 60 天零散几批，三家供应商、两种子智能体、
 * 两种后台调用。期望值在铺的时候就算好，和界面上读回来的比。
 *
 * 用法：node --experimental-strip-types e2e/usage-requests-demo.ts [输出目录]
 *       PLUME_USAGE_ONLY_OVERVIEW=1 只拍打开时的第一屏（改动前那一版拿来对照）
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp } from "./app.ts";
import { click, frames as waitFrames, openSettings, until } from "./drive.ts";
import { encode, frameGrabber, pause, type Frame } from "./record.ts";
import { seedSessions, type FixtureRecord } from "./session-fixture.ts";

const PORT = 9441;
const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume用量请求页测试");
const STAMP = new Date().toLocaleString("sv-SE").replace(/[: ]/g, "-").slice(0, 16);
const ONLY_OVERVIEW = process.env.PLUME_USAGE_ONLY_OVERVIEW === "1";
const DAY = 86_400_000;

const MODELS = [
	{ provider: "relay-a", model: "claude-opus-5-5", speed: 90, firstMs: 3000, perCost: 0.06 },
	{ provider: "anthropic", model: "claude-sonnet-5-5", speed: 140, firstMs: 1500, perCost: 0.02 },
	{ provider: "relay-b", model: "gpt-6.1", speed: 50, firstMs: 6000, perCost: 0.03 },
] as const;

/** 一个确定的随机数，好让每次铺出来的一样。 */
let state = 7;
const random = () => ((state = (state * 48271) % 2147483647) / 2147483647);

const expected = { today: 0, todayOutput: 0, todayStreamMs: 0 };

function seedRecords(now: number): FixtureRecord[] {
	const records: FixtureRecord[] = [];
	const midnight = new Date(now);
	midnight.setHours(0, 0, 0, 0);
	let n = 0;
	const reply = (at: number, which: (typeof MODELS)[number]) => {
		n += 1;
		const output = 300 + Math.round(random() * 900);
		const streamMs = Math.round((output / which.speed) * 1000);
		const input = 2000 + Math.round(random() * 4000);
		const cacheRead = 30_000 + Math.round(random() * 60_000);
		const today = at >= midnight.getTime();
		if (today) {
			expected.today += 1;
			expected.todayOutput += output;
			expected.todayStreamMs += streamMs;
		}
		return {
			role: "assistant" as const, content: [{ type: "text" as const, text: "。" }], api: "openai-responses" as const,
			provider: which.provider, model: which.model, timestamp: at,
			stopReason: "stop" as const, durationMs: which.firstMs + streamMs, sseDurationMs: streamMs,
			usage: { input, output, cacheRead, cacheWrite: 0, total: input + output + cacheRead, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: which.perCost, rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } } },
		};
	};
	records.push({ type: "event", ts: now - 60 * DAY, event: { type: "subagent", id: "sub-explore", agent: "explore", description: "", prompt: "", tools: [] } as never });
	records.push({ type: "event", ts: now - 60 * DAY, event: { type: "subagent", id: "sub-review", agent: "review", description: "", prompt: "", tools: [] } as never });
	const batch = (at: number, size: number) => {
		for (let i = 0; i < size; i++) {
			const when = at + i * 37_000;
			if (when > now) return;
			const which = MODELS[Math.floor(random() * MODELS.length)]!;
			records.push({ type: "message", ts: when, message: reply(when, which) });
		}
		const sub = Math.round(random() * 3);
		for (let i = 0; i < sub; i++) {
			const when = at + 20 * 60_000 + i * 41_000;
			if (when > now) return;
			const explore = i % 2 === 0;
			records.push({ type: "event", ts: when, event: { type: "subagent_message", id: explore ? "sub-explore" : "sub-review", message: reply(when, explore ? MODELS[1] : MODELS[0]) } });
		}
		const title = at + 40 * 60_000;
		if (title <= now) {
			if (title >= midnight.getTime()) expected.today += 1;
			records.push({ type: "usage", ts: title, source: "title-summary", providerId: "anthropic", modelId: "claude-sonnet-5-5", usage: { input: 800, output: 20, cacheRead: 0, cacheWrite: 0, total: 820, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.003 } } });
		}
	};
	for (let day = 60; day >= 1; day--) {
		if (random() < 0.35) continue;
		const start = midnight.getTime() - day * DAY;
		for (let k = 0; k < 1 + Math.floor(random() * 3); k++) batch(start + (9 + Math.floor(random() * 12)) * 3_600_000, 3 + Math.floor(random() * 8));
	}
	const hourNow = new Date(now).getHours();
	for (let hour = 0; hour <= hourNow; hour++) {
		if (hour < 8 && hour % 3 !== 0) continue;
		batch(midnight.getTime() + hour * 3_600_000 + 60_000, 2 + Math.floor(random() * 7));
	}
	return records;
}

const now = Date.now();
const app = await startApp({
	port: PORT,
	seed: async (home) => {
		const project = join(home, "demo-project");
		await mkdir(project, { recursive: true });
		await writeFile(join(home, "window.json"), JSON.stringify({ width: 1440, height: 940, x: 0, y: 0 }));
		const records = seedRecords(now);
		// 有一条人说的话：一条消息都没有的会话，应用启动时 `pruneEmpty` 会把它连记录一起删掉。
		records.unshift({ type: "message", ts: now - 61 * DAY, message: { role: "user", content: [{ type: "text", text: "开始" }], timestamp: now - 61 * DAY } });
		const meta = {
			id: "usage-demo", title: "用量固件", cwd: project, projectId: "cccccccccccccccc", projectName: "demo-project",
			createdAt: now - 61 * DAY, updatedAt: now, modelId: "anthropic/claude-sonnet-5-5", messageCount: 1, seq: 1,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		seedSessions(home, [{ meta, records: [{ type: "meta", ts: now - 61 * DAY, meta } as FixtureRecord, ...records] }]);
		await writeFile(join(home, "settings.json"), JSON.stringify({
			version: 1,
			providers: [
				{ id: "relay-a", name: "公司中转", baseUrl: "https://relay-a.example/v1", api: "openai-responses", apiKey: "", enabled: true, models: [] },
				{ id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com", api: "anthropic-messages", apiKey: "", enabled: true, models: [] },
				{ id: "relay-b", name: "备用中转", baseUrl: "https://relay-b.example/v1", api: "openai-responses", apiKey: "", enabled: true, models: [] },
			],
			mcpServers: [], projects: [{ id: "e2e", name: "demo-project", path: project, pinned: true, lastOpenedAt: now }],
			defaultModelId: null, permissionMode: "auto", thinking: "medium", retryAttempts: 1, hooks: [], scheduledTasks: [],
			disabledPlugins: [], pluginRegistries: [], skillRegistries: [], alwaysAllow: [], appearance: { theme: "dark" },
		}));
	},
});
const grab = await frameGrabber(PORT);
const recorded: Frame[] = [];
const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw: unknown) {
	checks.push({ ok, what, saw: String(saw) });
	console.log(`   ${ok ? "✅" : "❌"} ${what}  —— ${String(saw)}`);
}
async function film(ms: number) {
	const end = Date.now() + ms;
	do recorded.push({ at: Date.now(), data: await grab.shot() });
	while (Date.now() < end);
}
async function shot(name: string) {
	await mkdir(OUT_DIR, { recursive: true });
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${name}.png`), Buffer.from(image.data, "base64"));
}
const read = <T>(expression: string) => app.evaluate<T>(expression);
const ROOT = "[data-usage-requests]";
const kpi = (index: number) => read<string>(`document.querySelectorAll('${ROOT} [data-usage-request-kpis] > div')[${index}].children[1].innerText`);
const barHeights = () => read<number>(`[...document.querySelectorAll('${ROOT} [data-bar-slot] rect, ${ROOT} rect[data-bar-slot]')].reduce((s, r) => s + r.getBoundingClientRect().height, 0)`);
const step = async (ms = 1100) => {
	await waitFrames(app, 30);
	await film(ms);
};

try {
	await app.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 940, deviceScaleFactor: 2, mobile: false });
	await pause(2200);
	await openSettings(app, "使用统计");
	await until(app, `document.querySelector('${ROOT} [data-bar-slot]')`, 1200);
	await pause(800);
	// 不用 process.exit：那样会跳过 finally，留下一个占着端口的 Electron。
	walkthrough: {
	if (ONLY_OVERVIEW) {
		await shot("00_概览");
		break walkthrough;
	}
	await film(900);

	console.log("\n一、打开就是请求页，默认今天按小时");
	await step(1500);
	await shot("01_今天按小时");
	check("今天画 24 格", (await read<number>(`document.querySelectorAll('${ROOT} [data-bar-slot]').length`)) === 24, await read<number>(`document.querySelectorAll('${ROOT} [data-bar-slot]').length`));
	const requests = await kpi(1);
	check(`请求数 = 固件里今天的 ${expected.today}`, requests.replace(/,/g, "") === String(expected.today), requests);
	const speedWant = Math.round(expected.todayOutput / (expected.todayStreamMs / 1000));
	const speed = await kpi(4);
	check(`输出速度 ≈ ${speedWant} token/秒`, speed.includes(`${speedWant} token/秒`), speed);

	console.log("\n二、悬停一根柱子");
	const target = await read<{ x: number; y: number } | null>(`(() => { const bars = [...document.querySelectorAll('${ROOT} [data-bar-slot] rect')].filter((r) => r.getBoundingClientRect().height > 4); const r = bars.at(-1)?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
	if (target) await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...target });
	await step(1300);
	const tip = await read<string>(`document.querySelector('[data-chart-tip]')?.innerText ?? ""`);
	check("气泡写着这一小时和各系列", /\d{2}:00–\d{2}:00/.test(tip) && tip.split("\n").length >= 3, tip.replace(/\n/g, " | "));
	await shot("02_悬停气泡");
	await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });

	console.log("\n三、点掉第一个系列");
	const before = await barHeights();
	await click(app, `${ROOT} [data-usage-series]`);
	await step(1200);
	const after = await barHeights();
	check("柱子变矮，这个系列不在图上", after < before && (await read<string>(`document.querySelector('${ROOT} [data-usage-series]').getAttribute('aria-pressed')`)) === "false", `${Math.round(before)}px → ${Math.round(after)}px`);
	await shot("03_关掉一个系列");
	await click(app, `${ROOT} [data-usage-series]`);
	await step(700);

	console.log("\n四、按供应商拆");
	await click(app, `${ROOT} [data-segment="provider"]`);
	await step(1200);
	const series = await read<string>(`[...document.querySelectorAll('${ROOT} [data-usage-series]')].map((b) => b.getAttribute('data-usage-series')).join(",")`);
	check("系列就是三家供应商", series.split(",").sort().join(",") === "anthropic,relay-a,relay-b", series);
	check("页面上没有 Agent、用途和失败筛选", !(await read<boolean>(`[...document.querySelectorAll('${ROOT} button')].some((b) => /Agent|用途|失败|重试/.test(b.innerText))`)), "没有");
	await shot("04_按供应商拆");

	console.log("\n五、口径换成速度");
	await click(app, `${ROOT} [data-segment="speed"]`);
	await step(1200);
	check("速度每格一根，不按系列堆", (await read<number>(`document.querySelectorAll('${ROOT} rect[data-bar-slot]').length`)) === 24, await read<number>(`document.querySelectorAll('${ROOT} rect[data-bar-slot]').length`));
	await shot("05_速度");

	console.log("\n六、搜 gpt，按请求数看");
	await read(`(() => { const input = document.querySelector('${ROOT} input[aria-label="搜索模型、供应商"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(input, "gpt"); input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
	await click(app, `${ROOT} [data-segment="requests"]`);
	await step(1200);
	// 一家供应商一小时只有几次，最容易把 0.5、1.5 这种刻度四舍五入成重复的数。
	const ticks = await read<string>(`[...document.querySelectorAll('${ROOT} [data-usage-bars] svg text[text-anchor="end"]')].map((t) => t.textContent).join(",")`);
	check("次数很小时纵轴刻度不重复", ticks.split(",").length > 1 && new Set(ticks.split(",")).size === ticks.split(",").length, ticks);
	await shot("06_搜gpt按请求数");

	console.log("\n七、30 天");
	await click(app, `${ROOT} [data-segment="30"]`);
	await click(app, `${ROOT} [data-segment="tokens"]`);
	await step(1200);
	check("30 天画 30 格", (await read<number>(`document.querySelectorAll('${ROOT} [data-bar-slot]').length`)) === 30, await read<number>(`document.querySelectorAll('${ROOT} [data-bar-slot]').length`));
	const gptOnly = await read<string>(`[...document.querySelectorAll('${ROOT} [data-usage-series]')].map((b) => b.getAttribute('data-usage-series')).join(",")`);
	check("搜 gpt 之后只剩备用中转", gptOnly === "relay-b", gptOnly);
	await shot("07_30天搜索gpt");

	console.log("\n八、导出 CSV");
	const csv = await read<string>(`(async () => {
		// 不真下载（会弹系统的存储对话框），也不 fetch blob 地址（页面的 CSP 不放行）：直接拿交出去的那个 Blob。
		let blob = null;
		let name = "";
		const create = URL.createObjectURL;
		const click = HTMLAnchorElement.prototype.click;
		URL.createObjectURL = (value) => { blob = value; return "blob:captured"; };
		HTMLAnchorElement.prototype.click = function () { name = this.download; };
		document.querySelector('${ROOT} [data-usage-export]').click();
		URL.createObjectURL = create;
		HTMLAnchorElement.prototype.click = click;
		if (!blob) return "";
		// text() 解码时会吃掉 BOM，所以 BOM 在不在要看字节。
		const head = [...new Uint8Array(await blob.slice(0, 3).arrayBuffer())].join(" ");
		return name + "\\n" + head + "\\n" + (await blob.text());
	})()`);
	const lines = csv.split("\n");
	const body = lines.slice(3);
	check("CSV 带 BOM、有表头，且每一行都是 gpt-6.1", lines[1] === "239 187 191" && lines[2]?.startsWith("hour,provider,providerId,model,requests") && body.length > 0 && body.every((line) => line.split(",")[3] === "gpt-6.1"), `${lines[0]}，${body.length} 行`);

	console.log("\n九、自定义区间、热力图换成请求数");
	await read(`(() => { const input = document.querySelector('${ROOT} input[aria-label="搜索模型、供应商"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(input, ""); input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
	await click(app, `${ROOT} [data-segment="custom"]`);
	await step(900);
	check("自定义默认最近 7 天", (await read<number>(`document.querySelectorAll('${ROOT} [data-bar-slot]').length`)) === 7, await read<number>(`document.querySelectorAll('${ROOT} [data-bar-slot]').length`));
	const HEAT = `${ROOT} [data-usage-heatmap]`;
	const order = await read<{ miss: number; heat: number; text: string }>(`(() => { const miss = document.querySelector('${ROOT} [data-usage-cache-miss]'); const heat = document.querySelector('${HEAT}'); return { miss: miss.getBoundingClientRect().top, heat: heat.getBoundingClientRect().top, text: miss.innerText.split("\\n").slice(0, 3).join(" ") }; })()`);
	check("缓存未命中在用量热力图上面", order.miss < order.heat, order.text);
	const shades = () => read<string>(`[...document.querySelectorAll('${HEAT} [data-ly-tip-side="top"]')].map((c) => c.className.match(/bg-(?:ink|accent)\\S*/)?.[0]).join("")`);
	const tokenShades = await shades();
	await read(`document.querySelector('${HEAT}').scrollIntoView({ block: "center" })`);
	await step(600);
	await click(app, `${HEAT} [data-segment="requests"]`);
	await step(1200);
	check("热力图按请求数重新上色", (await shades()) !== tokenShades, "格子颜色变了");
	await shot("08_自定义区间与热力图");
	await film(800);
	}
} finally {
	const passed = checks.filter((each) => each.ok).length;
	if (recorded.length > 0) {
		await mkdir(OUT_DIR, { recursive: true });
		const file = join(OUT_DIR, `${STAMP}_用量请求页_${passed}of${checks.length}.mp4`);
		await encode(recorded, file, 30);
		console.log(`\n${passed}/${checks.length} 通过 · ${recorded.length} 帧 → ${file}`);
	}
	grab.close();
	await app.stop();
}
