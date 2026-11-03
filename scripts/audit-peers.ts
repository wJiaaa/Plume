/**
 * 第 15 节：会话之间的消息到底怎么用、成没成。单拿出来是为了能测：`session-audit.ts` 一 import 就去读本机数据库。
 *
 * 问答改成不阻塞（ADR-0060）之前，`ask_session` / `wait_for_session` 是就地等的，结果看工具返回；之后问是发出即
 * 返回，答复作为一封 `answer` 信送回提问方，结果看收到的信。两种记录都认，改前改后才能对照。
 */

export const PEER_TOOLS = ["list_sessions", "read_session", "ask_session", "reply_session", "notify_session", "wait_for_session"] as const;

/** 一次会话间工具调用和它的结果，只留分类要用的几样。 */
export interface PeerCall {
	name: string;
	isError: boolean;
	/** 结果的 `details.kind`；旧记录的出错结果没有。 */
	kind?: string;
	text: string;
}

/** 收到的一条来信消息（几封信可能并成一条）。 */
export interface PeerArrival {
	/** 插进了正在跑的那一轮；否则是为它开的一轮。 */
	steered: boolean;
	letters: { request?: boolean; answer?: string }[];
}

export interface PeerSession {
	calls: PeerCall[];
	arrivals: PeerArrival[];
}

/**
 * 问、等的结果归成几类。新记录带 `details.kind`；旧记录只有出错与否和正文，按正文开头认——
 * 那几句话写在 `peer-tools.ts` 里，改前的版本一直是这样说的。
 */
export function waitOutcome(call: PeerCall): string {
	if (call.kind) return call.kind;
	if (/No running session|is not reachable|matches several sessions|That address is this session|is a sub-agent/.test(call.text)) return "address";
	if (/was still working after/.test(call.text)) return "timeout";
	if (/Your user spoke to you/.test(call.text)) return "person";
	if (/(message|notice) from another session arrived/.test(call.text)) return "notice";
	return call.isError ? "refused" : "other";
}

function bump(map: Record<string, number>, key: string): void {
	map[key] = (map[key] ?? 0) + 1;
}

export function peerStats(sessions: PeerSession[]) {
	const calls: Record<string, number> = {};
	const ask: Record<string, number> = {};
	const wait: Record<string, number> = {};
	const letters: Record<string, number> = {};
	let steered = 0;
	let opened = 0;
	let involved = 0;
	for (const session of sessions) {
		const peerCalls = session.calls.filter((call) => (PEER_TOOLS as readonly string[]).includes(call.name));
		if (peerCalls.length > 0 || session.arrivals.length > 0) involved++;
		for (const call of peerCalls) {
			bump(calls, call.name);
			if (call.name === "ask_session") bump(ask, waitOutcome(call));
			if (call.name === "wait_for_session") bump(wait, waitOutcome(call));
		}
		for (const arrival of session.arrivals) {
			if (arrival.steered) steered++;
			else opened++;
			for (const letter of arrival.letters) bump(letters, letter.answer ? `answer:${letter.answer}` : letter.request ? "request" : "notice");
		}
	}
	return {
		involvedSessions: involved,
		calls,
		ask,
		wait,
		letters,
		arrivals: { steered, opened },
		noticesPerInvolvedSession: involved ? +((calls.notify_session ?? 0) / involved).toFixed(2) : 0,
	};
}
