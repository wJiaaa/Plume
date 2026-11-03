/**
 * The terminal pane, with xterm fetched when it is first wanted rather than at launch.
 *
 * The panel table names every pane statically, so `TerminalPane` imported directly put xterm
 * (about 0.5MB) in the startup graph: parsed and run on every launch, terminal or not. Behind
 * `lazy` it is its own chunk — and fetched on idle by `useTerminalPrewarm`, so the first open still
 * lands on a pane that is already there, the same way the shell behind it already is.
 */

import { Suspense, lazy } from "react";

const load = () => import("./TerminalPane.tsx");
const Pane = lazy(() => load().then((module) => ({ default: module.TerminalPane })));

/** Start fetching the pane's code; harmless to call again. */
export function preloadTerminalPane(): void {
	void load();
}

export function TerminalPane() {
	return (
		<Suspense fallback={null}>
			<Pane />
		</Suspense>
	);
}
