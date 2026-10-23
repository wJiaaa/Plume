/**
 * What a `spawn_session` call leaves for the card that draws it.
 *
 * The main process writes it as the tool result's `details`, which the log keeps: a conversation
 * reopened tomorrow still has its card, with the prompt it would start with. The renderer reads it
 * back to draw the card (`SessionSuggestionCard`). Here because both sides need the shape.
 */

export const SPAWN_SESSION_TOOL = "spawn_session";
export const ARCHIVE_SESSION_TOOL = "archive_session";

export interface SessionSuggestionDetails {
	kind: "session_suggestion";
	title: string;
	summary: string;
	prompt: string;
	/** The model asked for the new conversation's first reply to come back here; the card's switch starts from it. */
	reportBack?: true;
}

export const REVIEW_SESSION_TOOL = "review_session";

/**
 * What a `review_session` call leaves: everything the main process needs to start the review session
 * when it sees the call end (`electron/session/review-session.ts`), and the row in the conversation
 * reads the title from. The session it started is found the way a started suggestion is, by its
 * `spawnedFrom` naming this call.
 */
export interface ReviewSessionDetails {
	kind: "review_session";
	/** The new session's name in the sidebar, already localised: 「审阅 · <subject>」. */
	title: string;
	/** What is under review, as the row in the conversation names it after 「审阅会话」: the target, or the conversation's title. */
	subject: string;
	/** What `/review` was pointed at; absent for the uncommitted local changes. */
	target?: string;
	effort?: "low" | "medium" | "high";
	/** The implementing conversation's hand-off; absent for a pull request, which has no implementation to hand off. */
	handoff?: ReviewHandoff;
}

/**
 * What the implementing conversation tells the review session, field by field, so the reviewer does not
 * have to guess at why or under what constraints the change was made. Each required field is checked
 * for length by the tool (`electron/session/review-brief.ts`).
 */
export interface ReviewHandoff {
	/** Why this was done: the problem the person hit or what they asked for. */
	background: string;
	/** The person's decisions and constraints, their own words in quotes. */
	decisions: string;
	/** What was actually done and how; where and why it departs from the plan. */
	implementation: string;
	files: { path: string; change: string }[];
	/** Deliberately not done, so it is not reported as missed. */
	outOfScope?: string;
	/** What the author knows is unverified, unfinished or doubtful. */
	unverified: string;
	/** Where the author most wants a second look. */
	focus?: string;
}
