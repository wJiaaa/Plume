/**
 * 定义页（插件、技能、智能体、命令、钩子）共有的两块：顶上那一行，和「没能加载 / 需要留意」那两条提示。
 *
 * 四个页面长成一个样子是 `e2e/definition-pages-parity.test.ts` 守着的，而它能守住，是因为从前每一页
 * 都把这一行和那两条提示逐字抄了一份，一份漂开另一份不知道。现在是同一份。
 */

import { TriangleAlert } from "../../ui/icons/index.ts";
import { SearchField } from "../../ui/inputs/SearchField.tsx";
import { Notice } from "./layout.tsx";

/** 范围（用户级还是哪个项目）、这一页的名字和条数、搜索。 */
export function DefinitionToolbar({ scope, title, count, query, onQuery, placeholder }: {
	scope: React.ReactNode;
	title: string;
	count: number;
	query: string;
	onQuery: (query: string) => void;
	placeholder: string;
}) {
	return (
		<div className="flex min-w-0 flex-wrap items-center gap-3">
			{scope}
			<div className="h-4 w-px bg-line" aria-hidden />
			<div className="flex items-center gap-1 text-label font-medium text-ink">
				{title}
				<span className="text-detail font-normal text-ink-faint">{count}</span>
			</div>
			<SearchField size="comfortable" value={query} onChange={onQuery} placeholder={placeholder} className="ml-auto max-w-[220px] flex-1 basis-[120px]" />
		</div>
	);
}

interface Diagnostic {
	path: string;
	message: string;
}

/**
 * 没能加载的（强调色）和加载了但有毛病的（安静的那种），各一条，没有就不画。
 *
 * 按位置作键：一个文件有两条问题时路径会重复，而这些行不带状态。
 */
export function DiagnosticNotices({ problems, problemsTitle, warnings, warningsTitle, className = "" }: {
	problems: readonly Diagnostic[];
	problemsTitle: string;
	warnings: readonly Diagnostic[];
	warningsTitle: string;
	/** 和上下文之间的距离：在工具行下面是 `mt-5`，在页顶是 `mb-5`。 */
	className?: string;
}) {
	if (problems.length === 0 && warnings.length === 0) return null;
	return (
		<div className={`space-y-5 ${className}`}>
			{problems.length > 0 && (
				<Notice tone="accent" icon={TriangleAlert}>
					<div className="min-w-0">
						<div className="text-accent">{problemsTitle}</div>
						{problems.map((diagnostic, index) => (
							<div key={index} className="mt-0.5">
								<span className="font-mono">{diagnostic.path}</span> — {diagnostic.message}
							</div>
						))}
					</div>
				</Notice>
			)}
			{warnings.length > 0 && (
				<Notice tone="muted" icon={TriangleAlert} className="text-ink-faint">
					<div className="min-w-0">
						<div className="text-ink-muted">{warningsTitle}</div>
						{warnings.map((warning, index) => (
							<div key={index} className="mt-0.5">
								<span className="font-mono">{warning.path}</span> — {warning.message}
							</div>
						))}
					</div>
				</Notice>
			)}
		</div>
	);
}
