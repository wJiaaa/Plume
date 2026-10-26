/**
 * 智能体开关：`disabledAgents` 里的名字，会话里没有，`/` 与 `@` 菜单里也没有；内置的一样能关。
 *
 * 会话走 `loadCapabilities`，菜单走 `listCommands`，摘掉任何一处的过滤都得变红。改了开关要当场
 * 生效——正在跑的会话重载一次，而不是等下一个会话。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { listCommands } from "../src/commands/catalogue.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import { AgentSession } from "../src/runtime/agent-session/session.ts";
import type { SessionMeta } from "../src/session/store.ts";
import type { SessionStorage } from "../src/session/storage.ts";

let home: string;
let root: string;

const META = { id: "s1", projectId: "p", cwd: "", modelId: "m", title: "", createdAt: 0, updatedAt: 0 } as unknown as SessionMeta;
const STORE = { append: async (meta: SessionMeta) => meta, create: async () => META } as unknown as SessionStorage;

before(async () => {
	home = await mkdtemp(join(tmpdir(), "ly-agent-switch-home-"));
	root = await mkdtemp(join(tmpdir(), "ly-agent-switch-"));
	process.env.PLUME_HOME = home;
});

after(async () => {
	delete process.env.PLUME_HOME;
	await rm(home, { recursive: true, force: true });
	await rm(root, { recursive: true, force: true });
});

test("关掉的内置智能体进不了会话和菜单，打开后正在跑的会话当场拿回它", async () => {
	const settings: Settings = { ...DEFAULT_SETTINGS, disabledAgents: ["general", "explore"] };
	let reloaded = Promise.withResolvers<void>();
	const session = new AgentSession({
		cwd: root, settings, store: STORE, meta: { ...META, cwd: root },
		emit: async (event) => { if (event.type === "capabilities_changed") reloaded.resolve(); },
	});
	await session.initialize();
	const names = () => new Set(session.can.agents.map((agent) => agent.name));
	assert.ok(!names().has("general") && !names().has("explore"), "关掉的不进会话，general 也不例外");
	assert.ok(names().has("review"), "开着的照常在");

	const menu = new Set((await listCommands(root, settings, [])).agents.map((agent) => agent.name));
	assert.ok(!menu.has("general") && !menu.has("explore"), "菜单和会话一致");
	assert.ok(menu.has("review"));

	reloaded = Promise.withResolvers<void>();
	session.updateSettings({ ...settings, disabledAgents: ["explore"] });
	await reloaded.promise;
	assert.ok(names().has("general"), "打开的当场回到会话里");
	assert.ok(!names().has("explore"), "没打开的还关着");
});
