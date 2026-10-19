/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 新对话铺着背景图，点进一个会话：图当场退掉，不在已经出来的正文底下再淡出一段；回到新对话时照旧淡入。
 *
 * `node --experimental-strip-types e2e/backdrop-switch-demo.ts <before|after>`
 *
 * 每一帧读背景层的 `opacity` 和转录行数。渲染进程从开发服务器加载源码，理由见 `cold-switch-demo.ts`。
 */

import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { startDevRenderer } from "./dev-renderer.ts";
import { click, openSession, until } from "./drive.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const PORT = 9485;
const PANE = '[data-dock-pane="conversation"]';
const OPACITY = 0.5;
const label = process.argv[2] ?? "after";
const stamp = new Date().toLocaleString("sv-SE").replace(/[: ]/g, "-").slice(0, 16);
const out = join(homedir(), "Desktop", "Plume背景图切换测试");

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw: string) {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}  —— ${saw}`);
}

let app: RunningApp | undefined;

type Sample = { t: number; rows: number; opacity: number | null };
const arm = `(() => {
	const out = [];
	window.__backdrop = out;
	const t0 = performance.now();
	const f = () => {
		const layer = document.querySelector('[data-ly-split-pane] .ly-chat-backdrop');
		out.push({
			t: Math.round(performance.now() - t0),
			rows: document.querySelector('${PANE} [data-ly-transcript-rows]')?.childElementCount ?? 0,
			opacity: layer ? Number(getComputedStyle(layer).opacity) : null,
		});
		if (out.length < 45) requestAnimationFrame(f);
	};
	requestAnimationFrame(f);
})()`;

async function seed(home: string): Promise<void> {
	await seedInteractions(home, 1);
	await mkdir(join(home, "backgrounds"), { recursive: true });
	await copyFile(join(import.meta.dirname, "assets", "image-gen-night.jpg"), join(home, "backgrounds", "chat-1.jpg"));
	const path = join(home, "settings.json");
	const settings = JSON.parse(await readFile(path, "utf8"));
	await writeFile(path, JSON.stringify({ ...settings, appearance: { ...settings.appearance, chatBackground: "chat-1.jpg", chatBackgroundEffect: "none", chatBackgroundOpacity: OPACITY } }));
}

async function main() {
	const renderer = await startDevRenderer();
	app = await startApp({ port: PORT, rendererUrl: renderer.url, seed });
	await mkdir(out, { recursive: true });
	const frames: Frame[] = [];
	const stop = await startRecording(PORT, frames);
	const shoot = async (name: string) => {
		const image = await app!.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		const file = join(out, `${stamp}_${label}_${name}.png`);
		await writeFile(file, Buffer.from(image.data, "base64"));
		console.log(`   📸 ${file}`);
	};
	const sampled = async () => {
		await until(app!, "window.__backdrop.length >= 45");
		return app!.evaluate<Sample[]>("window.__backdrop");
	};
	try {
		await click(app, "button", "新对话");
		await until(app, `Number(getComputedStyle(document.querySelector('[data-ly-split-pane] .ly-chat-backdrop') ?? document.body).opacity) === ${OPACITY}`);
		await pause(1000);
		await shoot("01_新对话铺着图");

		await app.evaluate(arm);
		await openSession(app, "qa-long");
		const leaving = await sampled();
		if (process.env.DUMP) console.log(leaving.map((one) => `${one.t}:${one.rows}:${one.opacity?.toFixed(2)}`).join(" "));
		const shown = leaving.filter((one) => one.rows > 0);
		const lingering = shown.filter((one) => (one.opacity ?? 0) > 0);
		check("正文出来的那一帧起，图已经不在", shown.length > 0 && lingering.length === 0, lingering.length ? `正文底下还有 ${lingering.length} 帧带图，最浓 ${Math.max(...lingering.map((one) => one.opacity ?? 0)).toFixed(2)}` : `${shown[0]?.t}ms 起 opacity ${shown[0]?.opacity}`);
		await pause(1000);
		await shoot("02_切进会话");

		await app.evaluate(arm);
		await click(app, "button", "新对话");
		const back = await sampled();
		const between = back.filter((one) => one.opacity !== null && one.opacity > 0 && one.opacity < OPACITY);
		check("回到新对话时图是淡入的，不是硬切", between.length >= 3, `中间值 ${between.length} 帧：${between.slice(0, 4).map((one) => one.opacity?.toFixed(2)).join(" → ")}`);
		await pause(1000);
		await shoot("03_回到新对话");
	} finally {
		await stop();
		const passed = checks.filter((one) => one.ok).length;
		if (frames.length > 1) {
			const video = join(out, `${stamp}_${label}_新对话背景图切换_${passed}of${checks.length}.mp4`);
			await encode(frames, video, 30, 1500).catch((error: unknown) => console.log(`   视频合成失败：${String(error)}`));
			console.log(`   🎬 ${video}`);
		}
		console.log(`\n${passed}/${checks.length} 通过（${label}）`);
		const home = app?.home;
		await app?.stop();
		await renderer.close();
		if (home) await rm(home, { recursive: true, force: true });
		if (passed !== checks.length) process.exitCode = 1;
	}
}

await main();
