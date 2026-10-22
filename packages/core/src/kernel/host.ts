/**
 * What every host does before its first session.
 *
 * The window and the terminal both run this. It used to build a plugin context and copy each of its
 * services onto a module-level seam; every service was the same object the seam already fell back
 * to, so that layer is gone (ADR-0054) and what is left is the part that is really per host: the
 * session store, and somewhere for the host to register skills of its own.
 *
 * Nothing else in core imports this directory — `.dependency-cruiser.cjs`
 * (`core-does-not-reach-the-host-assembly`) holds that, so it stays the top of the package.
 */

import type { SessionStorage } from "../session/storage.ts";
import { SessionStore } from "../session/store.ts";
import { createSkillRegistry, useSkillRegistry, type SkillRegistry } from "../skills/registry.ts";

export interface HostKernel {
	/** Where this host's sessions are kept. Hosts build their sessions on this one. */
	storage: SessionStorage;
	/** Skills the host brings in code; every session reads them through `registeredSkills()`. */
	skills: SkillRegistry;
	/** Unbinds the skill registry. A second call is a no-op. */
	dispose(): void;
}

/**
 * One host per process, enforced rather than assumed.
 *
 * The skill registry, like every other seam, is module-level: a second host would silently re-point
 * sessions already running under the first, and disposing either would unbind both. ADR-0039 has
 * why the seams stay per process; until a process needs two hosts, booting a second one is an
 * error, not a surprise.
 */
let booted = false;

export function bootHostKernel(): HostKernel {
	if (booted) throw new Error("bootHostKernel: a host is already running in this process; dispose it first.");
	// Built before anything is marked or bound, so a store that fails to construct leaves no trace.
	const storage = new SessionStore();
	const skills = createSkillRegistry();
	booted = true;
	useSkillRegistry(skills);
	let disposed = false;
	return {
		storage,
		skills,
		dispose() {
			// A second dispose of this host must not unbind a host booted since.
			if (disposed) return;
			disposed = true;
			useSkillRegistry(null);
			booted = false;
		},
	};
}
