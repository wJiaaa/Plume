/**
 * 会话之间的消息：谁看得见谁、权限比自己宽的不让发、发太快太长太绕的拦下来、问和告诉各走哪条路。
 * 等回答见 `peer-wait.test.ts`。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { Settings } from "@plume/core";
import { peerAddress, peerName, peerRef, resolvePeer } from "../electron/peer/peer-address.ts";
import { broaderThan, PEER_BUCKET, PeerPacer } from "../electron/peer/peer-policy.ts";
import { rootsOverlap, sessionRoots } from "../electron/peer/peer-reach.ts";
import { pathKey } from "../electron/path-key.ts";
import { asking, fakeSession, routerWith, stopAsking } from "./helpers/peer-fake.ts";

afterEach(stopAsking);

test("地址：名字取标题、ref 取 id 前六位；ref 说了算，重名不猜", () => {
	const a = { id: "a1b2c3d4-0000-0000-0000-000000000000", title: "修登录", cwd: "/w/api" };
	const b = { id: "ffee0011-0000-0000-0000-000000000000", title: "修登录", cwd: "/w/web" };
	const c = { id: "12345678-0000-0000-0000-000000000000", title: "", cwd: "/w/docs" };
	assert.equal(peerRef(a.id), "a1b2c3");
	assert.equal(peerAddress(a), "修登录 [a1b2c3]");
	assert.equal(peerName(c), "docs", "没有标题用目录名");
	assert.equal(peerName({ title: "[草稿]\n修 bug", cwd: "/x" }), "草稿 修 bug", "方括号和换行不能混进名字");
	assert.deepEqual(resolvePeer("修登录 [a1b2c3]", [a, b, c]), { kind: "found", peer: a });
	assert.deepEqual(resolvePeer("改过名了 [ffee00]", [a, b, c]), { kind: "found", peer: b }, "名字过期了，ref 还对");
	assert.equal(resolvePeer("修登录", [a, b, c]).kind, "ambiguous");
	assert.deepEqual(resolvePeer("docs", [a, b, c]), { kind: "found", peer: c });
	assert.deepEqual(resolvePeer("123456", [a, b, c]), { kind: "found", peer: c }, "只抄了 ref 也认");
	assert.equal(resolvePeer("不存在", [a, b, c]).kind, "none");
});

test("限速：太长、链太长、自己绕圈、三十秒内同一句、发得太快", () => {
	let now = 0;
	const pacer = new PeerPacer(() => now);
	assert.equal(pacer.admit("a", "b", "x".repeat(20_001), ["a"]), "too-long");
	assert.equal(pacer.admit("a", "b", "hi", Array.from({ length: 29 }, (_, i) => `s${i}`)), "chain-runaway");
	assert.equal(pacer.admit("a", "b", "hi", [...Array(11).fill("a"), "b"]), "chain-loop");
	assert.equal(pacer.admit("a", "b", "同一句", ["a"]), null);
	assert.equal(pacer.admit("a", "b", "同一句", ["a"]), "duplicate");
	now += 30_001;
	assert.equal(pacer.admit("a", "b", "同一句", ["a"]), null, "过了窗口可以再说");
	assert.equal(pacer.admit("a", "c", "同一句", ["a"]), null, "对别人说不算重复");
	for (let i = 0; i < PEER_BUCKET; i++) pacer.admit("x", "y", `第${i}封`, ["x"]);
	assert.equal(pacer.admit("x", "y", "再来", ["x"]), "paced");
	now += 2_000;
	assert.equal(pacer.admit("x", "y", "两秒后", ["x"]), null, "两秒补一封");
	assert.equal(pacer.admit("y", "x", "反方向另算", ["y"]), null);
});

test("目录重叠：同目录、包含、p-old 不在 p 里、软链、worktree 认主工作树", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-peer-reach-"));
	try {
		const repo = join(root, "p");
		await mkdir(join(repo, "packages", "a"), { recursive: true });
		await mkdir(join(root, "p-old"), { recursive: true });
		await mkdir(join(root, "elsewhere"), { recursive: true });
		await writeFile(join(repo, "README.md"), "x");
		const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
		run(repo, "init", "-q");
		run(repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "add", ".");
		run(repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init");
		const tree = join(root, "trees", "feature");
		run(repo, "worktree", "add", "-q", "-b", "feature", tree);
		await symlink(repo, join(root, "link"));

		const roots = (cwd: string, projects?: Settings["projects"], project?: string) => sessionRoots(cwd, projects, project);
		assert.ok(rootsOverlap(await roots(repo), await roots(join(repo, "packages", "a"))), "一个在另一个里面");
		assert.ok(!rootsOverlap(await roots(repo), await roots(join(root, "p-old"))), "p-old 不在 p 里");
		assert.ok(rootsOverlap(await roots(repo), await roots(join(root, "link"))), "软链指过去的是同一个目录");
		assert.ok(rootsOverlap(await roots(tree), await roots(repo)), "worktree 和主工作树");
		assert.ok(!rootsOverlap(await roots(tree), await roots(join(root, "elsewhere"))));
		assert.ok(!rootsOverlap(await roots(join(repo, "packages", "a")), await roots(join(root, "elsewhere"))));
		const projects = [{ id: "p", name: "p", path: repo, folders: [repo, join(root, "elsewhere")] }] as unknown as Settings["projects"];
		assert.ok(rootsOverlap(await roots(repo, projects, "p"), await roots(join(root, "elsewhere"))), "同一个项目的另一个源目录");
		// git 报的主工作树是解析过软链的路径（macOS 临时目录在 /private/var 下），项目也得这么写才包含得住。
		const real = [{ id: "p", name: "p", path: await realpath(repo), folders: [await realpath(repo), join(root, "elsewhere")] }] as unknown as Settings["projects"];
		assert.ok(rootsOverlap(await roots(tree, real, "p"), await roots(join(root, "elsewhere"))), "worktree 也算它项目的源目录");
		assert.ok(!rootsOverlap(await roots(repo, projects), await roots(join(root, "elsewhere"))), "没记项目的会话不从文件夹推算项目");
		assert.ok((await roots(join(root, "p-old"))).every((one) => one === pathKey(one)), "都是比较用的写法");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("权限：对方比自己宽才拦，一样宽或更窄都放", () => {
	assert.ok(broaderThan("full", "auto"));
	assert.ok(broaderThan("auto", "ask"));
	assert.ok(!broaderThan("auto", "auto"));
	assert.ok(!broaderThan("ask", "full"), "宽的请窄的做事，窄的那边照样一步步审批");
});

test("路由：列出目录重叠的、送达时带上地址和链、看不见的说清原因", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-peer-route-"));
	try {
		await mkdir(join(root, "api", "src"), { recursive: true });
		await mkdir(join(root, "other"), { recursive: true });
		const a = fakeSession("aaaaaaaa-1", join(root, "api"));
		const b = fakeSession("bbbbbbbb-1", join(root, "api", "src"));
		const c = fakeSession("cccccccc-1", join(root, "other"));
		const { router } = routerWith(a, b, c);

		assert.deepEqual(await router.list("aaaaaaaa-1"), [{ address: "bbbb [bbbbbb]", sessionId: "bbbbbbbb-1", cwd: join(root, "api", "src"), busy: false, mode: "auto" }]);
		await asking(router, b, "aaaaaaaa-1", { to: "bbbb", message: "接着发版" });
		assert.equal(b.inbox[0]?.kind, "request");
		const { id, ...letter } = b.inbox[0]!.letter;
		assert.match(id ?? "", /^[0-9a-f-]{36}$/, "每封信有自己的 id，回答和兜底都据此认出是哪封");
		assert.deepEqual(letter, { sessionId: "aaaaaaaa-1", from: "aaaa [aaaaaa]", text: "接着发版", cwd: join(root, "api"), chain: ["aaaaaaaa-1"], request: true });

		// B 为这封信开的那一轮里再去找 A：链接上了。
		b.read();
		b.start();
		await router.notify("bbbbbbbb-1", { to: "aaaa [aaaaaa]", message: "顺带说一句" });
		assert.deepEqual(a.inbox[0]?.letter.chain, ["aaaaaaaa-1", "bbbbbbbb-1"]);
		// 人在 B 那边开口之后，B 发的是一条新链。
		router.personSpoke("bbbbbbbb-1");
		await router.notify("bbbbbbbb-1", { to: "aaaa", message: "新的事" });
		assert.deepEqual(a.inbox[1]?.letter.chain, ["bbbbbbbb-1"]);
		b.finish("好了。");
		// 人开的那一轮里，B 发的也是新链——链跟着运行走，不是「B 最近收到的那封信」。
		b.start();
		await router.notify("bbbbbbbb-1", { to: "aaaa", message: "人让我说的" });
		assert.deepEqual(a.inbox[2]?.letter.chain, ["bbbbbbbb-1"]);
		b.finish("好了。");

		assert.equal((await router.ask("aaaaaaaa-1", { to: "cccc", message: "hi" })).kind, "unreachable");
		assert.equal((await router.notify("aaaaaaaa-1", { to: "cccc", message: "hi" })).kind, "unreachable");
		assert.equal((await router.notify("aaaaaaaa-1", { to: "aaaa", message: "hi" })).kind, "self");
		assert.equal((await router.notify("aaaaaaaa-1", { to: "nobody", message: "hi" })).kind, "none");
		assert.equal((await router.wait("aaaaaaaa-1", { to: "cccc" })).kind, "unreachable", "等也一样要目录重叠");
		assert.equal(c.inbox.length, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("路由：对方权限比自己宽，不送；反过来照送", async () => {
	const ask = fakeSession("aaaaaaaa-2", "/w/p", "ask");
	const full = fakeSession("bbbbbbbb-2", "/w/p", "full");
	const { router } = routerWith(ask, full);
	assert.deepEqual(await router.ask("aaaaaaaa-2", { to: "bbbb", message: "帮我删了它" }), { kind: "broader", to: "bbbb [bbbbbb]", theirs: "full", mine: "ask" });
	assert.equal((await router.notify("aaaaaaaa-2", { to: "bbbb", message: "帮我删了它" })).kind, "broader", "通知也一样");
	assert.equal(full.inbox.length, 0);
	assert.equal((await router.notify("bbbbbbbb-2", { to: "aaaa", message: "看一眼" })).kind, "delivered");
	assert.equal(ask.inbox.length, 1);
});

test("路由：问送的是请求，告诉送的是通知；闲着时的通知为它开一轮", async () => {
	const a = fakeSession("aaaaaaaa-3", "/w/p");
	const b = fakeSession("bbbbbbbb-3", "/w/p");
	const { router } = routerWith(a, b);
	assert.deepEqual(await router.notify("aaaaaaaa-3", { to: "bbbb", message: "闲着时" }), { kind: "delivered", to: "bbbb [bbbbbb]", busy: false });
	assert.equal(b.session.idleInForeground, false);
	b.read();
	b.start();
	assert.deepEqual(await router.notify("aaaaaaaa-3", { to: "bbbb", message: "先别动 config.ts" }), { kind: "delivered", to: "bbbb [bbbbbb]", busy: true });
	await asking(router, b, "aaaaaaaa-3", { to: "bbbb", message: "接着发版" });
	assert.deepEqual(b.inbox.map((one) => one.kind), ["notice", "notice", "request"]);
});

test("路由：两家的信进了 B 的同一次运行（一封请求开轮、一封通知插进来），之后发出去的接开轮那封的链", async () => {
	const a = fakeSession("aaaaaaaa-4", "/w/p");
	const b = fakeSession("bbbbbbbb-4", "/w/p");
	const c = fakeSession("cccccccc-4", "/w/p");
	const { router } = routerWith(a, b, c);
	// C 先在 A 那里接了一跳，A 再找 B：A→B 那封的链是 [C, A]。
	await asking(router, a, "cccccccc-4", { to: "aaaa", message: "你去问 B" });
	a.read();
	a.start();
	await asking(router, b, "aaaaaaaa-4", { to: "bbbb", message: "C 让我问你" });
	await router.notify("cccccccc-4", { to: "bbbb", message: "顺带" });
	b.read(0);
	b.start();
	b.read(1);
	await router.notify("bbbbbbbb-4", { to: "aaaa", message: "答复" });
	assert.deepEqual(a.inbox[1]?.letter.chain, ["cccccccc-4", "aaaaaaaa-4", "bbbbbbbb-4"]);
});

test("路由：插进一次已经在跑的运行的通知不接链——各跑长回合、互相递通知，链不会一封封涨上去", async () => {
	const a = fakeSession("aaaaaaaa-19", "/w/p");
	const b = fakeSession("bbbbbbbb-19", "/w/p");
	const { router } = routerWith(a, b);
	a.start();
	b.start();
	for (let round = 0; round < 15; round++) {
		assert.equal((await router.notify("aaaaaaaa-19", { to: "bbbb", message: `A 第 ${round} 次` })).kind, "delivered");
		b.read();
		assert.equal((await router.notify("bbbbbbbb-19", { to: "aaaa", message: `B 第 ${round} 次` })).kind, "delivered", "不会撞上链长上限");
		a.read();
	}
	assert.deepEqual(a.inbox.at(-1)?.letter.chain, ["bbbbbbbb-19"]);
	// 叫起一次运行的通知照样接链：闲着的 B 被它叫起来之后再发的，接在后面。
	b.finish();
	await router.notify("aaaaaaaa-19", { to: "bbbb", message: "叫醒你" });
	b.read();
	b.start();
	await router.notify("bbbbbbbb-19", { to: "aaaa", message: "醒了" });
	assert.deepEqual(a.inbox.at(-1)?.letter.chain, ["aaaaaaaa-19", "bbbbbbbb-19"]);
});
