/**
 * The merge rules, with providers that return fixed lists.
 *
 * Real directories belong in the provider tests. What is under test here is the arithmetic —
 * who wins, who is recorded as having lost —
 * and a fixture on disk would only make those assertions slower to read and no more true.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CapabilityRegistry } from "../src/capability/registry.ts";
import type { CapabilityId, CapabilityProvider, DiscoveryContext, Sourced } from "../src/capability/types.ts";

interface Named {
	name: string;
	body?: string;
}

function registry(): CapabilityRegistry {
	return new CapabilityRegistry({ home: "/home/.plume", userHome: "/home", repoRoot: () => null });
}

/** A provider that hands back the names it was built with. */
function fake(
	id: string,
	priority: number,
	names: string[],
	extra?: Partial<CapabilityProvider<Named>> & { scope?: "builtin" | "user" | "project" },
): CapabilityProvider<Named> {
	return {
		id,
		label: id,
		priority,
		supplies: ["skill"],
		...extra,
		async load(_kind: CapabilityId, ctx: DiscoveryContext) {
			if (extra?.load) return extra.load(_kind, ctx);
			return {
				items: names.map(
					(name) =>
						({
							name,
							body: id,
							provenance: { provider: id, providerLabel: id, path: `/${id}/${name}.md`, scope: extra?.scope ?? "project" },
						}) as Sourced<Named>,
				),
			};
		},
	};
}

test("the higher priority provider wins, and the loser points at the winner", async () => {
	const reg = registry();
	reg.register(fake("low", 10, ["deploy"]));
	reg.register(fake("high", 100, ["deploy"]));

	const result = await reg.load<Named>("skill", { cwd: "/p" });

	assert.equal(result.items.length, 1);
	assert.equal(result.items[0].provenance.provider, "high");
	const loser = result.all.find((item) => item.provenance.provider === "low");
	assert.ok(loser, "the loser is still listed");
	assert.equal(loser.shadowedBy?.provider, "high", "and names who took it");
	assert.equal(loser.shadowedBy?.path, "/high/deploy.md", "by path, not just by provider");
});

test("equal priorities keep registration order", async () => {
	const reg = registry();
	reg.register(fake("first", 10, ["x"]));
	reg.register(fake("second", 10, ["x"]));

	const result = await reg.load<Named>("skill", { cwd: "/p" });
	assert.equal(result.items[0].provenance.provider, "first");
});

test("a provider that throws costs only its own items", async () => {
	const reg = registry();
	reg.register(fake("good", 100, ["a", "b"]));
	reg.register({
		id: "broken",
		label: "坏掉的来源",
		priority: 50,
		supplies: ["skill"],
		async load() {
			throw new Error("directory is on fire");
		},
	});

	const result = await reg.load<Named>("skill", { cwd: "/p" });

	assert.deepEqual(
		result.items.map((i) => i.name),
		["a", "b"],
		"the healthy provider is unaffected",
	);
	const reported = result.diagnostics.find((d) => d.path === "broken");
	assert.ok(reported, "the failure is reported");
	assert.equal(reported.severity, "error");
	assert.match(reported.message, /on fire/, "with the reason");
	assert.match(reported.message, /坏掉的来源/, "and the human name of the source");
});

test("an item with no provenance is dropped and reported rather than crashing the merge", async () => {
	const reg = registry();
	reg.register({
		id: "sloppy",
		label: "Sloppy",
		priority: 10,
		supplies: ["skill"],
		async load() {
			return { items: [{ name: "x" } as unknown as Sourced<Named>] };
		},
	});

	const result = await reg.load<Named>("skill", { cwd: "/p" });
	assert.equal(result.items.length, 0);
	assert.ok(result.diagnostics.some((d) => /没有 provenance/.test(d.message)));
});

test("watched directories come back", async () => {
	const reg = registry();
	reg.register({
		id: "native",
		label: "Plume",
		priority: 100,
		supplies: ["skill"],
		async load() {
			return {
				items: [{ name: "a", provenance: { provider: "native", providerLabel: "Plume", path: "/a", scope: "project" } } as Sourced<Named>],
				watched: ["/p/.plume/skills"],
			};
		},
	});
	reg.register(fake("empty", 50, []));

	const result = await reg.load<Named>("skill", { cwd: "/p" });

	assert.deepEqual(result.watched, ["/p/.plume/skills"]);
});

test("registering the same provider id twice is refused", async () => {
	const reg = registry();
	reg.register(fake("native", 100, []));
	assert.throws(() => reg.register(fake("native", 90, [])), /already registered/);
});
