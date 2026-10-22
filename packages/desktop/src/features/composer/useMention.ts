import { useEffect, useMemo, useState } from "react";
import type { SessionMeta, SkillEntry } from "@plume/core";
import { bridge } from "../../services/index.ts";
import { baseName } from "../../lib/paths.ts";
import { useApp } from "../../store/index.ts";
import { useScopedWorkspace } from "../../app/session-scope.tsx";
import { useProjectFolders } from "../../store/project-folders.ts";
import { useAgentAvatars } from "../../store/agent-avatars.ts";
import {
	findMentionRanges,
	formatMention,
	parseMentionTrigger,
	rankMentions,
	type MentionFile,
	type MentionItem,
} from "./mention-catalog.ts";
import { useCompletionList } from "./useCompletionList.ts";

export function useMention(
	text: string,
	cwd: string,
	field: React.RefObject<HTMLTextAreaElement | null>,
	setText: (text: string) => void,
	onPickAction?: (actionId: string) => Promise<string | null>,
	onPickSession?: (session: { id: string; title: string }) => void,
) {
	const list = useCompletionList(text, field, setText, parseMentionTrigger, cwd);

	const [agents, setAgents] = useState<Array<{ id: string; name: string; description: string; avatar?: string }>>([]);
	const [skills, setSkills] = useState<SkillEntry[]>([]);
	const [sessions, setSessions] = useState<SessionMeta[]>([]);
	const [workspaceFiles, setWorkspaceFiles] = useState<MentionFile[]>([]);
	// Every folder this screen's project is made of; usually just the working directory. The live
	// slot's is the focused screen's, and the `@` under the screen beside it listed that project's files.
	const folders = useProjectFolders(useScopedWorkspace().workspace);
	const folderKey = folders.join("\0");

	const nonce = useApp((state) => state.extensionsNonce);
	const projects = useApp((state) => state.settings?.projects);

	const mentionMode = list.completion !== null;

	// Load candidates (skills, sessions, workspace files)
	useEffect(() => {
		if (!mentionMode) return;
		let alive = true;
		setSkills([]);
		setAgents([]);
		setWorkspaceFiles([]);

		// Fetch skills & plugins
		void bridge.commands.list(cwd).then((result) => {
			if (alive) { setSkills(result.skills); setAgents(result.agents ?? []); }
		}).catch(() => {});

		// Fetch sessions
		void bridge.sessions.list().then((list) => {
			if (alive) setSessions(list);
		}).catch(() => {});

		/*
		 * The top level of every source folder the project has.
		 *
		 * The working directory's entries stay relative, exactly as they were — `src/` is what you
		 * read and what gets inserted, and it resolves on its own. A second source folder cannot
		 * work that way: `src/` there would resolve against the working directory and name a file
		 * that does not exist, so those go in absolute and carry the folder's name as their origin
		 * so two `src/` rows are telling you apart.
		 */
		// Rebuilt from the key rather than closed over: `folders` is a fresh array on every render
		// of the composer, and depending on it would re-list every folder on each keystroke.
		const sources = folderKey ? folderKey.split("\0") : [];
		if (sources.length > 0) {
			void Promise.all(
				sources.map(async (folder, index) => {
					const entries = await bridge.files.list(folder).catch(() => []);
					const many = sources.length > 1;
					return entries.map((entry) => {
						const label = entry.isDirectory ? `${entry.name}/` : entry.name;
						return {
							path: index === 0 ? label : entry.isDirectory ? `${entry.path}/` : entry.path,
							label,
							origin: many ? baseName(folder) : undefined,
						};
					});
				}),
			)
				.then((lists) => {
					if (alive) setWorkspaceFiles(lists.flat());
				})
				.catch(() => {});
		}

		return () => {
			alive = false;
		};
	}, [cwd, folderKey, nonce, mentionMode]);

	const { term, listening } = list;

	const matches = useMemo(() => {
		if (!listening || term === null) return [];
		return rankMentions(term, {
			files: workspaceFiles,
			agents,
			sessions,
			projects,
			skills,
			allowAction: true,
		});
	}, [term, listening, workspaceFiles, sessions, projects, skills, agents]);

	const current = list.activeIn(matches.length);

	/* 选文件要等一个系统对话框：回来时框里的字要是已经变了，那段位置也就不作数了。 */
	function insertMentionText(tokenText: string) {
		if (field.current?.value !== text) return;
		list.replace(tokenText);
	}

	async function pick(item: MentionItem) {
		if (!list.completion) return;

		if (item.id === "action:compact") { insertMentionText("@compact"); return; }
		if (item.kind === "action") {
			list.dismiss();
			const token = await onPickAction?.(item.id);
			if (token) insertMentionText(token);
			return;
		}

		let token = "";
		if (item.kind === "plugin") {
			token = `/skill:${item.title}`;
		} else if (item.kind === "subagent") {
			token = `@${item.title}`;
		} else if (item.kind === "session") {
			if (item.data?.sessionId) onPickSession?.({ id: item.data.sessionId, title: item.title });
			insertMentionText("");
			return;
		} else if (item.kind === "file") {
			token = formatMention(item.data?.path ?? item.title);
		} else {
			token = `@${item.title}`;
		}

		insertMentionText(token);
	}

	// Decoration ranges for all mentions in the text
	const avatarOf = useAgentAvatars(agents.length > 0 ? agents : null);
	const mentionDecorations = useMemo(() => {
		// 点名的是名单里的一个智能体，就带上它的脸——输入框里那个 `@` 换成它。
		const named = new Set(agents.map((agent) => agent.name));
		return findMentionRanges(text).map((r) => ({
			start: r.start,
			end: r.end,
			...(named.has(r.inner) ? { kind: "subagent" as const, avatar: avatarOf(r.inner) } : {}),
		}));
	}, [text, agents, avatarOf]);

	return {
		id: list.id,
		matches,
		/** 菜单里那几个智能体的完整名单：它们的脸要按这份名单排，才和设置页里的是同一张。 */
		agents,
		term: term ?? "",
		active: current,
		keyboardSelection: list.keyboardSelection,
		hover: list.hover,
		pick,
		mentionDecorations,
		change: list.change,
		select: list.select,
		focus: list.focus,
		blur: list.blur,
		keyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => list.keyDown(event, matches.length, (index) => void pick(matches[index])),
	};
}
