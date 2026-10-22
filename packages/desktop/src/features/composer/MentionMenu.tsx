import type { MessageKey } from "../../i18n/messages/index.ts";
import { translate } from "../../i18n/translate.ts";
import { Minimize2, Bot, FileCode, FolderArchive, MessageSquare, Paperclip, Puzzle } from "../../ui/icons/index.ts";
import { ScrollText } from "../../ui/scroll/ScrollText.tsx";
import { AgentAvatar } from "../../ui/avatar/AgentAvatar.tsx";
import { useAgentAvatars } from "../../store/agent-avatars.ts";
import { CompletionPopup } from "./CompletionPopup.tsx";
import type { MentionItem, MentionKind } from "./mention-catalog.ts";

/** Section headings, as keys — this table is built at import time. */
const GROUPS: Record<MentionKind, MessageKey> = {
	action: "mention.actions",
	file: "mention.filesAndFolders",
	subagent: "mention.agents",
	plugin: "mention.pluginsAndSkills",
	session: "mention.sessions",
};

function iconOf(item: MentionItem) {
	if (item.id === "action:compact") return Minimize2;
	switch (item.kind) {
		case "action": return Paperclip;
		case "subagent": return Bot;
		case "plugin": return Puzzle;
		case "session": return MessageSquare;
		default: return item.title.endsWith("/") ? FolderArchive : FileCode;
	}
}

export function MentionMenu({
	items,
	agents,
	term,
	active,
	keyboardSelection,
	onPick,
	onHover,
	id,
}: {
	items: MentionItem[];
	/** 智能体的完整名单，给它们排脸——见 `useAgentAvatars`。 */
	agents?: readonly { name: string; avatar?: string }[];
	term: string;
	active: number;
	keyboardSelection: boolean;
	onPick: (item: MentionItem) => void;
	onHover: (index: number) => void;
	id: string;
}) {
	const avatarOf = useAgentAvatars(agents && agents.length > 0 ? agents : null);
	return <CompletionPopup id={id} items={items} term={term} active={active} keyboardSelection={keyboardSelection} onPick={onPick} onHover={onHover}
		label={translate("mention.menu")} className="ly-mention-menu" optionClassName="ly-mention-option"
		keyOf={(item) => item.id} groupOf={(item) => item.kind} heading={(item) => translate(GROUPS[item.kind])}
		row={(item, index, selected) => {
			const Icon = iconOf(item);
			return {
				label: [item.title, item.description, item.origin].filter(Boolean).join(translate("common.comma")),
				/* Which one this is, apart from the label. The label is three translated pieces joined by a
				   comma, so anything matching on it moves with the language; the title is the agent's own
				   name and does not. */
				data: { "data-mention-kind": item.kind, "data-mention-title": item.title },
				content: <>
					{/*
					 * 智能体用它自己的脸，别的还是线性图标。高亮的那一行眼睛跟着指针、身子弹一下：
					 * 键盘上下翻的时候，那张脸就是「选中了谁」最快的回答。
					 */}
					{item.kind === "subagent" ? (
						<AgentAvatar avatar={avatarOf(item.data?.subagentId ?? item.title)} size={18} seed={item.title} host=".ly-mention-option"
							cheer={keyboardSelection && selected ? index : null} />
					) : (
						<Icon size={16} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
					)}
					<ScrollText text={item.title} className="min-w-0 max-w-[42%] shrink-0 text-ink" />
					{item.description && <ScrollText text={item.description} className="min-w-0 flex-1 text-ink-muted" />}
					{item.origin && <ScrollText text={item.origin} className="ml-auto min-w-0 max-w-[20%] shrink-0 text-detail text-ink-faint" />}
				</>,
			};
		}} />;
}
