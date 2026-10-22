/** 一个链接指着的那几行，从 1 数起，`from <= to`。 */
export interface LineRange {
	from: number;
	to: number;
}

const LINE_SUFFIX = /:(\d+)(?:-(\d+))?$|#L(\d+)(?:-L?(\d+))?$/;
/** 文内锚点（`README.md#usage`）。只认最后一段里的 `#`，`src/C#/a.cs` 的目录名不是锚点。 */
const ANCHOR = /#[^/\\#]*$/;

/**
 * `src/a.ts:42`、`src/a.ts:42-50`、GitHub 写法的 `src/a.ts#L42-L50` 拆成路径和行号，其余锚点去掉。
 *
 * `:0` 不算行号，但照样从路径上去掉：留着它，`a.ts:0` 会被当成一个叫这个名字的文件去找。锚点同理：
 * 从前 `a.go#L224` 原样拿去项目里找，永远找不到，每次打开会话都为它再起一遍 git。
 */
export function splitLineSuffix(text: string): { path: string; lines: LineRange | null } {
	const match = LINE_SUFFIX.exec(text);
	if (!match) return { path: text.replace(ANCHOR, ""), lines: null };
	const path = text.slice(0, match.index);
	const from = Number(match[1] ?? match[3]);
	const to = Number(match[2] ?? match[4] ?? from);
	if (from < 1) return { path, lines: null };
	return { path, lines: { from: Math.min(from, to), to: Math.max(from, to) } };
}

function lineLabel(lines: LineRange): string {
	return lines.from === lines.to ? `${lines.from}` : `${lines.from}-${lines.to}`;
}

/**
 * What a local file link should show in the transcript.
 *
 * Models write [`docs/issue/very-long-name.md`](docs/issue/very-long-name.md). Painting that whole
 * path inside a chip forces a wrap through the middle of a word. The chip keeps the filename;
 * overflow is an ellipsis, never a second line. The path belongs on the tooltip.
 *
 * 行号先看链接地址，再看文字：`[a.ts:42](src/a.ts)` 这种写法里行号只在文字上。文字里的只在它写的就是
 * 路径时才算，「端口 8080:3000」不是第 3000 行。`line` 是胶囊上要画的那段，同样只在胶囊写的是文件名
 * 时给——「入口逻辑:42」读起来不像话，那时行号只进提示。
 */
export function fileLinkCaption(
	label: string,
	path: string,
	given: LineRange | null = null,
): { text: string; tip: string; lines: LineRange | null; line: string | null } {
	const own = splitLineSuffix(label.trim());
	const trimmed = own.path;
	const base = path.split(/[/\\]/).pop()?.trim() || path;
	const pathLike = !trimmed || /[/\\]/.test(trimmed) || trimmed === base;
	const lines = given ?? (pathLike ? own.lines : null);
	const line = lines && pathLike ? lineLabel(lines) : null;
	const suffix = lines ? `:${lineLabel(lines)}` : "";
	if (!trimmed) return { text: base, tip: path + suffix, lines, line };
	if (!pathLike) return { text: trimmed, tip: path + suffix, lines, line };
	return { text: trimmed.split(/[/\\]/).pop() || base, tip: trimmed + suffix, lines, line };
}

/**
 * 裸文件名只认这些扩展名。带目录的路径不查这张表。
 *
 * `console.log`、`process.env`、`obj.method` 在形状上和 `index.ts` 一样，全靠扩展名分辨；
 * 表里只放一眼就是文件的那些，漏掉的冷门类型写成带目录的路径照样能点。
 */
const BARE_FILE_EXTENSIONS = new Set(
	"ts tsx mts cts js jsx mjs cjs json jsonc md mdx yaml yml toml ini xml csv sql html htm css scss sass less vue svelte py rs go java kt rb php swift c h cpp hpp cs sh bash zsh ps1 bat lock txt png jpg jpeg gif svg webp pdf".split(" "),
);

/**
 * 行内代码里写的是不是一个文件路径；是的话返回它（保留 `:42` 行号后缀）。
 *
 * 提示词让模型把路径写成 `path/to/file.ts:42` 以便点击，所以这类行内代码要画成文件链接。
 * 判断宁紧勿松：带空格、括号、引号、协议的都不是；目录（以分隔符结尾）不是；最后一段必须有
 * 以字母开头的扩展名，这样 `feature/v1.2`、`origin/main`、`node:test` 都留作代码。
 */
export function filePathInCode(text: string): string | null {
	const raw = text.trim();
	if (!raw || raw.length > 300 || /[\s()[\]{}<>"'`,;=*?|$&!]/.test(raw) || raw.includes("://")) return null;
	const { path } = splitLineSuffix(raw);
	if (/[/\\]$/.test(path)) return null;
	const base = path.split(/[/\\]/).pop() ?? "";
	const ext = /^[\w@+-][\w.@+-]*\.([A-Za-z][A-Za-z0-9]{0,9})$/.exec(base)?.[1];
	if (!ext) return null;
	const pathLike = /[/\\]/.test(path);
	if (!pathLike && !BARE_FILE_EXTENSIONS.has(ext.toLowerCase())) return null;
	return raw;
}
