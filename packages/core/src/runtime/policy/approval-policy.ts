/**
 * Which approval policy is in force.
 *
 * Neither host binds one, so the app, the CLI and the tests all judge with the built-in blacklist
 * below; `useApprovalPolicy` is the seam a test swaps.
 */

import { assessCommand, assessWrite } from "../../tools/risk.ts";
import { assessNetwork } from "../../tools/risk-network.ts";
import type { RiskCode, RiskParams } from "../../tools/risk-reasons.ts";
import type { ApprovalRequest } from "../../types.ts";

export interface ApprovalVerdict {
	risky: boolean;
	/** Why, as a sentence, when it is risky. Shown as is wherever `code` is absent. */
	reason?: string;
	/**
	 * Which built-in rule found it, when one did. A host says it in its own language from this
	 * (`risk.<code>` in the desktop's catalogues); a policy with rules of its own leaves it out and
	 * gives only `reason`.
	 */
	code?: RiskCode;
	/** The values `code`'s sentence needs. */
	params?: RiskParams;
}

export interface ApprovalPolicy {
	/**
	 * Judge one action.
	 *
	 * `subject` is the command, path or URL — the thing the decision is actually about, rather
	 * than the prose the model wrapped it in.
	 */
	assess(kind: string, subject: string, cwd: string, request?: ApprovalRequest): ApprovalVerdict;
}

export const builtInApprovalPolicy: ApprovalPolicy = {
	assess(kind, subject, cwd, request) {
		if (kind === "bash") return assessCommand(subject, cwd);
		if (kind === "edit" || kind === "write") return assessWrite(subject, cwd);
		/*
		 * A read that got this far has already been judged, by `assessRead`.
		 *
		 * Unlike a command or a write — where this seam *is* the judgement — the reading tools do
		 * not ask about a path unless it already left the workspace. Re-deciding here could only
		 * overturn that, and `risky: false` would mean the question is composed, shown to nobody,
		 * and answered yes by the thing that was supposed to be asking.
		 *
		 * The line below is what the fallback would do anyway. It is written out because the two
		 * agree by accident rather than by design: the fallback is "a kind this policy has never
		 * heard of", and read is a kind it has. Someone narrowing that fallback later should have
		 * to delete this line on purpose.
		 */
		if (kind === "read") return { risky: true };
		if (kind === "network") {
				/*
				 * Three answers folded into this seam's two.
				 *
				 * `assessNetwork` distinguishes "refuse outright" from "ask a person", and this
				 * interface only has "risky or not". Both non-allow answers arrive here as risky,
				 * which is the safe fold — the refusals that matter are enforced at the tool,
				 * before anything reaches a prompt.
				 */
				const verdict = assessNetwork({ url: subject });
				if (verdict.decision === "allow") return { risky: false };
				return { risky: true, reason: verdict.reason, code: verdict.code, ...(verdict.params ? { params: verdict.params } : {}) };
			}
		/*
		 * An MCP tool. Its annotations are the server's own word, so they only move one way on their
		 * own: `destructiveHint` makes the call risky with a reason the card can show, while
		 * `readOnlyHint` lets it through only when the person has said they trust this server's
		 * claims (`trusted`). Why, at length, is in `mcp/tool.ts`.
		 */
		if (kind === "mcp") {
			if (request?.destructive === true) return { risky: true, code: "mcp-destructive" };
			return { risky: !(request?.readOnly === true && request.trusted === true) };
		}
		// An unfamiliar kind is one this policy was not written for, so it defers to a person.
		return { risky: true };
	},
};

let bound: ApprovalPolicy | null = null;

export function useApprovalPolicy(next: ApprovalPolicy | null): void {
	bound = next;
}

export function approvalPolicy(): ApprovalPolicy {
	return bound ?? builtInApprovalPolicy;
}
