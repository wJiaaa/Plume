/**
 * Throwing away the logos that identify nothing.
 *
 * The case this was written for is on screen right now in the default catalogue: its entries carry
 * a `logo` URL each, and for everything that shipped no icon of its own the registry answers with
 * the GitHub avatar of whoever owns the repository it was built from. Since the official MCP
 * servers all live in one monorepo, seven different products came back wearing the same person's
 * face — a page of cards showing one photograph seven times, in the place the eye goes first.
 *
 * The rule is the definition of a mark read literally: a picture two entries share is not either
 * entry's mark. Nothing here knows about GitHub or avatars, which is deliberate — the same rule
 * catches a registry that hands out one placeholder to everything, and leaves alone a registry that
 * gives every entry its own icon.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { dropShared } from "../electron/plugins/registry-icons.ts";

/** Stands in for a fetched image; only its identity as bytes matters to the rule. */
const face = "data:image/jpeg;base64,AAAA";
const anthropic = "data:image/png;base64,BBBB";
const context7 = "data:image/svg+xml;base64,CCCC";

test("a picture two entries share belongs to neither of them", () => {
	const kept = dropShared(
		new Map([
			["https://registry/icon/context7", face],
			["https://registry/icon/filesystem", face],
		]),
	);

	assert.deepEqual([...kept.values()], [null, null]);
});

test("a picture only one entry has is that entry's, and is kept", () => {
	const kept = dropShared(
		new Map([
			["https://registry/icon/anthropic-skills", anthropic],
			["https://registry/icon/context7", context7],
		]),
	);

	assert.equal(kept.get("https://registry/icon/anthropic-skills"), anthropic);
	assert.equal(kept.get("https://registry/icon/context7"), context7);
});

test("the shared one goes and the distinct ones stay, in the same batch", () => {
	/*
	 * The realistic shape, and the reason this is judged over a whole list rather than per card:
	 * a catalogue is a mixture. Anthropic's mark is a real logo that happens to also be an org's
	 * avatar, and it survives — being shared is what makes a picture useless here, not where it
	 * came from.
	 */
	const kept = dropShared(
		new Map([
			["https://registry/icon/context7", face],
			["https://registry/icon/filesystem", face],
			["https://registry/icon/playwright", face],
			["https://registry/icon/anthropic-skills", anthropic],
		]),
	);

	assert.deepEqual(
		[...kept].map(([url, image]) => [url.split("/").pop(), image === null ? "dropped" : "kept"]),
		[
			["context7", "dropped"],
			["filesystem", "dropped"],
			["playwright", "dropped"],
			["anthropic-skills", "kept"],
		],
	);
});

test("every key asked about comes back, so a caller can tell answered from unasked", () => {
	const kept = dropShared(
		new Map([
			["https://registry/icon/a", face],
			["https://registry/icon/b", face],
			["https://registry/icon/c", null],
		]),
	);

	assert.deepEqual([...kept.keys()], ["https://registry/icon/a", "https://registry/icon/b", "https://registry/icon/c"]);
});

test("logos that could not be fetched do not count as sharing anything", () => {
	/*
	 * Three failures are three nulls, and nulls are not a picture. Counting them together would make
	 * every unreachable logo "shared" — which lands on the same answer by luck, and would drop a
	 * fourth entry's perfectly good icon the moment it happened to be the only one that failed.
	 */
	const kept = dropShared(
		new Map([
			["https://registry/icon/a", null],
			["https://registry/icon/b", null],
			["https://registry/icon/c", context7],
		]),
	);

	assert.equal(kept.get("https://registry/icon/c"), context7);
});

test("one entry on its own keeps its logo, whatever it is a picture of", () => {
	// Nothing is inferred from a single entry: with no second claim, there is no evidence.
	const kept = dropShared(new Map([["https://registry/icon/waza", face]]));

	assert.equal(kept.get("https://registry/icon/waza"), face);
});

test("an empty batch is an empty answer, not a crash", () => {
	assert.deepEqual([...dropShared(new Map())], []);
});
