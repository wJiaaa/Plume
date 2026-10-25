import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { BUILTIN_AGENTS, type AgentDefinitionRecord, type AgentDefinitionSave } from "@plume/core";
import { AgentDefinitionEditor } from "../../src/features/settings/AgentDefinitionEditor.tsx";
import { avatarResolver } from "../../src/store/agent-avatars.ts";
import { click, fire, mount } from "../helpers/mount.ts";

/** 编辑器在弹窗里，弹窗挂在 body 上，不在挂载的那个容器里。 */
function at<T extends Element = HTMLElement>(selector: string): T {
	const found = document.querySelector<T>(`[data-ly-modal] ${selector}`);
	assert.ok(found, `no element matched ${selector} in the dialog`);
	return found;
}
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("[data-ly-modal] button")].find(each => (each.getAttribute("aria-label") ?? each.textContent) === text);

const record: AgentDefinitionRecord = { id: "editor-fixture", definition: BUILTIN_AGENTS[0], scope: "builtin", editable: true, customized: false, revision: "initial", raw: "" };

test("a failed definition save retains the draft across navigation and never reports success", async () => {
	const previous = Object.getOwnPropertyDescriptor(window, "plume");
	let submitted: AgentDefinitionSave | undefined; let saved = 0;
	Object.defineProperty(window, "plume", { configurable: true, value: { agentDefinitions: { save: async (_project: string | null, input: AgentDefinitionSave) => { submitted = input; throw new Error("definition changed externally"); } } } });
	const props = { record, projectId: null, tools: ["read"], avatarOf: avatarResolver(BUILTIN_AGENTS), taken: [], onClose: () => {}, onSaved: () => { saved++; } };
	const view = await mount(h(AgentDefinitionEditor, props));
	try {
		const field = at<HTMLTextAreaElement>('[aria-label="智能体指令"]');
		const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set; assert.ok(setter);
		setter.call(field, "Unsaved instructions"); await fire(field, new Event("input", { bubbles: true }));
		await fire(at("form"), new Event("submit", { bubbles: true, cancelable: true }));
		assert.match(at("[role=alert]").textContent ?? "", /definition changed externally/); assert.equal(saved, 0);
		assert.equal(submitted?.revision, "initial"); assert.equal(submitted?.scope, "user");
		await view.rerender(null); await view.rerender(h(AgentDefinitionEditor, props));
		assert.equal(at<HTMLTextAreaElement>('[aria-label="智能体指令"]').value, "Unsaved instructions");
		// 改过再按取消：底栏换成「尚有未保存的修改」和两个去处，放弃才关。
		const cancel = button("取消"); assert.ok(cancel); await click(cancel);
		const discard = button("放弃修改"); assert.ok(discard); await click(discard);
	} finally { await view.unmount(); if (previous) Object.defineProperty(window, "plume", previous); else Reflect.deleteProperty(window, "plume"); }
});
