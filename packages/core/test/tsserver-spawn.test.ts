/**
 * How `tsserver` is started, which only matters inside the app.
 *
 * In Electron's main process `process.execPath` is Plume itself. Started without
 * `ELECTRON_RUN_AS_NODE`, it is the app, not Node: every code-intelligence question launched a second
 * copy of Plume with `tsserver.js` for an argument, the single-instance lock sent it away, and the tool
 * waited out its timeout. Tests run under Node, where the variable changes nothing — so the arguments
 * the process is started with are what is checked here, not whether a server answers.
 */

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { TsServerBackend } from "../src/lsp/tsserver.ts";

test("tsserver starts as Node inside the app, with no console window on Windows", async (t) => {
	const calls: { file: string; args: readonly string[]; options: childProcess.SpawnOptions }[] = [];
	const spawn = t.mock.method(childProcess, "spawn", (file: string, args: readonly string[], options: childProcess.SpawnOptions) => {
		calls.push({ file, args, options });
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			stdin: new PassThrough(),
			pid: 1,
			killed: false,
			unref() {},
			kill() {
				return true;
			},
		});
		return child as unknown as childProcess.ChildProcess;
	});
	syncBuiltinESMExports();
	t.after(() => {
		spawn.mock.restore();
		syncBuiltinESMExports();
	});

	const backend = new TsServerBackend();
	if (!(await backend.available())) {
		t.skip("typescript is not installed here");
		return;
	}
	await backend.start(process.cwd());

	assert.equal(calls.length, 1);
	assert.equal(calls[0].file, process.execPath);
	assert.match(String(calls[0].args[0]), /tsserver\.js$/);
	assert.equal(calls[0].options.env?.ELECTRON_RUN_AS_NODE, "1", "in the app, process.execPath is Plume — without this it is not Node");
	assert.equal(calls[0].options.windowsHide, true);
});

test("a tsserver that died and was restarted is told to open the file again", async (t) => {
	/*
	 * The restarted process has opened nothing. When the backend kept its record of opened files
	 * across the crash, the new server never got an `open`, and every answer was "No Project".
	 */
	const children: (EventEmitter & { stdout: PassThrough; commands: string[] })[] = [];
	const spawn = t.mock.method(childProcess, "spawn", () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const commands: string[] = [];
		stdin.setEncoding("utf8");
		stdin.on("data", (chunk: string) => {
			for (const line of chunk.split("\n").filter(Boolean)) {
				const request = JSON.parse(line) as { seq: number; command: string };
				commands.push(request.command);
				// Answer everything that is not a notification, with an empty body — on the next turn, after the backend is listening for it.
				if (request.command !== "open") setImmediate(() => stdout.write(`${JSON.stringify({ type: "response", request_seq: request.seq, success: true, body: [] })}\n`));
			}
		});
		const child = Object.assign(new EventEmitter(), { stdout, stderr: new PassThrough(), stdin, pid: children.length + 1, killed: false, commands, unref() {}, kill: () => true });
		children.push(child);
		return child as unknown as childProcess.ChildProcess;
	});
	syncBuiltinESMExports();
	const dir = await mkdtemp(join(tmpdir(), "ly-tsserver-restart-"));
	t.after(async () => {
		spawn.mock.restore();
		syncBuiltinESMExports();
		await rm(dir, { recursive: true, force: true });
	});
	const file = join(dir, "a.ts");
	await writeFile(file, "export const a = 1;\n");

	const backend = new TsServerBackend();
	if (!(await backend.available())) {
		t.skip("typescript is not installed here");
		return;
	}
	await backend.start(dir);
	await backend.definition(file, 1, 14);
	assert.deepEqual(children[0].commands, ["open", "definition"]);

	children[0].emit("exit", 1);
	assert.equal(backend.ready(), false, "a dead server is not ready");

	await backend.start(dir);
	assert.equal(children.length, 2, "restarting spawns a new process");
	await backend.definition(file, 1, 14);
	assert.deepEqual(children[1].commands, ["open", "definition"], "the new process is told to open the file before it is asked about it");

	// The first process's late exit must not reset the second.
	children[0].emit("exit", 1);
	assert.equal(backend.ready(), true);
	await backend.dispose();
});
