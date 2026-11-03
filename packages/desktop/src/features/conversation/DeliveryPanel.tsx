/**
 * This turn's recorded diffs, in a dock pane: what the delivery card under a turn opens.
 *
 * Only `app/panels.tsx` draws it, and it imports this file directly rather than through the domain's
 * index — on the index it would pull git and dock into every domain that wants something small from
 * the conversation, and those lead back here.
 */

import { FileDiff, Undo2 } from "../../ui/icons/index.ts";
import { relativeTo } from "../../lib/paths.ts";
import { PanelEmpty } from "../../ui/layout/PanelEmpty.tsx";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import { Scroller } from "../../ui/scroll/Scroller.tsx";
import { closeNow } from "../dock/index.ts";
import { useDockScope, useScopedProjectPath, useScopedSessionId } from "../../app/session-scope.tsx";
import { DiffView } from "../git/index.ts";
import { usePathMenu } from "../markdown/index.ts";
import { useI18n } from "../../i18n/index.ts";
import { useTurnDelivery } from "./delivery-cache.ts";
import { useDeliveryReview, useSharedDeliveryTarget } from "./delivery-review.ts";
import { useDeliveryUndo } from "./delivery-undo.ts";
import { Counts, FileName } from "./TurnDelivery.tsx";

export function DeliveryTitle() {
	const { t } = useI18n();
	const owner = useScopedSessionId();
	const path = useDeliveryReview((state) => (owner ? (state.reviews[owner]?.target.path ?? null) : null));
	const name = path ? path.split(/[\\/]/).pop() : null;
	return (
		<span className="flex min-w-0 items-center gap-1 py-0.5 pl-1 text-detail">
			<FileDiff size={12.5} strokeWidth={1.8} className="shrink-0 text-ink-faint" />
			<span className="min-w-0 truncate text-ink">{name ?? t("delivery.fileChanges")}</span>
		</span>
	);
}

export function DeliveryPanel() {
	const { t } = useI18n();
	// Named from the project of this screen's conversation; the live slot's is the focused screen's.
	const workspace = useScopedProjectPath();
	// The conversation whose screen this panel is in — not whichever one has the focus.
	const owner = useScopedSessionId();
	const scope = useDockScope();
	// A popped-out pane starts with an empty store; the turn it shows is on the shared record.
	useSharedDeliveryTarget(owner);
	// Right-click on a file's header: the same menu as the file's row on the card, minus 打开 — this
	// pane is the turn's recorded diff, and opening the file's current contents is the card's to offer.
	const pathMenu = usePathMenu(workspace);
	// That conversation's own review: one opened under another screen is that screen's, and leaves this one be.
	const target = useDeliveryReview((state) => (owner ? (state.reviews[owner]?.target ?? null) : null));
	// The same entry the turn's card reads, so an undo on either — or in another window — shows on both.
	const data = useTurnDelivery(target?.sessionId ?? null, target?.timestamp ?? null);
	const { undoing, ask, element: confirmElement } = useDeliveryUndo(target?.sessionId ?? null, target?.timestamp ?? null, (value) => {
		if (value.files.length || !target) return;
		if (scope) closeNow(scope, "delivery");
		else useDeliveryReview.getState().close(target.sessionId);
	});

	if (!target) return <PanelEmpty icon={FileDiff} title={t("delivery.fileChanges")} />;
	const files = (data?.files ?? []).filter((file) => !target.path || file.path === target.path);
	if (!files.length) return <PanelEmpty icon={FileDiff} title={t("delivery.fileChanges")} />;
	const relative = (path: string) => workspace ? relativeTo(workspace, path) : path;

	return <>
		{/* No top fade: a file's header is always pinned at the top once scrolled, so the fade would only dissolve the header itself. */}
		<Scroller top="none">
			{files.map((file) => (
				<section key={file.path} data-delivery-diff={file.path} className="mb-1">
					<div className="ly-pin sticky top-0 z-10">
						<div className="flex min-w-0 items-center gap-3 px-3 py-2 text-label" onContextMenu={(event) => pathMenu.onContextMenu(event, { path: file.path })}>
							<FileName path={relative(file.path)} />
							<Counts added={file.added} removed={file.removed} />
							<IconButton
								size="sm"
								icon={<Undo2 size={14} />}
								label={file.canUndo ? t("delivery.revertOne") : t("delivery.cannotRevert")}
								explainDisabled
								disabled={!file.canUndo || undoing}
								onClick={() => ask(file.path)}
							/>
						</div>
					</div>
					<DiffView path={file.path} hunks={file.hunks} maxLines={Infinity} />
				</section>
			))}
		</Scroller>
		{confirmElement}
		{pathMenu.element}
	</>;
}
