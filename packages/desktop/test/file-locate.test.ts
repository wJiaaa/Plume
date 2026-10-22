/**
 * 回复里写的相对路径在项目里找：`approvals.ts`、相对子包的 `scripts/x.mjs` 都要落到真正那一个文件上。
 *
 * 用真仓库：匹配交给 `git ls-files`，被忽略的目录不该混进来，这件事只有 git 自己说得准。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { after, before, test } from "node:test";
import { locateInProject } from "../electron/files/file-locate.ts";

/*
 * 同一个模块再载一份，git 换成「全量清单超出输出上限」：几十万个文件的仓库，在测试里造不出 32MB 的清单。
 * 只有不带 pathspec 的全量列举会溢出，按名字问的照常交给真 git。
 */
const overflowing = new URL("../electron/files/file-locate.ts?overflow", import.meta.url).href;
const fakeGit = `data:text/javascript,${encodeURIComponent(`
import { git as real } from ${JSON.stringify(new URL("../electron/git/git-exec.ts", import.meta.url).href)};
export const overflows = { count: 0 };
export const git = async (cwd, args, options) => {
	if (args.at(-1) === "--exclude-standard") {
		overflows.count++;
		throw Object.assign(new Error("stdout maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
	}
	return real(cwd, args, options);
};
`)}`;
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		if (context.parentURL === overflowing && specifier === "../git/index.ts") return { url: fakeGit, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
const { locateInProject: locateOverflowing } = (await import(overflowing)) as typeof import("../electron/files/file-locate.ts");
const { overflows } = (await import(fakeGit)) as { overflows: { count: number } };
hooks.deregister();

let repo: string;

before(() => {
	repo = mkdtempSync(join(tmpdir(), "plume-locate-"));
	const file = (path: string, text = "") => {
		mkdirSync(join(repo, path, ".."), { recursive: true });
		writeFileSync(join(repo, path), text);
	};
	file("README.md");
	file("packages/core/src/runtime/approvals.ts");
	file("packages/desktop/scripts/check-native-arch.mjs");
	file("packages/core/src/agent/tool-run.ts");
	file("packages/desktop/src/store/tool-run.ts");
	file("node_modules/pkg/approvals.ts");
	file("generated/approvals.ts");
	file(".gitignore", "node_modules/\ngenerated/\n");
	execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "pipe" });
});

after(() => rmSync(repo, { recursive: true, force: true }));

test("工作目录下就有的，原样返回，不去搜", async () => {
	assert.deepEqual(await locateInProject(repo, "README.md"), ["README.md"]);
});

test("只写文件名的，找到项目里那一个；被 .gitignore 忽略的同名文件不算", async () => {
	assert.deepEqual(await locateInProject(repo, "approvals.ts"), ["packages/core/src/runtime/approvals.ts"]);
});

test("相对子包写的路径，按结尾找到它", async () => {
	assert.deepEqual(await locateInProject(repo, "scripts/check-native-arch.mjs"), ["packages/desktop/scripts/check-native-arch.mjs"]);
});

test("同名的有两个，两个都列出来，由调用方决定不猜", async () => {
	assert.equal((await locateInProject(repo, "tool-run.ts")).length, 2);
});

test("仓库大到全量清单溢出时，按名字去问 git，不退回不认 .gitignore 的走目录", async () => {
	// `generated/` 不在 `SKIP_DIRS` 里：退回走目录的话，被忽略的那一个会混进来。
	assert.deepEqual(await locateOverflowing(repo, "approvals.ts"), ["packages/core/src/runtime/approvals.ts"]);
	assert.equal((await locateOverflowing(repo, "tool-run.ts")).length, 2);
	assert.deepEqual(await locateOverflowing(repo, "nowhere.ts"), []);
	assert.ok(overflows.count > 0, "the listing really overflowed");
});

test("走出项目的、带通配符的、不存在的，都是空", async () => {
	assert.deepEqual(await locateInProject(repo, "../etc/passwd"), []);
	assert.deepEqual(await locateInProject(repo, "*.ts"), []);
	assert.deepEqual(await locateInProject(repo, "nowhere.ts"), []);
});

/*
 * 不是 git 仓库的项目：834c1105 的「水墨塔防」。回复里写 `ink_splat_06.png`，以前拼到项目根上读不到；
 * 现在自己走目录，跳过的目录和 core 的 `glob` 兜底是同一张名单。
 */
test("不是 git 仓库的项目，只写文件名也找得到；依赖和隐藏目录里的同名文件不算", async () => {
	const plain = mkdtempSync(join(tmpdir(), "plume-locate-plain-"));
	try {
		const file = (path: string) => {
			mkdirSync(join(plain, path, ".."), { recursive: true });
			writeFileSync(join(plain, path), "");
		};
		file("素材原图/ink_splat_06.png");
		file("ink-defense/Assets/Art/ink_splat_06.png");
		file("ink-defense/Assets/Art/ink_splat_06.png.meta");
		file("node_modules/pkg/ink_splat_06.png");
		file(".cache/ink_splat_06.png");
		file("tools/approvals.ts");

		assert.deepEqual(await locateInProject(plain, "ink_splat_06.png"), [
			"ink-defense/Assets/Art/ink_splat_06.png",
			"素材原图/ink_splat_06.png",
		]);
		assert.deepEqual(await locateInProject(plain, "Art/ink_splat_06.png"), ["ink-defense/Assets/Art/ink_splat_06.png"]);
		// 按整段路径对结尾，`approvals.ts` 不会认成 `xapprovals.ts`，反过来也一样。
		assert.deepEqual(await locateInProject(plain, "provals.ts"), []);
		assert.deepEqual(await locateInProject(plain, "nowhere.png"), []);
	} finally {
		rmSync(plain, { recursive: true, force: true });
	}
});
