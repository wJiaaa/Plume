/**
 * 会话背景的几种重绘：尺寸不变、透明度不丢、深浅主题各有各的纸色。
 *
 * 这些都是用肉眼在窗口里不容易看出来的错——差一行、透明通道被抹成 0，背景就是一整块消失或一道
 * 白边，而那时候它在 opacity 24% 底下，第一眼只会以为「图挑得太暗」。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKDROP_EFFECTS, lumaOf, redraw, redrawn, themed, type BackdropSource } from "../src/lib/chat-backdrop.ts";

/** 一张奇数边长的图：每种效果都按 2、4、6×8 分格，奇数边正好落在格子半中间。 */
function source(width: number, height: number, rgba: [number, number, number, number]): BackdropSource {
	const pixels = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < pixels.length; i += 4) pixels.set(rgba, i);
	return { width, height, pixels, luma: lumaOf(pixels) };
}

const PIXEL_EFFECTS = ["dither", "ascii", "halftone", "scanlines"] as const;

test("每种重绘都交回同样大小的一张图，透明通道原样保留", () => {
	const image = source(13, 11, [200, 120, 40, 180]);
	for (const effect of PIXEL_EFFECTS) {
		for (const light of [false, true]) {
			const out = redraw(image, effect, light);
			assert.equal(out.length, image.pixels.length, `${effect} 改了尺寸`);
			for (let a = 3; a < out.length; a += 4) assert.equal(out[a], 180, `${effect} 在 ${a} 处丢了透明度`);
		}
	}
});

test("扫描线每三行一行，深色压暗、浅色提亮，其余行不动", () => {
	const image = source(4, 6, [100, 100, 100, 255]);
	const dark = redraw(image, "scanlines", false);
	const light = redraw(image, "scanlines", true);
	const row = (data: Uint8ClampedArray, y: number) => data[y * 4 * 4];
	assert.equal(row(dark, 0), 52);
	assert.equal(row(dark, 1), 100);
	assert.equal(row(dark, 3), 52);
	assert.ok(row(light, 0) > 100, "浅色主题的扫描线应该是一道亮线");
	assert.equal(row(light, 2), 100);
});

test("纯黑的图在字符效果下，深色主题的纸是黑的、浅色主题的是亮的", () => {
	const image = source(12, 16, [0, 0, 0, 255]);
	// 深色下黑图没有墨，整张保持全黑；浅色下墨量反过来，纸色占四成，画面整体变亮。
	assert.ok(redraw(image, "ascii", false).every((value, i) => i % 4 === 3 || value === 0));
	const light = redraw(image, "ascii", true);
	assert.ok(light.some((value, i) => i % 4 !== 3 && value > 0));
});

test("抖动只用两档：提亮到饱和，或者压到近黑", () => {
	const out = redraw(source(8, 8, [200, 100, 50, 255]), "dither", false);
	for (let p = 0; p < out.length; p += 4) {
		const peak = Math.max(out[p], out[p + 1], out[p + 2]);
		assert.ok(peak === 255 || peak <= Math.round(200 * 0.08), `像素 ${p / 4} 落在两档之间：${peak}`);
	}
});

test("缓存按主题区分的，只有纸色跟着主题变的那几种", () => {
	assert.deepEqual(
		BACKDROP_EFFECTS.filter(redrawn),
		["dither", "ascii", "halftone", "scanlines"],
		"原图和雾化不经过逐像素重绘",
	);
	assert.deepEqual(BACKDROP_EFFECTS.filter(themed), ["ascii", "halftone", "scanlines"]);
});
