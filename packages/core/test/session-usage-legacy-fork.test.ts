/** 旧 schema 没有分叉截止标记：相同记录可来自不同的继承边界，不能据此猜本地活动。 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { sessionDb } from "../src/session/db.ts";
import { SessionStore } from "../src/session/store.ts";
import { forkSession } from "../src/trajectory/fork.ts";
import type { Message } from "../src/types.ts";

test("schema 3 的 forkedFrom 与记录不能区分继承的尾部用户消息和本地新消息", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-legacy-fork-"));
	const store = new SessionStore(root);
	mock.method(Date, "now", () => 1000);
	try {
		const source = await store.create(root, "m");
		const first: Message = { role: "user", content: [{ type: "text", text: "first" }], timestamp: 1000 };
		const second: Message = { role: "user", content: [{ type: "text", text: "second" }], timestamp: 1000 };
		await store.append(source, { type: "message", message: first });
		await store.append(source, { type: "message", message: second });
		const local = (await forkSession(store, source.id, 2))!;
		await store.append(local.meta, { type: "message", message: second });
		const inherited = (await forkSession(store, source.id, 3))!;
		const db = sessionDb(store.path);
		assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 3);
		// v0.9.44 的写法只有这一个区别：copy 不在正文里，但照样跳过 spend。
		db.exec("UPDATE records SET body = json_remove(body, '$.copy')");
		assert.deepEqual((await store.get(local.meta.id))?.forkedFrom, { sessionId: source.id });
		assert.deepEqual((await store.get(inherited.meta.id))?.forkedFrom, { sessionId: source.id });
		assert.deepEqual({ ...(await store.get(local.meta.id)), id: "fork" }, { ...(await store.get(inherited.meta.id)), id: "fork" });
		assert.deepEqual(await Array.fromAsync(store.usageRecords(local.meta.id, 0)), await Array.fromAsync(store.usageRecords(inherited.meta.id, 0)));
		assert.deepEqual(await store.readSpend(), []);
		// 源会话删除也不能带走分叉；缺少的截止点不会由剩下的 schema 补出来。
		await store.delete(source.id);
		assert.deepEqual(await Array.fromAsync(store.usageRecords(local.meta.id, 0)), await Array.fromAsync(store.usageRecords(inherited.meta.id, 0)));
	} finally {
		mock.restoreAll();
		store.close();
		await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	}
});
