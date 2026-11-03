/**
 * 发给窗口的那一份事件：`turn_end` 不发、大图换成文件引用、工具进度只发变了的部分。
 *
 * 补丁每条都先过一遍 `structuredClone`，那就是 IPC 做的事；窗口还原出来的必须和主进程手里的逐字一致。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentEvent, ImageContent, Message } from "@plume/core";
import type { ToolPatch, WireAgentEvent } from "@plume/contract";
import { EventWire } from "../electron/session/event-wire.ts";
import { ToolPatchReader } from "../shared/tool-patch.ts";

type Progress = Extract<AgentEvent, { type: "tool_update" }>;

const home = mkdtempSync(join(tmpdir(), "plume-wire-"));
const previous = process.env.PLUME_HOME;
process.env.PLUME_HOME = home;
test.after(() => {
	if (previous === undefined) delete process.env.PLUME_HOME;
	else process.env.PLUME_HOME = previous;
	rmSync(home, { recursive: true, force: true });
});

const progress = (toolCallId: string, text: string, details?: unknown): Progress => ({ type: "tool_update", toolCallId, partial: { content: [{ type: "text", text }], ...(details === undefined ? {} : { details }) } });

/** 主进程发出、过 IPC、窗口接回：返回窗口那一头交给 store 的 `tool_update`。 */
function pipe(wire: EventWire, reader: ToolPatchReader, sessionId: string, event: AgentEvent): WireAgentEvent | null {
	const sent = wire.wire(sessionId, event);
	if (!sent) return null;
	const crossed = structuredClone(sent);
	if (crossed.type === "tool_patch") reader.take(sessionId, crossed);
	else reader.observe(sessionId, crossed);
	return crossed;
}

test("turn_end does not cross to the windows", () => {
	const wire = new EventWire();
	const reply: Message = { role: "assistant", content: [{ type: "text", text: "完" }], timestamp: 1 } as Message;
	assert.equal(wire.wire("s", { type: "turn_end", message: reply, toolResults: [] } as AgentEvent), null);
	assert.equal(wire.wire("s", { type: "agent_end", reason: "done" } as AgentEvent)?.type, "agent_end", "其余照发");
});

test("tool progress crosses as appended text and is put back word for word", () => {
	const wire = new EventWire();
	const got: Progress[] = [];
	const reader = new ToolPatchReader(async () => null, (_sessionId, event) => got.push(event));
	const outputs = ["$ pnpm test\n", "$ pnpm test\n✔ a 通过\n", "$ pnpm test\n✔ a 通过\n✔ b 😀 \u{20000}\n"];
	const sent: WireAgentEvent[] = [];
	for (const text of outputs) sent.push(pipe(wire, reader, "s", progress("c1", text))!);
	assert.deepEqual(got.map((one) => one.partial), outputs.map((text) => ({ content: [{ type: "text", text }] })));
	assert.ok(sent.every((one) => one.type === "tool_patch"));
	const later = sent.slice(1) as ToolPatch[];
	// 第二次起只带新来的那几行，不带前面的全部。
	assert.deepEqual(later.map((one) => one.ops), [[[["content", 0, "text"], "a", outputs[0].length, outputs[1].slice(outputs[0].length)]], [[["content", 0, "text"], "a", outputs[1].length, outputs[2].slice(outputs[1].length)]]]);
});

test("output that stops growing at its end (clipped, scrolled, details changed) falls back to the whole field", () => {
	const wire = new EventWire();
	const got: Progress[] = [];
	const reader = new ToolPatchReader(async () => null, (_sessionId, event) => got.push(event));
	const head = "head\n".repeat(20);
	const steps: Progress[] = [
		progress("c1", `${head}line 1\nline 2\n`),
		progress("c1", `${head}line 1\nline 2\nline 3\n`),
		// 超过上限以后中段被截掉，末尾在滚：不是接着长的。
		progress("c1", `${head}… 2 lines omitted …\nline 3\nline 4\n`),
		progress("c1", `${head}… 2 lines omitted …\nline 3\nline 4\n`, { outputPath: "/tmp/out.log" }),
		// 变短了。
		progress("c1", "reset\n"),
	];
	const sent = steps.map((one) => pipe(wire, reader, "s", one) as ToolPatch);
	assert.deepEqual(got.map((one) => one.partial), steps.map((one) => one.partial));
	assert.equal(sent[2].ops[0][1], "s", "滚动的那一次整段换掉");
	assert.deepEqual(sent[3].ops, [[["details"], "s", { outputPath: "/tmp/out.log" }]]);
});

test("parallel calls are tracked apart, and a finished one starts over from a keyframe", () => {
	const wire = new EventWire();
	const got: Progress[] = [];
	const reader = new ToolPatchReader(async () => null, (_sessionId, event) => got.push(event));
	pipe(wire, reader, "s", progress("a", "a1\n"));
	pipe(wire, reader, "s", progress("b", "b1\n"));
	pipe(wire, reader, "s", progress("a", "a1\na2\n"));
	pipe(wire, reader, "s", progress("b", "b1\nb2\n"));
	pipe(wire, reader, "s", { type: "tool_end", toolCallId: "a", toolName: "bash", result: { content: [{ type: "text", text: "a1\na2\n" }] }, isError: false });
	assert.equal(wire.streamingTool("s", "a"), null, "收了尾的不再记着");
	const again = pipe(wire, reader, "s", progress("a", "x\n")) as ToolPatch;
	assert.equal(again.seq, 0);
	assert.deepEqual(got.map((one) => `${one.toolCallId}:${(one.partial.content[0] as { text: string }).text}`), ["a:a1\n", "b:b1\n", "a:a1\na2\n", "b:b1\nb2\n", "a:x\n"]);
});

test("a window that starts listening mid-command asks for a keyframe and carries on from it", async () => {
	const wire = new EventWire();
	pipe(wire, new ToolPatchReader(async () => null, () => {}), "s", progress("c1", "one\n"));
	wire.wire("s", progress("c1", "one\ntwo\n"));
	const got: Progress[] = [];
	const asked: string[] = [];
	const late = new ToolPatchReader(async (sessionId, toolCallId) => {
		asked.push(toolCallId);
		return structuredClone(wire.streamingTool(sessionId, toolCallId));
	}, (_sessionId, event) => got.push(event));
	// 窗口从第三次进度才开始听：接不上，要一帧关键帧；那之后到的照常接上。
	pipe(wire, late, "s", progress("c1", "one\ntwo\nthree\n"));
	await new Promise((resolve) => setTimeout(resolve, 0));
	pipe(wire, late, "s", progress("c1", "one\ntwo\nthree\nfour\n"));
	assert.deepEqual(asked, ["c1"]);
	assert.deepEqual(got.map((one) => (one.partial.content[0] as { text: string }).text), ["one\ntwo\nthree\n", "one\ntwo\nthree\nfour\n"]);
});

test("a keyframe that comes back after the call ended is dropped", async () => {
	const wire = new EventWire();
	wire.wire("s", progress("c1", "one\n"));
	const got: Progress[] = [];
	let answer: (patch: ToolPatch | null) => void = () => {};
	const late = new ToolPatchReader(() => new Promise((resolve) => (answer = resolve)), (_sessionId, event) => got.push(event));
	const keyframe = structuredClone(wire.streamingTool("s", "c1"));
	pipe(wire, late, "s", progress("c1", "one\ntwo\n"));
	pipe(wire, late, "s", { type: "tool_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "one\ntwo\n" }] }, isError: false });
	answer(keyframe);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(got, []);
});

test("a screenshot crosses as a file pointer, and the tool result carrying it points at the same file", () => {
	const wire = new EventWire();
	const pixels = "iVBORw0KGgo".padEnd(20_000, "A");
	const shot: ImageContent = { type: "image", mimeType: "image/png", data: pixels };
	const icon: ImageContent = { type: "image", mimeType: "image/png", data: "tiny" };
	const ended = wire.wire("s", { type: "tool_end", toolCallId: "c1", toolName: "browser_screenshot", result: { content: [shot, icon] }, isError: false });
	assert.ok(ended?.type === "tool_end");
	const [parked, small] = ended.result.content as ImageContent[];
	assert.equal(parked.data, "");
	assert.ok(parked.media && existsSync(join(home, "session-media", parked.media)));
	assert.equal(small, icon, "小图照旧内联");
	assert.equal(shot.data, pixels, "主进程手里那份不动");

	const result: Message = { role: "toolResult", toolCallId: "c1", toolName: "browser_screenshot", content: [{ ...shot }], isError: false, timestamp: 2 };
	const message = wire.wire("s", { type: "message_end", message: result });
	assert.ok(message?.type === "message_end" && message.message.role === "toolResult");
	assert.equal((message.message.content[0] as ImageContent).media, parked.media, "按内容起名，同一张图同一个文件");

	const sub = wire.wire("s", { type: "subagent_message", id: "sub", message: result });
	assert.ok(sub?.type === "subagent_message" && sub.message.role === "toolResult");
	assert.equal((sub.message.content[0] as ImageContent).media, parked.media);

	const inner = wire.wire("s", { type: "subagent_event", id: "sub", event: { type: "tool_end", toolCallId: "c2", toolName: "browser_screenshot", result: { content: [shot] }, isError: false } });
	assert.ok(inner?.type === "subagent_event" && inner.event.type === "tool_end");
	assert.equal((inner.event.result.content[0] as ImageContent).media, parked.media);
});

test("events without large images keep their identity", () => {
	const wire = new EventWire();
	const event: AgentEvent = { type: "message_end", message: { role: "user", content: [{ type: "text", text: "你好" }], timestamp: 3 } };
	assert.equal(wire.wire("s", event), event);
});
