/**
 * 输入框下面那一排：项目、分支、工作树各一枚，点开是各自的菜单。
 */

import { ChevronDown, CircleAlert, X } from "../../ui/icons/index.ts";
import { useRolled } from "../../ui/motion/RollingText.tsx";
import { ScrollText } from "../../ui/scroll/ScrollText.tsx";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import { useI18n } from "../../i18n/index.ts";

export function Chip({
	icon,
	label,
	tip,
	marks,
	onClick,
	onClear,
	active,
	busy,
	dimmed,
}: {
	icon: React.ReactNode;
	label: string;
	/** What the tooltip says, when the label alone does not; the label otherwise. */
	tip?: string;
	/** Small facts after the label: how far a worktree has moved from its base. */
	marks?: React.ReactNode;
	onClick: (event: React.MouseEvent<HTMLElement>) => void;
	onClear?: () => void;
	active?: boolean;
	/** Something is being changed about what this names; the label is held until it lands. */
	busy?: boolean;
	/** What it names is not on disk right now — a worktree that was taken back. */
	dimmed?: boolean;
}) {
	const { t } = useI18n();
	const rolls = useRolled(label);

	const chip = (
		<button
			type="button"
			data-ly-tip={busy ? t("composer.switchingBranch") : (tip ?? label)}
			aria-haspopup="menu"
			aria-expanded={active}
			aria-busy={busy || undefined}
			onClick={onClick}
			/* Dimmed while it is being changed, so the name reads as "still this, for now". */
			className={`ly-composer-control ly-scroll flex min-w-0 items-center gap-1 rounded-lg pr-2 pl-3 text-label transition-[color,background-color,opacity] duration-[var(--ly-t-quick)] ${
				busy ? "opacity-60" : ""
			} ${dimmed ? "text-ink-muted" : "text-ink"} ${active ? "bg-card-hover" : onClear ? "group-hover/chip:bg-card-hover" : "hover:bg-card-hover"}`}
		>
			<span className="shrink-0 text-ink-muted">{icon}</span>
			{/* Keyed on the label so switching project or branch rolls the new one in. `ScrollText`
			    cannot take `RollingText` as a child — it measures the string to decide whether the
			    chip scrolls on hover — so the remount happens around it instead, on the same terms. */}
			<ScrollText key={label} text={label} className={`min-w-0 ${rolls ? "ly-roll" : ""}`} />
			{marks}
			<ChevronDown size={14} className={`shrink-0 text-ink-muted ${onClear ? "group-hover/chip:opacity-0 group-focus-within/chip:opacity-0" : ""}`} aria-hidden />
		</button>
	);
	if (!onClear) return chip;
	return (
		<div className="group/chip relative flex min-w-0">
			{chip}
			<span className="pointer-events-none absolute inset-y-0 right-1 flex items-center opacity-0 group-hover/chip:pointer-events-auto group-hover/chip:opacity-100 group-focus-within/chip:pointer-events-auto group-focus-within/chip:opacity-100">
				<IconButton size="sm" label={t("project.without")} icon={<X size={14} />} onClick={onClear} />
			</span>
		</div>
	);
}

/**
 * `↑3 ↓1`: commits this side has that the other lacks, and the reverse — a worktree against its base, a
 * branch against its upstream. Nothing when there is nothing to say, and a mark of its own while a
 * worktree's sync waits on conflicts.
 */
export function DistanceMarks({ ahead, behind, conflicted = false }: { ahead: number; behind: number; conflicted?: boolean }) {
	if (!ahead && !behind && !conflicted) return null;
	return (
		<span data-ly-distance-marks="" className="flex shrink-0 items-center gap-1 text-caption text-ink-faint tabular-nums">
			{ahead > 0 && <span>↑{ahead}</span>}
			{behind > 0 && <span>↓{behind}</span>}
			{conflicted && <CircleAlert size={12} strokeWidth={2} className="text-amber-500" aria-hidden />}
		</span>
	);
}
