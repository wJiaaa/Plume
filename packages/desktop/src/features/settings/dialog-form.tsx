/**
 * 设置页「新建」弹窗里共用的两样：一个字段，和一组二选一的卡片。
 *
 * 新建命令、钩子、MCP 服务、代码托管账号、模型供应商原来都是在页面里就地展开的表单，现在都进了
 * 弹窗。五个弹窗各写一份标签和说明，过不了多久就是五种字号、五种间距。
 */

import { useI18n } from "../../i18n/index.ts";
import { ChoiceMark } from "../../ui/primitives/ChoiceMark.tsx";

/**
 * 标题、控件、底下一行字。
 *
 * 那行字平时是说明，出错时换成错误，位置不动——说明和错误各占一行的话，框会随着打字一高一矮。
 * `disabled` 只淡掉整块，控件照样在：跟当前选择无关的字段说清为什么用不了，而不是藏起来。
 */
export function DialogField({ label, htmlFor, optional, hint, error, disabled, children }: {
	label: React.ReactNode;
	htmlFor?: string;
	optional?: boolean;
	hint?: React.ReactNode;
	error?: string | null;
	disabled?: boolean;
	children: React.ReactNode;
}) {
	const { t } = useI18n();
	const Label = htmlFor ? "label" : "div";
	return (
		<div data-ly-dialog-field="" className={disabled ? "opacity-50" : undefined}>
			<Label htmlFor={htmlFor} className="mb-1.5 flex items-baseline gap-1.5 text-detail font-medium text-ink">
				{label}
				{optional && <span className="font-normal text-ink-faint">{t("settingsDialog.optional")}</span>}
			</Label>
			{children}
			{error ? (
				<p role="alert" className="mt-1.5 text-caption text-danger">{error}</p>
			) : hint ? (
				<p className="mt-1.5 text-caption text-ink-faint">{hint}</p>
			) : null}
		</div>
	);
}

/** 几张并排的单选卡片，每张一个名字一句说明。用在「存在哪」这种选了就改变结果去向的地方。 */
export function ChoiceCards<T extends string>({ label, value, onChange, options }: {
	label: string;
	value: T;
	onChange: (value: T) => void;
	options: { value: T; title: string; detail: React.ReactNode; disabled?: boolean }[];
}) {
	return (
		<div role="radiogroup" aria-label={label} className="grid gap-2" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
			{options.map((option) => {
				const on = option.value === value;
				return (
					<button
						key={option.value}
						type="button"
						role="radio"
						aria-checked={on}
						disabled={option.disabled}
						data-ly-choice-card={option.value}
						onClick={() => onChange(option.value)}
						className={`group flex items-start gap-2.5 rounded-lg p-3 text-left ring-inset transition-[box-shadow,background-color] duration-[var(--ly-t-quick)] disabled:cursor-default disabled:opacity-50 ${
							on ? "ring-[1.5px] ring-ink/80" : "ring-1 ring-line enabled:hover:bg-card-hover"
						}`}
					>
						<ChoiceMark checked={on} kind="radio" className="mt-0.5" />
						<span className="min-w-0">
							<span className="block text-label font-medium text-ink">{option.title}</span>
							<span className="mt-0.5 block text-caption text-ink-muted">{option.detail}</span>
						</span>
					</button>
				);
			})}
		</div>
	);
}
