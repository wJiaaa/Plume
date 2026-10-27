/**
 * 划词取字：对话里的引用菜单和计划面板的评论都从这里拿「人看见被选中的那段」。
 */

/**
 * 选区收到人真正看见被选中的字上：起点挪到第一段选中的字，终点挪到最后一段。
 *
 * 划词菜单拿这个范围量挂点。三击选段时浏览器把终点放在下一段开头，下一段若是代码块，`user-select:
 * none` 的标题栏被跳过、整个落进选区，`getBoundingClientRect()` 把它整栏宽的边框盒也并进来——菜单
 * 就对着栏中间，而不是那行字。
 */
export function selectedText(range: Range): Range {
	const root = range.commonAncestorContainer;
	if (root.nodeType === Node.TEXT_NODE) return range.cloneRange();
	const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let first: Text | null = null;
	let last: Text | null = null;
	for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
		if (!range.intersectsNode(node) || !chosen(node, range)) continue;
		first ??= node;
		last = node;
	}
	if (!first || !last) return range.cloneRange();
	const trimmed = range.cloneRange();
	trimmed.setStart(first, first === range.startContainer ? range.startOffset : 0);
	trimmed.setEnd(last, last === range.endContainer ? range.endOffset : last.length);
	return trimmed;
}

/**
 * 选中的字在屏幕上占的外框，只并字的行框。
 *
 * `selectedText` 收得了两端，收不了中间：跨三条列表项划选，中间那条 `<li>` 整个落在范围里，
 * `Range.getBoundingClientRect()` 把它整栏宽的边框盒并进来，菜单就挂到了栏的右半边。
 */
export function selectedBounds(range: Range): DOMRect {
	const root = range.commonAncestorContainer;
	if (root.nodeType === Node.TEXT_NODE) return range.getBoundingClientRect();
	const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const piece = root.ownerDocument!.createRange();
	let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
	for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
		if (!range.intersectsNode(node) || !chosen(node, range)) continue;
		piece.selectNodeContents(node);
		if (node === range.startContainer) piece.setStart(node, range.startOffset);
		if (node === range.endContainer) piece.setEnd(node, range.endOffset);
		for (const rect of piece.getClientRects()) {
			if (!rect.width) continue;
			left = Math.min(left, rect.left);
			top = Math.min(top, rect.top);
			right = Math.max(right, rect.right);
			bottom = Math.max(bottom, rect.bottom);
		}
	}
	return left === Infinity ? range.getBoundingClientRect() : new DOMRect(left, top, right - left, bottom - top);
}

/** 这段字在选区里有没有选中的可见内容：只选到一个换行、或者标题栏那种选不中的字，都不算。 */
function chosen(node: Text, range: Range): boolean {
	const from = node === range.startContainer ? range.startOffset : 0;
	const to = node === range.endContainer ? range.endOffset : node.length;
	if (!node.data.slice(from, to).trim()) return false;
	const parent = node.parentElement;
	return !parent || getComputedStyle(parent).userSelect !== "none";
}
