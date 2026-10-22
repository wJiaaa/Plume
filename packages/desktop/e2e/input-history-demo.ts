/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 方向键往回翻自己说过的话——在真窗口里按真键盘，边验边录。
 *
 * 单测已经把规矩逐条验过了（`test/ui/input-history.test.ts`），但那些跑在 happy-dom 里，按的是合成
 * 出来的 `keydown`。这里补的是它证不到的那几段：键要先经过 `@` 的名单和 `/` 的命令单，两个都得在
 * 方向键上让路；`Input.dispatchKeyEvent` 送的是操作系统那一级的按键，textarea 得真的握着焦点才收
 * 得到；而叉的显隐是 CSS 的 `:hover` 加一段过渡，happy-dom 里既没有真指针，也不跑过渡。
 *
 * 历史直接 seed 成一个会话文件，不去跑模型：这一轮要验的是按键这条路，而一轮真实对话会让页面忙上
 * 好几分钟。只有最后那一次发送是真的（借了真实模型配置）——「发出去之后那行小字还在不在」，只有真
 * 走一遍 submit 才算数。
 *
 * 用法：node --experimental-strip-types e2e/input-history-demo.ts [输出目录]
 */

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const REAL_HOME = join(homedir(), ".plume");
const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume输入历史测试");
const PORT = 9427;
const STAMP = new Date()
	.toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" })
	.replace(/[: ]/g, "-")
	.slice(0, 16);

const UP = 38;
const DOWN = 40;
const SESSION_ID = randomUUID();

/** 会话里那三句人说过的话。翻出来的必须一字不差是它们。 */
const WITH_IMAGE = "这个图片里面有什么呢？";
const FIRST = "第一句：这个项目用 pnpm，不要用 npm。";
const SECOND = "第二句：发版走 pnpm release，先排练。";
const SHOT = "截图.png";
/** 一条附了一排图的旧消息，用来逼出换行——叉浮在角上，最怕的就是换行之后压住上一行。 */
const MANY = "这一堆图都看一下";
const MANY_COUNT = 14;
/** 手里那半句：有字的时候 ↑ 归光标，不翻历史；清空之后才往回翻。 */
const DRAFT = "这是我打了一半的草稿";
/** 一张 1×1 的红点 PNG。够小，而且是张真图——加载不了的话缩略图就是个空框。 */
const PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let app: RunningApp;
const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw: string) {
	checks.push({ ok, what, saw });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

async function seed(home: string): Promise<void> {
	await mkdir(home, { recursive: true });
	const cwd = join(home, "project");
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "README.md"), "# 演示工程\n");

	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);

	const at = Date.now() - 600_000;
	const record = (seq: number, role: string, text: string) =>
		({
			seq,
			ts: at + seq * 1000,
			type: "message",
			message: { role, content: [{ type: "text", text }], timestamp: at + seq * 1000 },
		});
	/*
	 * 一条带图的消息，照 `outgoing.ts` 打包出来的形状写：图片前一行标签、然后是 image 块、最后才
	 * 是人打的那句话。`attachments` 是那份元数据清单，`displayText` 是人看到的字。
	 */
	const withImage = (seq: number) =>
		({
			seq,
			ts: at + seq * 1000,
			type: "message",
			message: {
				role: "user",
				content: [
					{ type: "text", text: `\n\n### Attachment 1 of 1: ${SHOT}\n\n` },
					{ type: "image", data: PNG, mimeType: "image/png" },
					{ type: "text", text: WITH_IMAGE },
				],
				displayText: WITH_IMAGE,
				attachments: [{ name: SHOT, kind: "image", mimeType: "image/png" }],
				timestamp: at + seq * 1000,
			},
		});
	/** 同一条消息里附一排图：够多才会换行，而换行正是叉浮到外面时唯一会出事的地方。 */
	const manyImages = (seq: number) =>
		({
			seq,
			ts: at + seq * 1000,
			type: "message",
			message: {
				role: "user",
				content: [
					...Array.from({ length: MANY_COUNT }, (_, i) => [
						{ type: "text", text: `\n\n### Attachment ${i + 1} of ${MANY_COUNT}: 图${i + 1}.png\n\n` },
						{ type: "image", data: PNG, mimeType: "image/png" },
					]).flat(),
					{ type: "text", text: MANY },
				],
				displayText: MANY,
				attachments: Array.from({ length: MANY_COUNT }, (_, i) => ({
					name: `图${i + 1}.png`,
					kind: "image",
					mimeType: "image/png",
				})),
				timestamp: at + seq * 1000,
			},
		});

	const meta = {
		id: SESSION_ID,
		title: "输入历史演示",
		cwd,
		projectId,
		projectName: "演示工程",
		createdAt: at,
		updatedAt: at,
		modelId: "relay/gemini-3.7-flash-high",
		messageCount: 8,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
		seq: 0,
	};
	const records = [
		{ seq: 1, ts: at, type: "meta", meta },
		manyImages(2),
		record(3, "assistant", "都看过了。"),
		withImage(4),
		record(5, "assistant", "图里是一个一像素的红点。"),
		record(6, "user", FIRST),
		record(7, "assistant", "好的，记下了：用 pnpm。"),
		record(8, "user", SECOND),
		record(9, "assistant", "也记下了：发版前先排练。"),
	];
	seedSessions(home, [{ meta, records }]);

	/*
	 * 借真实的模型配置，只为了让最后那一次「发送」是真的发出去。
	 *
	 * 不借的话 submit 照样会清空输入框、验证照样成立——但窗口上会挂一条「未配置模型」的红提示，录
	 * 进视频里比功能本身更抢眼。
	 */
	for (const file of ["credentials.json", "vault.key"]) {
		await copyFile(join(REAL_HOME, file), join(home, file)).catch(() => {
			throw new Error(`没找到 ~/.plume/${file}——最后那次真实发送需要它`);
		});
	}
	const real = JSON.parse(await readFile(join(REAL_HOME, "settings.json"), "utf8"));
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			...real,
			permissionMode: "full",
			projects: [{ id: projectId, path: cwd, name: "演示工程", pinned: true, lastOpenedAt: Date.now() }],
			pinnedSessionIds: [],
		}),
	);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 860 }));
}

function fieldValue(): Promise<string> {
	return app.evaluate<string>(
		'(() => { const el = document.querySelector("main textarea"); return el ? el.value : ""; })()',
	);
}

/** 输入框里那行小字。没在翻历史时它根本不该存在。 */
function indicator(): Promise<string> {
	return app.evaluate<string>(
		'(() => { const el = document.querySelector("[data-ly-history]"); return el && el.textContent ? el.textContent.trim() : ""; })()',
	);
}

/**
 * 输入框里此刻挂着几张图、都叫什么名字。
 *
 * 从 textarea 往上 `closest(".ly-composer")` 再往下找，**不能**直接
 * `querySelector("[data-ly-attachments]")`：同一个组件在气泡外面也画一排，转录排在输入框前面，
 * 于是那句话会拿到转录里的附件条。上一版就是这么写的，结果「图跟着回来了」这一条是假绿——它看
 * 的一直是转录里那张图，输入框里有没有根本没验到。
 */
function stripState(): Promise<{ images: number; names: string }> {
	return app.evaluate(
		'(() => {' +
			' const shell = document.querySelector("main textarea")?.closest(".ly-composer");' +
			' const strip = shell ? shell.querySelector("[data-ly-attachments]") : null;' +
			' if (!strip) return { images: 0, names: "" };' +
			// 收起时那一排还在 DOM 里（留着给收起的动画用），看不见的不算。
			' if (strip.closest(".ly-reveal")?.getAttribute("data-open") === "false") return { images: 0, names: "" };' +
			' const images = strip.querySelectorAll("img").length;' +
			' const names = [...strip.querySelectorAll("[data-ly-tip]")].map((el) => el.getAttribute("data-ly-tip") || "").join("|");' +
			' return { images, names };' +
			'})()',
	);
}

/**
 * 一排缩略图和它们的叉，各自的几何。
 *
 * 叉 `opacity: 0` 的时候盒子还在，量得到——这正好，「藏着」和「摆在哪」是两件事，分开验。
 */
function stripGeometry(): Promise<{
	thumbs: { top: number; right: number; bottom: number }[];
	crosses: { top: number; right: number }[];
}> {
	return app.evaluate(
		'(() => {' +
			' const shell = document.querySelector("main textarea")?.closest(".ly-composer");' +
			' const strip = shell ? shell.querySelector("[data-ly-attachments]") : null;' +
			' if (!strip) return { thumbs: [], crosses: [] };' +
			' const box = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) }; };' +
			' return {' +
			'  thumbs: [...strip.querySelectorAll("img")].map(box),' +
			'  crosses: [...strip.querySelectorAll("[data-ly-hover-reveal]")].map(box),' +
			' };' +
			'})()',
	);
}

/** 那个叉此刻的不透明度。0 = 藏着，1 = 露出来了。 */
function crossOpacity(): Promise<string> {
	return app.evaluate<string>(
		'(() => {' +
			' const shell = document.querySelector("main textarea")?.closest(".ly-composer");' +
			' const el = shell ? shell.querySelector("[data-ly-hover-reveal]") : null;' +
			' return el ? getComputedStyle(el).opacity : "(没有这个元素)";' +
			'})()',
	);
}

/** 把光标放到第 n 个字符处，顺手确保输入框握着焦点——真实按键只送给聚焦的那个元素。 */
function putCaret(at: number): Promise<void> {
	return app.evaluate(
		`(() => { const el = document.querySelector("main textarea"); el.focus(); el.setSelectionRange(${at}, ${at}); })()`,
	);
}

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	const frames: Frame[] = [];
	app = await startApp({ port: PORT, seed, scaleFactor: 2 });
	const d = driver(app);
	const stop = await startRecording(PORT, frames);

	try {
		console.log("【一】打开那个说过四句话的会话，其中两句附了图");
		await d.until('document.querySelector("main textarea")', 30000);
		await pause(1200);
		// 真鼠标：会话行用 evaluate 里的 .click() 是打不开的。
		await d.click(`[data-ly-row="${SESSION_ID}"]`);
		await d.until(`document.body.innerText.includes(${JSON.stringify("不要用 npm")})`, 20000);
		await pause(1500);
		check("会话开着，那几句都在转录里", true, "");

		console.log("\n【二】手里有字时 ↑ 不翻历史，清空之后才往回翻");
		await d.type(DRAFT);
		await pause(1200);
		await putCaret(DRAFT.length);
		await pause(400);
		await d.key("ArrowUp", UP);
		await pause(900);
		check("有字时 ↑ 归光标，框里还是那半句", (await fieldValue()) === DRAFT, await fieldValue());
		// 单行里 ↑ 把光标挪到了行首，删之前放回行尾。
		await putCaret(DRAFT.length);
		for (let i = 0; i < DRAFT.length; i++) await d.key("Backspace", 8);
		await pause(600);
		check("清空了", (await fieldValue()) === "", await fieldValue());

		await d.key("ArrowUp", UP);
		await pause(1100);
		const up1 = await fieldValue();
		const mark1 = await indicator();
		check("↑ 翻出的是最近说的那句", up1 === SECOND, up1 || "（空的）");
		check("框里标着 1/4", /1\s*\/\s*4/.test(mark1), mark1 || "（没有指示器）");
		const inside = await app.evaluate<boolean>(
			'(() => { const el = document.querySelector("main [data-ly-history]"); return Boolean(el && el.closest(".ly-composer")); })()',
		);
		check("那行小字长在输入框里面", inside, inside ? "" : "（跑到框外面去了）");

		await d.key("ArrowUp", UP);
		await pause(1100);
		check("再按 ↑ 翻到更早那句", (await fieldValue()) === FIRST, await fieldValue());

		console.log("\n【三】再翻一条——那一条当初附了图，图得跟着回来");
		await d.key("ArrowUp", UP);
		await pause(1400);
		const withImg = await fieldValue();
		const strip = await stripState();
		check("翻出的是带图的那句", withImg === WITH_IMAGE, withImg || "（空的）");
		check("那张图跟着回到输入框里了", strip.images === 1, `缩略图 ${strip.images} 张`);
		check("认得出是哪个文件", strip.names.includes(SHOT), strip.names || "（没有文件名）");
		await pause(1200);

		console.log("\n【四】叉要等鼠标挪上去才现身");
		const resting = await crossOpacity();
		check("没碰它的时候，叉是藏着的", resting === "0", resting);
		await d.hover(".ly-composer [data-ly-attachments] img");
		await pause(900);
		const hovered = await crossOpacity();
		check("鼠标挪上去，叉就出来了", hovered === "1", hovered);
		await pause(1200);
		// 挪开再看一眼：这一步同时说明「现身」不是一次性的。
		await d.hover("main textarea");
		await pause(900);
		const left = await crossOpacity();
		check("鼠标挪开又藏回去", left === "0", left);
		await pause(800);

		console.log("\n【五】再翻一条——一排图，看叉是不是浮在角上，以及放不下时是不是横着滚");
		await d.key("ArrowUp", UP);
		await pause(1600);
		const manyText = await fieldValue();
		const manyStrip = await stripState();
		check("翻出的是那条一排图", manyText === MANY, manyText || "（空的）");
		check(`${MANY_COUNT} 张图都回来了`, manyStrip.images === MANY_COUNT, `只有 ${manyStrip.images} 张`);

		const geo = await stripGeometry();
		/*
		 * 叉在**角上**：比格子更靠上、也更靠右。
		 *
		 * 量的是盒子不是眼睛看到的：叉此刻 `opacity: 0`，但位置早就定下了。
		 */
		const cornered =
			geo.thumbs.length > 0 &&
			geo.thumbs.every((thumb, at) => {
				const cross = geo.crosses[at];
				return Boolean(cross) && cross.top < thumb.top && cross.right > thumb.right;
			});
		check(
			"每个叉都探到格子的右上角外面",
			cornered,
			JSON.stringify({ 第一个格子: geo.thumbs[0], 它的叉: geo.crosses[0] }),
		);

		// 放不下的图不换行，留在同一排里横着滚（见 attachments.css 的 `.ly-attachments-row`）。
		const rows = new Set(geo.thumbs.map((thumb) => thumb.top)).size;
		check("十几张图还是一排，不换行", rows === 1, `排成了 ${rows} 行`);
		const scroll = await app.evaluate<{ width: number; client: number }>(
			'(() => { const row = document.querySelector("main .ly-composer .ly-attachments-row"); return { width: row?.scrollWidth ?? 0, client: row?.clientWidth ?? 0 }; })()',
		);
		check("放不下的那一截能横着滚过去", scroll.width > scroll.client, `内容宽 ${scroll.width}，可见宽 ${scroll.client}`);
		await pause(1500);

		console.log("\n【六】一路翻回来，回到空着的输入框");
		for (const wait of [900, 900, 900, 1400]) {
			await d.key("ArrowDown", DOWN);
			await pause(wait);
		}
		const back = await fieldValue();
		const backStrip = await stripState();
		check("回到空着的输入框", back === "", back);
		check("翻出来的图也跟着退干净", backStrip.images === 0, `还剩 ${backStrip.images} 张`);
		check("回到草稿就不再标第几条", (await indicator()) === "", (await indicator()) || "（已消失）");

		console.log("\n【七】多行文本里，方向键该归光标管");
		await pause(600);
		await d.type("上面一行\n下面一行");
		await pause(900);
		// 光标搁在第二行开头：它上面还有一行，↑ 的本分是把光标挪上去，不是翻历史。
		await putCaret(5);
		await pause(400);
		await d.key("ArrowUp", UP);
		await pause(1000);
		const multi = await fieldValue();
		check("多行里没被历史抢走 ↑", multi === "上面一行\n下面一行", multi.replace(/\n/g, "⏎"));

		// 挪到最前面也一样：框里有字，↑ 就一律归光标（见 useInputHistory 的草稿态）。
		await putCaret(0);
		await pause(400);
		await d.key("ArrowUp", UP);
		await pause(1000);
		check("贴到最前面也不翻：有字时历史不接手", (await fieldValue()) === multi, (await fieldValue()).replace(/\n/g, "⏎"));

		// 清空之后，这才轮到历史。
		await putCaret(multi.length);
		for (let i = 0; i < multi.length; i++) await d.key("Backspace", 8);
		await pause(400);
		await d.key("ArrowUp", UP);
		await pause(1200);
		check("清空之后 ↑ 才翻历史", (await fieldValue()) === SECOND, await fieldValue());
		await pause(1200);

		console.log("\n【八】发出去之后，那行小字不该还留着");
		check("发送前确实标着", (await indicator()) !== "", "（发送前就没有，这一条白验了）");
		await d.submit();
		await pause(2000);
		const afterSend = await indicator();
		check("发完之后那行小字没了", afterSend === "", afterSend);
		check("输入框也空了", (await fieldValue()) === "", await fieldValue());
		await pause(1800);
	} finally {
		await stop();
		console.log(`\n采到 ${frames.length} 帧，正在合成 60fps…`);
	}

	if (frames.length === 0) throw new Error("一帧都没采到");
	const passed = checks.filter((c) => c.ok).length;
	const out = join(OUT_DIR, `${STAMP}_方向键翻输入历史_${passed}of${checks.length}.mp4`);
	await app.stop();
	await encode(frames, out, 60, 1200);

	console.log(`\n${passed}/${checks.length} 项通过`);
	console.log(`视频：${out}`);
	if (passed !== checks.length) process.exitCode = 1;
}

main().catch(async (error) => {
	console.error(error);
	await app?.stop().catch(() => {});
	process.exitCode = 1;
});
