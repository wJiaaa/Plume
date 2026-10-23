/**
 * 谁来跑后台抽取，什么时候跑。
 *
 * `memory-extract.ts` 那份代码写完之后，很长一段时间里**没有任何东西调用它**——它自己的注释
 * 写着「同意与调度归调用方」，而那个调用方一直没有写。结果是：抽取出来的 `MEMORY.md` 会被读
 * 进提示词（那一半是接好的），而写它的那一半从不运行，所以那个文件永远是空的。整套东西看起来
 * 完整、测试全绿、一个字节也没产生过。
 *
 * 这个文件就是那个缺掉的一半，三件事：
 *
 *   **同意。** 设置里的 `memoryExtraction` 打开才跑，默认关：抽取会把会话内容发给模型。
 *
 *   **节流。** 一次抽取要读几十个会话，问一次模型。每小时跑一遍不会得到更好的记忆，只会得到
 *   更高的账单。
 *
 *   **模型。** 设置里单独选的 `memoryModelId`：读几十段转录、输出一个列表，便宜比聪明要紧得多。
 */

import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import type { Settings } from "../../config/settings.ts";
import { resolveModelRef } from "../../config/model-choice.ts";
import { resolveModel } from "../../config/settings.ts";
import type { streamAssistant } from "../../ai/index.ts";
import { streamAssistant as realStream } from "../../ai/index.ts";
import { projectIdFor } from "../../session/store.ts";
import type { SessionStorage } from "../../session/storage.ts";
import type { ModelConfig, ProviderConfig } from "../../types.ts";
import { extractMemory, findCandidates, type ExtractionResult } from "./memory-extract.ts";
import { projectMemoryDir } from "./project-memory.ts";

/**
 * 两次抽取之间至少隔多久。
 *
 * 候选会话本身就要「至少 12 小时没动过」，所以一天跑一次已经覆盖了每一个会变成候选的会话。
 * 更勤只会重复读同样那几十段转录。
 */
export const PASS_INTERVAL_MS = 24 * 60 * 60 * 1000;

type PassModel = { provider: ProviderConfig; model: ModelConfig };

/** 抽取该不该跑：跑就带上用哪个模型，不跑就说为什么。 */
export type PassVerdict = ({ run: true } & PassModel) | { run: false; reason: "declined" | "too-soon" | "no-model" };

/** 问一次这个项目现在该不该跑。 */
export function shouldRunPass(settings: Settings, lastRunAt: number | null, now = Date.now()): PassVerdict {
	if (settings.personalization?.enableProjectMemory === false || settings.memoryExtraction !== true) return { run: false, reason: "declined" };
	if (lastRunAt !== null && now - lastRunAt < PASS_INTERVAL_MS) return { run: false, reason: "too-soon" };
	/*
	 * 没有可用模型不是「跑失败」，是根本没得跑。单独一个原因，是因为一个还没配供应商的窗口
	 * 会每隔五分钟安静地失败一次，而屏幕上没有任何东西说这件事。
	 */
	const resolved = passModel(settings);
	return resolved ? { run: true, ...resolved } : { run: false, reason: "no-model" };
}

/** 抽取用哪个模型：设置里单独选的，没选或已被删掉就用新会话的默认模型。 */
function passModel(settings: Settings): PassModel | null {
	const fallback = resolveModel(settings, settings.defaultModelId ?? "");
	if (fallback) return resolveModelRef(settings, settings.memoryModelId, fallback);
	return settings.memoryModelId ? resolveModel(settings, settings.memoryModelId) : null;
}

/** 上次跑完的时间戳，没跑过就是 null。 */
export async function lastPassAt(cwd: string): Promise<number | null> {
	const raw = await readFile(join(projectMemoryDir(cwd), ".last-pass"), "utf8").catch(() => null);
	const at = raw === null ? Number.NaN : Number.parseInt(raw.trim(), 10);
	return Number.isFinite(at) ? at : null;
}

async function markPass(cwd: string, at: number): Promise<void> {
	const dir = projectMemoryDir(cwd);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, ".last-pass"), String(at), "utf8");
}

export interface PassOptions {
	cwd: string;
	settings: Settings;
	storage: SessionStorage;
	/** 覆盖发请求的方式，跟会话里那个 `streamFn` 同一个用途。 */
	stream?: typeof streamAssistant;
	/** 抽取候选的年龄判断基准，只有测试会传。 */
	now?: number;
	signal?: AbortSignal;
}

/**
 * 跑一遍，或者说清楚为什么没跑。
 *
 * **时间戳在跑之前就写下**。一次没找到候选、或者模型没返回的空跑，跟一次成功的抽取花掉的是
 * 同一批工作（读几十个会话文件）；不记下来，一个没有候选的项目会在每一次空闲时重读一遍全部
 * 转录，永远。
 */
export async function runMemoryPass(options: PassOptions): Promise<ExtractionResult> {
	const now = options.now ?? Date.now();
	const verdict = shouldRunPass(options.settings, await lastPassAt(options.cwd), now);
	if (!verdict.run) return { memory: "", sessions: 0, skipped: verdict.reason };

	const candidates = await findCandidates(options.storage, projectIdFor(options.cwd), now);
	await markPass(options.cwd, now);
	// 没有候选时 `extractMemory` 自己交回「没有符合条件的会话」。
	return extractMemory({
		cwd: options.cwd,
		candidates,
		provider: verdict.provider,
		model: verdict.model,
		stream: options.stream ?? realStream,
		signal: options.signal,
		// A ledger that cannot be written must not cost the memory the reply just paid for.
		spent: (usage) =>
			options.storage.recordUsage({ source: "memory-extract", providerId: verdict.provider.id, modelId: verdict.model.modelId, usage }).catch(() => {}),
	});
}
