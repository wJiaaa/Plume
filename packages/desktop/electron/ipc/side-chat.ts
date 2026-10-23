/** Side chats, the queue of work a session dispatched, and the wakeups it scheduled for itself. */

import { ipcMain } from "electron";
import { sessions } from "../session/session-hub.ts";
import { sideChatClose, sideChatList, sideChatOpen } from "../session/side-chat-service.ts";

export function registerSideChatIpc(): void {
	ipcMain.handle("sidechat:list", (_event, sessionId: string) => sideChatList(sessionId));
	ipcMain.handle("sidechat:open", (_event, sessionId: string, sideId: string) => sideChatOpen(sessionId, sideId));
	ipcMain.handle("sidechat:close", (_event, sessionId: string, sideId: string) => sideChatClose(sessionId, sideId));
	ipcMain.handle("tasks:list", (_event, sessionId: string) => sessions.get(sessionId)?.taskQueue ?? []);
	ipcMain.handle("tasks:cancel", async (_event, sessionId: string, taskId: string) => (await sessions.get(sessionId)?.cancelTask(taskId)) ?? false);
	ipcMain.handle("tasks:dismiss", async (_event, sessionId: string, taskId: string) => (await sessions.get(sessionId)?.dismissTask(taskId)) ?? false);
	ipcMain.handle("tasks:resume", async (_event, sessionId: string, taskId: string) => (await sessions.get(sessionId)?.resumeTask(taskId)) ?? false);
	ipcMain.handle("wakeups:list", (_event, sessionId: string) => sessions.get(sessionId)?.wakeups.list() ?? []);
	ipcMain.handle("wakeups:cancel", (_event, sessionId: string, wakeupId: string) => sessions.get(sessionId)?.wakeups.cancel(wakeupId) ?? false);
}
