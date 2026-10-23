/**
 * A list's conversation rows, each followed by the conversations started from its suggestions.
 *
 * The nesting itself is decided in `lib/sidebar-grouping.ts` (`nestSpawned`); this only draws it, the
 * same way in every section, so a project, 「置顶」 and 「聊天」 cannot each grow their own version.
 */

import { Fragment, useEffect, useMemo } from "react";
import type { SessionMeta } from "@plume/core";
import { SessionRow, type RowActions } from "./SessionRow.tsx";
import { Collapsible } from "./Collapsible.tsx";
import { useFoldedThreads } from "./folded-threads.ts";
import { useApp } from "../../store/index.ts";
import { useLayout } from "../../app/layout.tsx";
import { projectLabel } from "../../lib/project-identity.ts";
import { withSpawned } from "../../lib/sidebar-grouping.ts";

const NO_PROJECTS: never[] = [];

export function SessionRows({ sessions, spawned, actions, project }: {
	sessions: SessionMeta[];
	spawned: Record<string, SessionMeta[]>;
	actions: RowActions;
	/** Name each top-level row's project on hover — 「置顶」, where no folder row says it. */
	project?: boolean;
}) {
	const projects = useApp((s) => s.settings?.projects ?? NO_PROJECTS);
	return (
		<>
			{sessions.map((session) => {
				const label = project ? projectLabel(projects, session) : undefined;
				return spawned[session.id] ? (
					<Thread key={session.id} session={session} project={label} spawned={spawned} actions={actions} />
				) : (
					<SessionRow key={session.id} session={session} project={label} actions={actions} />
				);
			})}
		</>
	);
}

/**
 * A row with follow-ups under it, which it can fold away.
 *
 * Only the top-level row folds: the follow-ups are drawn one indent deep however they nest, so a fold
 * in the middle of that run would hide rows that look like siblings rather than children.
 *
 * The row and its follow-ups share one flex item so a folded run takes no list gap with it; the gap
 * the follow-ups need is put back inside the fold.
 */
function Thread({ session, project, spawned, actions }: {
	session: SessionMeta;
	project?: string;
	spawned: Record<string, SessionMeta[]>;
	actions: RowActions;
}) {
	const { compact } = useLayout();
	const followUps = useMemo(() => withSpawned([session], spawned).slice(1), [session, spawned]);
	const folded = useFoldedThreads((s) => s.folded.includes(session.id));
	const setFolded = useFoldedThreads((s) => s.setFolded);
	/*
	 * 打开的会话不能藏在收起的一组里：在父会话里点建议新开一条、从命令面板跳过去，都会落到这里，
	 * 侧边栏上却找不到亮着的那一行。真的展开而不是临时露出来，否则切走以后它又自己收回去。
	 */
	const holdsOpen = useApp((s) => followUps.some((child) => child.id === (s.pendingSessionId ?? s.activeSessionId)));
	useEffect(() => {
		if (folded && holdsOpen) setFolded(session.id, false);
	}, [folded, holdsOpen, session.id, setFolded]);

	return (
		<div className="flex flex-col">
			<SessionRow session={session} project={project} followUps={followUps} actions={actions} />
			<Collapsible open={!folded}>
				<div className={`flex flex-col ${compact ? "gap-[5px] pt-[5px]" : "gap-[2px] pt-[2px]"}`}>
					<Spawned parentId={session.id} spawned={spawned} actions={actions} />
				</div>
			</Collapsible>
		</div>
	);
}

/** One indent however deep it goes: a suggestion's suggestion is still a follow-up of the same work. */
function Spawned({ parentId, spawned, actions }: { parentId: string; spawned: Record<string, SessionMeta[]>; actions: RowActions }) {
	return (
		<>
			{(spawned[parentId] ?? []).map((child) => (
				<Fragment key={child.id}>
					<SessionRow session={child} nested actions={actions} />
					<Spawned parentId={child.id} spawned={spawned} actions={actions} />
				</Fragment>
			))}
		</>
	);
}
