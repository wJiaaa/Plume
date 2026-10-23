/**
 * Undoing a turn's file changes, from the card or from the review beside it.
 *
 * Nothing here hands the new state on: the main process pushes it to every window, and both surfaces
 * read it from `delivery-cache.ts`. What is left is the confirm, the one-at-a-time lock, and what
 * the surface does once the turn has nothing left to undo.
 */

import { useRef, useState } from "react";
import type { TurnDelivery } from "@plume/contract";
import { useI18n } from "../../i18n/index.ts";
import { bridge } from "../../services/index.ts";
import { useApp } from "../../store/index.ts";
import { useConfirmer } from "../../ui/overlay/Confirm.tsx";
import { rememberDelivery } from "./delivery-cache.ts";

export function useDeliveryUndo(sessionId: string | null, timestamp: number | null, afterUndo: (value: TurnDelivery) => void) {
	const { t } = useI18n();
	const confirm = useConfirmer();
	const [undoing, setUndoing] = useState(false);
	const lock = useRef(false);
	const undo = async (path?: string) => {
		if (!sessionId || timestamp === null || lock.current) return;
		lock.current = true;
		setUndoing(true);
		try {
			const value = await bridge.delivery.undo(sessionId, timestamp, path);
			rememberDelivery(sessionId, timestamp, value);
			useApp.getState().notify(t("delivery.reverted"), "info");
			afterUndo(value);
		} catch (error) {
			useApp.getState().notify(String(error), "error");
		} finally {
			lock.current = false;
			setUndoing(false);
		}
	};
	/** One file, or with no path the whole turn. */
	const ask = (path?: string) => {
		confirm.ask({
			title: path ? t("delivery.revertFileConfirm") : t("delivery.revertAllConfirm"),
			detail: t("delivery.revertDetail"),
			confirmLabel: t("delivery.revertChanges"),
			onConfirm: () => undo(path),
		});
	};
	return { undoing, ask, element: confirm.element };
}
