/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 有消息的会话里，背景图在几种效果、深浅色下各拍一张，量正文底下的图还剩多少起伏、字的最差对比度。
 *
 * `node --experimental-strip-types e2e/chat-backdrop-session-demo.ts [浓度] [目录]`
 *
 * 每种先拍新对话里清楚的原样，再进会话拍压淡以后的样子。
 */

import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { click, frames, openSession, until } from "./drive.ts";
import { seedSessions } from "./session-fixture.ts";

const OPACITY = Number(process.argv[2] ?? 0.4);
const OUT_DIR = process.argv[3] ?? join(homedir(), "Desktop", "Plume会话背景测试");
const PORT = 9441;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const SESSION_ID = randomUUID();
const IMAGE = "chat-1.jpg";

/** 名字、外观设置的改动。 */
const VARIANTS: [string, Record<string, unknown>][] = [
	["原图", { chatBackgroundEffect: "none" }],
	["抖动", { chatBackgroundEffect: "dither" }],
	["网点", { chatBackgroundEffect: "halftone" }],
	["雾化", { chatBackgroundEffect: "haze" }],
	["浅色_原图", { theme: "light", chatBackgroundEffect: "none" }],
];

let app: RunningApp;

async function seed(home: string): Promise<void> {
	const cwd = join(home, "project");
	await mkdir(join(home, "backgrounds"), { recursive: true });
	await copyFile(join(import.meta.dirname, "assets", "image-gen-night.jpg"), join(home, "backgrounds", IMAGE));
	await mkdir(cwd, { recursive: true });
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1600, height: 960, x: 0, y: 0 }));
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
			appearance: { theme: "dark", chatBackground: IMAGE, chatBackgroundEffect: "none", chatBackgroundOpacity: OPACITY },
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
		"背景图在有消息的会话里也留着，只是正文底下要换一种画法，不然字压在图上读不清。",
		"",
		"深色主题下，底色是 `#171717`，次要文字 `#888` 对它的对比度大约 5:1，刚好够读。图上白的地方按 65% 叠上来，底色就成了 `#aeaeae` 左右，正文和次要文字都只剩 1.5 上下。",
		"",
		"- 光调淡不够：要让次要文字留在 4.5:1，图的有效浓度得压到 5% 左右",
		"- 真正抢眼的是图里的边缘和纹理，和字的笔画挤在一起",
		"- 所以盖一层底色，把图压到一半",
		"",
		"```ts",
		"const effective = opacity * (1 - tint);",
		"```",
		"",
		"两侧要不要留原图，是这一轮要挑的事。",
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
				updatedAt: at + 5000,
				modelId: "none",
				messageCount: 4,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				seq: 4,
			},
			records: [
				message(1, "user", "会话里的背景图为什么看不清？"),
				message(2, "assistant", reply),
				message(3, "user", "那几种画法各是什么样子？"),
				message(4, "assistant", reply),
			],
		},
	]);
}

const rect = (selector: string) =>
	app.evaluate<{ x: number; y: number; width: number; height: number }>(
		`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
	);

/** 一块区域里背景的最亮、最暗（相对亮度）和 8 位亮度的标准差。量之前把正文藏起来，只剩背景。 */
async function backdropStats(clip: { x: number; y: number; width: number; height: number }) {
	await app.evaluate(`document.querySelector(".ly-transcript").style.visibility = "hidden"`);
	await frames(app, 4);
	const { data } = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 1 } });
	await app.evaluate(`document.querySelector(".ly-transcript").style.visibility = ""`);
	return app.evaluate<{ max: number; min: number; sd: number }>(`(async () => {
		const bytes = Uint8Array.from(atob(${JSON.stringify(data)}), (c) => c.charCodeAt(0));
		const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		const ctx = canvas.getContext("2d");
		ctx.drawImage(bitmap, 0, 0);
		const px = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
		const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
		let max = 0, min = 1, sum = 0, sq = 0, n = 0;
		for (let i = 0; i < px.length; i += 4) {
			const L = 0.2126 * lin(px[i]) + 0.7152 * lin(px[i + 1]) + 0.0722 * lin(px[i + 2]);
			max = Math.max(max, L); min = Math.min(min, L);
			const y = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
			sum += y; sq += y * y; n += 1;
		}
		const mean = sum / n;
		return { max, min, sd: Math.sqrt(sq / n - mean * mean) };
	})()`);
}

const inkColors = () =>
	app.evaluate<number[][]>(`["--color-ink", "--color-ink-muted"].map((v) => {
		const probe = document.createElement("span");
		probe.style.color = "var(" + v + ")";
		document.body.append(probe);
		const rgb = getComputedStyle(probe).color.match(/[\\d.]+/g).slice(0, 3).map(Number);
		probe.remove();
		return rgb;
	})`);

const checks: boolean[] = [];
function check(what: string, ok: boolean, saw = "") {
	checks.push(ok);
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

const luminance = (rgb: number[]) => {
	const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
	return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
};
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	app = await startApp({ port: PORT, seed, scaleFactor: 2 });
	try {
		await until(app, 'document.querySelector("main textarea")', 1800);
		await openSession(app, SESSION_ID);
		await until(app, `document.body.innerText.includes("两侧要不要留原图") && document.querySelector(".ly-chat-veil")`, 1800);
		await frames(app, 30);
		const transcript = await rect(".ly-transcript");
		const pane = await rect(".ly-chat-backdrop");
		const scroller = await rect("[data-ly-chat-surface] .ly-transcript");
		const top = Math.max(pane.y, scroller.y);
		const column = { x: transcript.x, y: top + 40, width: transcript.width, height: 420 };
		console.log(`浓度 ${Math.round(OPACITY * 100)}%`);
		for (const [name, patch] of VARIANTS) {
			await app.evaluate(`(async () => {
				const s = await window.plume.settings.get();
				await window.plume.settings.save({ ...s, appearance: { ...s.appearance, ...${JSON.stringify(patch)} } });
			})()`);
			await until(app, `document.querySelector(".ly-chat-backdrop")?.dataset.lyChatBackdrop === ${JSON.stringify(patch.chatBackgroundEffect)}`);
			await frames(app, 40);
			console.log(`\n【${name}】`);
			check(`${name}：会话里压淡那一层在`, await app.evaluate<boolean>(`Boolean(document.querySelector(".ly-chat-backdrop > .ly-chat-veil"))`));
			const { data } = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
			await writeFile(join(OUT_DIR, `${STAMP}_${Math.round(OPACITY * 100)}%_会话_${name}.png`), Buffer.from(data, "base64"));
			const col = await backdropStats(column);
			const ink = await inkColors();
			const worst = (rgb: number[]) => Math.min(contrast(luminance(rgb), col.max), contrast(luminance(rgb), col.min));
			console.log(`      正文底下起伏 σ=${col.sd.toFixed(1)}，最差对比度 正文 ${worst(ink[0]).toFixed(1)}:1 / 次要 ${worst(ink[1]).toFixed(1)}:1`);
			check(`${name}：正文最差对比度不低于 4.5:1`, worst(ink[0]) >= 4.5, worst(ink[0]).toFixed(1));
		}
		await click(app, "button", "新对话");
		await until(app, `Boolean(document.querySelector(".ly-chat-backdrop"))`);
		await frames(app, 40);
		check("新对话里不压，还是原样", await app.evaluate<boolean>(`!document.querySelector(".ly-chat-veil")`));
		const { data } = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(OUT_DIR, `${STAMP}_${Math.round(OPACITY * 100)}%_新对话_浅色_原图.png`), Buffer.from(data, "base64"));
	} finally {
		await app.stop();
	}
	console.log(`\n${checks.filter(Boolean).length}/${checks.length} 通过`);
	if (checks.includes(false)) process.exitCode = 1;
}

await main();
