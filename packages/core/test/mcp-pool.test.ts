/**
 * 会话之间共用 MCP 连接（`mcp/pool.ts`）。
 *
 * 进程数要从操作系统那里数：「两个会话共用一条连接」说的是只起了一个进程，一个对象上的计数说明不了。
 * 反问人的那几条对着真的 SDK 服务器（`mcp-http-fixture.ts`），它在工具调用中途发 `elicitation/create`。
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { McpManager, type McpServerStatus, type McpStdioServer } from "../src/mcp/client.ts";
import { McpPool } from "../src/mcp/pool.ts";
import type { ApprovalRequest } from "../src/types.ts";
import { startMcpHttpFixture } from "./mcp-http-fixture.ts";

/** 启动时把自己的 pid 写进 `FAKE_MCP_DIR`，好让测试问操作系统它还在不在。 */
const SERVER = `
const fs = require("node:fs");
fs.writeFileSync(require("node:path").join(process.env.FAKE_MCP_DIR, process.pid + ".pid"), "");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let end;
	while ((end = buffer.indexOf("\\n")) !== -1) {
		const message = JSON.parse(buffer.slice(0, end));
		buffer = buffer.slice(end + 1);
		if (message.id === undefined) continue;
		if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } });
		else if (message.method === "tools/list") send({ id: message.id, result: { tools: [{ name: "echo", description: "Echo.", inputSchema: { type: "object" } }] } });
		else send({ id: message.id, error: { code: -32601, message: "no such method" } });
	}
});
process.stdin.on("end", () => process.exit(0));
`;

async function fixture(t: TestContext): Promise<{ server(extra?: Partial<McpStdioServer>): McpStdioServer; started(): Promise<number[]> }> {
	const dir = await mkdtemp(join(tmpdir(), "plume-mcp-pool-"));
	const script = join(dir, "server.cjs");
	await writeFile(script, SERVER);
	const started = async () => (await readdir(dir)).filter((name) => name.endsWith(".pid")).map((name) => Number(name.slice(0, -4)));
	t.after(async () => {
		for (const pid of await started()) if (alive(pid)) process.kill(pid, "SIGKILL");
		await rm(dir, { recursive: true, force: true });
	});
	return {
		server: (extra = {}) => ({ id: "fake", name: "fake", transport: "stdio", command: process.execPath, args: [script], env: { FAKE_MCP_DIR: dir }, enabled: true, ...extra }),
		started,
	};
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function stopped(pid: number, ms = 3000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (alive(pid)) {
		if (Date.now() > deadline) return false;
		await delay(25);
	}
	return true;
}

test("两个会话用同一台服务器：只起一个进程，最后一个会话放手才停", async (t) => {
	const fx = await fixture(t);
	const pool = new McpPool({ timeoutMs: 5000 });
	const a = new McpManager({ pool });
	const b = new McpManager({ pool });
	t.after(() => Promise.all([a.dispose(), b.dispose()]));
	const [first] = await a.connectAll([fx.server()]);
	const [second] = await b.connectAll([fx.server()]);
	assert.equal(first?.state, "connected");
	assert.equal(second?.state, "connected");
	assert.deepEqual(b.allTools().map((tool) => tool.name), ["mcp__fake__echo"]);
	const pids = await fx.started();
	assert.equal(pids.length, 1, "第二个会话接上了第一个起的那个进程");

	await a.dispose();
	assert.equal(alive(pids[0]!), true, "还有会话在用，不能停");
	await b.dispose();
	assert.equal(await stopped(pids[0]!), true, "没人用了就停");
});

test("改名、改信任开关不重起；每个会话独立的服务器各起一份", async (t) => {
	const fx = await fixture(t);
	const pool = new McpPool({ timeoutMs: 5000 });
	const a = new McpManager({ pool });
	const b = new McpManager({ pool });
	t.after(() => Promise.all([a.dispose(), b.dispose()]));
	await a.connectAll([fx.server()]);
	await b.connectAll([fx.server({ name: "Renamed", trustReadOnly: true })]);
	const [shared] = await fx.started();
	assert.equal((await fx.started()).length, 1);

	await a.connectAll([fx.server({ perSession: true })]);
	await b.connectAll([fx.server({ perSession: true })]);
	assert.equal((await fx.started()).length, 3, "打开「每个会话独立」：两个会话各起一个");
	assert.equal(await stopped(shared!), true, "共用的那个没人用了，停掉");
});

test("池子上断开：每个会话都不再有它，进程停掉", async (t) => {
	const fx = await fixture(t);
	const pool = new McpPool({ timeoutMs: 5000 });
	const seen: McpServerStatus[] = [];
	const a = new McpManager({ pool, onChange: (status) => seen.push(status) });
	const b = new McpManager({ pool });
	t.after(() => Promise.all([a.dispose(), b.dispose()]));
	await a.connectAll([fx.server()]);
	await b.connectAll([fx.server()]);
	const [pid] = await fx.started();

	await pool.disconnect((server) => server.id === "fake");
	assert.equal(await stopped(pid!), true);
	assert.deepEqual(a.allTools(), []);
	assert.deepEqual(b.statuses(), []);
	assert.equal(seen.at(-1)?.state, "disabled", "另一个会话也被告知，好重算工具表");

	// 重载一遍又连得上：登录之后就是这么走的。
	const [again] = await b.connectAll([fx.server()]);
	assert.equal(again?.state, "connected");
});

test("池子上重连一次，共用的那条连接只重起一次", async (t) => {
	const fx = await fixture(t);
	const pool = new McpPool({ timeoutMs: 5000 });
	const a = new McpManager({ pool });
	const b = new McpManager({ pool });
	t.after(() => Promise.all([a.dispose(), b.dispose()]));
	await a.connectAll([fx.server()]);
	await b.connectAll([fx.server()]);
	await pool.reconnect("fake");
	await Promise.all([a.settled(), b.settled()]);
	assert.equal((await fx.started()).length, 2);
	assert.equal(a.statuses()[0]?.state, "connected");
	assert.equal(b.statuses()[0]?.state, "connected");
});

const httpServer = (url: string) => ({ id: "fx", name: "Fixture", transport: "http" as const, url, enabled: true });

test("共用的连接上服务器反问：问正在调用的那个会话，不问另一个", async (t) => {
	const fixture = await startMcpHttpFixture();
	t.after(() => fixture.close());
	const pool = new McpPool({ timeoutMs: 5000, elicitation: true });
	const asked: string[] = [];
	const asker = (who: string) => async (_request: ApprovalRequest) => {
		asked.push(who);
		return { values: { name: who, age: 1 } };
	};
	const a = new McpManager({ pool, ask: asker("a") });
	const b = new McpManager({ pool, ask: asker("b") });
	t.after(() => Promise.all([a.dispose(), b.dispose()]));
	await a.connectAll([httpServer(fixture.url)]);
	await b.connectAll([httpServer(fixture.url)]);
	assert.equal(fixture.capabilities.length, 1, "两个会话一条连接");

	await b.allTools().find((tool) => tool.name === "mcp__fx__ask")!.execute({}, { cwd: "/tmp", sessionId: "b" });
	await a.allTools().find((tool) => tool.name === "mcp__fx__ask")!.execute({}, { cwd: "/tmp", sessionId: "a" });
	assert.deepEqual(asked, ["b", "a"]);
	assert.deepEqual(fixture.answers.map((answer) => answer.content?.name), ["b", "a"]);
});

test("两个会话同时在调用，分不清是谁的：拒绝，不猜", async (t) => {
	const fixture = await startMcpHttpFixture();
	t.after(() => fixture.close());
	const pool = new McpPool({ timeoutMs: 5000, elicitation: true });
	const asked: string[] = [];
	const asker = (who: string) => async () => {
		asked.push(who);
		return { values: { name: who, age: 1 } };
	};
	const a = new McpManager({ pool, ask: asker("a") });
	const b = new McpManager({ pool, ask: asker("b") });
	t.after(() => Promise.all([a.dispose(), b.dispose()]));
	await a.connectAll([httpServer(fixture.url)]);
	await b.connectAll([httpServer(fixture.url)]);
	await Promise.all([
		a.allTools().find((tool) => tool.name === "mcp__fx__ask")!.execute({}, { cwd: "/tmp", sessionId: "a" }),
		b.allTools().find((tool) => tool.name === "mcp__fx__ask")!.execute({}, { cwd: "/tmp", sessionId: "b" }),
	]);
	assert.deepEqual(asked, []);
	assert.deepEqual(fixture.answers, [{ action: "decline" }, { action: "decline" }]);
});
