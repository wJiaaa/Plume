/**
 * KaTeX 不在启动时加载：第一条公式先显示它的源码，KaTeX 到了再排成公式。
 *
 * 从前 `math.ts` 静态引 katex，每次启动都要解析执行约 1MB，而大多数回复里一个公式也没有。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import { Markdown } from "../../src/features/markdown/Markdown.tsx";
import { mathReady, onMathReady, renderMath } from "../../src/lib/markdown/math.ts";
import { mount } from "../helpers/mount.ts";

/*
 * 挂上去那一刻 KaTeX 还没到，只能画源码；它到了之后要靠订阅重画，没有那一下公式会一直停在源码上。
 * Node 里动态 import 落地得快，中间那一帧在 act 里就过去了，所以「先是源码」由 renderMath 的返回值
 * 来断言，界面上断言的是最后排出来了。
 */
test("KaTeX 还没到时公式交回 undefined（显示源码），到了以后重画成公式", async () => {
	assert.equal(mathReady(), false, "这个文件里 KaTeX 应该还没加载过");
	assert.equal(renderMath("y^2", false), undefined);
	const view = await mount(h(Markdown, { text: "面积是 $x^2$。\n\n$$\n\\frac{a}{b}\n$$" }));
	try {
		if (!mathReady()) await act(() => new Promise<void>((resolve) => { const stop = onMathReady(() => { stop(); resolve(); }); }));
		assert.ok(view.find(".ly-math .katex"), "行内公式没有排出来");
		assert.ok(view.find(".ly-math-block .katex"), "独立公式没有排出来");
		assert.doesNotMatch(view.text(), /\$x\^2\$/);
		assert.equal(renderMath("\\frac{", false), null, "解析不了的照旧是 null");
	} finally { await view.unmount(); }
});
