/**
 * The Git panel's release flow: what the next version would be, bumping it, and watching the CI
 * workflow that publishes it. Part of `window.plume.git`; see `git.ts`.
 */

export interface ReleaseInfo {
	currentVersion: string;
	latestTag: string | null;
	commitsSinceTag: { sha: string; shortSha: string; subject: string; author: string; date: string }[];
	suggestedVersion: {
		patch: string;
		minor: string;
		major: string;
	};
}

interface WorkflowJobStep {
	name: string;
	status: string;
	conclusion: string | null;
	number: number;
	startedAt?: string;
	completedAt?: string;
}

export interface WorkflowJob {
	id: number;
	name: string;
	status: string;
	conclusion: string | null;
	url?: string;
	startedAt?: string;
	completedAt?: string;
	steps?: WorkflowJobStep[];
}

export interface WorkflowRunSummary {
	id: number;
	name: string;
	displayTitle: string;
	event: string;
	status: "queued" | "in_progress" | "completed" | "waiting" | "unknown";
	conclusion: "success" | "failure" | "cancelled" | "timed_out" | "skipped" | null;
	headBranch: string;
	headSha: string;
	createdAt: string;
	url: string;
	jobs?: WorkflowJob[];
}

export interface WorkflowRunStatus {
	id: number;
	name?: string;
	displayTitle?: string;
	event?: string;
	status: "queued" | "in_progress" | "completed" | "waiting" | "unknown";
	conclusion: "success" | "failure" | "cancelled" | "timed_out" | "skipped" | null;
	url: string;
	createdAt?: string;
	headBranch?: string;
	headSha?: string;
	jobs: WorkflowJob[];
}

export interface ReleaseApi {
	releaseInfo(cwd: string): Promise<ReleaseInfo | null>;
	bumpVersion(cwd: string, newVersion: string): Promise<{ ok: boolean; error?: string }>;
	triggerDryRun(cwd: string): Promise<{ ok: boolean; runId?: number; error?: string }>;
	listWorkflowRuns(cwd: string, limit?: number): Promise<WorkflowRunSummary[]>;
	workflowRunStatus(cwd: string, runId: number): Promise<WorkflowRunStatus | null>;
	publishReleaseTag(cwd: string, version: string): Promise<{ ok: boolean; tag?: string; error?: string }>;
}
