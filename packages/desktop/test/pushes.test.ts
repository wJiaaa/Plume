import assert from "node:assert/strict";
import { test } from "node:test";

// 帧由测试自己推：`inFrame` 排进去的东西只在这里调 `tick()` 时落地。推送跟着拍子走（`ticker.ts`），
// 拍子要帧时间戳判断到没到点：每次推的帧都离上一帧一秒，总是到点；时间戳远在 `performance.now()`
// 之前，下一拍也就不睡计时器、直接等下一帧。
let frames: Array<(now: number) => void> = [];
let clock = -1e9;
const frame = (ms: number) => {
	clock += ms;
	const due = frames;
	frames = [];
	for (const run of due) run(clock);
};
const tick = () => frame(1000);
const reported: unknown[] = [];
let reply: (value: string) => void = () => {};
const scope = globalThis as Record<string, unknown>;
scope.requestAnimationFrame = (run: (now: number) => void) => frames.push(run);
scope.cancelAnimationFrame = (id: number) => { frames[id - 1] = () => {}; };
scope.reportError = (error: unknown) => reported.push(error);
scope.document = { visibilityState: "visible", addEventListener() {}, hasFocus: () => true };
scope.window = {
	addEventListener() {},
	setTimeout,
	clearTimeout,
	plume: { sessions: { read: () => new Promise<string>((resolve) => { reply = resolve; }) } },
};
const { inFrame, flushPushes } = await import("../src/services/pushes.ts");
const { bridge } = await import("../src/services/bridge.ts");

test("pushes that arrive before a frame are applied together, in arrival order", () => {
	const seen: string[] = [];
	inFrame(() => seen.push("message_start"));
	inFrame(() => seen.push("message_end"));
	inFrame(() => seen.push("agent_start"));
	assert.deepEqual(seen, []);
	assert.equal(frames.length, 1, "one frame for the whole burst");
	tick();
	assert.deepEqual(seen, ["message_start", "message_end", "agent_start"]);
});

test("a steady stream of pushes lands once per tick, not once per frame", () => {
	const seen: string[] = [];
	inFrame(() => seen.push("tool_start"));
	tick();
	assert.deepEqual(seen, ["tool_start"], "the first push after a quiet spell lands on the next frame");
	inFrame(() => seen.push("tool_end"));
	frame(1000 / 120);
	assert.deepEqual(seen, ["tool_start"], "one 120Hz frame later is not yet the next tick");
	inFrame(() => seen.push("message_end"));
	frame(1000 / 120);
	frame(1000 / 120);
	frame(1000 / 120);
	assert.deepEqual(seen, ["tool_start", "tool_end", "message_end"], "the tick takes both, together");
	tick();
});

test("a reply resolves only after the pushes that arrived ahead of it", async () => {
	const seen: string[] = [];
	const read = bridge.sessions.read("a" as never).then(() => seen.push("reply"));
	inFrame(() => seen.push("message_start"));
	reply("transcript");
	await read;
	assert.deepEqual(seen, ["message_start", "reply"]);
	tick();
	assert.deepEqual(seen, ["message_start", "reply"], "already applied, not applied again");
});

test("a hidden window applies pushes at once, behind anything already queued", () => {
	const seen: string[] = [];
	inFrame(() => seen.push("queued"));
	(scope.document as { visibilityState: string }).visibilityState = "hidden";
	try {
		inFrame(() => seen.push("hidden"));
		assert.deepEqual(seen, ["queued", "hidden"]);
	} finally {
		(scope.document as { visibilityState: string }).visibilityState = "visible";
	}
	tick();
});

test("one push throwing does not drop the ones behind it", () => {
	const seen: string[] = [];
	inFrame(() => { throw new Error("bad event"); });
	inFrame(() => seen.push("next"));
	flushPushes();
	assert.deepEqual(seen, ["next"]);
	assert.equal((reported.at(-1) as Error).message, "bad event");
});
