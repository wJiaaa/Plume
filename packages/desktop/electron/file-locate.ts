/**
 * 回复里写的一条相对路径，在项目里实际指的是哪个文件。
 *
 * 模型常把文件写成 `approvals.ts:125`、`scripts/check-native-arch.mjs`——前者只有名字，后者相对的是
 * 某个子包而不是工作目录。按工作目录直接拼，点开的是项目根下一个不存在的文件。这里先按原样找，
 * 找不到再在项目的文件里按结尾匹配，由调用方决定只有一个匹配时才认。
 */

import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { SKIP_DIRS } from "@plume/core";
import { git } from "./git-exec.ts";

/** 同名文件再多也只列这么几个：调用方只认唯一的那一个，多出来的数目没有用处。 */
const LIMIT = 8;

/**
 * 不是 git 仓库时最多走这么多个文件。两万个文件的 Unity 工程（`Library` 1.1G 在内）走一遍 35ms；
 * 这道上限防的是把整个家目录当项目打开，那样一走就是好几秒，找到的也多半不是那一个。
 */
const WALK_CAP = 50_000;

/**
 * 返回相对 `root` 的路径，由调用方拼回它自己认的那个项目目录。`root` 是过了边界检查、解析过软链的
 * 真实目录；直接拼它，项目在软链下时（`/var` 与 `/private/var`）文件面板就认不出这是项目里的文件。
 */
export async function locateInProject(root: string, relative: string): Promise<string[]> {
	const clean = relative.replaceAll("\\", "/").replace(/^\.\//, "");
	// 通配符会被 pathspec 当成模式；`..` 会走出项目。两种都不是「回复里提到的一个文件」。
	if (!clean || isAbsolute(clean) || /[*?[\]]/.test(clean) || clean.split("/").includes("..")) return [];

	if ((await stat(join(root, clean)).catch(() => null))?.isFile()) return [clean];

	// 交给 git 列：它认 .gitignore，`node_modules` 和构建产物里的同名文件不会混进来。
	const listed = await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", `:(glob)**/${clean}`]).catch(() => null);
	if (listed !== null) return [...new Set(listed.split("\0").filter(Boolean))].slice(0, LIMIT);

	/*
	 * 不是 git 仓库（git 报错）：自己走目录，规矩和 core 的 `glob` 兜底一样，见 `SKIP_DIRS`。
	 * 只靠 git 时，这种项目里只写文件名的链接一律拼到项目根上，点开就是「读不到」。
	 */
	const files = await projectFiles(root);
	return files.filter((path) => path === clean || path.endsWith(`/${clean}`)).sort().slice(0, LIMIT);
}

/*
 * 同一个项目同时只走一遍。一段长对话里几十个只写了名字的链接是一起挂上来的，各走各的就是几十遍；
 * 走完就丢，不留缓存：文件可能是回复提到之后才写出来的，记住旧清单就再也找不到它。
 */
const walking = new Map<string, Promise<string[]>>();

function projectFiles(root: string): Promise<string[]> {
	let walk = walking.get(root);
	if (!walk) {
		walk = walkFiles(root).finally(() => walking.delete(root));
		walking.set(root, walk);
	}
	return walk;
}

/** `root` 之下的文件，相对 `root`、用 `/` 分隔。不跟软链：一个指回上层的链接会让它绕不出来。 */
async function walkFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	const visit = async (dir: string): Promise<void> => {
		if (files.length >= WALK_CAP) return;
		const entries: Dirent[] = await readdir(dir, { withFileTypes: true }).catch(() => []);
		const below: Promise<void>[] = [];
		for (const entry of entries) {
			const full = join(dir, entry.name);
			// 隐藏目录也跳过：仓库外没有 .gitignore 兜着，`.venv`、`.idea` 里同名的文件不是回复说的那一个。
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) below.push(visit(full));
			} else if (entry.isFile() && files.length < WALK_CAP) {
				files.push(relative(root, full).split(sep).join("/"));
			}
		}
		await Promise.all(below);
	};
	await visit(root);
	return files;
}
