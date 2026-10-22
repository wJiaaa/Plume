import { Box, Eraser, FoldVertical, ListOrdered, MessageCirclePlus, Server, Settings2, SquareTerminal } from "../../ui/icons/index.ts";
import { ScrollText } from "../../ui/scroll/ScrollText.tsx";
import type { CommandEntry } from "./command-catalog.ts";
import { CompletionPopup } from "./CompletionPopup.tsx";
import { useI18n, type MessageKey } from "../../i18n/index.ts";

const GROUPS: Record<CommandEntry["kind"], MessageKey> = {
	builtin: "command.builtin",
	command: "command.custom",
	skill: "command.skills",
	prompt: "command.mcpPrompts",
};

function iconOf(command: CommandEntry) {
	if (command.kind === "skill") return Box;
	if (command.kind === "prompt") return Server;
	switch (command.action) {
		case "compact": return FoldVertical;
		case "clear": return Eraser;
		case "manage-commands": return Settings2;
		case "aside": return MessageCirclePlus;
		case "plan": return ListOrdered;
		default: return SquareTerminal;
	}
}

/** One anchored list: names, descriptions and origins share a stable centre line. */
export function CommandMenu({ commands, active, keyboardSelection, onPick, onHover, id, term }: {
	commands: CommandEntry[];
	term: string;
	active: number;
	keyboardSelection: boolean;
	onPick: (command: CommandEntry) => void;
	onHover: (index: number) => void;
	id: string;
}) {
	const { t } = useI18n();
	return <CompletionPopup id={id} items={commands} term={term} active={active} keyboardSelection={keyboardSelection} onPick={onPick} onHover={onHover}
		label={t("command.slash")} className="ly-command-menu" optionClassName="ly-command-option"
		keyOf={(command) => `${command.kind}:${command.name}`} groupOf={(command) => command.kind} heading={(command) => t(GROUPS[command.kind])}
		row={(command) => {
			const Icon = iconOf(command);
			return {
				label: [command.name, command.description, command.origin].filter(Boolean).join(t("common.comma")),
				data: { "data-command-kind": command.kind },
				content: <>
					<Icon size={16} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
					<ScrollText text={command.name} className="min-w-0 max-w-[42%] shrink-0 text-ink" />
					<ScrollText text={command.description} className="min-w-0 flex-1 text-ink-muted" />
					<ScrollText text={command.origin} className="ml-auto min-w-0 max-w-[20%] shrink-0 text-detail text-ink-faint" />
				</>,
			};
		}} />;
}
