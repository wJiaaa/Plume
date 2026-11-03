/**
 * 压缩收尾部时逐条增减的那几样（`runtime/compaction/retired.ts`、`estimateChars`），和从前每次对整段
 * 重算的结果对拍：合成的历史上，读到每一个位置交出的都必须和对那一段从头调原函数得出的一样。
 *
 * 头里的这几样决定压缩当场发出去的头；重建时（`session-turn.ts`）是从头调原函数算的。两边差一个字，
 * 前缀缓存从 `messages[0]` 起整段不命中。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { filesSeen, lastRequest } from "../src/runtime/compaction/compaction-head.ts";
import { RetiredHistory } from "../src/runtime/compaction/retired.ts";
import { taskContextFromHistory } from "../src/runtime/compaction/task-context.ts";
import { charsToTokens, estimateChars, estimateTokens } from "../src/tokens.ts";
import { emptyUsage, type AssistantMessage, type Message } from "../src/types.ts";

/** 固定种子：失败时能原样复现。 */
function random(seed: number): () => number {
	return () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
}

function history(rnd: () => number): Message[] {
	const pick = <T>(items: T[]): T => items[Math.floor(rnd() * items.length)]!;
	const words = (n: number) => Array.from({ length: n }, () => pick(["修复", "login", "x".repeat(40), "文件"])).join(" ");
	const said = (content: AssistantMessage["content"]): AssistantMessage => ({ role: "assistant", content, api: "anthropic-messages", provider: "p", model: "m", usage: emptyUsage(), stopReason: "stop", timestamp: 2 });
	const out: Message[] = [];
	let id = 0;
	for (let i = 0; i < 80; i++) {
		const r = rnd();
		if (r < 0.15) out.push({ role: "user", content: [{ type: "text", text: words(1 + Math.floor(rnd() * 900)) }], timestamp: i });
		else if (r < 0.2) out.push({ role: "user", content: [{ type: "text", text: " " }], timestamp: i });
		else if (r < 0.25) {
			// 上一次压缩留下的头：任务上下文和文件清单从它这里接着往下算。
			out.push({
				role: "user", content: [{ type: "text", text: "head" }], timestamp: i, synthetic: true,
				compactionContext: { originalRequest: "orig", latestRequest: "late", requests: [{ ordinal: 1, text: "orig", timestamp: 0 }], todos: [{ content: "t", status: "pending" }] },
				compactionFiles: { read: ["a.ts", "b.ts"], changed: ["c.ts"] },
			});
		} else if (r < 0.3) out.push({ role: "user", content: [{ type: "text", text: "继续" }], timestamp: i, synthetic: true, clearsTaskPlan: rnd() < 0.5 });
		else if (r < 0.45) out.push(said([{ type: "text", text: words(Math.floor(rnd() * 40)) }, { type: "thinking", thinking: words(3) }]));
		else {
			const calls = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => ({ type: "toolCall" as const, id: `c${id++}`, name: pick(["read", "write", "edit", "bash", "todo_write"]), arguments: { path: pick(["a.ts", "b.ts", "c.ts", "d.ts", ""]) } }));
			out.push(said(calls));
			for (const call of calls) {
				out.push({
					role: "toolResult", toolCallId: call.id, toolName: call.name, isError: rnd() < 0.1, timestamp: i,
					content: rnd() < 0.1 ? [{ type: "image", data: "AAAA", mimeType: "image/png" }] : [{ type: "text", text: words(Math.floor(rnd() * 50)) }],
					...(call.name === "todo_write" ? { details: { kind: "todo", todos: [{ content: words(2), status: pick(["pending", "completed"]) }] } } : {}),
				} as Message);
			}
		}
	}
	return out;
}

test("read one message at a time, the retired stretch gives what recomputing it from the start gives", () => {
	for (let seed = 1; seed <= 40; seed++) {
		const messages = history(random(seed));
		const retired = new RetiredHistory();
		const handed: ReturnType<RetiredHistory["taskContext"]>[] = [];
		for (let at = 0; at <= messages.length; at++) {
			const prefix = messages.slice(0, at);
			assert.equal(retired.request(), lastRequest(prefix), `seed ${seed} at ${at}: request`);
			assert.deepEqual(retired.files(), filesSeen(prefix), `seed ${seed} at ${at}: files`);
			const context = retired.taskContext();
			assert.deepEqual(context, taskContextFromHistory(prefix), `seed ${seed} at ${at}: task context`);
			handed.push(context);
			if (at < messages.length) retired.add(messages[at]!);
		}
		// 交出去的那份是自己的：后面接着读，不会把早先交出去的改掉。
		for (const [at, context] of handed.entries()) assert.deepEqual(context, taskContextFromHistory(messages.slice(0, at)), `seed ${seed} at ${at}: handed copy`);
	}
});

test("characters added one message at a time round to the same tokens as estimating the whole list", () => {
	for (let seed = 1; seed <= 40; seed++) {
		const messages = history(random(seed));
		let chars = 0;
		for (let at = 0; at < messages.length; at++) {
			chars += estimateChars(messages[at]!);
			assert.equal(charsToTokens(chars), estimateTokens(messages.slice(0, at + 1)));
		}
	}
});
