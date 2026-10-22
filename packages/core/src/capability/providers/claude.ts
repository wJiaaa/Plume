/**
 * Claude Code's project-level skills, `.claude/skills`.
 *
 * Skills live there in a layout close enough to ours that the same loader reads them, and its
 * project-level directory is one people genuinely share. User-level `~/.claude/skills` is not read:
 * your private skills following you into someone else's repository is a surprise nobody asked for.
 * Slash commands under `.claude/commands` are read by `commands/loader.ts`, not here.
 *
 * Priority 80: below our own directories, above `.agents/`, because it is the format ours
 * is closest to and a collision between the two is most likely to be the same file copied across.
 */

import { join } from "node:path";
import { loadSkills, type Skill } from "../../skills/loader.ts";
import type { CapabilityId, CapabilityProvider, DiscoveryContext, ProviderResult, Sourced } from "../types.ts";

const ID = "claude";
const LABEL = "Claude Code";

export const claudeProvider: CapabilityProvider = {
	id: ID,
	label: LABEL,
	priority: 80,
	supplies: ["skill"],

	async load(kind: CapabilityId, ctx: DiscoveryContext): Promise<ProviderResult> {
		if (kind !== "skill" || !ctx.cwd) return { items: [] };
		const dir = join(ctx.cwd, ".claude", "skills");
		const { skills, diagnostics } = await loadSkills([{ dir, source: "workspace" }]);
		return {
			items: skills.map((s) => ({ ...s, provenance: { provider: ID, providerLabel: LABEL, path: s.path, scope: "project", depth: 0 } }) as Sourced<Skill>),
			// The loader's severity, kept: a skill that loaded with a warning is not one that failed to
			// load, and the settings page counts only the latter.
			diagnostics: diagnostics.map((d) => ({ path: d.path, message: d.message, severity: d.severity ?? ("error" as const) })),
			watched: [dir],
		};
	},
};
