/**
 * Each turn's delivery, once for every surface in this window that shows it.
 *
 * Delivery cards are fetched after the transcript paints. Without a memory, every session click
 * starts from `null` and the card appears one IPC later — a 200px insert in a list you were already
 * reading. The cache is the last payload for that turn, so coming back paints the card at its real
 * height on the first frame.
 *
 * The card and the review beside it read the same entry, so neither keeps a copy that can fall
 * behind the other. An undo, made here or in any other window, reaches the entry through the main
 * process's `delivery:changed` push — a popped-out pane is another renderer, and that push is the one
 * thing every window hears.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { TurnDelivery } from "@plume/contract";
import { bridge } from "../../services/index.ts";
import { useApp } from "../../store/index.ts";

const MAX = 32;
const useDeliveries = create<{ values: Readonly<Record<string, TurnDelivery>> }>(() => ({ values: {} }));
/** Pushes heard per turn: a read that went out before one may answer with what the undo replaced. */
const pushes = new Map<string, number>();

function deliveryKey(sessionId: string, timestamp: number): string {
	return `${sessionId}:${timestamp}`;
}

export function peekDelivery(sessionId: string, timestamp: number): TurnDelivery | undefined {
	return useDeliveries.getState().values[deliveryKey(sessionId, timestamp)];
}

/** Newest last, so the oldest is the first key once there are too many. */
export function rememberDelivery(sessionId: string, timestamp: number, value: TurnDelivery): void {
	const key = deliveryKey(sessionId, timestamp);
	useDeliveries.setState(({ values }) => {
		const kept = Object.entries(values).filter(([old]) => old !== key).slice(1 - MAX);
		return { values: Object.fromEntries([...kept, [key, value]]) };
	});
}

/**
 * The turn's delivery, read when the surface mounts and kept current by every undo of it.
 *
 * Null until the first read answers, unless an earlier one is still remembered.
 */
export function useTurnDelivery(sessionId: string | null, timestamp: number | null): TurnDelivery | null {
	const key = sessionId && timestamp !== null ? deliveryKey(sessionId, timestamp) : null;
	const value = useDeliveries((state) => (key ? (state.values[key] ?? null) : null));
	useEffect(() => {
		if (!key || !sessionId || timestamp === null) return;
		let live = true;
		const seen = pushes.get(key) ?? 0;
		void bridge.delivery.get(sessionId, timestamp).then((read) => {
			if ((pushes.get(key) ?? 0) === seen) rememberDelivery(sessionId, timestamp, read);
		}).catch((error: unknown) => { if (live) useApp.getState().notify(String(error), "error"); });
		const stop = bridge.delivery.onChanged((change) => {
			if (deliveryKey(change.sessionId, change.timestamp) !== key) return;
			pushes.set(key, (pushes.get(key) ?? 0) + 1);
			rememberDelivery(change.sessionId, change.timestamp, change.delivery);
		});
		return () => { live = false; stop(); };
	}, [key, sessionId, timestamp]);
	return value;
}

/** Tests only — production never needs to forget on purpose. */
export function clearDeliveryCache(): void {
	useDeliveries.setState({ values: {} });
	pushes.clear();
}
