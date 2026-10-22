/**
 * 开在自己工作树里的会话，和主检出用同一份项目记忆。
 *
 * 记忆按目录的哈希存放，而工作树会话的 `cwd` 是工作树（ADR-0048）：不映射回去，它读不到项目
 * 记下的东西，`learn` 写下的又落进一个只有它自己看得见、工作树一收回就没人再读的目录。
 *
 * 夹具用真的 `git worktree add` 和 `git submodule add` 造，理由同 `workspace.test.ts`：磁盘形状是
 * git 定的，手写 `.git` 文件测的是对 git 的记忆。
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { findCandidates } from "../src/runtime/memory/memory-extract.ts";
import { projectMemoryDir, readLessons, recordLesson } from "../src/runtime/memory/project-memory.ts";
import type { SessionMeta } from "../src/session/types.ts";

const run = promisify(execFile);

let root: string;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PLUME_HOME: process.env.PLUME_HOME };

before(async () => {
	/*
	 * 取真实路径：macOS 的临时目录在 `/var` 下，那是 `/private/var` 的软链，而 git 写进 `.git` 指针的
	 * 是后者。登记的项目路径本来就是 git 那种写法时两边才对得上——软链下的项目是已知边界，见实现。
	 */
	root = await realpath(await mkdtemp(join(tmpdir(), "plume-mem-wt-")));
	// 两个都设：`os.homedir()` 在 Windows 上读 `USERPROFILE`。
	process.env.HOME = join(root, "home");
	process.env.USERPROFILE = join(root, "home");
	process.env.PLUME_HOME = join(root, "plume");
});

after(async () => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
});

/** 一个有一次提交、带一个子目录的仓库。子目录要提交过，工作树里才有它。 */
async function repo(name: string): Promise<string> {
	const dir = join(root, name);
	await mkdir(join(dir, "packages", "app"), { recursive: true });
	const git = (...args: string[]) => run("git", ["-C", dir, ...args]);
	await git("init", "-q");
	await git("config", "user.email", "t@t.test");
	await git("config", "user.name", "t");
	await git("config", "commit.gpgsign", "false");
	await writeFile(join(dir, "packages", "app", "a.txt"), "a\n");
	await git("add", "-A");
	await git("commit", "-q", "-m", "init");
	return dir;
}

async function worktreeOf(main: string, name: string): Promise<string> {
	const wt = join(root, name);
	await run("git", ["-C", main, "worktree", "add", "-q", "--detach", wt, "HEAD"]);
	return wt;
}

test("工作树和主检出落在同一个记忆目录，子目录也一样", async () => {
	const main = await repo("main");
	const wt = await worktreeOf(main, "wt");

	assert.equal(projectMemoryDir(wt), projectMemoryDir(main));
	assert.equal(projectMemoryDir(join(wt, "packages", "app")), projectMemoryDir(join(main, "packages", "app")));
	// 子目录项目仍是自己那一份：映射接上的是同一个子路径，不是仓库根。
	assert.notEqual(projectMemoryDir(join(wt, "packages", "app")), projectMemoryDir(main));
});

test("工作树里 learn 记下的，主检出读得到", async () => {
	const main = await repo("main-learn");
	const wt = await worktreeOf(main, "wt-learn");

	await recordLesson(wt, { text: "这个仓库的测试要用 node --test" });
	assert.deepEqual((await readLessons(main)).map((lesson) => lesson.text), ["这个仓库的测试要用 node --test"]);
});

test("submodule 不是工作树，记忆仍是它自己的", async () => {
	// submodule 的 `.git` 也是写着 `gitdir:` 的文件，但它是另一个仓库，不能并进外层项目的记忆。
	const parent = await repo("parent");
	const child = await repo("child");
	await run("git", ["-c", "protocol.file.allow=always", "-C", parent, "submodule", "add", "-q", child, "sub"]);

	const sub = join(parent, "sub");
	assert.notEqual(projectMemoryDir(sub), projectMemoryDir(parent));
	assert.notEqual(projectMemoryDir(sub), projectMemoryDir(child));
});

test("后台抽取把工作树会话算进原项目，工作树收回以后也算", async () => {
	const main = await repo("main-pass");
	const wt = await worktreeOf(main, "wt-pass");
	const other = await repo("other-pass");

	const old = Date.now() - 20 * 60 * 60 * 1000;
	const meta = (id: string, fields: Partial<SessionMeta>) => ({ id, updatedAt: old, messageCount: 6, ...fields }) as SessionMeta;
	const sessions = [
		meta("in-main", { cwd: main }),
		meta("in-worktree", { cwd: wt, worktree: { project: main, branch: "plume/session-1" } }),
		// 收回的工作树：目录已经不在，只剩会话上记着的原项目。
		meta("reclaimed", { cwd: join(root, "gone-wt"), worktree: { project: main, branch: "plume/session-2" } }),
		meta("elsewhere", { cwd: other }),
	];
	const storage = { listSessions: async () => sessions, messages: async () => [] };

	const ids = (await findCandidates(storage, main)).map((found) => found.id);
	assert.deepEqual(ids, ["in-main", "in-worktree", "reclaimed"]);
	// 从工作树那一侧发起（窗口开着的正是工作树会话），找到的是同一批。
	assert.deepEqual((await findCandidates(storage, wt)).map((found) => found.id), ids);
});
