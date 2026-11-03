/**
 * 句子里那一枚附件标记：左键打开或预览，右键弹出和输入框里同一份附件菜单。
 *
 * 一条消息一份：查看器的起点要在这条消息自己的元素里找（分屏时另一屏同一序号的消息也在文档里）。
 */

import { useState, type RefObject } from "react";
import { useDockScope, useScopedSessionId } from "../../app/session-scope.tsx";
import { useI18n } from "../../i18n/index.ts";
import { TokenGlyph, tokenLook } from "../../ui/fileIcon.tsx";
import { AttachmentMenu, previewableInPanel, useAttachmentActions, type FileKind, type StripFile } from "../composer/index.ts";
import { openFilePane } from "../dock/index.ts";
import { attachToComposer, openViewer } from "../image/index.ts";
import type { SentFile } from "./sent-attachments.ts";

export function useSentAttachmentToken(files: StripFile[], root: RefObject<HTMLDivElement | null>) {
	const { t } = useI18n();
	const sessionId = useScopedSessionId();
	// The screen a file this message names opens in: a press on another screen would open it in the focused one.
	const screen = useDockScope();
	const attachmentActions = useAttachmentActions();
	/** 右键点在句子里某一枚标记上时，那份附件和菜单该弹在哪儿。 */
	const [markMenu, setMarkMenu] = useState<{
		point: { x: number; y: number };
		file: { name: string; label?: string; kind: FileKind; path?: string; src?: string };
	} | null>(null);
	/** 从句子里那枚标记打开查看器。起点取气泡外那一排里对应的格子，没有就从点击/右键的位置长。 */
	const previewImage = (src: string, originRect?: DOMRect) => {
		const pictures = files.filter((file) => file.kind === "image" && (file.full || file.src));
		const imgIndex = pictures.findIndex((file) => file.full === src || file.src === src);
		if (imgIndex < 0) return;
		// 只在这条消息里找：分屏下按序号全文档查，会先找到另一屏的格子，图从那边起飞、把那边的缩略图藏起来。
		const tile = root.current?.querySelectorAll<HTMLElement>(".ly-attachment-body")[imgIndex] ?? null;
		const origin = originRect ?? tile?.getBoundingClientRect() ?? new DOMRect(markMenu?.point.x ?? 0, markMenu?.point.y ?? 0, 1, 1);
		openViewer(
			// 标注完按「完成」，带标注的副本回到这个对话的输入框。
			pictures.map((file) => ({ src: file.full ?? file.src!, onAttach: attachToComposer(sessionId) })),
			imgIndex,
			origin,
			tile,
		);
	};

	/**
	 * 在右边的文件面板里打开一份发出去的文件——句子里那枚标记的左键，和它菜单里的「预览」，都是这一个。
	 *
	 * 项目外的也打得开：主进程认得转录里记下的附件路径，面板可以只读地读它们（见
	 * `electron/files/attachment-reads.ts`）。先问一句它还在不在：转录活得比文件久，挪走了的文件在面板里只是
	 * 一句「无法读取」，而这里说得清是它不在原处了。
	 *
	 * 标签页叫它在磁盘上的名字，不叫句子里那枚标记的名字：面板按扩展名决定怎么画，`.md` 才渲染成文档。
	 */
	const previewFile = async (file: { name: string; label?: string; path?: string }) => {
		const path = file.path;
		if (!path) return;
		if (!(await attachmentActions.ensureThere({ name: file.label ?? file.name, path }))) return;
		void openFilePane(path, screen ?? undefined);
	};

	/**
	 * 这一份文件能不能在面板里预览，不论它在不在项目里——项目外附件的放行在桌面主进程里
	 * （`electron/files/attachment-reads.ts`）。
	 */
	const panelPreview = (file: { name: string; kind: FileKind; path?: string }) =>
		Boolean(file.path) && previewableInPanel(file.kind, file.name);

	const renderFile = (file: SentFile, at: number) => {
		const look = tokenLook(file.name, file.kind);
		return (
			<span
				key={at}
				className="ly-attachment-token"
				data-kind={file.kind}
				data-glyph={look ? "" : undefined}
				/* 只有名字进了提示词的那些：图标淡一档。气泡里还多一句悬停说明。 */
				data-bodiless={file.bodiless ? "" : undefined}
				data-ly-tip={file.bodiless ? t("composer.filenameOnly") : undefined}
				onClick={(event) => {
					const rect = event.currentTarget.getBoundingClientRect();
					attachmentActions.openOrPreview(
						{
							name: file.label ?? file.name,
							path: file.path,
							src: file.src,
							isImage: Boolean(file.src || file.kind === "image"),
							isFolder: file.kind === "folder",
							/*
							 * 发出去的文件，项目外的也进得了面板——面板打开它看得到东西的话。其余的照旧：项目里
							 * 的进面板，项目外的在访达中指出来。
							 */
							panelReadable: panelPreview(file),
							onPreviewImage: (originRect?: DOMRect) => {
								if (file.src) {
									previewImage(file.src, originRect);
								}
							},
							onOpenFile: () => void previewFile(file),
						},
						rect,
					);
				}}
				/*
				 * 右键点这一枚，和右键点输入框里那一枚、点附件条上那一格，弹的是同一份菜单。
				 *
				 * 已经发出去的消息里没有「移除」——那一份是记录。其余几行照旧，靠的是消息里存下的
				 * 路径（`MessageAttachment.path`）；存之前发的那些没有路径，菜单会自己把它们画成
				 * 灰的并说明为什么。
				 */
				onContextMenu={(event) => {
					event.preventDefault();
					setMarkMenu({ point: { x: event.clientX, y: event.clientY }, file });
				}}
			>
				{look && <TokenGlyph look={look} />}
				{file.label ?? file.name}
			</span>
		);
	};

	const menu = (
		<AttachmentMenu
			anchor={markMenu?.point ?? null}
			file={
				markMenu
					? {
							name: markMenu.file.label ?? markMenu.file.name,
							...(markMenu.file.path ? { path: markMenu.file.path } : {}),
							...(markMenu.file.src ? { src: markMenu.file.src } : {}),
							/*
							 * 「预览」：图片进查看器，像素就在消息里，查看器要的只是一个放大的起点；文件进右边的文件
							 * 面板。
							 *
							 * 文件这一半从前不给，理由是面板读不到项目外的东西，而附件绝大多数来自项目外。现在主进程
							 * 认得消息里记下的附件路径（`electron/files/attachment-reads.ts`），面板只读地打得开它们——只要
							 * 打开之后看得到的是它本身，见 `previewableInPanel`。
							 */
							...(markMenu.file.src
								? { onPreview: () => previewImage(markMenu.file.src ?? "") }
								: panelPreview(markMenu.file)
									? { onPreview: () => void previewFile(markMenu.file) }
									: {}),
						}
					: null
			}
			onClose={() => setMarkMenu(null)}
		/>
	);

	return { renderFile, menu };
}
