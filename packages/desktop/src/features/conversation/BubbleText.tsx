/**
 * 一条自己发出去的消息，气泡里那部分正文。
 *
 * 主会话和侧边聊天共用，因为它们画的本来就是同一件东西——而在这个文件出现之前，它们各画各的：
 * 主会话把附件切成行内胶囊、正文当纯文本；侧边聊天把所有文本块拼起来直接摊开，于是
 * `### Attached file: image.png` 这种写给模型的记号原样出现在人眼前。同一条消息两个样子。
 *
 * **两种画法，按有没有附件标记分。** 这是个取舍，写下来免得下一个人以为是漏的：
 *
 * - **没有标记**：整段交给 markdown。一条以 `# 需求1` 开头的消息，人写的时候就是当标题写的，
 *   画成一行井号是把他的意思丢了。绝大多数长消息走这一支。
 * - **有标记**：保持行内纯文本。markdown 是块级的——`看这张 【图片 1】 再看那张` 交给它，
 *   会切成「段落、胶囊、段落」三块竖着排，一句话被拆成三行。胶囊本身就是这句话的一部分，
 *   把它挤到单独一行，比不支持 markdown 更糟。带附件的消息几乎都是短句，这一支够用。
 *
 * 标记画成什么由调用方给：点了之后做什么，两边并不一样。
 *
 * **太长的折起来。** 一段两万字的 JSON 贴进来，气泡能把整屏占满好几遍，回复被顶到很远的地方。
 * 超过 `FOLD_AT` 行就只露出 `FOLD_TO` 行、底下化开，留一颗按钮展开。两个数不一样，是为了不出现
 * 「折起来只藏了一两行」：那一下点开什么也没多看到。
 */

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { translate } from "../../i18n/translate.ts";
import { placeAttachments } from "../../lib/attachment-placeholders.ts";
import { Markdown } from "../markdown/index.ts";
import { Button } from "../../ui/primitives/Button.tsx";

/** 超过这么多行才折。 */
const FOLD_AT = 14;
/** 折起来露出这么多行。 */
const FOLD_TO = 10;

export function BubbleText<File extends { name: string; label?: string }>({
	text,
	files,
	renderFile,
	className = "",
}: {
	/** 人打的那些字，`【图片 1】` 这样的标记留在里面。 */
	text: string;
	/** 这条消息带的附件，用来认出文中的标记。 */
	files: File[];
	/** 一枚标记画成什么。点它之后做什么两边并不一样，所以也由调用方给。 */
	renderFile: (file: File, at: number) => React.ReactNode;
	className?: string;
}) {
	const segments = useMemo(() => placeAttachments(text, files).segments, [text, files]);
	const hasFiles = segments.some((segment) => segment.kind === "file");
	const box = useRef<HTMLDivElement>(null);
	const body = useRef<HTMLDivElement>(null);
	const [foldable, setFoldable] = useState(false);
	const [open, setOpen] = useState(false);

	/*
	 * 量里面那层的自然高度，不量外面那层：外面那层折起来以后就被 `max-height` 压住了，量它永远
	 * 「不超」，折一次就再也认不出自己该折。layout effect 里量，第一帧画出来就已经是折好的样子。
	 * 宽度一变行数就变，所以盯着它。
	 */
	useLayoutEffect(() => {
		const inner = body.current;
		const outer = box.current;
		if (!inner || !outer) return;
		const measure = () => {
			const line = Number.parseFloat(getComputedStyle(outer).lineHeight);
			setFoldable(Number.isFinite(line) && line > 0 && inner.offsetHeight > line * FOLD_AT);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(inner);
		return () => observer.disconnect();
	}, [text]);

	const folded = foldable && !open;

	return (
		<div className={className}>
			<div ref={box} className="ly-bubble-fold" data-folded={folded ? "" : undefined} style={folded ? { maxHeight: `${FOLD_TO}lh` } : undefined}>
				<div ref={body}>
					{hasFiles ? (
						<p className="whitespace-pre-wrap break-words">
							{segments.map((segment, at) => (segment.kind === "text" ? segment.text : renderFile(segment.file, at)))}
						</p>
					) : (
						<Markdown text={text} />
					)}
				</div>
			</div>
			{foldable && (
				<Button
					variant="subtle"
					size="xs"
					expanded={open}
					data-ly-bubble-fold-toggle=""
					className="mt-1.5 -ml-1.5 font-medium"
					onClick={() => {
						setOpen(!open);
						// 展开后往下读到了底再收起，气泡一下子矮回十行，人就落在它下面很远的地方。把它拉回视野里。
						if (open) requestAnimationFrame(() => box.current?.scrollIntoView({ block: "nearest" }));
					}}
				>
					{open ? translate("userMessage.showLess") : translate("userMessage.showMore")}
				</Button>
			)}
		</div>
	);
}
