/**
 * 截图测试拍的「屏幕」，换成 Plume 自己的一张窗口截图。
 *
 * 只换操作系统取屏的那一层，截图本身——start / init、指针、裁剪、IPC、写文件、提示——全照真的跑。
 * 换它有两个理由，各自都够：
 *
 * - 真屏幕上是用户手边的私人窗口，测试不该把它们拍进来，更不该写进下载目录。
 * - 真取屏要这台机器给 Electron 开过屏幕录制。本地装的 Electron 每换一次二进制授权就没了（见
 *   `warmCapturePipeline` 那段注释），没有授权时 `captureFullDisplaySnapshot` 安静地返回 null，
 *   浮层不进 active，后面每一条都只会报「拖拽之后没有选区」——量的是机器的授权，不是截图。
 *
 * macOS 上真截图先走取屏小程序（ADR-0052），它绕开 `desktopCapturer` 直接读屏，所以只替换
 * `desktopCapturer` 不够：这里把系统版本报成小程序不支持的 15.0，并停掉启动预热时可能已经拉起
 * 的那一个，截图就只剩 `desktopCapturer` 这一条路。
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunningApp } from "./app.ts";

/** 拍下主窗口此刻的样子，从现在起每次截图拍到的都是它。返回那张 PNG 的路径。 */
export async function captureOwnWindowAsScreen(app: Pick<RunningApp, "send" | "main" | "home">): Promise<string> {
	const { data } = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	const fixture = join(app.home, "own-window-as-screen.png");
	await writeFile(fixture, Buffer.from(data, "base64"));
	const installed = await app.main<boolean>(`(() => {
		const require = process.getBuiltinModule('module').createRequire(process._linkedBinding('electron_browser_app').app.getAppPath() + '/package.json');
		const e = require('electron'), image = e.nativeImage.createFromPath(${JSON.stringify(fixture)});
		e.systemPreferences.getMediaAccessStatus = () => 'granted';
		e.desktopCapturer.getSources = async (options) => e.screen.getAllDisplays().map((d) => ({
			id: 'screen:' + d.id + ':0', display_id: String(d.id), name: 'Plume window fixture', thumbnail: image.resize(options.thumbnailSize),
		}));
		process.getSystemVersion = () => '15.0.0';
		// pkill 没匹配到会以 1 退出，那正是「本来就没有在跑」。
		try { process.getBuiltinModule('child_process').execFileSync('pkill', ['-P', String(process.pid), '-x', 'plume-screen-capture']); } catch {}
		return !image.isEmpty() && process.getSystemVersion() === '15.0.0';
	})()`);
	if (!installed) throw new Error("the window fixture did not replace the screen capture");
	return fixture;
}
