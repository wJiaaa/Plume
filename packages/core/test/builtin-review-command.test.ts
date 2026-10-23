/**
 * 内建命令 `/review`：任何宿主都有，敲下去展开成整段说明，和用户的技能、命令都不混在一起。
 *
 * 这几条各守一处接线：`builtinCommandsFor` 按宿主动作把它筛掉，命令行就没有 `/review`；`resolveInvocation`
 * 不先认它，同名的磁盘命令就把它顶掉；正文的分流写坏了，审阅会话会再转交一次，命令行会去找一件不存在的工具。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { listCommands } from "../src/commands/catalogue.ts";
import { parseInvocation } from "../src/commands/expand.ts";
import { resolveInvocation } from "../src/commands/invoke.ts";
import type { SlashCommand } from "../src/commands/loader.ts";
import { DEFAULT_SETTINGS } from "../src/config/settings.ts";
import { AgentSession } from "../src/runtime/agent-session/session.ts";
import { REVIEW_ARGUMENT_HINT, REVIEW_BODY, REVIEW_SESSION_OPENING } from "../src/commands/review.ts";
import type { SessionMeta } from "../src/session/store.ts";
import type { SessionStorage } from "../src/session/storage.ts";

let root: string;
let home: string;
let userHome: string;
const saved = { PLUME_HOME: process.env.PLUME_HOME, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

const META = { id: "s1", projectId: "p", cwd: "", modelId: "m", title: "", createdAt: 0, updatedAt: 0 } as unknown as SessionMeta;
const STORE = { append: async (meta: SessionMeta) => meta, create: async () => META } as unknown as SessionStorage;

before(async () => {
	root = await mkdtemp(join(tmpdir(), "ly-builtin-review-"));
	home = join(root, "plume-home");
	userHome = join(root, "user-home");
	await mkdir(home, { recursive: true });
	await mkdir(userHome, { recursive: true });
	// 两个都设：`os.homedir()` 在 Windows 上读 USERPROFILE，只设 HOME 的沙箱在那里不生效。
	process.env.PLUME_HOME = home;
	process.env.HOME = userHome;
	process.env.USERPROFILE = userHome;
});

after(async () => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
});

async function project(name: string): Promise<string> {
	const dir = join(root, name);
	await mkdir(dir, { recursive: true });
	return dir;
}

test("/review 是内建命令：哪个宿主都有，不在技能列表里", async () => {
	const cwd = await project("menu");
	for (const actions of [[], ["compact", "clear", "manage-commands", "aside", "plan"]] as const) {
		const catalogue = await listCommands(cwd, DEFAULT_SETTINGS, actions);
		const review = catalogue.builtins.find((command) => command.name === "review");
		assert.ok(review, `宿主动作 ${actions.length} 个时也有它`);
		assert.equal(review.action, undefined, "不靠宿主动作：展开成一段话发出去");
		assert.ok(review.argumentHint?.includes("--effort"), "/ 菜单给出用法提示");
		assert.ok(!catalogue.skills.some((skill) => skill.name === "review"));
	}
});

test("/review 展开成整段说明加参数，气泡里只留人敲的那一行；同名的磁盘命令盖不住它", () => {
	const invocation = parseInvocation("/review 123 --effort low");
	assert.ok(invocation);
	const resolved = resolveInvocation(invocation, { commands: [] });
	assert.ok(resolved?.outgoing.startsWith(REVIEW_BODY), "不再要模型先调一次 skill 去读正文");
	assert.ok(resolved?.outgoing.endsWith("Arguments: 123 --effort low"), resolved?.outgoing.slice(-80));
	assert.equal(resolved?.displayText, "/review 123 --effort low");
	assert.equal(resolved?.skillRef, undefined);

	const bare = resolveInvocation(parseInvocation("/review")!, { commands: [] });
	assert.ok(bare?.outgoing.endsWith("Arguments: none (the uncommitted local changes)"));
	assert.equal(bare?.displayText, "/review");

	const command = { name: "review", description: "我的命令", content: "我的审阅命令 $ARGUMENTS" } as unknown as SlashCommand;
	const mine = resolveInvocation(invocation, { commands: [command] });
	assert.ok(mine?.outgoing.startsWith(REVIEW_BODY), "菜单里列的是内建那条，回车发出去的也得是它");
});

/** 第 0 步的三条分流各守一种会话：把它们的顺序或判断条件改坏了，审阅会话会再转交一次，命令行会去找一件不存在的工具。 */
test("正文分两半：审阅会话认开头那一行，有 review_session 的交出去，其余当场跑完", () => {
	const where = REVIEW_BODY.slice(REVIEW_BODY.indexOf("## 0."), REVIEW_BODY.indexOf("## H."));
	const reviewer = where.indexOf(`"${REVIEW_SESSION_OPENING}"`);
	const handoff = where.indexOf("You have the `review_session` tool");
	const fallback = where.indexOf("**Otherwise**");
	assert.ok(reviewer > 0 && handoff > reviewer && fallback > handoff, "先认审阅会话，再看有没有工具，最后回退");
	assert.match(where, /Do not call `review_session`/, "审阅会话自己也拿得到这件工具");
	assert.match(where, /Until step F, review only/);
	assert.match(where, /no `--comment`: the implementing conversation does that/);
	assert.match(where, /run steps 1 to 8 in this conversation/);
	// 给原会话的那一半：审阅会话来问时由它定修哪几条，定不下的才问人；自己不修，报告回来也不再修。
	const handOff = REVIEW_BODY.slice(REVIEW_BODY.indexOf("## H."), REVIEW_BODY.indexOf("## 1."));
	assert.match(handOff, /the review session asks you \(a message from it\) which of its findings to fix/);
	assert.match(handOff, /ask the person with `ask_user`, about those findings only/);
	assert.match(handOff, /Do not fix anything yourself/);
	assert.match(handOff, /Do not fix again/);
	// 审阅会话那一半的第 F 步：先问、拿到回答才修，只修点名的，等不到就不修。
	const fix = REVIEW_BODY.slice(REVIEW_BODY.indexOf("## F."), REVIEW_BODY.indexOf("## 7."));
	assert.match(fix, /call `ask_session` with the implementing conversation's address/);
	assert.match(fix, /call `wait_for_session`/, "原会话去问人时接着等");
	assert.match(fix, /No answer .*: fix nothing/);
	assert.match(fix, /Fix exactly the findings it named/);
	assert.match(handOff, /Do not copy the plan or the person's messages/, "计划和用户原话由宿主附原文");
	for (const field of ["background", "decisions", "implementation", "files", "out_of_scope", "unverified", "focus"]) {
		assert.match(handOff, new RegExp(`- \`${field}\` \\((required|optional)\\) — [^\\n]+Example`), `交接单的 ${field} 有说明、有示例`);
	}
	assert.match(handOff, /quote the person's own words/);
	// 审阅会话那一半：依据分先后，子智能体的提示词里要有背景和约束。
	assert.match(where, /The person's own words and decisions are the highest authority/);
	assert.match(where, /claims to check against the code, never evidence/);
	assert.match(where, /Every finder and checker you dispatch gets the path to `review\/intent\.md` and, written into its prompt, the background, the constraints and the intent/);
	assert.match(where, /write `review\/intent\.md` in the same sections, in the same order, with the same headings/);
	assert.match(REVIEW_BODY, /<review session only: Context \(read before the diff\)/, "finder 提示词里给背景留了位置");
	// 意图对照只在有总结或计划时才有，读的是审阅会话写下的那份。
	assert.match(REVIEW_BODY, /\*\*E\. Intent\*\* \(only with `review\/intent\.md`/);
	assert.ok(!REVIEW_ARGUMENT_HINT.includes("--fix"), "交出去时修是默认的，菜单里不再提示 --fix");
	assert.match(REVIEW_BODY, /\*\*--fix\*\*: kept for the case where the whole pipeline runs in this conversation/, "回退路径上照旧认 --fix");
});

test("没有 review_session 的宿主（命令行那样不传 extraTools）里，这件工具根本不在", async () => {
	const cwd = await project("cli");
	const session = new AgentSession({ cwd, settings: DEFAULT_SETTINGS, store: STORE, meta: { ...META, cwd }, emit: async () => {} });
	await session.initialize();
	assert.ok(!session.can.tools.some((tool) => tool.name === "review_session"), "第 0 步因此落到第三条：当场跑完整条流水线");
	assert.ok(!session.can.skills.some((s) => s.name === "review"), "它是命令，不进会话的技能表");
});
