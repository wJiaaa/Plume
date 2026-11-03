import assert from "node:assert/strict";
import { test } from "node:test";
import { peerStats, waitOutcome } from "../scripts/audit-peers.ts";

const call = (name: string, text: string, extra: { isError?: boolean; kind?: string } = {}) => ({ name, isError: false, text, ...extra });

test("old ask/wait results without details are classified by their wording", () => {
	assert.equal(waitOutcome(call("ask_session", "X was still working after 120 seconds.", { isError: true })), "timeout");
	assert.equal(waitOutcome(call("wait_for_session", 'No running session is addressed "self".', { isError: true })), "address");
	assert.equal(waitOutcome(call("wait_for_session", "Your user spoke to you, so you stopped waiting.")), "person");
	assert.equal(waitOutcome(call("wait_for_session", "A notice from another session arrived, so you stopped waiting.")), "notice");
	assert.equal(waitOutcome(call("ask_session", "A message from another session arrived, so you stopped waiting.")), "notice");
	assert.equal(waitOutcome(call("ask_session", "anything", { kind: "sent" })), "sent", "details.kind wins over the text");
});

test("letters are counted by kind and by whether they opened a turn; only sessions with traffic are involved", () => {
	const stats = peerStats([
		{
			calls: [call("notify_session", "Delivered", { kind: "delivered" }), call("notify_session", "Delivered", { kind: "delivered" }), call("bash", "")],
			arrivals: [
				{ steered: true, letters: [{}, { request: true }] },
				{ steered: false, letters: [{ answer: "replied" }] },
			],
		},
		{ calls: [call("read", "")], arrivals: [] },
	]);
	assert.equal(stats.involvedSessions, 1);
	assert.deepEqual(stats.calls, { notify_session: 2 });
	assert.deepEqual(stats.letters, { notice: 1, request: 1, "answer:replied": 1 });
	assert.deepEqual(stats.arrivals, { steered: 1, opened: 1 });
	assert.equal(stats.noticesPerInvolvedSession, 2);
});
