/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 用量页「Token 构成」「耗时构成」两张环图，在真窗口里量。
 *
 * 单测验的是记录怎么合（core 的 `session-usage-activity.test.ts`、`test/usage-activity.test.ts`）；
 * 这里补它们证不到的：卡片真的读到了主进程扫出来的数、环上的段按比例画、区间一换数跟着变。
 *
 * 固件：今天两个会话（一个已归档，一个带子智能体和一次失败的工具），昨天一个会话。期望值照固件算好。
 * 主进程的扫描拖慢 1.5 秒（`PLUME_E2E_SLOW_USAGE`），让骨架露出来，好量它和真卡片对不对得上。
 *
 * 用法：node --experimental-strip-types e2e/usage-breakdown-demo.ts [输出目录]
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp } from "./app.ts";
import { click, frames as waitFrames, openSettings, until } from "./drive.ts";
import { encode, frameGrabber, pause, type Frame } from "./record.ts";
import { seedSessions, type FixtureRecord } from "./session-fixture.ts";

const PORT = 9443;
const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume用量统计测试");
const STAMP = new Date().toLocaleString("sv-SE").replace(/[: ]/g, "-").slice(0, 16);
const DAY = 86_400_000;

const now = Date.now();
const midnight = new Date(now);
midnight.setHours(0, 0, 0, 0);
// 今天的记录从零点后一分钟起，好让脚本在一天里什么时候跑都落在今天。
const today = midnight.getTime() + 60_000;
const yesterday = midnight.getTime() - DAY + 9 * 3_600_000;

const usage = { input: 3000, output: 800, cacheRead: 40_000, cacheWrite: 2000 };
const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function reply(at: number, timing: { durationMs: number; sseDurationMs: number; thinkingMs?: number }, counted = true) {
	if (counted) for (const key of Object.keys(tokens) as (keyof typeof tokens)[]) tokens[key] += usage[key];
	const content = [{ type: "text" as const, text: "好" }] as { type: string; text?: string; thinking?: string; durationMs?: number }[];
	if (timing.thinkingMs) content.unshift({ type: "thinking", thinking: "想一想", durationMs: timing.thinkingMs });
	return {
		role: "assistant" as const, content, api: "openai-responses" as const, provider: "anthropic", model: "claude-sonnet-5-5", timestamp: at,
		stopReason: "stop" as const, durationMs: timing.durationMs, sseDurationMs: timing.sseDurationMs,
		usage: { ...usage, total: 45_800, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
	};
}

const tool = (at: number, durationMs: number, isError = false, text = "ok") => ({ role: "toolResult" as const, toolCallId: `c${at}`, toolName: "bash", content: [{ type: "text" as const, text }], isError, durationMs, startedAt: at - durationMs, timestamp: at });
const user = (at: number, text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: at });

/** 提示词按来源分三段，外加一份工具定义：Token 构成的前四类都要有数。 */
const systemPrompt = "S".repeat(6000) + "I".repeat(2000) + "K".repeat(1000);
const context = {
	type: "context", systemPrompt, tools: ["bash"], skills: [],
	sections: [{ source: "identity", start: 0, end: 6000 }, { source: "projectInstructions", start: 6000, end: 8000 }, { source: "skills", start: 8000, end: 9000 }],
	schemas: [{ name: "bash", description: "d".repeat(3000), parameters: {} }],
};

function busySession(): FixtureRecord[] {
	const records: FixtureRecord[] = [{ type: "event", ts: today, event: context as never }, { type: "message", ts: today, message: user(today, "开始") }];
	for (let i = 0; i < 6; i++) {
		const at = today + (i + 1) * 60_000;
		records.push({ type: "event", ts: at - 1000, event: { type: "request", provider: "anthropic", model: "claude-sonnet-5-5", messageCount: 1 + i * 2 } });
		records.push({ type: "message", ts: at, message: reply(at, { durationMs: 8000, sseDurationMs: 5000, thinkingMs: 2000 }) as never });
		records.push({ type: "message", ts: at + 10_000, message: tool(at + 10_000, 3000, i === 2, "r".repeat(8000)) });
	}
	const sub = today + 10 * 60_000;
	records.push({ type: "event", ts: sub, event: { type: "subagent", id: "sub-explore", agent: "explore", description: "", prompt: "", tools: [] } as never });
	records.push({ type: "event", ts: sub + 1000, event: { type: "subagent_message", id: "sub-explore", message: reply(sub + 1000, { durationMs: 4000, sseDurationMs: 3000 }) } as never });
	records.push({ type: "event", ts: sub + 2000, event: { type: "subagent_message", id: "sub-explore", message: tool(sub + 2000, 1500) } as never });
	return records;
}

function meta(id: string, title: string, project: string, createdAt: number, extra: Record<string, unknown> = {}) {
	return {
		id, title, cwd: project, projectId: "cccccccccccccccc", projectName: "demo-project", createdAt, updatedAt: now, modelId: "anthropic/claude-sonnet-5-5", messageCount: 1, seq: 1,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...extra,
	};
}

/*
 * 今天：轮次 1 + 1；工具 6 + 子智能体 1 = 7 次，3000×6 + 1500 = 19.5s，失败 1；
 * 模型 6×8000 + 4000 + 8000 = 60s，生成 6×5000 + 3000 + 5000 = 38s，思考 6×2000 + 2000 = 14s。
 */
const EXPECT_TODAY = { wait: 22_000, thinking: 14_000, reply: 24_000, tool: 19_500 };
process.env.PLUME_E2E_SLOW_USAGE = "1500";
const app = await startApp({
	port: PORT,
	seed: async (home) => {
		const project = join(home, "demo-project");
		await mkdir(project, { recursive: true });
		await writeFile(join(home, "window.json"), JSON.stringify({ width: 1440, height: 940, x: 0, y: 0 }));
		const busy = meta("usage-busy", "忙的会话", project, today);
		const archived = meta("usage-archived", "归档的会话", project, today, { archived: true });
		const old = meta("usage-yesterday", "昨天的会话", project, yesterday);
		const second = today + 30 * 60_000;
		seedSessions(home, [
			{ meta: busy as never, records: [{ type: "meta", ts: today, meta: busy } as FixtureRecord, ...busySession()] },
			{ meta: archived as never, records: [{ type: "meta", ts: today, meta: archived } as FixtureRecord, { type: "event", ts: second, event: context as never }, { type: "message", ts: second, message: user(second, "问一句") }, { type: "event", ts: second + 1000, event: { type: "request", provider: "anthropic", model: "claude-sonnet-5-5", messageCount: 1 } }, { type: "message", ts: second + 5000, message: reply(second + 5000, { durationMs: 8000, sseDurationMs: 5000, thinkingMs: 2000 }) as never }] },
			// 昨天的那次不进今天的 token：它只在切到 7 天时出现。
			{ meta: old as never, records: [{ type: "meta", ts: yesterday, meta: old } as FixtureRecord, { type: "message", ts: yesterday, message: user(yesterday, "昨天") }, { type: "event", ts: yesterday + 1000, event: { type: "request", provider: "anthropic", model: "claude-sonnet-5-5", messageCount: 1 } }, { type: "message", ts: yesterday + 60_000, message: tool(yesterday + 60_000, 60_000) }] },
		]);
		await writeFile(join(home, "settings.json"), JSON.stringify({
			version: 1,
			providers: [{ id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com", api: "anthropic-messages", apiKey: "", enabled: true, models: [] }],
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
const TIME = `${ROOT} [data-usage-time-breakdown]`;
const TOKEN = `${ROOT} [data-usage-token-breakdown]`;
const legend = (card: string, key: string) => read<string>(`document.querySelector('${card} [data-usage-legend="${key}"]')?.innerText.replace(/\\n/g, " ") ?? ""`);
const center = (card: string) => read<string>(`document.querySelector('${card} svg')?.parentElement?.innerText.replace(/\\n/g, " ") ?? ""`);
/** 每一段画出来的弧长（dasharray 的第一个数）加上缝，占整圈的比例。 */
const arcs = (card: string) => read<Record<string, number>>(`Object.fromEntries([...document.querySelectorAll('${card} [data-donut-segment]')].map((c) => [c.dataset.donutSegment, Math.round(((parseFloat(c.getAttribute('stroke-dasharray')) + 2) / (2 * Math.PI * 46)) * 1000) / 10]))`);
const pct = (part: number, whole: number) => Math.round((part / whole) * 1000) / 10;
const step = async (ms = 1100) => {
	await waitFrames(app, 30);
	await film(ms);
};

try {
	await app.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 940, deviceScaleFactor: 2, mobile: false });
	await pause(2200);
	console.log("\n零、第一次扫描时的骨架");
	type Box = { top: number; left: number; width: number; height: number; ring: { top: number; left: number } };
	const boxes = (cards: string, ring: string) => `[...document.querySelectorAll('${cards}')].map((card) => { const c = card.getBoundingClientRect(); const r = card.querySelector('${ring}').getBoundingClientRect(); return { top: Math.round(c.top), left: Math.round(c.left), width: Math.round(c.width), height: Math.round(c.height), ring: { top: Math.round(r.top - c.top), left: Math.round(r.left - c.left) } }; })`;
	// 骨架在扫描期间才在，点进去之前先挂上观察者，出现的那一帧就量下来。
	await read(`(() => { window.__skeleton = null; window.__opened = performance.now(); const observer = new MutationObserver(() => { if (!window.__skeleton && document.querySelector('[data-usage-breakdown-skeleton]')) window.__skeleton = { at: Math.round(performance.now() - window.__opened), boxes: ${boxes("[data-usage-breakdown-skeleton] > div", "[data-skeleton-ring]")} }; if (document.querySelector('[data-usage-requests]')) { window.__landed = Math.round(performance.now() - window.__opened); observer.disconnect(); } }); observer.observe(document.body, { subtree: true, childList: true }); })()`);
	await openSettings(app, "使用统计");
	await until(app, `document.querySelector('[data-usage-breakdown-skeleton]')`, 600);
	await read(`document.querySelector('[data-usage-breakdown-skeleton]').scrollIntoView({ block: "start" })`);
	await shot("00_骨架");
	await film(400);
	await until(app, `document.querySelector('${TIME} [data-usage-legend]')`, 1200);
	const seenSkeleton = await read<{ at: number; boxes: Box[] } | null>("window.__skeleton");
	const skeleton = seenSkeleton?.boxes ?? null;
	console.log(`   骨架出现在 ${seenSkeleton?.at ?? "—"}ms，数据到在 ${await read<number>("window.__landed")}ms`);
	check("扫描慢时露出两张环图卡片的骨架", skeleton?.length === 2, JSON.stringify(skeleton));
	const real = await read<Box[]>(boxes(`${ROOT} [data-usage-breakdown] > div`, "svg"));
	const same = (a: Box, b: Box) => a.width === b.width && Math.abs(a.height - b.height) <= 1 && a.ring.top === b.ring.top && a.ring.left === b.ring.left;
	check("数据到了，卡片宽高和环在卡片里的位置不变", Boolean(skeleton) && skeleton!.every((box, index) => same(box, real[index]!)), `骨架 ${JSON.stringify(skeleton?.map(({ width, height, ring }) => ({ width, height, ring })))} → 真卡片 ${JSON.stringify(real.map(({ width, height, ring }) => ({ width, height, ring })))}`);
	await read(`document.querySelector('${ROOT} [data-usage-breakdown]').scrollIntoView({ block: "center" })`);
	await step(1500);

	console.log("\n一、今天");
	await shot("01_今天_两张环图");
	const counts = await read<string>(`document.querySelector('${TIME} [data-usage-activity-counts]').innerText`);
	check("会话、归档、轮次、工具调用", counts === "2 个会话（已归档 1） · 2 轮 · 7 次工具调用", counts);
	check("累计耗时 1m20s（模型 60s + 工具 19.5s）", (await center(TIME)) === "1m20s 累计耗时", await center(TIME));
	check("工具执行：20s · 7 次 · 失败 1", (await legend(TIME, "tool")).endsWith("20s · 7 次 · 失败 1"), await legend(TIME, "tool"));
	const total = EXPECT_TODAY.wait + EXPECT_TODAY.thinking + EXPECT_TODAY.reply + EXPECT_TODAY.tool;
	const wantTime = Object.fromEntries(Object.entries(EXPECT_TODAY).map(([key, value]) => [key, pct(value, total)]));
	const sawTime = await arcs(TIME);
	check(`耗时环上各段的弧长按比例 ${JSON.stringify(wantTime)}`, Object.entries(wantTime).every(([key, value]) => Math.abs((sawTime[key] ?? 0) - value) <= 0.2), JSON.stringify(sawTime));
	// 十以上的占比取整，和右边系列列表一个写法；精确比例看上面的弧长。
	check("等待首字 28%，8 次计时", (await legend(TIME, "wait")) === "等待首字 28% 22s · 8 次", await legend(TIME, "wait"));
	const tokenTotal = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
	check(`Token 环中间是全部 ${tokenTotal}，写成 366k`, tokenTotal === 366_400 && (await center(TOKEN)) === "366k 全部 Token", await center(TOKEN));
	const sawTokens = await arcs(TOKEN);
	const shares = Object.values(sawTokens).reduce((sum, value) => sum + value, 0);
	// 比段间那道缝还窄的段（这份固件里的注入内容是 0、助手消息只有一个字）环上不画，图例里照样列着。
	const legends = await read<number>(`document.querySelectorAll('${TOKEN} [data-usage-legend]').length`);
	check("图例列十类，环上画出来的各段加起来近乎一整圈", legends === 10 && shares >= 98 && shares <= 100.5, `图例 ${legends} 类，环上 ${Object.keys(sawTokens).length} 段合 ${shares.toFixed(1)}%：${JSON.stringify(sawTokens)}`);
	const largest = Object.entries(sawTokens).sort((a, b) => b[1] - a[1])[0]?.[0];
	check("这份固件里工具结果最大（每条 8000 字符）", largest === "toolResults", `${largest} · ${await legend(TOKEN, "toolResults")}`);
	const split = await read<string>(`document.querySelector('${TOKEN} [data-usage-cache-split]')?.innerText ?? ""`);
	check("缓存那一维是账单实数：读 89%、写 4.4%、未缓存 6.7%", split === "输入中缓存读取 89% · 缓存写入 4.4% · 未缓存 6.7%", split);

	console.log("\n二、切到 7 天：昨天那个会话进来");
	await read(`document.querySelector('${ROOT}').scrollIntoView({ block: "start" })`);
	await step(600);
	await click(app, `${ROOT} [data-segment="7"]`);
	await read(`document.querySelector('${ROOT} [data-usage-breakdown]').scrollIntoView({ block: "center" })`);
	await step(1500);
	const weekCounts = await read<string>(`document.querySelector('${TIME} [data-usage-activity-counts]').innerText`);
	check("7 天：3 个会话、3 轮、8 次工具调用", weekCounts === "3 个会话（已归档 1） · 3 轮 · 8 次工具调用", weekCounts);
	check("7 天：累计 2m20s", (await center(TIME)) === "2m20s 累计耗时", await center(TIME));
	await shot("02_7天");

	console.log("\n三、窄窗口：两张卡片上下排");
	await app.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 940, deviceScaleFactor: 2, mobile: false });
	await read(`document.querySelector('${ROOT} [data-usage-breakdown]').scrollIntoView({ block: "start" })`);
	await step(1200);
	const stacked = await read<boolean>(`(() => { const a = document.querySelector('${TOKEN}').getBoundingClientRect(); const b = document.querySelector('${TIME}').getBoundingClientRect(); return b.top >= a.bottom; })()`);
	const overflow = await read<number>(`[...document.querySelectorAll('${ROOT} [data-usage-breakdown] [data-usage-legend] div')].filter((d) => d.scrollWidth > d.clientWidth + 1).length`);
	check("窄窗口上下排，图例没有被截断", stacked && overflow === 0, `上下排 ${stacked}，截断 ${overflow} 处`);
	await shot("03_窄窗口");
	await film(800);
} finally {
	const passed = checks.filter((each) => each.ok).length;
	if (recorded.length > 0) {
		await mkdir(OUT_DIR, { recursive: true });
		const file = join(OUT_DIR, `${STAMP}_用量环图_${passed}of${checks.length}.mp4`);
		await encode(recorded, file, 30);
		console.log(`\n${passed}/${checks.length} 通过 · ${recorded.length} 帧 → ${file}`);
	}
	grab.close();
	await app.stop();
}
