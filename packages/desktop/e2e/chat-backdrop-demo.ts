/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 会话背景图，在真窗口里从头走一遍：选图 → 换六种效果 → 空会话 → 有消息的会话 → 仅空会话 → 浅色 → 移除。
 *
 * `node --experimental-strip-types e2e/chat-backdrop-demo.ts [图片] [目录]`
 *
 * 选图对话框是系统的，点不到；主进程里把 `showOpenDialog` 换成直接交回那张图，其余（复制进
 * `backgrounds/`、写设置、各窗口读图、重绘）都是真路径。
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { click, closeSettings, frames, openSession, openSettings, still, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const IMAGE = resolve(process.argv[2] ?? join(import.meta.dirname, "assets", "image-gen-night.jpg"));
const OUT_DIR = process.argv[3] ?? join(homedir(), "Desktop", "Plume会话背景测试");
const PORT = 9431;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const SESSION_ID = randomUUID();
const CARD = "[data-ly-chat-background-settings]";
const PREVIEW = "[data-ly-chat-background-preview] .ly-chat-backdrop";
const PANE = "[data-ly-split-pane] .ly-chat-backdrop";
const EFFECTS = [
	["dither", "抖动"],
	["ascii", "ASCII"],
	["halftone", "网点"],
	["scanlines", "扫描线"],
	["haze", "雾化"],
	["none", "原图"],
] as const;

let app: RunningApp;
const checks: { ok: boolean }[] = [];
function check(what: string, ok: boolean, saw = "") {
	checks.push({ ok });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

let shots = 0;
async function shot(name: string, clip?: { x: number; y: number; width: number; height: number }): Promise<string> {
	const { data } = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
	shots += 1;
	await writeFile(join(OUT_DIR, `${STAMP}_${String(shots).padStart(2, "0")}_${name}.png`), Buffer.from(data, "base64"));
	return createHash("sha256").update(data).digest("hex");
}

async function seed(home: string): Promise<void> {
	const cwd = join(home, "project");
	await mkdir(cwd, { recursive: true });
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 860, x: 0, y: 0 }));
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			version: 1,
			providers: [],
			mcpServers: [],
			projects: [{ id: "e2e", name: "project", path: cwd, pinned: true, lastOpenedAt: 1 }],
			defaultModelId: null,
			permissionMode: "auto",
			hooks: [],
			scheduledTasks: [],
			disabledPlugins: [],
			alwaysAllow: [],
			appearance: { theme: "dark" },
		}),
	);
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	const at = Date.now() - 600_000;
	const message = (seq: number, role: string, text: string) => ({
		seq,
		ts: at + seq * 1000,
		type: "message" as const,
		message: { role, content: [{ type: "text", text }], timestamp: at + seq * 1000 },
	});
	const reply = [
		"背景图铺在整个窗格底下，往输入框那头淡出。",
		"",
		"- 只铺在还没有消息的新对话里",
		"- 发出第一条消息就淡出",
		"",
		"```ts",
		"const opacity = empty ? chatBackgroundOpacity : 0;",
		"```",
	].join("\n");
	seedSessions(home, [
		{
			meta: {
				id: SESSION_ID,
				title: "会话背景",
				cwd,
				projectId,
				projectName: "project",
				createdAt: at,
				updatedAt: at + 3000,
				modelId: "none",
				messageCount: 2,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				seq: 2,
			},
			records: [message(1, "user", "会话背景图是怎么画的？"), message(2, "assistant", reply)],
		},
	]);
}

const style = (selector: string) =>
	app.evaluate<{ opacity: string; image: string; effect: string | null } | null>(`(() => {
		const el = document.querySelector(${JSON.stringify(selector)});
		if (!el) return null;
		const cs = getComputedStyle(el);
		return { opacity: cs.opacity, image: el.style.getPropertyValue("--ly-backdrop-image"), effect: el.dataset.lyChatBackdrop ?? null };
	})()`);

const rect = (selector: string) =>
	app.evaluate<{ x: number; y: number; width: number; height: number }>(
		`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
	);

const settings = () => app.evaluate<{ appearance: Record<string, unknown> }>("window.plume.settings.get()");
const patchAppearance = async (patch: Record<string, unknown>) => {
	await app.evaluate(`(async () => {
		const s = await window.plume.settings.get();
		await window.plume.settings.save({ ...s, appearance: { ...s.appearance, ...${JSON.stringify(patch)} } });
	})()`);
	await frames(app, 30);
};

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	const recorded: Frame[] = [];
	app = await startApp({ port: PORT, seed, scaleFactor: 2, inspectPort: PORT + 1 });
	const stop = await startRecording(PORT, recorded);
	try {
		await until(app, 'document.querySelector("main textarea")', 1800);
		await pause(1200);

		console.log("【一】改动前：空会话，没有背景");
		check("窗格里没有背景层", (await style(PANE)) === null);
		await shot("改动前_空会话");

		console.log("\n【二】外观页选一张图");
		await openSettings(app, "外观");
		await app.evaluate(`document.querySelector(${JSON.stringify(CARD)}).scrollIntoView({ block: "start" })`);
		await frames(app, 20);
		await pause(800);
		await shot("设置页_还没选图", await rect(CARD));
		const patched = await app.main<string>(`(() => {
			const binding = process._linkedBinding("electron_browser_dialog");
			binding.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [${JSON.stringify(IMAGE)}] });
			return typeof binding.showOpenDialog;
		})()`);
		check("主进程的选图对话框换成直接交图", patched === "function", patched);
		await click(app, `${CARD} button`, "选择图片");
		await until(app, `document.querySelector(${JSON.stringify(PREVIEW)})`);
		await still(app, PREVIEW);
		await pause(900);
		const saved = (await settings()).appearance.chatBackground as string | null;
		check("设置里记下的是 backgrounds 下的文件名", typeof saved === "string" && /^chat-\d+\.jpg$/.test(saved), String(saved));
		const stored = await readdir(join(app.home, "backgrounds"));
		check("图复制进了 ~/.plume/backgrounds，只有这一张", stored.length === 1 && stored[0] === saved, stored.join(", "));
		const preview = await style(PREVIEW);
		check("预览按空会话的浓度画：24%", preview?.opacity === "0.24", preview?.opacity);
		const hashes = new Map<string, string>();
		hashes.set("none", await shot("设置页_选了图_原图", await rect(CARD)));

		console.log("\n【三】六种效果逐个换，量每一次从点下到新图上屏的时间和主线程最长的一段阻塞");
		await app.evaluate(`(() => {
			window.__longest = 0;
			new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__longest = Math.max(window.__longest, e.duration); }).observe({ type: "longtask" });
		})()`);
		for (const [effect, label] of EFFECTS) {
			const before = (await style(PREVIEW))?.image ?? "";
			await app.evaluate("window.__t0 = performance.now()");
			await click(app, `${CARD} button`, label);
			await until(app, `document.querySelector(${JSON.stringify(PREVIEW)})?.dataset.lyChatBackdrop === ${JSON.stringify(effect)}`);
			// 原图和雾化共用一张 URL；其余几种每种都要换出一张新图。
			const reuse = effect === "haze" || effect === "none" || before === "";
			if (!reuse) await until(app, `document.querySelector(${JSON.stringify(PREVIEW)}).style.getPropertyValue("--ly-backdrop-image") !== ${JSON.stringify(before)}`);
			const ms = await app.evaluate<number>("Math.round(performance.now() - window.__t0)");
			await pause(900);
			const hash = await shot(`设置页_效果_${label}`, await rect(CARD));
			if (effect !== "none") hashes.set(effect, hash);
			console.log(`      ${label}：${ms}ms`);
		}
		const longest = await app.evaluate<number>("Math.round(window.__longest)");
		console.log(`      主线程最长一段：${longest}ms`);
		check("六种效果画出来的预览两两不同", new Set(hashes.values()).size === hashes.size, `${new Set(hashes.values()).size} / ${hashes.size}`);

		await click(app, `${CARD} button`, "抖动");
		await until(app, `document.querySelector(${JSON.stringify(PREVIEW)})?.dataset.lyChatBackdrop === "dither"`);
		await pause(600);

		console.log("\n【四】回到工作区：空会话");
		await closeSettings(app);
		await until(app, `document.querySelector(${JSON.stringify(PANE)})`);
		await still(app, PANE);
		await pause(900);
		const empty = await style(PANE);
		check("空会话的窗格里铺着背景，浓度 24%", empty?.opacity === "0.24", empty?.opacity);
		const edges = await app.evaluate<{ backdrop: number; card: number }>(`(() => {
			const backdrop = document.querySelector(${JSON.stringify(PANE)}).getBoundingClientRect().top;
			// 卡片的内沿：外框还有 1px 描边，图铺在描边里面。
			const edge = document.querySelector("[data-ly-split-pane] .ly-dock-card");
			const card = edge.getBoundingClientRect().top + edge.clientTop;
			return { backdrop: Math.round(backdrop), card: Math.round(card) };
		})()`);
		check("背景从卡片内沿铺起，标题栏底下也有图", edges.backdrop === edges.card, JSON.stringify(edges));
		const mask = await app.evaluate<string>(`getComputedStyle(document.querySelector(${JSON.stringify(PANE)})).maskImage`);
		check("除雾化以外不加遮罩，图从上铺到底", mask === "none", mask);
		const textarea = await app.evaluate<boolean>(`(() => {
			const field = document.querySelector("main textarea").getBoundingClientRect();
			const hit = document.elementFromPoint(field.x + field.width / 2, field.y + field.height / 2);
			return hit?.tagName === "TEXTAREA";
		})()`);
		check("背景不挡输入框：点输入框落在输入框上", textarea);
		await shot("空会话_抖动");

		console.log("\n【五】进一个有消息的会话：背景淡出");
		await openSession(app, SESSION_ID);
		await until(app, `document.body.innerText.includes("往输入框那头淡出")`);
		const fading = await app.evaluate<number[]>(`new Promise((resolve) => {
			const el = document.querySelector(${JSON.stringify(PANE)});
			const seen = [];
			const f = () => { seen.push(Number(getComputedStyle(el).opacity)); seen.length < 12 ? requestAnimationFrame(f) : resolve(seen); };
			f();
		})`);
		check("切过去是淡出，中途有介于 0 和 24% 之间的值", fading.some((v) => v > 0 && v < 0.24), JSON.stringify(fading));
		await still(app, PANE);
		await pause(900);
		const session = await style(PANE);
		check("有消息的会话里背景退到 0", session?.opacity === "0", session?.opacity);
		await shot("有消息的会话_没有背景");

		console.log("\n【六】回到新对话：背景回来");
		await click(app, "button", "新对话");
		await until(app, `getComputedStyle(document.querySelector(${JSON.stringify(PANE)})).opacity !== "0"`);
		await still(app, PANE);
		await pause(900);
		const back = await style(PANE);
		check("新对话里背景回到 24%", back?.opacity === "0.24", back?.opacity);
		await shot("新对话_抖动");

		await patchAppearance({ chatBackgroundEffect: "haze", chatBackgroundOpacity: 0.5 });
		await until(app, `document.querySelector(${JSON.stringify(PANE)})?.dataset.lyChatBackdrop === "haze"`);
		await still(app, PANE);
		await pause(900);
		check("调浓度直接作用到新对话", (await style(PANE))?.opacity === "0.5");
		await shot("新对话_雾化_50%");

		console.log("\n【七】浅色主题");
		await patchAppearance({ theme: "light", chatBackgroundEffect: "ascii", chatBackgroundOpacity: 0.4 });
		await until(app, `document.querySelector(${JSON.stringify(PANE)})?.dataset.lyChatBackdrop === "ascii"`);
		await still(app, PANE);
		await pause(1200);
		const light = await style(PANE);
		check("浅色主题下照样画出来", light?.opacity === "0.4" && Boolean(light.image), JSON.stringify(light));
		await shot("浅色_新对话_ASCII");

		console.log("\n【八】移除");
		await patchAppearance({ theme: "dark" });
		await openSettings(app, "外观");
		await app.evaluate(`document.querySelector(${JSON.stringify(CARD)}).scrollIntoView({ block: "start" })`);
		await frames(app, 20);
		await pause(600);
		await click(app, `${CARD} button`, "移除");
		await until(app, `!document.querySelector(${JSON.stringify(PREVIEW)})`);
		await pause(600);
		check("设置里背景清空", (await settings()).appearance.chatBackground === null);
		const left = await readdir(join(app.home, "backgrounds"));
		check("backgrounds 目录里的图删掉了", left.length === 0, left.join(", "));
		await shot("设置页_移除之后", await rect(CARD));
		await closeSettings(app);
		await pause(600);
		check("窗格里的背景层跟着没了", (await style(PANE)) === null);
	} finally {
		await stop();
		await app.stop();
	}

	const passed = checks.filter((c) => c.ok).length;
	const video = join(OUT_DIR, `${STAMP}_会话背景_${passed}of${checks.length}.mp4`);
	await encode(recorded, video);
	console.log(`\n${passed}/${checks.length} 通过 · 视频 ${video}`);
	if (passed !== checks.length) process.exitCode = 1;
}

await main();
