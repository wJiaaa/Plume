/**
 * 子智能体面板的转录和主会话一样按回合收：连着的「想一下、跑两条命令」是一行，不是一行思考、一行工具交替排下去。
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createElement as h } from "react";
import type { Message } from "@plume/core";
import { SubAgentTranscript } from "../../src/features/subagents/SubAgentMessageRow.tsx";
import { useApp } from "../../src/store/index.ts";
import { mount } from "../helpers/mount.ts";

afterEach(() => useApp.setState({ settings: null }));

function transcript(rounds: number): Message[] {
	const messages = [{ role: "user", origin: "parent", content: [{ type: "text", text: "查一下构建为什么慢" }], timestamp: 1 }] as Message[];
	for (let round = 0; round < rounds; round++) {
		const ids = [`r${round}a`, `r${round}b`];
		messages.push({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: `第 ${round} 次想`, durationMs: 1000 },
				...ids.map((id) => ({ type: "toolCall", id, name: "bash", arguments: { command: `echo ${id}` } })),
			],
			stopReason: "toolUse",
			timestamp: 2 + round,
		} as Message);
		for (const id of ids) messages.push({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: id }], isError: false, timestamp: 2 + round } as Message);
	}
	messages.push({ role: "assistant", content: [{ type: "text", text: "慢在类型检查。" }], stopReason: "stop", timestamp: 99 } as Message);
	return messages;
}

test("推理和调用交替的三轮收成一行，结论照旧在下面", async () => {
	useApp.setState({ settings: { ...useApp.getState().settings, showThinking: true } as never });
	const view = await mount(h(SubAgentTranscript, { messages: transcript(3) }));
	try {
		const steps = view.all<HTMLElement>("[data-ly-step]");
		assert.equal(steps.length, 1, `one line for the whole stretch: ${steps.map((step) => step.textContent).join(" | ")}`);
		assert.match(steps[0].textContent ?? "", /思考 3 次/);
		assert.match(steps[0].textContent ?? "", /执行命令 6 个/);
		assert.ok(view.find("[data-sub-brief]"), "派出去那一句还是任务卡片");
		assert.match(view.text(), /慢在类型检查。/);
	} finally {
		await view.unmount();
	}
});
