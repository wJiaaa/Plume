/**
 * 复制一段带文件签的文字时，文件名两边不多出换行。
 *
 * 文件签是 `inline-flex`，链接、文件名、行号、浮条都是它的 flex 项目。浏览器生成纯文本时把每个 flex
 * 项目当成块、前后各补一个换行：「由 `webviewPreload.cjs` 注入」复制出来是「由 \nwebviewPreload.cjs\n 注入」，
 * 带行号的还要多出三个空行。版式离不开 flex（名字过长时省略、行号不被裁掉），所以只在复制的那一下把
 * 选区里的签摊成行内，序列化照旧交给浏览器——纯文本和富文本都还是它自己生成的。
 */

const COPYING = "data-ly-copying";

export function installChipCopy(): void {
	document.addEventListener("copy", () => {
		const selection = document.getSelection();
		if (!selection || selection.isCollapsed) return;
		const chips = [...document.querySelectorAll("[data-ly-file-link]")].filter((chip) => selection.containsNode(chip, true));
		if (!chips.length) return;
		// 挂在签上而不是根上：根上的属性要对整棵树重算样式，长会话里一下几十毫秒，见 `ui/motion/freeze.ts`。
		for (const chip of chips) chip.setAttribute(COPYING, "");
		// 浏览器在监听返回之后才序列化选区；rAF 在下一次绘制之前跑，摊开的样子不会被画出来。
		requestAnimationFrame(() => {
			for (const chip of chips) chip.removeAttribute(COPYING);
		});
	});
}
