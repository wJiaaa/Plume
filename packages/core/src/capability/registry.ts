/**
 * The registry: run every provider, merge what they found, and be able to say why.
 *
 * The whole of the interesting behaviour is in `load`, and it is short because the hard parts are
 * decisions rather than code:
 *
 *   A provider that throws must not take the others down. Discovery walks other people's
 *   directories, and one of them will eventually be a broken symlink or a file the user cannot
 *   read. The failure becomes a diagnostic and the rest of the load proceeds.
 *
 *   Losers are kept. A settings page that can only show what won cannot answer the question people
 *   actually ask, which is why the thing they wrote is not running.
 */

import { capabilityOf } from "./kinds.ts";
import type { CapabilityId, CapabilityProvider, CapabilityResult, Diagnostic, DiscoveryContext, LoadOptions, SourceMeta, Sourced } from "./types.ts";

export interface RegistryDeps {
	/** Plume's configuration root. */
	home: string;
	/** The operating system's home directory. */
	userHome: string;
	/** Resolve the repository root for a working directory, if there is one. */
	repoRoot?(cwd: string): Promise<string | null> | string | null;
}

const TRACE = process.env.PLUME_TRACE === "capability";

export class CapabilityRegistry {
	private readonly providers: CapabilityProvider[] = [];
	private readonly deps: RegistryDeps;

	constructor(deps: RegistryDeps) {
		this.deps = deps;
	}

	register(provider: CapabilityProvider): void {
		if (this.providers.some((p) => p.id === provider.id)) {
			throw new Error(`Capability provider "${provider.id}" is already registered.`);
		}
		this.providers.push(provider);
		/*
		 * Sort on insert rather than on load. Load happens per session and per kind; registration
		 * happens once. Doing it here also makes the order a property of the list rather than of
		 * whoever called load, which matters for the tie-break: equal priorities keep registration
		 * order, and that is the documented way `PLUME.md` beats `AGENTS.md`.
		 */
		this.providers.sort((a, b) => b.priority - a.priority);
	}

	async load<T>(kind: CapabilityId, options: LoadOptions): Promise<CapabilityResult<T>> {
		const started = Date.now();
		const capability = capabilityOf(kind);
		const diagnostics: Diagnostic[] = [];
		const timings: { provider: string; ms: number; count: number }[] = [];
		const watched = new Set<string>();

		const selected = this.providers.filter((provider) => provider.supplies.includes(kind));
		const repoRoot = options.cwd ? ((await this.deps.repoRoot?.(options.cwd)) ?? null) : null;
		const ctx: DiscoveryContext = { cwd: options.cwd, home: this.deps.home, userHome: this.deps.userHome, repoRoot };

		/*
		 * Providers run in parallel and are awaited together, so one slow directory walk does not
		 * serialise behind another. They are independent by construction — a provider is handed a
		 * context and returns items, with nothing shared — so the only ordering that matters is the
		 * priority order applied to the results, below.
		 */
		const results = await Promise.all(
			selected.map(async (provider) => {
				const at = Date.now();
				try {
					const result = await provider.load(kind, ctx);
					timings.push({ provider: provider.id, ms: Date.now() - at, count: result.items.length });
					for (const dir of result.watched ?? []) watched.add(dir);
					if (result.diagnostics) diagnostics.push(...result.diagnostics);
					return { provider, items: result.items as Sourced<T>[] };
				} catch (error) {
					/*
					 * A provider that throws is a bug in that provider, and the rest of the load is
					 * still worth having. The diagnostic names the provider because otherwise the
					 * only visible symptom is a capability that quietly stopped existing.
					 */
					timings.push({ provider: provider.id, ms: Date.now() - at, count: 0 });
					diagnostics.push({
						path: provider.id,
						message: `来源“${provider.label}”加载 ${kind} 时失败：${error instanceof Error ? error.message : String(error)}`,
						severity: "error",
						hint: "其余来源不受影响；这一个的条目这次没有加载。",
					});
					return { provider, items: [] as Sourced<T>[] };
				}
			}),
		);

		const items: Sourced<T>[] = [];
		const all: CapabilityResult<T>["all"] = [];
		/** key → the source that won it, so a loser can point at the winner. */
		const owners = new Map<string, SourceMeta>();

		for (const { provider, items: found } of results) {
			for (const item of found) {
				if (!item?.provenance) {
					diagnostics.push({
						path: provider.id,
						message: `来源“${provider.label}”返回了一个没有 provenance 的条目，已丢弃。`,
						severity: "error",
					});
					continue;
				}

				const key = capability.key(item as never);
				const owner = owners.get(key);
				const asked = options.preferred?.[`${kind}:${key}`] === item.provenance.path;
				if (owner && !asked) {
					all.push({ ...item, shadowedBy: owner });
					continue;
				}
				if (owner && asked) {
					/*
					 * The user named this file. Providers arrive in priority order, so the holder
					 * is already filed as the winner: take it back out, file it as beaten by this
					 * one, and repoint every loser that was told the old holder had won.
					 */
					const at = items.findIndex((existing) => capability.key(existing as never) === key);
					if (at !== -1) {
						const [beaten] = items.splice(at, 1);
						all.splice(all.indexOf(beaten), 1);
						all.push({ ...beaten, shadowedBy: item.provenance });
					}
					for (const entry of all) {
						if (entry.shadowedBy && capability.key(entry as never) === key) entry.shadowedBy = item.provenance;
					}
				}
				owners.set(key, item.provenance);
				items.push(item);
				all.push(item);
			}
		}

		if (TRACE) {
			const slow = [...timings].sort((a, b) => b.ms - a.ms);
			console.error(`[capability] ${kind}: ${Date.now() - started}ms  ${slow.map((t) => `${t.provider}=${t.ms}ms/${t.count}`).join(" ")}`);
		}

		return { items, all, diagnostics, watched: [...watched] };
	}
}
