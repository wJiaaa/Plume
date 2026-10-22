/**
 * The screen capture overlay, and the small windows a capture can be pinned to.
 */

import type { ScreenshotSettings } from "@plume/core/contract-types";

export interface ScreenshotApi {
	start(settings?: ScreenshotSettings): Promise<void>;
	finish(dataUrl: string, settings?: ScreenshotSettings): Promise<{ ok: boolean; filePath?: string }>;
	cancel(): Promise<void>;
	/**
	 * Write the capture to the download directory and end the capture.
	 *
	 * Separate from `finish` because an unset destination means the opposite thing: there, no
	 * save location means "keep no file"; here the file is the errand, so it falls back to the
	 * desktop. Returns where it went, which is what the confirmation says.
	 */
	download(dataUrl: string, settings?: ScreenshotSettings): Promise<{ ok: boolean; filePath?: string; error?: string }>;
	/**
	 * Leave the region on screen as a small always-on-top window, and end the capture.
	 *
	 * `at` is where the region was, in screen coordinates, so the window opens exactly over the
	 * frozen picture it replaces — which is what makes it read as the capture staying put.
	 */
	pin(dataUrl: string, at?: { x: number; y: number; width: number; height: number }): Promise<{ ok: boolean }>;
	/** How many pinned pictures are on screen. For tests; nothing in the app reads it. */
	/** Only e2e calls it: whether a closed pin is really gone from the main process. */
	pinnedCount(): Promise<number>;
	pickDirectory(): Promise<string | null>;
	onInit(
		handler: (payload: {
			/**
			 * The screen, as raw RGBA pixels rather than an encoded image.
			 *
			 * Encoding it to PNG so it could be decoded again on the other side of this message
			 * measured 133ms — the largest single thing Plume contributed to the wait before a
			 * capture appears, and the picture is taken before that wait, so it was time in which
			 * the screen could change and then appear to snap back when the frozen copy landed.
			 */
			snapshot: { pixels: Uint8Array; width: number; height: number };
			/**
			 * Which capture this is, counted in the main process.
			 *
			 * The overlay window is built once and then shown and hidden — building it per capture
			 * cost 147ms, and the picture it shows is taken before that, so the delay was visible as
			 * the desktop jumping back a moment when the overlay landed. The page therefore cannot
			 * tell a new capture from the last one by having just loaded, and cannot tell from the
			 * picture either: two captures of an unchanged screen are byte-identical.
			 */
			session: number;
			bounds: { x: number; y: number; width: number; height: number };
			/** On-screen windows, front to back, in the overlay's own coordinates. Empty off macOS. */
			windows?: { x: number; y: number; width: number; height: number; app: string }[];
			/** Where the pointer was when the capture began, so the first highlight needs no movement. */
			cursor?: { x: number; y: number };
			settings?: ScreenshotSettings;
		}) => void,
	): () => void;
	/** Say the snapshot has been drawn, so the overlay can be shown without a blank frame. */
	ready(): void;
	/**
	 * The overlay has composited a frame, and may now be made visible.
	 *
	 * Sent from inside an animation frame. `ready` is not a substitute: it means the snapshot is
	 * in the canvas's bitmap, which is CPU-side work — the window's GPU surface is released while
	 * it is hidden, and one that is still being rebuilt is displayed stretched to the window's
	 * size. That is the "the whole screen scales for an instant" on the first capture and on the
	 * first one after a pause.
	 */
	painted(): void;
	/**
	 * The capture is over on screen, but the window is not down yet.
	 *
	 * Three things end this way — a colour taken, a picture downloaded, a picture pinned — and
	 * each leaves a confirmation up for a moment over the real desktop after the frozen one has
	 * gone. This makes the window click-through for that moment, so the screen behaves normally
	 * the instant it looks normal. `cancel` follows once the message has faded.
	 *
	 * It was called `colourPicked`, back when picking a colour was the only thing that finished
	 * without delivering a picture.
	 */
	passThrough(): void;
	/**
	 * Escape was pressed during a capture. Returns an unsubscribe.
	 *
	 * The main process holds Escape as a global shortcut for as long as a capture is up, and a
	 * global shortcut is never delivered to the focused page as a keydown — so this is the only
	 * way the page hears it.
	 */
	onEscape(handler: () => void): () => void;
	/** The window is on screen — from here a fade has frames to run in. Returns an unsubscribe. */
	onShown(handler: () => void): () => void;
	/**
	 * The capture is over and the window is off screen.
	 *
	 * Sent after the hide has landed, never before: the page answers it by dropping the frozen
	 * screen, which is a white canvas if it is still being looked at. Its other purpose is
	 * memory — the snapshot is a full-resolution copy of the display, and the window holding it
	 * now lives as long as the app does.
	 */
	onHidden(handler: () => void): () => void;
	/** Report a measurement into the capture log, for diagnosing what a recording only hints at. */
	debug(what: string, detail: Record<string, unknown>): void;
}

/**
 * What a pinned picture's own window can do, which is very little on purpose.
 *
 * It receives one image, says when it has drawn it, and closes itself. There is no id in any of
 * these: the window that sent the message is the window it is about, which is the same trick the
 * capture overlay uses and for the same reason — a page cannot then ask about another one.
 */
export interface PinnedShotApi {
	/**
	 * This window's picture, asked for by the window itself.
	 *
	 * Pulled rather than pushed: the component behind this is loaded on demand, so a message sent
	 * when the document finished loading arrives before anything is listening and is dropped —
	 * which showed up as a correctly sized, correctly placed, completely empty window.
	 */
	request(): Promise<{ dataUrl: string; width: number; height: number } | null>;
	/** The picture is on the screen: the window may be shown. */
	ready(): void;
	/** The close button. Destroys this window. */
	close(): void;
	/** A drag has begun: remember where the window is now. */
	dragStart(): void;
	/** How far the pointer has moved since `dragStart`, in screen points. */
	dragMove(dx: number, dy: number): void;
}
