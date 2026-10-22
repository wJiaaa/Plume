/**
 * 回复里的一张图：能画就画，画不了就留成一条写着名字的链接。
 */

import { translate } from "../../i18n/translate.ts";
import { ExternalLink } from "../../ui/icons/index.ts";
import { useContext, useEffect, useState } from "react";
import { resolveAsset, isAbsolutePath } from "../../lib/markdown/assets.ts";
import { bridge } from "../../services/index.ts";
import { useScopedProjectPath } from "../../app/session-scope.tsx";
import { Doc, Writing } from "./context.ts";
import { Link } from "./MarkdownLink.tsx";

/**
 * A picture, drawn if there is a way to draw it and named if there is not.
 *
 * Three sources, three answers, and the page's `img-src` — `self data: blob:` — never moves:
 *
 * - `data:` and `blob:` go straight into `src`, as they always did.
 * - A path beside the file goes through `ly-media:`, the scheme the file panel already uses for
 *   images and video. Its handler re-checks that the path is inside an open project, so a README
 *   pointing at `../../../.ssh/id_rsa` gets a 403 rather than a picture.
 * - An https URL is fetched by the main process and comes back as a data URL, the same route
 *   avatars and registry logos take — and only for documents whose caller asked for it.
 *
 * Anything left over stays what it was: a named link that opens in the browser, which keeps the
 * reference and its filename instead of leaving a broken image behind.
 */
export function Image({ src, alt, width, height }: { src: string; alt: string; width?: number; height?: number }) {
	const { baseDir, remoteImages, localImages } = useContext(Doc);
	const project = useScopedProjectPath();
	/*
	 * 定在挂上那一刻：回复正在写时落下的图，先站在占位里、加载完再显影；写完的转录里的图直接就在，
	 * 否则每次滚回视野（重新挂载）都要再显影一遍。
	 */
	const [reveal] = useState(useContext(Writing));
	const [loaded, setLoaded] = useState<string | null>(null);
	const [small, setSmall] = useState(false);
	const remote = remoteImages && src.startsWith("https://") ? src : null;
	const fetched = useRemoteImage(remote);
	// A `src` that would not load — refused by the media protocol, or gone from the disk — is drawn as its link.
	const [broken, setBroken] = useState<string | null>(null);

	const direct = src.startsWith("data:") || src.startsWith("blob:") ? src : null;
	const base = baseDir ?? (localImages ? (project ?? (isAbsolutePath(src.trim()) ? "/" : undefined)) : undefined);
	const onDisk = direct || remote ? null : resolveAsset(base, src);
	const checked = localImages && !baseDir ? onDisk : null;
	const version = useFileVersion(checked);
	const local = !onDisk ? null : !checked ? bridge.files.mediaUrl(onDisk) : typeof version === "number" ? bridge.files.mediaUrl(onDisk, version) : null;
	const resolved = direct ?? fetched ?? (local === broken ? null : local);

	if (resolved) {
		const settling = reveal && checked !== null;
		const waiting = settling && loaded !== resolved;
		const picture = (
			<img
				src={resolved}
				alt={alt}
				loading="lazy"
				onError={() => setBroken(resolved)}
				onLoad={(event) => {
					setLoaded(resolved);
					if (checked) setSmall(fitsInLine(event.currentTarget, height));
				}}
				/*
				 * The author's `width` as a maximum, not as a width.
				 *
				 * `<img width="200">` in a README means "at most this big"; setting the attribute
				 * itself would also make it a minimum, and a 200px logo would then overflow a pane
				 * narrower than that rather than shrinking with everything else.
				 */
				style={{ maxWidth: width ? `min(100%, ${width}px)` : undefined, maxHeight: height ? `${height}px` : undefined }}
				className={`ly-md-image${checked && !small ? " ly-md-image-block" : ""}${waiting ? " ly-md-image-waiting" : settling ? " ly-image-reveal" : ""}`}
			/>
		);
		// 加载完之前图本身没有高度：占位留着，图在它旁边不占地方地加载。结构两头一样，图是同一个元素，不重新加载。
		return (
			<>
				{waiting && <ImagePending />}
				{picture}
			</>
		);
	}

	// In flight: a gap, not a link that is about to be replaced by the picture underneath it.
	if (remote && fetched === undefined) return null;
	if (checked && version === undefined) return reveal ? <ImagePending /> : null;

	const name = alt || decodeURIComponent(src.split("/").pop()?.split("?")[0] || translate("markdown.image"));
	return (
		<Link href={src}>
			<span className="ly-md-image-link">
				{/* The same size as the file chip's icon: two kinds of link prefix in one paragraph, and at 11.5px beside body text it is only x-height tall and reads as punctuation. */}
				<ExternalLink size={13} strokeWidth={1.9} />
				{name}
			</span>
		</Link>
	);
}

/**
 * 不超过两行字高的图留在字里，更高的独占一行。
 *
 * 只管回复里的本地图。`.ly-md-image` 默认行内是为了 README 的徽章排成一行，那些都在两行字高以内，
 * 照旧；二维码、截图跟在字里，会把一行字撑成图那么高、字悬在图中间。没加载完之前当它是大图：
 * 回复里的图多半是大的，先独占一行，小图标加载完再并回字里，比反过来跳得少。
 */
function fitsInLine(img: HTMLImageElement, height?: number): boolean {
	const line = Number.parseFloat(getComputedStyle(img).lineHeight) || 24;
	return Math.min(img.naturalHeight, height ?? Number.POSITIVE_INFINITY) <= line * 2;
}

/** 一张还没到的图站的位置：和生成图等图时同一块点阵底板（`.ly-canvas`）。 */
export function ImagePending() {
	return <span className="ly-md-image-pending ly-canvas" aria-hidden="true" />;
}

/**
 * When a file on disk last changed, for the media URL — see `mediaUrl`.
 *
 * Read once per mount and per path: the agent overwriting a picture in place and then pointing a new
 * reply at it is the case this exists for, and that reply mounts a new `Image`. Same three states as
 * `useRemoteImage`; `null` is a file this window may not read, which stays a link. Only for a reply's
 * own paths — a file pane's documents are reread with the pane.
 */
function useFileVersion(path: string | null): number | null | undefined {
	const [read, setRead] = useState<{ path: string; version: number | null } | null>(null);

	useEffect(() => {
		if (!path) return;
		let alive = true;
		void bridge.files
			.read(path)
			.catch(() => null)
			.then((contents) => alive && setRead({ path, version: contents ? (contents.modifiedAt ?? 0) : null }));
		return () => {
			alive = false;
		};
	}, [path]);

	return path && read?.path === path ? read.version : undefined;
}

/**
 * One remote picture as a data URL.
 *
 * Three states, not two: `undefined` while the request is in flight, `null` once it has failed,
 * and the data URL when it arrived. The caller needs the distinction — a picture that has not
 * answered yet should leave a gap, and one that will never answer should fall back to its link, so
 * the reference is not silently lost.
 */
function useRemoteImage(url: string | null): string | null | undefined {
	const [data, setData] = useState<string | null | undefined>(undefined);

	useEffect(() => {
		if (!url) return;
		let alive = true;
		setData(undefined);
		void bridge.system
			.remoteImage(url)
			.then((result) => alive && setData(result))
			.catch(() => alive && setData(null));
		return () => {
			alive = false;
		};
	}, [url]);

	return url ? data : null;
}
