/**
 * The table that lets a running fetch be stopped.
 *
 * Small, and worth its own tests because every one of its failures is silent. A token left behind
 * makes the *next* press do nothing, forever, with no error anywhere; a missing guard lets two
 * pushes race for the same repository; and cancelling has to stay distinguishable from failing, or
 * a red bar appears for something the user just did on purpose.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { RemoteCalls } from "../electron/git/remote-calls.ts";

const ok = { ok: true as const };

test("a call is reachable while it runs and gone afterwards", async () => {
	const calls = new RemoteCalls();
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});

	const running = calls.run("t1", async () => {
		await held;
		return ok;
	});
	// Not awaited yet, so it is in flight.
	await Promise.resolve();
	assert.equal(calls.size, 1);

	release();
	assert.deepEqual(await running, ok);
	assert.equal(calls.size, 0, "the token has to be released or the next press does nothing");
});

test("the signal reaches the work, and cancelling aborts it", async () => {
	const calls = new RemoteCalls();
	let seen: AbortSignal | undefined;
	const running = calls.run("t1", async (signal) => {
		seen = signal;
		await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
		return { ok: false as const, cancelled: true as const };
	});

	await Promise.resolve();
	assert.ok(seen, "work was given no signal, so nothing could ever cancel it");
	calls.cancel("t1");
	assert.deepEqual(await running, { ok: false, cancelled: true });
});

test("a token already in flight is refused, silently", async () => {
	/*
	 * A second press arriving while the first is still running is a double-send, not a second
	 * operation — and two pushes racing for one repository is the thing worth preventing. Reported
	 * as a cancellation because the panel says nothing about those; an error would put a red bar on
	 * screen for something nobody did wrong.
	 */
	const calls = new RemoteCalls();
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let started = 0;

	const first = calls.run("t1", async () => {
		started++;
		await held;
		return ok;
	});
	await Promise.resolve();
	const second = await calls.run("t1", async () => {
		started++;
		return ok;
	});

	assert.deepEqual(second, { ok: false, cancelled: true });
	assert.equal(started, 1, "the second call must not have run");

	release();
	await first;
});

test("the token is released even when the work throws", async () => {
	// Otherwise one failure disables the button permanently, with nothing on screen to say why.
	const calls = new RemoteCalls();
	await assert.rejects(
		calls.run("t1", async () => {
			throw new Error("boom");
		}),
		/boom/,
	);
	assert.equal(calls.size, 0);

	// And the same token works again immediately afterwards.
	assert.deepEqual(await calls.run("t1", async () => ok), ok);
});

test("without a token the work still runs, and nothing is tracked", async () => {
	// This is the silent background fetch: nobody can see it, so nobody can cancel it.
	const calls = new RemoteCalls();
	let signal: AbortSignal | undefined = new AbortController().signal;
	const result = await calls.run(undefined, async (given) => {
		signal = given;
		return ok;
	});
	assert.deepEqual(result, ok);
	assert.equal(signal, undefined, "no token means no controller to sign it with");
	assert.equal(calls.size, 0);
});

test("cancelling a token that is not running is ignored", async () => {
	// It may have finished a moment before the click landed; that is not an error.
	const calls = new RemoteCalls();
	assert.doesNotThrow(() => calls.cancel("never-started"));
});

test("two different tokens run side by side", async () => {
	const calls = new RemoteCalls();
	let releaseA = () => {};
	const a = calls.run("a", async () => {
		await new Promise<void>((resolve) => {
			releaseA = resolve;
		});
		return ok;
	});
	await Promise.resolve();
	const b = await calls.run("b", async () => ok);

	assert.deepEqual(b, ok);
	assert.equal(calls.size, 1, "b released its own token, a is still holding one");
	releaseA();
	await a;
	assert.equal(calls.size, 0);
});
