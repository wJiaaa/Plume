/**
 * 审计脚本数调用：同一条回复里重复的 id 不算，跨回复重复的 id 照算。
 *
 * 两种 id 长得一样，来源完全不同：
 *
 *   - **同一条回复里第二次出现**：Responses 补项把整份 `output` 又追加了一遍留下的旧记录（`backfill`）。
 *     生产出口 `ai/index.ts` 的 `withoutRepeatedCalls` 就是按单条消息去掉的，审计要跟它一致——不算。
 *   - **跨消息重复**：中转每一轮都从 `bash:0` / `call_0` 重新编号，这是支持的契约
 *     （`ai/anthropic-messages-request.ts` 的替身表按轮建）。会话级去重会把这些真跑过的调用和结果一起
 *     丢掉，第 1、2 节的体积和携带成本随之少算。
 *
 * 脚本一 import 就去读本机数据库，所以这里建一份临时库、用子进程跑它。`PLUME_HOME` 指向临时目录。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SessionStore } from "../packages/core/src/session/store.ts";
import { emptyUsage, type AssistantMessage, type Message } from "../packages/core/src/types.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BODY = "x".repeat(400);

const reply = (content: AssistantMessage["content"], timestamp: number): AssistantMessage => ({
	role: "assistant",
	content,
	api: "openai-responses",
	provider: "p",
	model: "m",
	stopReason: "toolUse",
	usage: { ...emptyUsage(), input: 10, output: 5, total: 15 },
	timestamp,
});

const call = (id: string, args = id): AssistantMessage["content"][number] => ({ type: "toolCall", id, name: "bash", arguments: { command: args } });
const result = (id: string): Message => ({ role: "toolResult", toolCallId: id, toolName: "bash", isError: false, content: [{ type: "text", text: BODY }], timestamp: 1 });

/** 用 `SessionStore` 建一份临时会话库，跑一次审计，返回 `--json` 的解析结果。 */
async function audit(replies: { content: AssistantMessage["content"]; results?: string[] }[]): Promise<any> {
	const home = mkdtempSync(join(tmpdir(), "ly-audit-"));
	const store = new SessionStore(join(home, "sessions"));
	try {
		const meta = await store.create("/tmp/audit", "m", "t");
		let at = 2;
		for (const { content, results = [] } of replies) {
			await store.append(meta, { type: "message", message: reply(content, at++) });
			for (const id of results) await store.append(meta, { type: "message", message: result(id) });
		}
	} finally {
		store.close();
	}
	const run = spawnSync(process.execPath, ["--experimental-strip-types", join(root, "scripts/session-audit.ts"), "--json"], {
		cwd: root,
		env: { ...process.env, PLUME_HOME: home },
		encoding: "utf8",
	});
	rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	assert.equal(run.status, 0, run.stderr);
	return JSON.parse(run.stdout);
}

test("跨消息复用的调用 id：每一轮都算，结果也跟着算", async () => {
	const out = await audit([
		{ content: [call("bash:0")], results: ["bash:0"] },
		{ content: [call("bash:0")], results: ["bash:0"] },
	]);
	assert.equal(out.tools.bash.calls, 2, "中转每轮从 bash:0 重新编号，两次都是真的跑过");
	assert.equal(out.tools.bash.tokens, Math.round((2 * BODY.length) / 3.5), "两次的结果都要算进体积");
});

test("同一条回复里重复的 id：只算一次", async () => {
	const out = await audit([{ content: [call("bash:0"), call("bash:0")], results: ["bash:0"] }]);
	assert.equal(out.tools.bash.calls, 1, "补项追加的那一份不是模型发的");
});

test("一条回复里既重复又换轮：同条算一次，跨轮照算", async () => {
	const out = await audit([
		{ content: [call("bash:0"), call("bash:0")], results: ["bash:0"] },
		{ content: [call("bash:0")], results: ["bash:0"] },
		{ content: [call("bash:1"), call("bash:0")], results: ["bash:1", "bash:0"] },
	]);
	assert.equal(out.tools.bash.calls, 4);
});
