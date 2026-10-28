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

before(async () => {
	server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			hits += 1;
			if (hits === 1) {
				res.writeHead(502, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "upstream exploded" } }));
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(`data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"接上了"},"finish_reason":null}]}\n\n`);
			setTimeout(() => {
				res.end(`data: {"choices":[{"index":0,"delta":{"content":"，说完了"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`);
			}, 300);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

test("a recovered retry is settled on the first delta, not when the reply ends", async () => {
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
		{ signal: undefined, state: undefined },
		async (event) => { events.push(event); },
	);

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
