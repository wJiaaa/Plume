/**
 * Settings and what the settings pages manage: model providers and their catalogue, the chat
 * background, both kinds of memory, and the code index.
 */

import type { CatalogSyncResult, ConfigProblem, LayerOverride, ModelCatalogDocument, Settings } from "@plume/core/contract-types";

/** What `settings.layers` answers; see there. */
export interface ProjectLayerView {
	path: string;
	exists: boolean;
	error?: string;
	/** What `error` says, for the window to say in its own language. */
	problem?: ConfigProblem;
	refused: string[];
	overrides: LayerOverride[];
}

export interface ProviderTestResult {
	ok: boolean;
	latencyMs: number;
	message: string;
	/** Model ids the endpoint reported, when it exposes a listing. */
	models?: string[];
}

export interface SettingsApi {
	get(): Promise<Settings>;
	save(settings: Settings): Promise<Settings>;
	/**
	 * 项目层相对全局的差别：哪些键被 `<cwd>/.plume/config.json` 整体替换（数组与标量；对象深合并
	 * 后只报叶子）、两侧的值各是什么，以及那个文件里被拒绝的键。设置页读写的是全局文件，
	 * 被替换的键在这一页拨了也不生效，页面要把这句话说出来。
	 */
	layers(cwd: string): Promise<ProjectLayerView>;
	/**
	 * Settings changed on the other side of the boundary.
	 *
	 * The renderer is not the only thing that writes them: installing an MCP bundle adds its
	 * servers, uninstalling takes them away, an approval appends to `alwaysAllow`. The main
	 * process has always broadcast this and nothing has ever listened, so the window went on
	 * showing the settings it last saved itself — install a server from the catalogue and the
	 * MCP page did not have it until the app was restarted.
	 */
	onChanged(handler: (settings: Settings) => void): () => void;
}

export interface ProvidersApi {
	test(providerId: string, modelId?: string): Promise<ProviderTestResult>;
	fetchModels(providerId: string): Promise<{ ok: boolean; models: string[]; error?: string }>;
	/**
	 * 主进程当前生效的模型目录（可能比渲染进程打包的那份新），让编辑器预览的值和保存后的一致。
	 * 版本与 `knownRevision` 相同时返回 `null`。
	 */
	modelCatalog(knownRevision?: string): Promise<ModelCatalogDocument | null>;
	/** 立即从 pi 拉一次模型目录；换上了新目录，设置会随之重新保存。 */
	updateModelCatalog(): Promise<CatalogSyncResult>;
}

/**
 * 会话窗背景图，存在 `~/.plume/backgrounds/`。
 *
 * 页面的 `ly-media` 只认已打开项目里的文件，而这张图来自哪里都行，所以选、读、删各走一条自己的
 * 路；设置里只记文件名，见 `AppearanceSettings.chatBackground`。
 */
export interface ChatBackgroundApi {
	/** 弹出选图对话框，复制进去，返回新文件名；取消或图太大时为 null。 */
	pick(): Promise<{ name: string } | { error: "too-large" } | null>;
	/** 那张图的字节；文件不在了为 null。 */
	read(name: string): Promise<Uint8Array | null>;
	remove(): Promise<void>;
}

export interface MemoryApi {
	/** 每条带来源与最后一次注入提示词的时间（没注入过就没有）。 */
	load(): Promise<{ entries: { id: string; content: string; createdAt: number; updatedAt: number; source?: "user" | "auto" | "session"; lastInjectedAt?: number }[] }>;
	add(content: string): Promise<{ id: string; content: string; createdAt: number; updatedAt: number }>;
	remove(id: string): Promise<boolean>;
	clear(): Promise<void>;
}

/**
 * 这个项目的记忆——跟上面那个跨项目的偏好库是两回事。
 *
 * 上面那个是「我这个人的习惯」，存在 `~/.plume/memory.json`；这个是「这个仓库怎么回事」，
 * 由后台抽取从历史会话里读出来，存在项目自己的记忆目录。
 */
export interface ProjectMemoryApi {
	/**
	 * 现在该不该跑一遍抽取。
	 *
	 * `never-asked` 不是「不跑」——它是**去问**的信号。窗口拿到这个才弹征询，
	 * 而不是每次空闲都弹。
	 */
	status(cwd: string): Promise<{ run: boolean; reason?: string }>;
	/** 跑一遍。返回写了什么、读了几个会话，或者为什么没跑。 */
	extract(cwd: string): Promise<{ memory: string; sessions: number; skipped?: string }>;
	/** 这个项目记住的：`learn` 写的每一条，和抽取出来的那一份，各带写入时间与最后注入时间。 */
	list(cwd: string): Promise<{
		lessons: { text: string; context?: string; at: number; lastInjectedAt?: number }[];
		extracted: { text: string; updatedAt?: number; lastInjectedAt?: number } | null;
	}>;
	/**
	 * 忘掉一条，按它的写入时间认人。
	 *
	 * 用 `at` 而不是正文：`recordLesson` 会把措辞相近的两条合成一条，正文相同是可能的，
	 * 时间戳相同不会。返回它是不是真的在那儿——两个窗口开着同一个项目就够产生「已经没了」。
	 */
	forget(cwd: string, at: number): Promise<boolean>;
	/** 丢掉后台抽取出来的那一份（`MEMORY.md`）。下一次抽取会重新写。 */
	forgetExtracted(cwd: string): Promise<boolean>;
	/** 这个项目的全部记忆，一次清空。 */
	forgetAll(cwd: string): Promise<void>;
}

export interface IndexApi {
	stats(cwd: string): Promise<{ exists: boolean; builtAt?: number; files?: number; symbols?: number; bytes?: number }>;
	rebuild(cwd: string): Promise<{ exists: boolean; builtAt?: number; files?: number; symbols?: number; bytes?: number }>;
	search(cwd: string, query: string): Promise<{ name: string; kind: string; file: string; line: number }[]>;
}
