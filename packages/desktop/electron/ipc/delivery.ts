import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { SessionStorage } from "@plume/core";
import { grantArtifactRead } from "../session/readable-artifacts.ts";
import { sessionDelivery, undoDeliveryFile } from "../session/turn-delivery.ts";
import { eachAppWindow, isAppWindowContents } from "../window.ts";
export function registerDeliveryIpc(store: () => SessionStorage): void {
	const trusted = (event: IpcMainInvokeEvent, id: unknown, at: unknown) => {
		if (!isAppWindowContents(event.sender) || event.senderFrame !== event.sender.mainFrame || typeof id !== "string" || typeof at !== "number" || !Number.isFinite(at)) throw new Error("无效的交付记录请求");
	};
	ipcMain.handle("delivery:get", async (event, id: string, at: number) => { trusted(event, id, at); const result = await sessionDelivery(store(), id, at); if (result.reportPath) grantArtifactRead(result.reportPath); return result; });
	ipcMain.handle("delivery:undo", async (event, id: string, at: number, path?: string) => {
		trusted(event, id, at); if (path !== undefined && typeof path !== "string") throw new Error("无效路径");
		const result = await undoDeliveryFile(store(), id, at, path);
		if (result.reportPath) grantArtifactRead(result.reportPath);
		// Every window, the one that undid included: a card and its review, or a popped-out pane, may each be showing this turn.
		eachAppWindow((win) => win.webContents.send("delivery:changed", { sessionId: id, timestamp: at, delivery: result }));
		return result;
	});
}
