/**
 * The icon another application already has.
 *
 * Better than shipping our own drawings of other people's logos: it is the icon the user already
 * recognises from their own Dock, at whatever version they have installed. An app that is not
 * installed simply has none, which is also the answer to whether it belongs in the list.
 *
 * macOS only. Everywhere else these return null and the caller falls back to a plain label.
 */

import { execFile } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Icons change about as often as applications are installed; one lookup per name is plenty. */
const appIconCache = new Map<string, string | null>();
/** The icon file a bundle declares, which is not always named after the app. */
async function iconFileFor(bundle: string): Promise<string | null> {
	const { stdout } = await execFileAsync("defaults", ["read", `${bundle}/Contents/Info`, "CFBundleIconFile"]).catch(
		() => ({ stdout: "" }),
	);
	const name = stdout.trim();
	if (!name) return null;
	const file = name.endsWith(".icns") ? name : `${name}.icns`;
	const path = `${bundle}/Contents/Resources/${file}`;
	return (await stat(path).then(() => true).catch(() => false)) ? path : null;
}

async function renderAppIcon(appName: string): Promise<string | null> {
	const bundle = await findApp(appName);
	if (!bundle) return null;
	const icns = await iconFileFor(bundle);
	if (!icns) return null;

	// A temporary file, because `sips` writes to a path and not to a pipe.
	const out = join(tmpdir(), `ly-icon-${Buffer.from(appName).toString("hex")}.png`);
	await execFileAsync("sips", ["-s", "format", "png", "--resampleWidth", "128", icns, "--out", out]);
	const png = await readFile(out).catch(() => null);
	await rm(out, { force: true }).catch(() => {});
	return png ? `data:image/png;base64,${png.toString("base64")}` : null;
}

/**
 * Where an application lives, by display name.
 *
 * The four directories macOS actually keeps applications in — third-party ones, the bundled
 * ones Apple moved out of /Applications in Catalina, the utilities folder, and the services
 * directory where Finder lives. Spotlight is the fallback for anything installed elsewhere,
 * matched on file name because display names are localised and ours are not.
 */
const APP_DIRS = [
	"/Applications",
	"/System/Applications",
	"/System/Applications/Utilities",
	"/System/Library/CoreServices",
];

/**
 * Whether a path is actually an application, rather than something merely named like one.
 *
 * Spotlight matches on file name, and a name ending in `.app` is not a promise: `iTerm.app` is
 * also a terminfo database at `/usr/share/terminfo/69/iTerm.app`, which is a *file*. Finding that
 * one made the app appear installed — offered in 「默认文件打开目标」, with no icon, because there
 * was no bundle to read one from. An executable directory is what makes it a bundle.
 */
async function isBundle(path: string): Promise<boolean> {
	const info = await stat(path).catch(() => null);
	if (!info?.isDirectory()) return false;
	return stat(`${path}/Contents/MacOS`).then((entry) => entry.isDirectory()).catch(() => false);
}

export async function findApp(name: string): Promise<string | null> {
	for (const dir of APP_DIRS) {
		const candidate = `${dir}/${name}.app`;
		if (await isBundle(candidate)) return candidate;
	}
	const { stdout } = await execFileAsync("mdfind", ["-name", `${name}.app`]).catch(() => ({ stdout: "" }));
	for (const line of stdout.split("\n")) {
		const path = line.trim();
		if (path.endsWith(`${name}.app`) && (await isBundle(path))) return path;
	}
	return null;
}

/**
 * The app's icon as a data URL, or null.
 *
 * Cached by name: icons change about as often as applications are installed, and the lookup shells
 * out twice.
 */
export async function appIcon(appName: string): Promise<string | null> {
	if (process.platform !== "darwin") return null;
	const cached = appIconCache.get(appName);
	if (cached !== undefined) return cached;
	const rendered = await renderAppIcon(appName).catch(() => null);
	appIconCache.set(appName, rendered);
	return rendered;
}
