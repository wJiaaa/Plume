import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { providerIdentity, providerLabel } from "../src/features/settings/usage-providers.ts";

describe("providerLabel", () => {
	const providers = [
		{ id: "relay", name: "Relay" },
		{ id: "provider-mszq0hpb", name: "deerGpt" },
	];

	it("puts the configured name to an id the log recorded", () => {
		assert.equal(providerLabel({ providers }, "provider-mszq0hpb"), "deerGpt");
	});

	it("a provider that has since been deleted still says something", () => {
		// It spent what it spent; a blank row would be worse than the id.
		assert.equal(providerLabel({ providers }, "gone"), "gone");
	});

	it("survives having no providers configured", () => {
		assert.equal(providerLabel(undefined, "relay"), "relay");
	});

	it("名字档案顶上删掉的那个供应商", () => {
		// 账按 id 记，名字只活在 `providers` 里——供应商一删，这一行就只剩 id。档案是那份留下来的。
		const naming = { providers, names: { "provider-mttnetnn": "公司中转" } };
		assert.equal(providerLabel(naming, "provider-mttnetnn"), "公司中转");
		assert.deepEqual(providerIdentity(naming, "provider-mttnetnn"), {
			label: "公司中转",
			configured: false,
			named: true,
		});
	});

	it("配置里的名字压过档案里的旧名字", () => {
		// 在设置页改了名，用量页该跟着改；档案记的是「最后见过的」，不是「第一次见到的」。
		const naming = { providers, names: { relay: "以前的叫法" } };
		assert.equal(providerLabel(naming, "relay"), "Relay");
	});

	it("两处都查不到就只剩 id，而 `provider-` 前缀是噪音", () => {
		// 2026-09 之前删掉的供应商，名字在删除那一刻就没了。剩下的八位是唯一能区分两个供应商的
		// 东西，而每个自动生成的 id 都以同样六个字母开头——在一栏几十像素宽的表格里它挤掉的正是那八位。
		const identity = providerIdentity({ providers }, "provider-mtdoijtz");
		assert.deepEqual(identity, { label: "mtdoijtz", configured: false, named: false });
	});

	it("名字是空字符串等于没有名字", () => {
		// 一个刚建出来还没填名字的供应商，显示成一片空白比显示 id 更糟。
		const naming = { providers: [{ id: "blank", name: "  " }], names: { blank: "" } };
		assert.equal(providerLabel(naming, "blank"), "blank");
	});
});
