/**
 * The dependency rules, as something a machine checks rather than something a comment asks for.
 *
 * The boundaries in this repository are real and were written down in AGENTS.md — core is platform
 * independent, the renderer may not pull core's values into a browser bundle, and so on. What was
 * missing is anything that notices when one is crossed. The comment on `core/src/index.ts` explains
 * that importing a *value* from it blanks the window; nothing stopped anyone from doing it.
 *
 * Rules start at `warn` when their violations have not been cleaned up yet, and move to `error` in
 * the commit that empties them. A rule that is red on arrival teaches people to ignore the tool —
 * the same reason `knip` runs with `--no-exit-code` in CI.
 */

/**
 * One rule per layer of `core/src/runtime/`: nothing below a layer may import it. Generated so the
 * order is written once — four hand-written rules would each repeat "everything below me", and the
 * lists drift the first time a group is added.
 */
function runtimeLayers(layers) {
	const dir = (groups) => `^packages/core/src/runtime/(${groups.join("|")})/`;
	return layers.slice(0, -1).map((groups, i) => ({
		name: `runtime-layer-${groups.join("-")}`,
		severity: "error",
		from: { path: dir(layers.slice(i + 1).flat()) },
		to: { path: dir(groups) },
	}));
}

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
	forbidden: [
		{
			name: "mobile-and-client-runtime-stay-portable",
			severity: "error",
			from: { path: "^packages/(mobile|client-runtime)/src/" },
			to: { path: "^packages/(desktop|cli)/|^(node:|electron$)", dependencyTypesNot: ["type-only"] },
		},
		{
			name: "mobile-core-imports-are-types-only",
			comment:
				"手机端只认 core 的类型。唯一的例外是 `ui-language/` 里给渲染用的那几个文件：整个目录一个 import " +
				"都不出去，和桌面渲染进程白名单里的是同一批。手机把回复里的 ```ui 画出来，读块的规则必须和提示词、" +
				"检查、桌面端是同一份——抄一份过去，就是模型学的写法在手机上被读成另一个样子。经 " +
				"`@plume/client-runtime/ui-language` 转出去，手机不直接依赖 core。`followups` 同理：回复末尾的下一步建议，" +
				"手机要把标记拿掉、流式输出时先藏住没写完的那段，认的写法必须和提示词是同一份。",
			severity: "error",
			from: { path: "^packages/(mobile|client-runtime)/src/" },
			to: { path: "^packages/core/", pathNot: "^packages/core/src/ui-language/(index|catalog|chart|check|expression|parse)\\.ts$|^packages/core/src/followups\\.ts$", dependencyTypesNot: ["type-only"] },
		},
		{
			name: "client-runtime-has-no-ui",
			severity: "error",
			from: { path: "^packages/client-runtime/src/" },
			to: { path: "^packages/mobile/|node_modules/(react|react-native|expo)(/|$)" },
		},
		{
			name: "no-circular",
			comment:
				"A cycle between *values* is how a module ends up half-initialised at runtime: one of " +
				"the two sees `undefined` where an export should be, and the error names the property " +
				"rather than the cycle. " +
				"Type-only cycles are excluded deliberately — `Message` referring to `Provider` " +
				"referring back is ordinary, correct TypeScript that disappears at compile time, and " +
				"forbidding it would mean flattening a type model to satisfy a tool.",
			/*
			 * `error`, against a baseline of the cycles that already exist.
			 *
			 * This was `warn` with a comment saying "the number is the thing to watch". Nothing was
			 * watching: it went from 53 to 159 without a single check going red, which is what a
			 * warning costs when there is no ratchet under it. Waiting for zero before turning it
			 * red was the plan, and three months of drift is the evidence that the plan does not
			 * survive contact with ordinary work.
			 *
			 * So the two halves are separated. The rule is red — a *new* cycle fails the build
			 * today. The 159 that are already here are listed in
			 * `.dependency-cruiser-known-violations.json` and pass, because failing the build for
			 * something somebody else wrote last month teaches people to ignore the tool, the same
			 * reason this comment used to give for staying yellow.
			 *
			 * The baseline is a file that can only be regenerated deliberately, so shrinking it is
			 * a visible act and growing it is one somebody has to defend in review. Untangling one
			 * hub and regenerating is the expected way this number goes down — `features/dock` was
			 * the first, and with `features/markdown` took it from 108 to 21.
			 */
			severity: "error",
			from: {},
			to: { circular: true, dependencyTypesNot: ["type-only"] },
		},

		{
			name: "core-stays-platform-free",
			comment:
				"`core` is the platform-free agent runtime the desktop drives. The moment it imports " +
				"the desktop it stops being that and starts pulling in Electron. AGENTS.md states " +
				"this; this enforces it.",
			severity: "error",
			from: { path: "^packages/core/src" },
			to: { path: "^packages/desktop/" },
		},

		{
			name: "core-does-not-reach-the-host-assembly",
			comment:
				"`kernel/` 是宿主装配：建会话存储、绑 skill 注册表，桌面端和命令行经根入口调用。core 里任何模块" +
				"都不该反过来引它——从前 `sandbox/`、`runtime/` 为了拿接口去 import `kernel/services.ts`，依赖方向" +
				"就是这样倒过来的（ADR-0054）。接口跟着实现它的模块走。类型也算：今天拿一个类型，明天就是拿一个值。",
			severity: "error",
			from: { path: "^packages/core/src/", pathNot: "^packages/core/src/(index\\.ts$|kernel/)" },
			to: { path: "^packages/core/src/kernel/" },
		},

		{
			name: "loop-sits-below-the-session",
			comment:
				"The agent loop is driven by the session, sub-agents and the side chat; it does not " +
				"know them. What it needs from above — compaction, approvals, hooks, a model that can " +
				"change mid-run — arrives through `AgentRunConfig`. Pure history transforms the loop " +
				"applies itself live in `agent/`, and token arithmetic in `tokens.ts`. Type imports " +
				"count too: a type from `runtime/` is how the next value import starts.",
			severity: "error",
			from: { path: "^packages/core/src/agent/" },
			to: { path: "^packages/core/src/(runtime|session|kernel)/" },
		},

		/*
		 * `runtime/` 内部的分层，从上到下。每一层只往下引，同层之间随意；类型也算，理由同上一条。
		 *
		 *   agent-session   会话驱动：`AgentSession` 和从它身上拆出来的部件，只有它开回合
		 *   sub-agent       被会话驱动的另两种运行；它们借会话的记录和能力，但不认识会话本身
		 *   side-chat
		 *   record          会话记下了什么（`SessionLog`），以及从记录里读出来的东西：状态、上下文分布、缓存诊断
		 *   setup           会话装上了什么：工具、技能、插件、MCP、子智能体定义，以及据此拼的提示词上下文
		 *   policy …        叶子：每种运行共用的规矩、计划模式、压缩、记忆、任务队列、标题、摘要与一次性旁路请求
		 *
		 * 子代理派发要的 `scratchDir`、`buildRouter` 和上下文分布住在 record / setup，所以这两层在
		 * sub-agent 之下；`dispatch-guard` 是提示词也要读的上限，所以在叶子层而不在 sub-agent。
		 * 理由与分组见 ARCHITECTURE.md 的「core 的 runtime」。
		 */
		...runtimeLayers([
			["agent-session"],
			["sub-agent", "side-chat"],
			["record"],
			["setup"],
			["policy", "plan", "compaction", "memory", "queue", "summary"],
		]),

		{
			name: "renderer-imports-core-types-only",
			comment:
				"Importing a *value* from core's root index pulls the whole index into a browser bundle, " +
				"and the index reaches `node:fs` and `node:child_process` — the bundle then throws on the " +
				"first Node built-in and the window is blank. Types are erased at compile time and cost " +
				"nothing. The listed sub-entries are the ones written to be browser-safe. " +
				"加进这份名单前要真的确认：`config/models` 是把 `resolveModel`/`availableModels` 从 " +
				"`settings.ts`（顶上就是 node:fs、node:os）里抽出来才安全的，`config/model-choice` 只依赖它，" +
				"`config/retry-policy` 一个 import 都没有——两个接口、两个常量和三个纯函数。" +
				"`runtime/delegation` 同样只有一个 `import type`，进名单是因为设置页要算「这一轮实际几个」，" +
				"而那个数字必须跟闸门真正拦人的那个来自同一份代码——界面自己算一遍，迟早会跟运行时说的不一样。" +
				"它住在 `runtime/` 而名单上其余的都在 `config/`，所以往里加依赖之前先想一下：" +
				"这个文件是靠「除了类型什么都不 import」才留在这儿的。" +
				"`config/project-folders` 进名单的理由也是这一条，而且它比名单上任何一个都干净：" +
				"一个 import 都没有，连 `import type` 都没有——需要的那个形状就在文件里声明着。" +
				"进名单是因为「一个项目由哪几个文件夹组成」必须只有一个答案：侧边栏据此把会话归到哪个" +
				"项目下，读取边界据此决定哪些路径不用问人。这两处各算各的，结果就是第二个文件夹的会话" +
				"归了组、却每读一个文件弹一次窗。" +
				"`mcp/placeholders` 也只有一个 `import type`：「这台服务还缺哪几个值」界面上画、连接时拦，" +
				"两处必须是同一个答案——设置页说齐了、启动时却报缺，比两处都不说更糟。" +
				"`config/image-models` 只有一个 `import type`：哪些模型是生图模型，对话模型的下拉要把它们剔掉、设置页要单独列出、运行时要据此挑模型，三处必须是同一个判断。" +
				"`mcp/form` 一个 import 都没有：MCP 表单哪一格没填对，窗口画提示、闸门收答案，两处必须是同一个判断。" +
				"`ui-language/` 整个目录一个 import 都不出去：界面块的解析、检查与组件表，模型在提示词里读到的、" +
				"运行时回报给它的、桌面端画出来的，必须是同一份规则——两处各写一遍，就是模型学的属性被渲染器悄悄丢掉。" +
				"`runtime/plan/plan-view` 只有一个 `import type`：计划长什么样、会话里眼下是哪一份，审批卡、压缩快照和右栏计划面板" +
				"必须是同一个答案——面板自己从历史里另找一遍，迟早和模型手上那份对不上。" +
				"`tools/shell-split` 一个 import 都没有：命令行怎么切成命令和词，审批判风险时用它，任务面板说「输出写进了哪个文件」" +
				"也用它——引号、`2>&1`、粘在 `>` 上的路径，两处各写一遍就会对同一行命令给出两种读法。" +
				"`reply-text` 只有一个 `import type`：一条回复里哪段播报已被最终答复重说过，界面画正文、子代理交回答复、" +
				"命令行打印答复都要据此跳过——各判一遍，就是这一处不重复了、那一处照样说两遍。" +
				"`followups` 一个 import 都没有：回复末尾下一步建议的写法，提示词教给模型的、输入框取来当灰字的、回复里拿掉的，" +
				"必须是同一份——各写一遍，就是模型照着写了、界面上却露出一串语法。" +
				"`session/usage-parts` 一个 import 都没有：用量页 Token 构成分哪几类，回放按它记、环图按它画，" +
				"两处各列一遍，就是回放多记了一类、环图上那一段不见了。" +
				"这一条是在真窗口里撞出来又验回去的——先看到过一整屏空白。",
			severity: "error",
			from: { path: "^packages/desktop/src" },
			to: {
				path: "^packages/core/src",
				pathNot:
					"^packages/core/src/(types|tokens|activity|trajectory-view|commands-view|model-catalog|agents-builtin|platform|reply-text|followups)\\.ts$" +
					"|^packages/core/src/(config/schedule|config/model-choice|config/models|config/image-models|config/project-folders|config/retry-policy|session/usage-parts|commands/builtin|plugins/install-record|mcp/placeholders|mcp/form|ai/thinking-options|runtime/delegation|runtime/plan/plan-view|tools/shell-split)\\.ts$" +
					"|^packages/core/src/ui-language/(index|catalog|chart|check|expression|parse)\\.ts$",
				dependencyTypesNot: ["type-only"],
			},
		},

		{
			name: "renderer-does-not-reach-into-main",
			comment:
				"The renderer talks to the main process over IPC and nowhere else. The description of " +
				"that boundary is `@plume/contract`, so the renderer has no reason to name a file here; " +
				"a type still costs nothing, but a value would be a module from the other process linked " +
				"into this bundle.",
			severity: "error",
			from: { path: "^packages/desktop/src" },
			to: { path: "^packages/desktop/electron/", dependencyTypesNot: ["type-only"] },
		},

		{
			name: "shared-belongs-to-neither",
			comment:
				"`shared/` is what both processes own — the tables they have to agree on. It reaches " +
				"neither of them, and nothing platform-specific: the moment it imports Electron the " +
				"renderer cannot have it, and the moment it imports the renderer the main process " +
				"cannot.",
			severity: "error",
			from: { path: "^packages/desktop/shared/" },
			to: { path: "^packages/desktop/(src|electron)/" },
		},

		{
			name: "contract-is-a-leaf",
			comment:
				"`@plume/contract` has two consumers — the main process registers by it and the preload " +
				"builds from it — and the phone reads its types. Whatever it imports *as a value* is " +
				"dragged into every one of those builds. So the only thing it reaches outside itself is " +
				"core's two type entries: `contract-types` (everything that crosses the IPC boundary) and " +
				"`client-types` (the part the phone shares). No other package, no `node:`, no npm module. " +
				"See ADR-0055.",
			severity: "error",
			from: { path: "^packages/contract/src" },
			to: { pathNot: "^packages/contract/src/|^packages/core/src/(contract-types|client-types)\\.ts$" },
		},

		{
			name: "contract-takes-only-types-from-core",
			comment:
				"The other half of the rule above: from those two entries, `import type` only. Both " +
				"files are nothing but `export type`, so a value import would also fail to compile; this " +
				"says why before the compiler says what.",
			severity: "error",
			from: { path: "^packages/contract/src" },
			to: { path: "^packages/core/", dependencyTypesNot: ["type-only"] },
		},

		{
			name: "ui-is-a-leaf",
			comment:
				"`ui/` is the part of the interface that would still make sense in another product: a " +
				"button, a popover, a scroller. The moment one of them reads the store or calls a " +
				"service it is not that any more — it is a feature that happens to look generic, and " +
				"the next person to reuse it inherits a dependency they did not ask for.",
			severity: "error",
			from: { path: "^packages/desktop/src/ui/" },
			to: { path: "^packages/desktop/src/(features|services|store|app)/" },
		},

		{
			name: "lib-is-a-leaf",
			comment:
				"`lib/` is the logic with nothing around it — markdown parsing, syntax highlighting, " +
				"how a model name is grouped. No React, no main process, no state. That is what makes " +
				"it testable without a DOM, which is most of why it is separate at all.",
			severity: "error",
			from: { path: "^packages/desktop/src/lib/" },
			to: { path: "^packages/desktop/src/(features|services|store|app|ui)/" },
		},

		{
			name: "features-through-the-front-door",
			comment:
				"A domain is reached through its `index.ts` and not by naming a file inside it. The " +
				"export list is the domain's public promise: what is on it, other domains depend on; " +
				"what is not, it can move or rename freely. Without the rule there is no such thing " +
				"as an internal file, and every domain's whole directory is its API.",
			severity: "error",
			from: { path: "^packages/desktop/src/features/([^/]+)/" },
			to: {
				path: "^packages/desktop/src/features/([^/]+)/",
				/*
				 * `index.ts` 是门。没有 index 的域是没有对外接口的域——`scheduled` 只有一个整屏
				 * 视图，而那个视图只有壳会 `lazy()` 它，放进出口反而会让打包器把整个域并回主
				 * chunk（实测差 630KB）。那种域不该被别人引，规则照常拦住。
				 */
				pathNot: "^packages/desktop/src/features/$1/|/index\\.ts$",
			},
		},

		{
			name: "features-are-not-reached-from-below",
			comment:
				"同一条正门规则的另一半：从**下面**伸上来的那一半。`features-through-the-front-door` 的 " +
				"`from` 只匹配 `features/`，所以它管得住域与域之间，管不住 `store/` 点名某个域里的一个 " +
				"文件——而那同样让「内部文件」这件事不存在。检查不到的规则不是规则。" +
				"壳不在这条规则里：`app/` 与 `main.tsx` 的职责就是装配，它们 `lazy()` 各域的整屏视图，" +
				"而把那些视图放进域的出口反而会让打包器把整个域并回主 chunk（见上一条规则的注释，实测 " +
				"差 630KB）。这条管的是底层——`store`/`ui`/`lib`/`services`/`i18n` 都在 features " +
				"之下，它们伸上去拿一个内部文件没有任何打包上的理由。",
			severity: "error",
			from: {
				path: "^packages/desktop/src/(store|ui|lib|services|i18n)/",
			},
			to: {
				path: "^packages/desktop/src/features/[^/]+/",
				pathNot: "/index\\.ts$",
			},
		},

		{
			name: "main-domains-through-the-front-door",
			comment:
				"主进程的同一条正门规则：`electron/<域>/` 之间只经对方的 `index.ts`。从前一百三十多个文件平铺在 " +
				"`electron/` 根下，靠文件名前缀分组，任何文件都能点名任何文件，「内部文件」这件事不存在。" +
				"`ipc/` 不算域：它是每个域的 IPC 注册，和 `main.ts`、`window.ts` 一样是装配层，照旧直接引各域的" +
				"文件——渲染进程的壳 `app/` 也是这样。根目录剩下的是入口与谁都能用的（`i18n.ts`、`app-settings.ts`、" +
				"`path-key.ts`、`find-executable.ts`），不在这条规则里。类型也算：一个类型就是下一个值的开头。",
			severity: "error",
			from: { path: "^packages/desktop/electron/([^/]+)/", pathNot: "^packages/desktop/electron/ipc/" },
			to: {
				path: "^packages/desktop/electron/([^/]+)/",
				pathNot: "^packages/desktop/electron/($1|ipc)/|/index\\.ts$",
			},
		},

		{
			name: "no-orphans",
			comment: "A module nobody imports is either dead or was meant to be wired up and was not.",
			severity: "warn",
			from: {
				orphan: true,
				pathNot: [
					"\\.d\\.ts$",
					"(^|/)(index|main|preload)\\.tsx?$",
					"^packages/[^/]+/(test|e2e)/",
					"^packages/desktop/(electron\\.vite\\.config|scripts)",
					"^scripts/",
					"\\.(config|conf)\\.(ts|js|cjs|mjs)$",
				],
			},
			to: {},
		},
	],

	options: {
		doNotFollow: { path: "node_modules" },
		/*
		 * `specify` is what makes the type-only rules above possible: without it every import looks
		 * the same to the cruiser, and "types are free, values are not" cannot be expressed at all.
		 */
		tsPreCompilationDeps: "specify",
		tsConfig: { fileName: "tsconfig.base.json" },
		enhancedResolveOptions: {
			exportsFields: ["exports"],
			conditionNames: ["import", "require", "default", "types"],
			extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
			mainFields: ["module", "main", "types"],
		},
		exclude: { path: "node_modules|\\.d\\.ts$|packages/desktop/out/" },
		reporterOptions: {
			dot: { collapsePattern: "^packages/[^/]+/(src|electron)/[^/]+" },
			archi: { collapsePattern: "^packages/[^/]+/(src|electron)/[^/]+" },
		},
	},
};
