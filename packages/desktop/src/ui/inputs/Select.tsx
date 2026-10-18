/**
 * A choice from a list: `Select` fills a form row, `InlineSelect` sits at the end of a setting or
 * in a panel's header.
 *
 * It used to live in the settings domain, and the task board, the preview card's tweaks and the
 * interface cards a model draws all reached across into settings to borrow it.
 */

import { Check, ChevronDown } from "../icons/index.ts";
import { MENU_MAX_HEIGHT, MenuBody, MenuItem, Popover, usePopover } from "../overlay/Popover.tsx";

/**
 * A dropdown, built from the app's own popover rather than from `<select>`.
 *
 * The native control was the last thing here drawing itself with the platform's widgets: its
 * list is rendered by the OS, so it ignores the theme, the type scale and the corner radii, and
 * on macOS it opens as a panel that overlaps its own trigger. Everything else in the app that
 * offers a list of choices already goes through `Popover` — the model picker, the effort picker,
 * the branch menu — so this one does too, and inherits their keyboard handling and dismissal.
 */
function Dropdown<T extends string>({
	value,
	onChange,
	options,
	size,
	ariaLabel,
	quiet,
	set,
}: {
	value: T;
	onChange: (value: T) => void;
	options: { value: T; label: string; detail?: string; icon?: React.ReactNode }[];
	/**
	 * `field` fills a form row; `inline` is the compact one that sits at the end of a setting;
	 * `compact` is the 26px one for a panel header, the same height as `SearchField` beside it.
	 */
	size: "field" | "inline" | "compact";
	/** For a dropdown whose own label does not say what it is — two of them reading `09` and `30`. */
	ariaLabel?: string;
	/** No fill until it is pointed at — for a control repeated down a list. See `ModelSelect`. */
	quiet?: boolean;
	/** In the quiet form, whether this is a choice somebody made rather than the default showing through. */
	set?: boolean;
}) {
	const menu = usePopover();
	const current = options.find((option) => option.value === value);
	const field = size === "field";
	const compact = size === "compact";

	return (
		<>
			<button
				type="button"
				onClick={menu.toggle}
				aria-label={ariaLabel}
				aria-haspopup="menu"
				aria-expanded={menu.open}
				data-ly-field=""
				data-ly-select=""
				data-set={set ? "" : undefined}
				className={`${quiet ? "ly-field-quiet" : "ly-field"} justify-between ${compact ? "ly-field-compact gap-1.5" : "gap-2"} ${field ? "w-full" : ""}`}
			>
				<span className="flex min-w-0 items-center gap-2">
					{current?.icon}
					<span className="min-w-0 truncate">{current?.label ?? value}</span>
				</span>
				<ChevronDown
					size={field ? 15 : compact ? 12 : 13}
					strokeWidth={1.9}
					className="shrink-0 text-ink-faint transition-transform duration-[var(--ly-t-quick)]"
					style={menu.open ? { transform: "rotate(180deg)" } : undefined}
				/>
			</button>

			{menu.open && (
				<Popover anchor={menu.anchor} onClose={menu.close} placement="bottom" align="end" width="default" maxHeight={MENU_MAX_HEIGHT}>
					{/*
					 * The icon column is reserved for the whole list, not per row.
					 *
					 * These options carry an icon only where one could be found — the file-opener
					 * dropdown reads each application's own icon off the machine, and four of its seven
					 * are simply not installed. With the column collapsing on the rows that had none,
					 * their labels started 26px left of the rest and the menu read as two lists that
					 * had been stacked by accident.
					 */}
					<MenuBody insetIcons={options.some((option) => option.icon)}>
						{options.map((option) => (
							<MenuItem
								key={option.value}
								selected={option.value === value}
								detail={option.detail}
								icon={option.icon}
								trailing={
									option.value === value ? (
										<Check size={13} strokeWidth={2.2} className={`shrink-0 text-ink ${option.detail ? "mt-[3px]" : ""}`} />
									) : undefined
								}
								onClick={() => {
									onChange(option.value);
									menu.close();
								}}
							>
								{option.label}
							</MenuItem>
						))}
					</MenuBody>
				</Popover>
			)}
		</>
	);
}

export function Select<T extends string>(props: {
	value: T;
	onChange: (value: T) => void;
	options: { value: T; label: string; detail?: string; icon?: React.ReactNode }[];
	ariaLabel?: string;
}) {
	return <Dropdown {...props} size="field" />;
}

/** Compact inline dropdown used in setting rows, matching the reference "Zed ˅" control. */
export function InlineSelect<T extends string>(props: {
	value: T;
	onChange: (value: T) => void;
	options: { value: T; label: string; detail?: string; icon?: React.ReactNode }[];
	ariaLabel?: string;
	quiet?: boolean;
	set?: boolean;
	/** For a panel header rather than a setting row — see `size` on `Dropdown`. */
	compact?: boolean;
}) {
	const { compact, ...rest } = props;
	return <Dropdown {...rest} size={compact ? "compact" : "inline"} />;
}
