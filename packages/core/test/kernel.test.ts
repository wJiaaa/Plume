import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "../src/kernel/context.ts";
import {
	createContext,
	COMPACTION,
	LLM,
	SANDBOX,
	SKILLS,
	TOOLS,
	type CompactionStrategy,
	type LlmRegistry,
	type Sandbox,
	type SkillRegistry,
	type ToolRegistry,
} from "../src/kernel/index.ts";

test("disposing a context unwinds everything it installed", async () => {
	const ctx = new Context();
	const events: string[] = [];

	await ctx.use({
		name: "thing",
		apply(c) {
			const off = c.provide("thing", 1);
			return () => {
				off();
				events.push("disposed");
			};
		},
	});

	assert.equal(ctx.has("thing"), true);
	await ctx.dispose();
	assert.deepEqual(events, ["disposed"]);
	assert.equal(ctx.has("thing"), false);
});

test("a service cannot be provided twice under the same key", async () => {
	const ctx = new Context();
	ctx.provide("thing", 1);
	assert.throws(() => ctx.provide("thing", 2), /already provided/);
});

test("emit reaches every listener, and one that throws does not stop the others", async () => {
	const ctx = new Context();
	const seen: string[] = [];
	ctx.on("x", () => {
		throw new Error("bad listener");
	});
	ctx.on("x", (value: unknown) => {
		seen.push(String(value));
	});
	ctx.emit("x", 42);
	assert.deepEqual(seen, ["42"]);
});

test("waterfall wraps: the first listener registered is the outermost", async () => {
	const ctx = new Context();
	const trace: string[] = [];

	ctx.onWaterfall<[string], string>("w", async (value, next) => {
		trace.push(`outer in ${value}`);
		const result = await next();
		trace.push("outer out");
		return `[${result}]`;
	});
	ctx.onWaterfall<[string], string>("w", async (value, next) => {
		trace.push(`inner in ${value}`);
		return `(${await next()})`;
	});

	const result = await ctx.waterfall<string>("w", ["v"], async () => "base");
	assert.equal(result, "[(base)]");
	assert.deepEqual(trace, ["outer in v", "inner in v", "outer out"]);
});

test("a waterfall listener that does not delegate owns the decision", async () => {
	const ctx = new Context();
	let baseRan = false;
	ctx.onWaterfall<[], string>("w", async () => "decided");
	ctx.onWaterfall<[], string>("w", async (next) => {
		baseRan = true;
		return next();
	});

	assert.equal(await ctx.waterfall<string>("w", [], async () => "base"), "decided");
	assert.equal(baseRan, false, "downstream is never asked once someone answers");
});

test("the default context provides the seams the app is built on", async () => {
	const ctx = await createContext();

	const llm = ctx.require<LlmRegistry>(LLM);
	for (const api of ["anthropic-messages", "openai-chat-completions", "openai-responses"]) assert.ok(llm.get(api), `${api} is registered`);

	assert.ok(ctx.require<Sandbox>(SANDBOX), "commands have somewhere to run");
	assert.ok(ctx.require<CompactionStrategy>(COMPACTION), "a full window has an answer");
	assert.deepEqual(ctx.require<SkillRegistry>(SKILLS).all(), [], "no skills ship in the box");

	const tools = ctx.require<ToolRegistry>(TOOLS);
	const byName = (name: string) => tools.all().find((tool) => tool.name === name);
	assert.ok(byName("bash"), "the shell tool is registered");
	assert.ok(byName("read"), "the file tools are registered");
	assert.ok(tools.all().length >= 13);

	await ctx.dispose();
});

test("a later registration replaces a tool of the same name", async () => {
	const ctx = await createContext();
	const tools = ctx.require<ToolRegistry>(TOOLS);
	const bash = () => tools.all().find((tool) => tool.name === "bash");
	const original = bash();

	const remove = tools.register([{ ...(original as never), description: "sandboxed" } as never]);
	assert.equal(bash()?.description, "sandboxed");
	// And withdrawing the replacement restores what it displaced.
	remove();
	assert.equal(bash(), original);

	await ctx.dispose();
});
