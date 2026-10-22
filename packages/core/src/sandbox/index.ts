/**
 * Which sandbox the tools use.
 *
 * Everything that runs a command asks here rather than importing a spawn, so replacing the sandbox
 * is one `useSandbox` call instead of a search through the tools. Neither host binds one: unbound is
 * the local sandbox, and tests bind stubs.
 */

import type { Sandbox } from "./types.ts";
import { LocalSandbox } from "./local.ts";

const BUILT_IN = new LocalSandbox();
let bound: Sandbox | null = null;

export function useSandbox(next: Sandbox | null): void {
	bound = next;
}

export function getSandbox(): Sandbox {
	return bound ?? BUILT_IN;
}

export { primeCommandPath } from "./login-path.ts";
export { sandboxModeFor } from "./mode-for.ts";
export { looksDenied, selectRunner, useSandboxRunner } from "./backend.ts";
