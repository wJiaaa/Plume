import type { SessionMeta } from "@plume/core";
import { translate } from "../../i18n/translate.ts";
import { useApp, useRunningBesideKey } from "../../store/index.ts";
import { ActionSpinner } from "../../ui/motion/loaders.tsx";
import { groupActivity } from "./group-activity.ts";

export function GroupActivity({ sessions, collapsed, count }: { sessions: readonly Pick<SessionMeta, "id">[]; collapsed: boolean; count: number }) {
	const ids = sessions.map((session) => session.id);
	const sideKey = useRunningBesideKey(collapsed ? ids : []);
	// A primitive return, so a heading only wakes when its own count changes.
	const running = useApp((state) =>
		collapsed ? groupActivity(ids, state.activity, state.activeSessionId, new Set(sideKey ? sideKey.split("\0") : [])).counts.running : 0,
	);
	if (!collapsed) return null;
	// Only running work is loading. Settled or waiting sessions keep their own row indicators.
	if (running === 0) return count > 0 ? count : null;
	return (
		<span
			className="inline-flex h-3.5 w-3.5 items-center justify-center"
			data-ly-group-running={running}
			aria-label={translate("groupActivity.running", { n: running })}
		>
			<ActionSpinner size={14} className="text-accent" />
		</span>
	);
}
