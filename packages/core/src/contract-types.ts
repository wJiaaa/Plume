/**
 * core 里跨过桌面端 IPC 边界的那些类型，给 `@plume/contract` 用。
 *
 * 只有 `export type`：契约只许从这里（和 `client-types`）拿类型，拿不到值——就算有人漏写了
 * `import type`，编译也会拒绝，而不是悄悄把 core 的 index 链进 preload 或手机的包里。
 * 从 `index.ts` 转出而不是逐个点名深处的文件：那些文件会搬家，出口不会。
 */
export type {
	AgentDefinitionRecord,
	AgentDefinitionSave,
	AgentEvent,
	ApprovalDecision,
	BuiltinCommand,
	BundleKind,
	CacheCause,
	CompactCode,
	ConfigProblem,
	ContextBreakdown,
	DiffHunk,
	ExtractedText,
	Gallery,
	HookDraft,
	HookEventName,
	HookScope,
	InstallRecord,
	LayerOverride,
	McpBundle,
	McpPromptEntry,
	McpServerStatus,
	MessageAttachment,
	NoticeParams,
	Plugin,
	PluginDiagnostic,
	QueuedTask,
	Registry,
	RegistryEntry,
	ScreenshotSettings,
	SessionMeta,
	Settings,
	Skill,
	SkillCandidate,
	SkillDiagnostic,
	SkillEntry,
	SlashCommand,
	SpawnedFrom,
	SubAgentDetail,
	SubAgentSummary,
	ThinkingLevel,
	TrajectoryChanges,
	TrajectoryEntry,
	UndoProblem,
	UsageReplayRow,
	UserContent,
} from "./index.ts";
export type { ModelCatalogDocument } from "./model-catalog-format.ts";
export type { CatalogSyncResult } from "./model-catalog-sync.ts";
