/**
 * Every method the renderer may call.
 *
 * This list is the answer to a question that used to be answered in two places:
 *
 *   which channel does this method use      → `preload.ts`, one `invoke` per method
 *   what does it look like                  → `ipc-types.ts`, a hand-written interface
 *
 * Both answers live in this package now: the channel here, the signature in `api.ts` and the file
 * for its subject (ADR-0055).
 *
 * `test/methods.test.ts` compares it with `preload.ts` and every `ipcMain.handle` in the main
 * process on every run, so none of them can drift apart again. The main process was the last one
 * added and the one that mattered most: it is the end that actually answers, and it was the end
 * nothing looked at.
 */

/**
 * The methods, by group, each naming its IPC channel. The channel appears here and nowhere else, so
 * it cannot be misspelt at a call site.
 *
 * Grouped the way `window.plume` is grouped, so a reader can hold one subject at a time. Within a
 * group the order is the order they appear in the preload, which is roughly the order they were
 * written.
 */
export const METHODS = {
	mobile: {
		status: "mobile:status",
		start: "mobile:start",
		stop: "mobile:stop",
		rotateToken: "mobile:rotateToken",
		setRelay: "mobile:setRelay",
	},
	agentDefinitions: {
		list: "agentdefs:list",
		read: "agentdefs:read",
		save: "agentdefs:save",
		remove: "agentdefs:remove",
	},
	delivery: {
		get: "delivery:get",
		undo: "delivery:undo",
	},
	services: {
		list: "services:list",
		stop: "services:stop",
		output: "services:output",
	},
	browser: {
		state: "browser:state",
		command: "browser:command",
		attach: "browser:attach",
		inspect: "browser:inspect",
		cancelInspect: "browser:cancelInspect",
	},
	settings: {
		get: "settings:get",
		save: "settings:save",
		layers: "settings:layers",
	},
	hooks: {
		list: "hooks:list",
		save: "hooks:save",
		remove: "hooks:remove",
		setEnabled: "hooks:setEnabled",
		trust: "hooks:trust",
	},
	usage: {
		scan: "usage:scan",
		storage: "usage:storage",
		clear: "usage:clear",
	},
	gallery: {
		list: "gallery:list",
	},
	worktree: {
		state: "worktree:state",
		merge: "worktree:merge",
		sync: "worktree:sync",
		abortSync: "worktree:abortSync",
	},
	workspace: {
		pick: "workspace:pick",
		info: "workspace:info",
		reveal: "workspace:reveal",
	},
	sessions: {
		list: "sessions:list",
		/* 这个会话此刻在不在跑——权威的那一份，用来和渲染层自己推出来的那份对账。 */
		running: "sessions:running",
		create: "sessions:create",
		transcript: "sessions:transcript",
		/* 只有 e2e 在调：断言持久化下来的轨迹。界面读的是 `trajectoryChanges`。 */
		trajectory: "sessions:trajectory",
		trajectoryChanges: "sessions:trajectoryChanges",
		exportTrajectory: "sessions:exportTrajectory",
		forkBefore: "sessions:forkBefore",
		forkAfter: "sessions:forkAfter",
		remove: "sessions:remove",
		setArchived: "sessions:setArchived",
		reportBack: "sessions:reportBack",
		move: "sessions:move",
		removeArchived: "sessions:removeArchived",
		capabilities: "sessions:capabilities",
		rename: "sessions:rename",
		compact: "sessions:compact",
		contextBreakdown: "sessions:contextBreakdown",
		/* 环境卡片里那段摘要：读存着的那份，和要一份新的。 */
		summary: "sessions:summary",
		summarize: "sessions:summarize",
	},
	agent: {
		prompt: "agent:prompt",
		editMessage: "agent:editMessage",
		revertMessage: "agent:revertMessage",
		abort: "agent:abort",
		approve: "agent:approve",
		setModel: "agent:setModel",
		setThinking: "agent:setThinking",
		setPlanMode: "agent:setPlanMode",
	},
	subAgents: {
		list: "subagents:list",
		detail: "subagents:detail",
		contextBreakdown: "subagents:contextBreakdown",
		steer: "subagents:steer",
		abort: "subagents:abort",
		dismiss: "subagents:dismiss",
	},
	sideChat: {
		list: "sidechat:list",
		open: "sidechat:open",
		close: "sidechat:close",
	},
	tasks: {
		list: "tasks:list",
		cancel: "tasks:cancel",
		dismiss: "tasks:dismiss",
		resume: "tasks:resume",
	},
	files: {
		list: "files:list",
		read: "files:read",
		document: "files:document",
		documentText: "files:documentText",
		bytes: "files:bytes",
		media: "files:media",
		create: "files:create",
		rename: "files:rename",
		copy: "files:copy",
		trash: "files:trash",
		remove: "files:remove",
		uniquePath: "files:uniquePath",
		exists: "files:exists",
		locate: "files:locate",
		importInto: "files:import",
		pick: "files:pick",
	},
	clipboard: {
		read: "clipboard:read",
		write: "clipboard:write",
		writeImage: "clipboard:writeImage",
	},
	terminal: {
		list: "terminal:list",
		listAll: "terminal:list-all",
		open: "terminal:open",
		attach: "terminal:attach",
	},
	providers: {
		test: "providers:test",
		fetchModels: "providers:fetchModels",
		modelCatalog: "providers:modelCatalog",
		updateModelCatalog: "providers:updateModelCatalog",
	},
	commands: {
		list: "commands:list",
		prompts: "commands:prompts",
		prompt: "commands:prompt",
		create: "commands:create",
		reveal: "commands:reveal",
		open: "commands:open",
	},
	plugins: {
		list: "plugins:list",
		revealDir: "plugins:revealDir",
		fetchRegistry: "registry:fetch",
		icon: "registry:icon",
		icons: "registry:icons",
		readme: "registry:readme",
		installFromRegistry: "registry:install",
		uninstall: "registry:uninstall",
		updates: "plugins:updates",
		updateAll: "plugins:updateAll",
		environment: "plugins:environment",
		mcpStatus: "plugins:mcpStatus",
		mcpLogin: "plugins:mcpLogin",
		mcpLogout: "plugins:mcpLogout",
		mcpReconnect: "plugins:mcpReconnect",
	},
	updates: {
		check: "updates:check",
		state: "updates:state",
		download: "updates:download",
		pause: "updates:pause",
		cancel: "updates:cancel",
		relaunch: "updates:relaunch",
		reopen: "updates:reopen",
		open: "updates:open",
	},
	windows: {
		keepOnTop: "windows:keepOnTop",
		capture: "windows:capture",
		open: "windows:open",
		list: "windows:list",
		openInMain: "windows:openInMain",
		openPanel: "windows:openPanel",
		openPanelInMain: "windows:openPanelInMain",
		filePanelState: "windows:filePanelState",
		restorePanel: "windows:restorePanel",
		closePanel: "windows:closePanel",
	},
	chatBackground: {
		pick: "chatbackground:pick",
		read: "chatbackground:read",
		remove: "chatbackground:remove",
	},
	system: {
		openPath: "system:openPath",
		openExternal: "system:openExternal",
		defaultBrowser: "system:defaultBrowser",
		openIn: "system:openIn",
		openTargets: "system:openTargets",
		revealSkillsDir: "system:revealSkillsDir",
		platform: "system:platform",
		remoteImage: "system:remoteImage",
		pathExists: "system:pathExists",
		isDirectory: "system:isDirectory",
	},
	screenshot: {
		start: "screenshot:start",
		finish: "screenshot:finish",
		cancel: "screenshot:cancel",
		download: "screenshot:download",
		pin: "screenshot:pin",
		/* 只有 e2e 在调：置顶窗口关掉之后主进程里是不是真没了，界面上看不出来。 */
		pinnedCount: "screenshot:pinnedCount",
		pickDirectory: "screenshot:pickDirectory",
	},
	/*
	 * 置顶在桌面的那张图片，自己的窗口在问自己的事。
	 *
	 * 单独一组而不是挂在 screenshot 下面：用到它的时候截图早就结束了，剩下的只是一个显示图片的
	 * 小窗口。它拉取而不是被推送——组件是按需加载的，窗口 did-finish-load 时监听还没注册，推过去
	 * 的消息会无声地掉在地上，窗口就空着。
	 */
	pinnedShot: {
		request: "pin:request",
	},
	index: {
		stats: "index:stats",
		rebuild: "index:rebuild",
		search: "index:search",
	},
	scheduler: {
		runNow: "scheduler:runNow",
	},
	capabilities: {
		trash: "capabilities:trash",
		diff: "capabilities:diff",
		prefer: "capabilities:prefer",
	},
	/* 从会话里总结出来的技能候选。 */
	skills: {
		pending: "skills:pending",
		approve: "skills:approve",
		reject: "skills:reject",
	},
	forge: {
		kinds: "forge:kinds",
		accounts: "forge:accounts",
		signIn: "forge:signIn",
		signOut: "forge:signOut",
		setEnabled: "forge:setEnabled",
		rename: "forge:rename",
	},
	git: {
		myPullRequests: "git:myPullRequests",
		pullRequest: "git:pullRequest",
		pullRequestDiff: "git:pullRequestDiff",
		scratchForPullRequest: "scratch:forPullRequest",
		generalScratch: "scratch:general",
		scratchRoots: "scratch:roots",
		findLocalCheckout: "git:findLocalCheckout",
		avatars: "git:avatars",
		commentOnPullRequest: "git:commentOnPullRequest",
		reviewPullRequest: "git:reviewPullRequest",
		branches: "git:branches",
		switchBranch: "git:switchBranch",
		removeWorktree: "git:removeWorktree",
		stat: "git:stat",
		upstream: "git:upstream",
		status: "git:status",
		repos: "git:repos",
		worktrees: "git:worktrees",
		init: "git:init",
		log: "git:log",
		commitDiff: "git:commitDiff",
		commitDiffSummary: "git:commitDiffSummary",
		diffRefs: "git:diffRefs",
		stage: "git:stage",
		unstage: "git:unstage",
		discard: "git:discard",
		commitStaged: "git:commitStaged",
		generateCommitMessage: "git:generateCommitMessage",
		createBranch: "git:createBranch",
		deleteBranch: "git:deleteBranch",
		push: "git:push",
		pull: "git:pull",
		fetch: "git:fetch",
		cancelRemote: "git:cancelRemote",
		releaseInfo: "git:releaseInfo",
		bumpVersion: "git:bumpVersion",
		triggerDryRun: "git:triggerDryRun",
		listWorkflowRuns: "git:listWorkflowRuns",
		workflowRunStatus: "git:workflowRunStatus",
		publishReleaseTag: "git:publishReleaseTag",
	},
	memory: {
		load: "memory:load",
		add: "memory:add",
		remove: "memory:remove",
		clear: "memory:clear",
	},
	/*
	 * 分组叫 `projectMemory`，channel 却在 `memory:` 域下。
	 *
	 * 不是不一致。channel 的形状是 `域:动作`，而域必须是一个小写词——`methods.test.ts` 在管这件
	 * 事，它的注释写得很好：「已知的一处例外」和「随便怎么写都行」是两回事。而项目记忆和用户
	 * 偏好记忆读写的是不同的地方、有各自的开关，在 `window.plume` 上分开才说得清。
	 *
	 * 于是域共用、动作带前缀。这条测试是在 `git push` 的钩子里抓到我的——它值这个位置。
	 */
	projectMemory: {
		status: "memory:projectStatus",
		extract: "memory:projectExtract",
		list: "memory:projectList",
		forget: "memory:projectForget",
		forgetExtracted: "memory:projectForgetExtracted",
		forgetAll: "memory:projectForgetAll",
	},
	diff: {
		workspaceDiff: "diff:workspace",
		blob: "diff:blob",
	},
} as const satisfies Record<string, Record<string, string>>;

/** Every channel name, flat. For the checks that compare the contract with what the main process registers. */
export const CHANNELS: readonly string[] = Object.values(METHODS).flatMap((group) => Object.values(group));
