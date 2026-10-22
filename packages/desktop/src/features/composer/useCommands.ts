import { translate } from "../../i18n/translate.ts";
import { useEffect, useMemo, useState } from "react";
import { rankCommands, resolveCommand } from "@plume/core/commands-view";
import { bridge } from "../../services/index.ts";
import { useApp } from "../../store/index.ts";
import { commandCompletion, commandDecoration, commandEntries, type CommandEntry } from "./command-catalog.ts";
import { useCompletionList } from "./useCompletionList.ts";

export function useCommands(text: string, cwd: string, sessionId: string | null, field: React.RefObject<HTMLTextAreaElement | null>, setText: (text: string) => void) {
	const nonce = useApp((state) => state.extensionsNonce);
	const [catalog, setCatalog] = useState<{ cwd: string; entries: CommandEntry[] } | null>(null);
	const list = useCompletionList(text, field, setText, commandCompletion, cwd);
	const commandMode = list.completion !== null;
	useEffect(() => {
		let alive = true;
		/*
		 * MCP prompt 和磁盘上的命令分开取：前者可能要临时连一台服务器（新对话还没有会话），慢的那一边
		 * 不该拖住命令和技能先出现。问不到 prompt 就当没有，菜单照常。
		 * 包一层 async：同步抛出（桥上没有这个方法）也要落进 catch，不能连带命令和技能一起挂掉。
		 */
		const prompts = (async () => bridge.commands.prompts(sessionId))().catch(() => []);
		void bridge.commands.list(cwd).then(async (result) => {
			if (!alive) return;
			setCatalog({ cwd, entries: commandEntries(result.commands, result.skills ?? []) });
			const found = await prompts;
			if (alive && found.length > 0) setCatalog({ cwd, entries: commandEntries(result.commands, result.skills ?? [], found) });
		}).catch((cause) => {
			if (alive) useApp.getState().notify(translate("commands.readFailed", { reason: cause instanceof Error ? cause.message : String(cause) }), "error");
		});
		return () => { alive = false; };
	}, [cwd, nonce, commandMode, sessionId]);
	const entries = useMemo(() => catalog?.cwd === cwd ? catalog.entries : commandEntries([], []), [catalog, cwd]);
	const { term, listening } = list;
	const matches = useMemo(() => listening && term !== null ? rankCommands(entries, term) : [], [entries, term, listening]);
	const current = list.activeIn(matches.length);
	const pick = (command: CommandEntry) => list.replace(`/${command.name}`);
	return {
		id: list.id, matches, term: term ?? "", active: current, keyboardSelection: list.keyboardSelection, pick,
		hover: list.hover,
		decoration: commandDecoration(text, entries),
		change: list.change,
		select: list.select,
		focus: list.focus,
		blur: list.blur,
		/** 回车选中的正好就是已经打全的那一条：直接发出去，不必再补一遍。 */
		keyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>, submit: () => void) => list.keyDown(event, matches.length, (index, key) => {
			const chosen = matches[index];
			if (key === "Enter" && resolveCommand(entries, term ?? "")?.name === chosen.name) submit(); else pick(chosen);
		}),
	};
}
