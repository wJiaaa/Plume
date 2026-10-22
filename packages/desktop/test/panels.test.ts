/**
 * The panel registry.
 *
 * The claim: a panel can be added without editing the side panel component.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { allPanels, registerPanels, type PanelDefinition } from "../src/features/dock/panels/registry.ts";

const stub = (kind: string, label: string): PanelDefinition =>
	({ kind, label, icon: (() => null) as never, shortcut: "⌘0", render: () => null }) as unknown as PanelDefinition;

test("a registered set is the list, and withdrawing puts the previous one back", () => {
	const first = registerPanels([stub("notes", "笔记")]);
	const second = registerPanels([stub("notes", "更好的笔记"), stub("todo", "待办")]);
	assert.deepEqual(allPanels().map((p) => p.label), ["更好的笔记", "待办"]);
	second();
	assert.deepEqual(allPanels().map((p) => p.label), ["笔记"]);
	first();
	assert.equal(allPanels().length, 0);
});

test("availability is decided against the current state, not at registration", () => {
	const remove = registerPanels([
		{
			...stub("notes", "笔记"),
			unavailable: (state) => (state.workspace ? undefined : "先打开一个项目"),
		},
	]);
	const panel = allPanels().find((p) => p.kind === "notes");
	assert.equal(panel?.unavailable?.({ workspace: false, session: false }), "先打开一个项目");
	assert.equal(panel?.unavailable?.({ workspace: true, session: false }), undefined);
	remove();
});

test("an unlisted ephemeral panel stays registered for code to open", () => {
	const remove = registerPanels([{ ...stub("notes", "笔记"), listed: false, ephemeral: true }]);
	const panel = allPanels().find((p) => p.kind === "notes");
	assert.equal(panel?.listed, false);
	assert.equal(panel?.ephemeral, true);
	remove();
});
