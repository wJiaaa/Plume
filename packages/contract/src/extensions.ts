/**
 * What extends the agent: plugins and MCP servers from the marketplace, skills, slash commands,
 * sub-agent definitions and hooks — listing them, installing them, and the settings pages for each.
 */

import type {
	AgentDefinitionRecord,
	AgentDefinitionSave,
	BuiltinCommand,
	BundleKind,
	DiffHunk,
	HookDraft,
	HookEventName,
	HookScope,
	InstallRecord,
	McpBundle,
	McpPromptEntry,
	Plugin,
	PluginDiagnostic,
	Registry,
	RegistryEntry,
	Skill,
	SkillCandidate,
	SkillDiagnostic,
	SkillEntry,
	SlashCommand,
	UserContent,
} from "@plume/core/contract-types";
import type { AgentCapabilities } from "./sessions.ts";

/** 设置页上的一条钩子，摊平了的样子。`id` 是位置，任何一次改动之后都要换成新列表里的。 */
export interface HookView {
	id: string;
	scope: HookScope;
	event: HookEventName;
	matcher?: string;
	type: "command" | "process";
	command: string;
	args?: string[];
	async?: boolean;
	shell?: true | string;
	statusMessage?: string;
	/** 秒。 */
	timeout?: number;
	enabled: boolean;
	/** 认不出的字段，原样保留。 */
	custom?: Record<string, unknown>;
	/** 只有项目钩子有：这一条的内容是否已被这台机器信任过。没信任的在会话里不运行。 */
	trusted?: boolean;
}

export interface HooksView {
	user: HookView[];
	/** 没有打开项目时为 null。 */
	project: HookView[] | null;
	projectPath?: string;
	/** 项目的 `.plume/config.json` 读不出来时，为什么。 */
	projectError?: string;
}

/**
 * 后台对账的结果：装过的东西里谁落后了市场，正在换谁，哪几个上次没换成。
 *
 * 主进程算、推给每个窗口（`plugins:changed`）。侧栏据此画那个数，两个插件页据此画「可更新」和
 * 「全部更新」——它们不各自再算一遍，因为各算各的就会一个说有新版、一个说没有。
 */
export interface PluginUpdateState {
	outdated: { id: string; name: string; version?: string; from: string }[];
	/** 自动更新开着没有（设置里的 `autoUpdatePlugins`，缺省为开）。 */
	auto: boolean;
	updating: string[];
	failed: { id: string; name: string; message: string }[];
	/**
	 * 磁盘上装着的东西变过几次（装、卸、更新）。窗口看到它变了就重扫——不管是哪个窗口、哪个页面
	 * 动的手，别的窗口里的市场和设置页都跟着变。
	 */
	revision: number;
}

export interface PluginsApi {
	/** Scan plugin and skill directories without needing an open session. */
	list(cwd: string): Promise<{
		plugins: Plugin[];
		/** Directories that turned out to be MCP servers rather than plugins. */
		mcpBundles: McpBundle[];
		/** 同样带 `severity`：插件里一个描述太短的技能是提醒，不是「没能加载」。 */
		pluginDiagnostics: PluginDiagnostic[];
		/**
		 * `where`：散装技能所在的目录，项目内是相对路径，主目录下是 `~/…`。
		 * `disabledBy`：关掉它的那条 `disabledSkills`（路径或符号链接的真实路径命中），开着就没有。
		 */
		skills: (Skill & { where?: string; disabledBy?: string })[];
		/** 带 `severity`：设置页按它把「没加载」和「加载了但描述太短」分成两段。 */
		skillDiagnostics: SkillDiagnostic[];
		/**
		 * Skills that were found and lost to another of the same name.
		 *
		 * "Why is the skill I wrote not running" cannot be answered from the list of the ones
		 * that are: a shadowed skill is simply absent, which looks the same as one that failed
		 * to parse or was never found at all.
		 */
		shadowedSkills: { name: string; path: string; by: string; byLabel: string }[];
		/**
		 * 账本：装过什么、从哪个市场、哪一版。技能集没有自己的目录，「装了没有」「落后没有」只能
		 * 从这里问；插件和 MCP 包的那一行已经挂在各自的 `origin` 上。
		 */
		installs?: Record<string, InstallRecord>;
	}>;
	/** Absolute path to the plugins directory, created if missing. */
	revealDir(scope: "workspace" | "user", cwd: string): Promise<string>;
	/** Write a runnable example bundle so the format is discoverable. */
	/** Read a registry index. Failures come back as data — a bad URL is routine, not exceptional. */
	/** `force` skips the main process's cache — what 刷新 means, and the only thing that does. */
	/**
	 * `allowStale`: with nothing fetched yet this launch, answer at once with the copy kept from the
	 * last one (`stale: true`) instead of waiting on the network. Ask again without it for the fresh one.
	 */
	fetchRegistry(
		url: string,
		force?: boolean,
		allowStale?: boolean,
	): Promise<{ ok: true; registry: Registry; stale?: boolean } | { ok: false; message: string }>;
	/** A registry logo as a data URL, or null. Fetched in the main process; see `registry:icon`. */
	icon(url: string): Promise<string | null>;
	/**
	 * A bundle's README as text, with the repository and directory its relative links are written
	 * against — from the platform it was listed on, its installed directory, or GitHub; null when
	 * none of them has one. See `plugin-readme.ts`.
	 */
	readme(query: { id: string; repository?: string; path?: string; dir?: string }): Promise<{ markdown: string; repo?: string; dir?: string } | null>;
	/**
	 * A whole catalogue's logos at once, keyed by the URL each was asked for.
	 *
	 * Not a batched `icon` for the sake of fewer round trips — the answers differ. A picture that
	 * more than one entry claims is nobody's mark and comes back `null`, which is a fact about the
	 * batch and cannot be decided one URL at a time. See `dropShared`.
	 */
	icons(urls: string[]): Promise<Record<string, string | null>>;
	/**
	 * Clone an entry and file it by what it turns out to be.
	 *
	 * `kind` comes back because the index's claim is only a claim: install something listed as
	 * a plugin that holds nothing but a `.mcp.json` and what you have installed is an MCP
	 * server, whose servers are now in settings switched off, waiting to be turned on.
	 */
	/**
	 * `replace` turns the same call into an update.
	 *
	 * It skips the "already installed" check and overwrites what is there — safely, because the
	 * new bundle is downloaded and inspected in a staging directory first, so a failed update
	 * leaves the working copy untouched. Uninstall-then-install would not: it has a window in
	 * the middle where the user has neither version.
	 */
	installFromRegistry(
		entry: RegistryEntry,
		registryName?: string,
		replace?: boolean,
	): Promise<{ ok: true; dir: string; kind: BundleKind; servers: number } | { ok: false; message: string }>;
	uninstall(id: string): Promise<void>;
	/** 后台对账的结果：谁落后了、正在更新谁、上次什么时候看的。见 `plugin-updates.ts`。 */
	updates(): Promise<PluginUpdateState>;
	/** 更新这几个（缺省：全部落后的）。人点的，不管自动更新开没开。 */
	updateAll(ids?: string[]): Promise<PluginUpdateState>;
	/**
	 * 这几个环境变量名里，哪些在登录 shell 里已经有值——只回名字，不回值。
	 *
	 * 「这台 MCP 服务还缺什么」要算上环境：已经在 `.zshrc` 里 export 过 `GITHUB_TOKEN` 的人，
	 * 不该被界面要求再填一遍。窗口读不到那个环境，只能问主进程。
	 */
	environment(names: string[]): Promise<string[]>;
	/** 设置里每台 MCP 服务的状态和工具，不需要会话：主进程临时连一次再断开。 */
	mcpStatus(): Promise<AgentCapabilities["mcp"]>;
	/**
	 * 在系统浏览器里走一遍这台远程 MCP 服务器的 OAuth 登录，等人点完（最多五分钟）。成功后
	 * 活着的会话会重连它。
	 */
	mcpLogin(serverId: string): Promise<{ ok: true } | { ok: false; error: string }>;
	/** 清掉这台服务器的令牌（注册信息留着，下次登录不必重新注册），会话随之重连。 */
	mcpLogout(serverId: string): Promise<{ ok: true } | { ok: false; error: string }>;
	/** 设置页的「重新连接」：每个开着的会话都把这台服务器断开重连，探测记着的那份也丢掉。 */
	mcpReconnect(serverId: string): Promise<void>;
	/** 对账结果一变就推过来：自动更新完了、有新的落后了、装卸之后重新数过了。 */
	onChanged(handler: (state: PluginUpdateState) => void): () => void;
}

export interface CommandsApi {
	/**
	 * Every slash command that applies here, and the files that could not be read.
	 *
	 * Scanned on call rather than cached: these are text files people edit in another window,
	 * and a list that needed a restart to notice would be wrong more often than right.
	 */
	list(cwd: string): Promise<{
		commands: SlashCommand[];
		/** 内建命令：名字和说明在 core，动作由各个宿主实现。 */
		builtins: BuiltinCommand[];
		diagnostics: { path: string; message: string }[];
		/**
		 * The skills the same project can use, for the same menu.
		 *
		 * A bundle advertises its skills as callable by name — waza's manifest says
		 * 「/waza:think」 — and nothing could call one: the agent picked them up on its own
		 * judgement and there was no way to ask. Read from the same place the session reads
		 * them, so the menu cannot offer something the agent does not have.
		 */
		skills: SkillEntry[];
		agents?: Array<{ id: string; name: string; description: string; avatar?: string }>;
	}>;
	/**
	 * MCP 服务器提供的 prompt，给 `/` 菜单。有会话用会话手上的连接；新对话（`null`）还没有会话，
	 * 临时连一次去问，见 `mcp-probe.ts`。和 `list` 分开，是因为设置页、`@` 提及也读 `list`，
	 * 它们不该为此去启动服务器。
	 */
	prompts(sessionId: string | null): Promise<McpPromptEntry[]>;
	/**
	 * 取一个 MCP prompt 展开后的内容。参数在渲染进程已经对过（`bindPromptArguments`）。
	 * 有会话就用会话的连接；新对话还没有会话，临时连那一台服务器取完就断。
	 */
	prompt(sessionId: string | null, name: string, args: Record<string, string>): Promise<{ ok: true; content: UserContent[] } | { ok: false; error: string }>;
	/** Write a starter file and answer with its path, or say why it could not be written. */
	create(
		scope: "workspace" | "user",
		name: string,
		cwd: string,
	): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
	/** Absolute path to the commands directory, created if missing. */
	reveal(scope: "workspace" | "user", cwd: string): Promise<string>;
	/** Open one command file for editing. */
	open(path: string): Promise<void>;
}

/** 从会话里总结出来、等着人点头的技能候选。 */
export interface SkillsApi {
	pending(cwd: string): Promise<SkillCandidate[]>;
	/** 批准一个。`content` 是人编辑过的版本——「编辑后启用」跟「启用」是同一个动作。 */
	approve(cwd: string, name: string, content?: string): Promise<string | null>;
	/** 否决一个。文件删掉，下次不再问。 */
	reject(cwd: string, name: string): Promise<boolean>;
}

export interface CapabilitiesApi {
	/** Trash a discovered loose definition, preserving built-ins and plugin bundles. */
	trash(kind: "command" | "skill", cwd: string, path: string): Promise<void>;
	/** 两份同名能力的差异，赢家在前输家在后；hunk 直接交给 DiffView。 */
	diff(
		kind: "skill",
		winner: string,
		loser: string,
	): Promise<{ hunks: DiffHunk[]; added: number; removed: number }>;
	/** 「改用那个」：让 `path` 这一份赢下 `kind:name`。返回写到了哪个文件。 */
	prefer(kind: "skill", name: string, path: string): Promise<{ wroteTo: string }>;
}

export interface AgentDefinitionsApi {
	list(projectId: string | null): Promise<{ records: AgentDefinitionRecord[]; tools: string[] }>;
	read(projectId: string | null, id: string): Promise<AgentDefinitionRecord>;
	save(projectId: string | null, input: AgentDefinitionSave): Promise<{ warning?: string }>;
	remove(projectId: string | null, id: string, revision: string): Promise<{ warning?: string }>;
}

/** 钩子：用户级和项目级，外加项目钩子的信任。每个写操作都回一份新的完整列表。 */
export interface HooksApi {
	list(cwd: string | null): Promise<HooksView>;
	/** `id` 为 null 是新建。 */
	save(scope: HookScope, cwd: string | null, id: string | null, draft: HookDraft): Promise<HooksView>;
	remove(scope: HookScope, cwd: string | null, id: string): Promise<HooksView>;
	setEnabled(scope: HookScope, cwd: string | null, id: string, enabled: boolean): Promise<HooksView>;
	trust(cwd: string, ids: string[]): Promise<HooksView>;
}
