/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 从新对话点进一个还没进缓存的会话：换屏前不再先画一帧空会话（加载圈、输入框落到底部）。
 *
 * `node --experimental-strip-types e2e/cold-switch-demo.ts <before|after>`
 *
 * 每一帧记下窗格里挂着的是哪个会话、转录里有几行。「挂的已经是它、却一行都没有」就是那一帧。
 *
 * 渲染进程从开发服务器加载源码，不读 `out/renderer`：这次改的全在渲染进程，不必为验它先打一遍包。
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { startDevRenderer } from "./dev-renderer.ts";
import { click, openSession, until } from "./drive.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const PORT = 9483;
const PANE = '[data-dock-pane="conversation"]';
const label = process.argv[2] ?? "after";
const stamp = new Date().toLocaleString("sv-SE").replace(/[: ]/g, "-").slice(0, 16);
const out = join(homedir(), "Desktop", "Plume冷开会话跳动测试");

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw: string) {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}  —— ${saw}`);
}

let app: RunningApp | undefined;

type Sample = { t: number; id: string | null; rows: number };
const arm = `(() => {
	const out = [];
	window.__coldSwitch = out;
	const t0 = performance.now();
	const f = () => {
		const tr = document.querySelector('${PANE} [data-ly-session]');
		out.push({ t: Math.round(performance.now() - t0), id: tr?.getAttribute('data-ly-session') || null, rows: tr?.querySelector('[data-ly-transcript-rows]')?.childElementCount ?? 0 });
		if (out.length < 60) requestAnimationFrame(f);
	};
	requestAnimationFrame(f);
})()`;

async function main() {
	const renderer = await startDevRenderer();
	app = await startApp({ port: PORT, rendererUrl: renderer.url, seed: (home) => seedInteractions(home, 1) });
	await mkdir(out, { recursive: true });
	const frames: Frame[] = [];
	const stop = await startRecording(PORT, frames);
	const shoot = async (name: string) => {
		const image = await app!.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		const file = join(out, `${stamp}_${label}_${name}.png`);
		await writeFile(file, Buffer.from(image.data, "base64"));
		console.log(`   📸 ${file}`);
	};
	const coldOpen = async (id: string, step: string) => {
		await click(app!, "button", "新对话");
		await pause(1000);
		await app!.evaluate(arm);
		await openSession(app!, id);
		await until(app!, "window.__coldSwitch.length >= 60");
		const samples = await app!.evaluate<Sample[]>("window.__coldSwitch");
		const blank = samples.filter((one) => one.id === id && one.rows === 0);
		const first = samples.find((one) => one.id === id);
		check(`${step}：没有一帧是空会话`, blank.length === 0, `空帧 ${blank.length} 个${blank[0] ? `，第一个在 ${blank[0].t}ms` : ""}`);
		check(`${step}：换上来的第一帧就有内容`, Boolean(first && first.rows > 0), first ? `${first.t}ms 换屏，${first.rows} 行` : "没换上来");
		await pause(1000);
		await shoot(step);
	};
	try {
		await click(app, "button", "新对话");
		await pause(1000);
		await shoot("00_新对话");
		await coldOpen("qa-long", "01_冷开长会话");
		await coldOpen("qa-short", "02_冷开短会话");
	} finally {
		await stop();
		const passed = checks.filter((one) => one.ok).length;
		if (frames.length > 1) {
			const video = join(out, `${stamp}_${label}_新对话切到冷会话_${passed}of${checks.length}.mp4`);
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
