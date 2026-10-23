/**
 * 后台抽取：从这个项目的历史会话里读出还用得上的东西。
 *
 * 什么时候叫它由窗口决定，因为「空闲」是界面才知道的事——主进程看不出一个人是在读代码还是去
 * 吃饭了。该不该真的跑（开关、节流、有没有模型）由 `runMemoryPass` 自己判断，不跑就交回原因。
 */

import { ipcMain } from "electron";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
	EXTRACTED_KEY,
	forgetAllLessons,
	forgetExtractedMemory,
	forgetLesson,
	projectInjectedPath,
	projectMemoryDir,
	readExtractedMemory,
	readInjected,
	readLessons,
	runMemoryPass,
	type SessionStorage,
} from "@plume/core";
import { settings } from "../app-settings.ts";

export interface ProjectMemoryIpcDeps {
	store(): SessionStorage;
}

export function registerProjectMemoryIpc({ store }: ProjectMemoryIpcDeps): void {
	/**
	 * What this project remembers, for the page: each lesson with when it was written and when it
	 * last reached the model, and the extracted file as one item with the same two times.
	 */
	ipcMain.handle("memory:projectList", async (_event, cwd: string) => {
		const [lessons, injected, extracted] = await Promise.all([
			readLessons(cwd).catch(() => []),
			readInjected(projectInjectedPath(cwd)),
			readExtractedMemory(cwd).catch(() => ""),
		]);
		const updatedAt = extracted ? await stat(join(projectMemoryDir(cwd), "MEMORY.md")).then((s) => s.mtimeMs).catch(() => undefined) : undefined;
		return {
			lessons: lessons.map((lesson) => ({ ...lesson, lastInjectedAt: injected[lesson.text] })),
			extracted: extracted ? { text: extracted, updatedAt, lastInjectedAt: injected[EXTRACTED_KEY] } : null,
		};
	});

	/*
	 * 忘掉一条，或者忘掉抽取出来的那一份。
	 *
	 * 这里的每一条都会被注入这个项目的每一次请求。一条错的记忆不是碍眼，是一句对模型永远重复
	 * 的指示——在这之前，撤回它的唯一办法是自己去 `~/.plume/projects` 底下翻那个项目的记忆目录。
	 */
	ipcMain.handle("memory:projectForget", async (_event, cwd: string, at: number) => forgetLesson(cwd, at));

	ipcMain.handle("memory:projectForgetExtracted", async (_event, cwd: string) => forgetExtractedMemory(cwd));

	ipcMain.handle("memory:projectForgetAll", async (_event, cwd: string) => {
		await Promise.all([forgetAllLessons(cwd), forgetExtractedMemory(cwd)]);
	});

	/*
	 * 不 await 也不行——窗口要拿结果来决定 toast 说什么。
	 *
	 * 它跑在主进程里，一次请求，几秒。真正保证它不打扰人的是调用时机（空闲），不是异步与否。
	 */
	ipcMain.handle("memory:projectExtract", async (_event, cwd: string) =>
		runMemoryPass({ cwd, settings: settings(), storage: store() }),
	);
}
