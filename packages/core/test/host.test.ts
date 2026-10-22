/**
 * What the host assembly still does after the plugin context went (ADR-0054): one per process, and
 * the skills a host registers are the ones every session reads.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { bootHostKernel } from "../src/kernel/host.ts";
import type { Skill } from "../src/skills/loader.ts";
import { registeredSkills } from "../src/skills/registry.ts";

test("a host's skills reach every session, and disposing the host takes them away", () => {
	const host = bootHostKernel();
	try {
		host.skills.register([{ name: "browser", description: "drive the page" } as unknown as Skill]);
		assert.deepEqual(registeredSkills().map((skill) => skill.name), ["browser"]);
	} finally {
		host.dispose();
	}
	assert.deepEqual(registeredSkills(), []);
});

test("a second host is refused until the first is disposed, and a stale dispose leaves the new one bound", () => {
	const first = bootHostKernel();
	assert.throws(() => bootHostKernel(), /already running/);
	first.dispose();

	const second = bootHostKernel();
	try {
		second.skills.register([{ name: "deploy", description: "ship it" } as unknown as Skill]);
		first.dispose();
		assert.deepEqual(registeredSkills().map((skill) => skill.name), ["deploy"], "the first host's second dispose is a no-op");
	} finally {
		second.dispose();
	}
});
