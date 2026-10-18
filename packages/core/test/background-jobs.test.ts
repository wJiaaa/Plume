import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BackgroundJobs, backgroundJobs, type BackgroundJob } from "../src/tools/background-jobs.ts";
import type { SandboxProcess } from "../src/kernel/services.ts";
import { useSandbox } from "../src/sandbox/index.ts";
import { bashOutputTool, bashTool } from "../src/tools/bash.ts";
import { SessionCapabilities } from "../src/runtime/session-capabilities.ts";
import { systemShell } from "../src/platform.ts";
test("a session can stop only its own process handle, and a terminated job cannot target a reused PID", () => {
	const a=new BackgroundJobs(),b=new BackgroundJobs(),signals:string[]=[];
	const info:BackgroundJob={id:"owned",command:"dev",startedAt:1,exitCode:null,output:"",pid:123,status:"running"};
	const process:SandboxProcess={onOutput(){},onExit(){},onError(){},kill(signal){signals.push(signal??"");}};
	a.add(info,process);
	assert.equal(b.stop("owned",true),false);assert.equal(a.stop("123",true),false);assert.equal(signals.length,0);
	assert.equal(a.stop("owned"),true);assert.deepEqual(signals,["SIGTERM"]);
	info.finishedAt=2;info.status="exited";assert.equal(a.stop("owned",true),false);assert.equal(signals.length,1);
});

test("one unkillable background process cannot leak the other processes and session resources", async () => {
	const capabilities = new SessionCapabilities();
	const jobs = backgroundJobs(capabilities.state);
	const closed: string[] = [];
	const denied = new Error("EPERM: process belongs to a different user");
	for (const id of ["denied", "owned"]) {
		jobs.add({ id, command: "server", startedAt: 1, exitCode: null, output: "", status: "running" }, {
			onOutput() {}, onError() {}, onExit() {},
			kill() { closed.push(id); if (id === "denied") throw denied; },
		});
	}
	capabilities.mcp.closeAll = async () => { closed.push("mcp"); };
	let failure: unknown;
	await assert.rejects(capabilities.dispose(), error => { failure = error; return true; });
	assert.deepEqual(closed, ["denied", "owned", "mcp"]);
	assert.ok(failure instanceof AggregateError);
	assert.deepEqual(failure.errors, [denied]);
	assert.equal(jobs.get("denied")?.status, "failed");
	assert.match(jobs.get("denied")?.error ?? "", /EPERM/);
});
test("a signalled command keeps its missing exit code instead of reporting exit 0", async () => {
	useSandbox({ run: () => ({ onOutput() {}, onError() {}, kill() {}, onExit(listener) { queueMicrotask(() => listener(null)); } }) });
	try {
		const result = await bashTool.execute({ command: "node verify.cjs" }, { cwd: process.cwd(), sessionId: "signal-test", state: new Map() });
		assert.ok("isError" in result && result.isError);
		assert.ok(result.details && typeof result.details === "object" && "exitCode" in result.details);
		assert.equal(result.details.exitCode, null);
		assert.match(result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""), /terminated without an exit code/);
	} finally { useSandbox(null); }
});

test("bash_output returns only what arrived since the last read, while the job keeps the whole", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	let emit: (chunk: string) => void = () => {};
	let exit: (code: number | null) => void = () => {};
	useSandbox({ run: () => ({ onOutput(listener) { emit = listener; }, onError() {}, kill() {}, onExit(listener) { exit = listener; } }) });
	try {
		const ctx = { cwd: process.cwd(), sessionId: "poll-test", state: new Map<string, unknown>() };
		const started = await bashTool.execute({ command: "dev", run_in_background: true }, ctx);
		const id = (started.details as { id: string }).id;
		const poll = async (signal?: AbortSignal) => {
			const result = await bashOutputTool.execute({ id }, { ...ctx, signal });
			return result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
		};
		// 没被定时器挡住的那些回调都跑完以后，这次轮询还没答。
		const pending = (reply: Promise<string>) => Promise.race([reply.then(() => false), new Promise<boolean>((resolve) => setImmediate(() => resolve(true)))]);

		// 第一次读：已经打印的就是答案（开发服务器起没起来），不等。
		emit("first line\n");
		assert.match(await poll(), /first line/);

		// 刚读过又来问：中途的输出不叫醒它，满 30 秒再把这段时间的一起给。
		emit("second line\n");
		const second = poll();
		emit("more\n");
		t.mock.timers.tick(29_000);
		assert.ok(await pending(second), "边跑边打印的任务，每来几行就答一次 = 每几秒一整轮");
		t.mock.timers.tick(1_000);
		const gathered = await second;
		assert.match(gathered, /second line\nmore/);
		assert.doesNotMatch(gathered, /first line/, "每次轮询都重发全部输出");

		// 隔了 30 秒以上、期间一个字没有：第一行到了就答，不再空等满。
		t.mock.timers.tick(30_000);
		const third = poll();
		assert.ok(await pending(third));
		emit("third line\n");
		assert.match(await third, /third line/);

		// 按停止，等待当场结束。
		const stop = new AbortController();
		const stopped = poll(stop.signal);
		stop.abort();
		assert.match(await stopped, /\(no new output\)/);
		assert.equal(backgroundJobs(ctx.state).list()[0].output, "first line\nsecond line\nmore\nthird line\n", "任务本身仍保留全部输出");

		// 等的时候任务结束了：当场答它怎么结束的，不等满 30 秒。
		const last = poll();
		emit("done\n");
		assert.ok(await pending(last));
		exit(0);
		assert.match(await last, /exited with code 0/);
	} finally { useSandbox(null); }
});

test("a command handed to the background at the default timeout counts as read: polling right after waits", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	let emit: (chunk: string) => void = () => {};
	let exit: (code: number | null) => void = () => {};
	let launched: () => void = () => {};
	const started = new Promise<void>((resolve) => { launched = resolve; });
	useSandbox({ run: () => { launched(); return { onOutput(listener) { emit = listener; }, onError() {}, kill() {}, onExit(listener) { exit = listener; } }; } });
	try {
		const ctx = { cwd: process.cwd(), sessionId: "handoff-test", state: new Map<string, unknown>() };
		const running = bashTool.execute({ command: "pnpm test" }, ctx);
		// 启动前还有几步异步检查；进程起来了，默认超时的计时器才挂上。
		await started;
		emit("suite 1 ok\n");
		t.mock.timers.tick(120_000);
		const handed = await running;
		const text = handed.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
		assert.match(text, /suite 1 ok/);
		assert.match(text, /still running after 120s/);
		const id = (handed.details as { jobId: string }).jobId;

		// 模型一轮请求的几秒里又打印了一行：那条 bash 结果就是上一次读，这次不该拿着一行进度就回去。
		emit("suite 2 ok\n");
		const poll = bashOutputTool.execute({ id }, ctx).then((result) => result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""));
		const pending = await Promise.race([poll.then(() => false), new Promise<boolean>((resolve) => setImmediate(() => resolve(true)))]);
		assert.ok(pending, "转到后台的任务被当成没读过，刚交出去就又是几秒一轮");
		emit("suite 3 ok\n");
		exit(0);
		const answer = await poll;
		assert.match(answer, /exited with code 0/);
		assert.match(answer, /suite 2 ok\nsuite 3 ok/);
		assert.doesNotMatch(answer, /suite 1 ok/, "交出时已经给过的不重发");
	} finally { useSandbox(null); }
});

/**
 * What was running when a wait below ran out: each job's shell, and everything under it.
 *
 * On Windows this test went red twice in ten runs with both services silent for the whole ten
 * seconds, where a passing run needs 0.66–3.8. Silence has several causes — the shell still
 * starting, node never launched, a pipe that never connected, a process long gone — and the job
 * list alone (status `running`, output empty) reads the same for all of them.
 */
function processReport(pids: number[]): string {
	const alive = pids.map((pid) => {
		try { process.kill(pid, 0); return `${pid} alive`; } catch (error) { return `${pid} ${(error as NodeJS.ErrnoException).code}`; }
	});
	let rows: { pid: number; ppid: number; command: string }[];
	try {
		if (process.platform === "win32") {
			const listing = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
				"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"],
			{ encoding: "utf8", timeout: 20_000, windowsHide: true });
			rows = (JSON.parse(listing) as { ProcessId: number; ParentProcessId: number; CommandLine: string | null }[])
				.map((row) => ({ pid: row.ProcessId, ppid: row.ParentProcessId, command: row.CommandLine ?? "" }));
		} else {
			rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,stat=,etime=,command="], { encoding: "utf8", timeout: 10_000 })
				.split("\n").map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter((match) => match !== null)
				.map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }));
		}
	} catch (error) {
		return `${alive.join(", ")}; process listing failed: ${String(error)}`;
	}
	const tree = new Set(pids);
	for (let grew = true; grew;) {
		grew = false;
		for (const row of rows) if (tree.has(row.ppid) && !tree.has(row.pid)) { tree.add(row.pid); grew = true; }
	}
	const lines = rows.filter((row) => tree.has(row.pid)).map((row) => `${row.pid} <- ${row.ppid}  ${row.command.slice(0, 240)}`);
	return `${alive.join(", ")}\n${lines.join("\n") || "(no process left under the job shells)"}`;
}

test("ordinary stop closes a real descendant listener without stopping a sibling session's service", { timeout: 90_000 }, async t => {
	const root = await mkdtemp(join(tmpdir(), "plume-owned-services-"));
	const ownedState = new Map<string, unknown>(), siblingState = new Map<string, unknown>();
	const registries = [backgroundJobs(ownedState), backgroundJobs(siblingState)];
	const started = Date.now();
	/*
	 * 25 seconds rather than 10: the slowest passing Windows run above is 3.8s, and a CI runner that
	 * is busy starting other suites' processes is exactly where a cold shell stretches. Nothing here
	 * waits the full time when things work, so the generous bound only costs a failing run.
	 */
	const until = async (condition: () => boolean, label: string) => {
		const deadline = Date.now() + 25_000;
		while (!condition() && Date.now() < deadline) await delay(25);
		if (condition()) return;
		const jobs = registries.map(registry => registry.list());
		const pids = jobs.flat().flatMap(job => job.pid === undefined ? [] : [job.pid]);
		const shell = systemShell();
		assert.fail(`${label} after ${Date.now() - started}ms (shell: ${shell.label} ${shell.file})\n` +
			`jobs: ${JSON.stringify(jobs)}\n${processReport(pids)}`);
	};
	t.after(async () => {
		for (const jobs of registries) jobs.dispose();
		await until(() => registries.every(jobs => jobs.list().every(job => job.finishedAt !== undefined)), "fixture processes did not exit");
		await rm(root, { recursive: true, force: true });
	});
	await writeFile(join(root, "server.cjs"), `const {createServer}=require('node:http');
const server=createServer((request,response)=>response.end(process.argv[2]));
server.listen(0,'127.0.0.1',()=>console.log('SERVICE_READY '+process.pid+' '+server.address().port));
`);
	await writeFile(join(root, "launcher.cjs"), "require('node:child_process').spawn(process.execPath,['server.cjs','owned'],{stdio:'inherit'});\n");
	// Written for the shell that will run it: Git Bash on a Windows that has Git, PowerShell otherwise.
	const executable = systemShell().kind === "powershell" ? `& '${process.execPath.replaceAll("'", "''")}'` : `'${process.execPath.replaceAll("'", "'\\''")}'`;
	await bashTool.execute({ command: `${executable} launcher.cjs`, run_in_background: true }, { cwd: root, sessionId: "owned", state: ownedState });
	await bashTool.execute({ command: `${executable} server.cjs sibling`, run_in_background: true }, { cwd: root, sessionId: "sibling", state: siblingState });
	const jobs = registries.map(registry => registry.list()[0]);
	await until(() => registries.every(registry => /SERVICE_READY \d+ \d+/.test(registry.list()[0]?.output ?? "")), "services did not listen");
	const endpoints = registries.map(registry => {
		const match = registry.list()[0].output.match(/SERVICE_READY (\d+) (\d+)/); assert.ok(match);
		return { pid: Number(match[1]), port: Number(match[2]) };
	});
	assert.notEqual(endpoints[0].pid, jobs[0].pid, "the listener must belong to a descendant rather than the shell");
	assert.equal(await (await fetch(`http://127.0.0.1:${endpoints[0].port}`)).text(), "owned");
	assert.equal(registries[1].stop(jobs[0].id), false, "another session cannot stop this process handle");
	assert.equal(registries[0].stop(jobs[0].id), true);
	await until(() => registries[0].get(jobs[0].id)?.finishedAt !== undefined, "ordinary stop did not close the process tree");
	await assert.rejects(new Promise<void>((resolve, reject) => {
		const socket = connect(endpoints[0].port, "127.0.0.1");
		socket.once("connect", () => { socket.destroy(); resolve(); });
		socket.once("error", reject);
	}), { code: "ECONNREFUSED" });
	assert.equal(await (await fetch(`http://127.0.0.1:${endpoints[1].port}`)).text(), "sibling");
	assert.equal(registries[1].get(jobs[1].id)?.finishedAt, undefined);
});
