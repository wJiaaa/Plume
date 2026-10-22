/**
 * Skills that come from code rather than from disk.
 *
 * The desktop registers its browser skill here at boot (`kernel/host.ts` builds and binds the
 * registry); every session's plugin provider then reads `registeredSkills()`. Process-wide, unlike
 * a host's tools, which arrive per session as `extraTools` — ADR-0054 has why that asymmetry is left
 * as it is for now. Unbound, there are simply no code-provided skills; the session still loads
 * everything on disk.
 */

import type { Skill } from "./loader.ts";

export interface SkillRegistry {
	/**
	 * Contribute skills.
	 *
	 * Skills normally arrive as directories on disk, which is right for something a user writes.
	 * This is the other door: a host that brings its own procedures without asking the user to
	 * place files for it. Returns the disposer that withdraws exactly this set.
	 */
	register(skills: Skill[]): () => void;
	all(): Skill[];
}

export function createSkillRegistry(): SkillRegistry {
	const sets: Skill[][] = [];
	return {
		register(skills) {
			sets.push(skills);
			return () => {
				const at = sets.indexOf(skills);
				if (at >= 0) sets.splice(at, 1);
			};
		},
		all() {
			// The later registration wins on a name, so a host can override one it inherited rather
			// than having to prevent it from loading.
			const byName = new Map<string, Skill>();
			for (const set of sets) for (const skill of set) byName.set(skill.name, skill);
			return [...byName.values()];
		},
	};
}

let bound: SkillRegistry | null = null;

export function useSkillRegistry(next: SkillRegistry | null): void {
	bound = next;
}

export function registeredSkills(): Skill[] {
	return bound?.all() ?? [];
}
