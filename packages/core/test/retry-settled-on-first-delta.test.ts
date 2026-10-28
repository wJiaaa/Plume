/**
 * 重试接上以后，第一段内容一到就说「恢复了」，不等这条回复写完。
 *
 * 会话 f25e586e 里量到的：23:38:55 断了一次（`stream_read_error`），四秒多后接上、开始出字，而
 * `retry_settled` 直到 23:41:46 回复写完才到——将近三分钟里转录那一行一直写着「服务端故障，正在
 * 重试（第 1 次）」。走真实适配器和本地服务器：重试发生在适配器里面，替身模型够不着。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import type { AgentEvent } from "../src/agent/events.ts";
import { streamTurn } from "../src/agent/stream-turn.ts";
import { runConfig } from "./run-config.ts";
import type { ModelConfig, ProviderConfig } from "../src/types.ts";

let server: Server;
let base = "";
let hits = 0;
/**
 * 每次请求怎么答，按到达顺序取；取完了就一直是最后那种。
 * `fail` 502；`slow` 先吐一段、停 300ms 再说完；`drop` 吐一段之后掐断连接。
 */
let script: ("fail" | "slow" | "drop")[] = [];

const piece = (text: string) => `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":${JSON.stringify(text)}},"finish_reason":null}]}\n\n`;

before(async () => {
	server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			hits += 1;
			const mode = script[Math.min(hits, script.length) - 1];
			if (mode === "fail") {
				res.writeHead(502, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "upstream exploded" } }));
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(piece("接上了"));
			if (mode === "drop") {
				setTimeout(() => res.destroy(), 100);
				return;
			}
			setTimeout(() => {
				res.end(`data: {"choices":[{"index":0,"delta":{"content":"，说完了"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`);
			}, 300);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function turn(signal?: AbortSignal, onEvent?: (event: AgentEvent) => void) {
	const model: ModelConfig = {
		id: "t/m", providerId: "t", modelId: "m", name: "M", contextWindow: 100_000,
		maxOutputTokens: 1024, supportsThinking: false, supportsImages: false, supportsTools: true,
	};
	const provider: ProviderConfig = { id: "t", name: "T", baseUrl: base, api: "openai-chat-completions", apiKey: "x", enabled: true, models: [model] };
	const rule = { retries: 3, strategy: "fixed" as const, intervalMs: 1000, maxIntervalMs: 1000 };
	const { model: modelConfig } = runConfig({ model: { provider, model, retryPolicy: { network: rule, upstream: rule } } });

	const events: AgentEvent[] = [];
	const { message } = await streamTurn(
		modelConfig,
		{ systemPrompt: "", messages: [{ role: "user", content: [{ type: "text", text: "Q" }], timestamp: Date.now() }], tools: [] },
		{ signal, state: undefined },
		async (event) => { events.push(event); onEvent?.(event); },
	);
	return { message, events };
}

const settledOf = (events: AgentEvent[]) => events.flatMap((event) => (event.type === "retry_settled" ? [event] : []));

test("a recovered retry is settled on the first delta, not when the reply ends", async () => {
	hits = 0;
	script = ["fail", "slow"];
	const { message, events } = await turn();

	assert.equal(message.stopReason, "stop", message.errorMessage);
	assert.equal(hits, 2);
	const kinds = events.map((event) => event.type);
	const settled = events.filter((event) => event.type === "retry_settled");
	assert.equal(settled.length, 1, `recovered is said once: ${kinds.join(", ")}`);
	assert.ok(settled[0]!.type === "retry_settled" && settled[0]!.outcome === "recovered" && settled[0]!.attempts === 1);
	const at = kinds.indexOf("retry_settled");
	assert.ok(at < kinds.indexOf("message_update"), `settled before the first delta is drawn: ${kinds.join(", ")}`);
	assert.ok(at < kinds.indexOf("message_end"), "not held until the reply is done");
});

test("stopped while waiting to retry is reported as stopped, never as recovered", async () => {
	hits = 0;
	script = ["fail"];
	const stop = new AbortController();
	const { message, events } = await turn(stop.signal, (event) => {
		if (event.type === "retry") setTimeout(() => stop.abort(), 50);
	});

	assert.equal(message.stopReason, "aborted");
	assert.equal(hits, 1, "nothing more went out after stop");
	const settled = settledOf(events);
	assert.equal(settled.length, 1, events.map((event) => event.type).join(", "));
	assert.equal(settled[0]!.outcome, "stopped");
	assert.equal(settled[0]!.attempts, 1);
});

test("a second interruption in the same request counts its own retries from 1", async () => {
	hits = 0;
	// 502 → 接上、出字后掐断 → 接上说完：两次中断，各重试一次。
	script = ["fail", "drop", "slow"];
	const { message, events } = await turn();

	assert.equal(message.stopReason, "stop", message.errorMessage);
	assert.equal(hits, 3);
	const retries = events.flatMap((event) => (event.type === "retry" ? [event.attempt] : []));
	assert.deepEqual(retries, [1, 1], "each interruption numbers its own retries");
	assert.deepEqual(settledOf(events).map((event) => [event.outcome, event.attempts]), [["recovered", 1], ["recovered", 1]]);
});
