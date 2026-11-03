import { translate } from "../../i18n/translate.ts";
import type { UserContent, UserMessage as UserMessageType } from "@plume/core";
import { MessageSquarePlus, Pencil } from "../../ui/icons/index.ts";
import { attachToComposer, openFromEvent } from "../image/index.ts";
import { AttachmentStrip, KIND_LABEL } from "../composer/index.ts";
import { isAttachmentBody } from "../../lib/attachment-placeholders.ts";
import { useMemo, useRef, useState } from "react";
import { BubbleText } from "./BubbleText.tsx";
import { MessageActions } from "./MessageActions.tsx";
import { ForkAction } from "./ForkAction.tsx";
import { RevertAction } from "./RevertAction.tsx";
import { useFilesBack } from "./files-back.tsx";
import { MessageEditor } from "./message/MessageEditor.tsx";
import { hasCapsules, MessageCapsules } from "./MessageCapsules.tsx";
import { attachmentsOf, sentFiles, type ImageBlock } from "./sent-attachments.ts";
import { useSentAttachmentToken } from "./SentAttachmentToken.tsx";
import { useApp } from "../../store/index.ts";
import { useScopedFromMessages, useScopedFromMeta, useScopedRunning, useScopedSessionId } from "../../app/session-scope.tsx";
import { useI18n } from "../../i18n/index.ts";
import { lastUserMessageIndex } from "../../lib/revert-draft.ts";
import { spokenText } from "../../lib/spoken.ts";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
/**
 * A message you sent, with the two things you want from one afterwards: to copy it, and to
 * take it back.
 *
 * Editing re-runs the conversation from this point. Everything after — the reply it drew, and
 * anything built on that reply — is discarded, because none of it follows from the new
 * wording any more. Leaving it would put an answer to a question nobody asked directly under
 * the question that replaced it.
 */
export function UserMessage({ message, index }: { message: UserMessageType; index: number }) {
	const { t } = useI18n();
	/*
	 * This screen's conversation, for what the two buttons below show and for whom they act.
	 *
	 * They read the live slot — the focused screen's conversation. Pressing a message on another
	 * screen focuses that screen first, so clicks happened to act on the right one; from the keyboard
	 * 撤回 and 编辑并重新发送 took back or rewrote the message at the same place in the conversation
	 * beside it, on disk.
	 */
	const sessionId = useScopedSessionId();
	const running = useScopedRunning();
	/*
	 * 侧边聊天里只有编辑重问。撤回要把话放回输入框、分叉要开一个新会话，两样都是对着主对话那个
	 * 输入框和会话列表说的，侧边聊天两样都没有。
	 */
	const aside = useScopedFromMeta((meta) => meta?.parentId !== undefined);
	const editMessage = useApp((s) => s.editMessage);
	const lastUser = useScopedFromMessages(lastUserMessageIndex);
	/** 这条消息自己的元素：分屏时另一屏同一序号的消息也在文档里。 */
	const root = useRef<HTMLDivElement>(null);
	const images = useMemo(
		() => message.content.filter((block): block is ImageBlock => block.type === "image"),
		[message.content],
	);
	const files = useMemo(() => attachmentsOf(message, images, (kind) => t(KIND_LABEL[kind]), t("composer.regionShot")), [message, images, t]);
	const text = spokenText(message);
	/*
	 * 认得出的 `【图片 1】` 画成一枚标签，认不出的原样留着。
	 *
	 * 它一度是被整个剥掉的，理由是「同一个文件说两遍」——气泡里一遍名字，气泡外那排附件上又一遍。
	 * 那个理由只在标记是一串裸方括号时成立：外面那排答的是「这条消息带了什么」，句子里这一枚答的是
	 * 「我这句话说的是哪一个」，剥掉之后「照着它改一版」里的「它」就没有着落了。
	 *
	 * 「这个【重要】」不会被误认：方括号在中文里是普通标点，配不上任何一个附件的名字就当作人打的字。
	 */
	/*
	 * 气泡外面那一排只有图片。
	 *
	 * 文件不上这一排，和输入框那边同一条规矩：一份表格的全部信息就是它的名字，而名字已经在句子里那
	 * 枚标记上了；再在上面摆一个同样写着名字的格子，是同一件事说两遍。图片留着，因为缩略图答的是
	 * 「是哪一张」——那是文件名答不了的。
	 */
	const shown = useMemo(() => files.filter((file) => file.src), [files]);
	const spokenFiles = useMemo(() => sentFiles(files, message.content), [files, message.content]);
	const token = useSentAttachmentToken(files, root);
	const said = text.trim();

	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(text);
	const filesBack = useFilesBack();
	function submit() {
		const trimmed = draft.trim();
		/*
		 * Unchanged text still sends.
		 *
		 * This used to return early when the wording had not moved, on the reasoning that there was
		 * nothing to do. But re-sending the same message is exactly what you want after a turn died
		 * on a dropped connection — and pressing 发送 and having nothing at all happen reads as a
		 * broken button, not as a considerate no-op. Cancel is right there for changing your mind.
		 */
		if (!trimmed) {
			setEditing(false);
			return;
		}
		/*
		 * Everything that was attached is carried over: the edit is to the wording, not to the files.
		 *
		 * Images always were. The file bodies are new here and are not optional — the editor works on
		 * `displayText`, which deliberately leaves them out, so rebuilding from the edited text alone
		 * would resend 【report.md】 with the document gone and the model answering about a file it can
		 * no longer see. They go ahead of the new wording rather than back where they were: an edit is
		 * a redo, and keeping the contents matters more than keeping the interleaving.
		 */
		const bodies = message.content.filter(
			(block): block is Extract<UserContent, { type: "text" }> =>
				block.type === "text" && isAttachmentBody(block.text),
		);
		/*
		 * 附了哪几个文件，和气泡里该显示什么，跟着一起过去。
		 *
		 * 不带的那一版等于每编辑一次就把附件从界面上抹掉一次——文件其实还在 `content` 里，模型照样
		 * 读得到，只有人看不见了。而 `displayText` 一旦没有，气泡就退回原文，附件正文重新整个铺进
		 * 自己发出的那条消息里，那正是 `displayText` 存在的全部理由。
		 */
		const content: UserContent[] = [...images, ...bodies, { type: "text", text: trimmed }];
		const meta = { displayText: trimmed, ...(message.attachments?.length ? { attachments: message.attachments } : {}) };
		const send = (files: boolean) => {
			setEditing(false);
			void editMessage(index, content, files ? { ...meta, files: true } : meta, sessionId ?? undefined);
		};
		// 侧边聊天改不了主对话的文件，它截的也不是那几轮。
		if (aside) return send(false);
		// 取消就回到编辑框，改好的字还在。
		void filesBack.check(
			sessionId,
			index,
			(n) => ({
				title: t("revert.editTitle"),
				detail: t("revert.editDetail", { n }),
				blocked: t("revert.editBlocked"),
				withFiles: t("revert.editWithFiles"),
				without: t("revert.editOnly"),
			}),
			send,
			() => send(false),
		);
	}

	if (editing) {
		return (
			<div ref={root} data-question-index={index} className="ly-enter flex justify-end">
				<MessageEditor
					value={draft}
					onChange={setDraft}
					onSubmit={submit}
					onCancel={() => {
						setEditing(false);
						setDraft(text);
					}}
					// 侧边面板只有两三百像素宽，320 会把它吞掉；按钮也照侧边聊天一直的说法叫「重新提问」。
					{...(aside ? { confirmLabel: t("sideMessage.reask"), maxHeight: 220 } : {})}
				/>
				{filesBack.element}
			</div>
		);
	}

	return (
		<div ref={root} data-question-index={index} data-ly-quote="user" className="group/msg ly-enter flex flex-col items-end">
			{/*
			 * Always visible, not folded into the hover row below.
			 *
			 * This message was written by the side chat, not by the person reading it. Finding
			 * an instruction in your own voice that you have no memory of writing is disorienting
			 * enough that the explanation cannot be something you have to go looking for.
			 */}
			{message.origin === "side-chat" && (
				<span className="mb-1 flex items-center gap-1 pr-1 text-caption text-ink-faint">
					<MessageSquarePlus size={11} strokeWidth={1.9} />
					{translate("userMessage.fromSideChat")}
				</span>
			)}

			{/*
			 * 全部附件，在气泡外面，一排。
			 *
			 * 图片是缩略图不是原图：一张已发出的图在这里要回答的只是「是哪一张」，看清楚它是一次
			 * 点击的事，而查看器比一个消息气泡称职得多。三张全尺寸的截图会把它们底下的回复整个顶
			 * 出屏幕——地方被图占了，对话把它丢了。
			 *
			 * 文件也在这里，而不是在气泡里当一段行内文字。从前只有图片站在外面，文档的名字嵌在句
			 * 子中间，于是同一条消息里两种附件是两种东西；更糟的是图片两样都占：外面一张缩略图，
			 * 里面还有一遍它的文件名。现在一个文件只画一次，画在同一个地方。
			 *
			 * 能点开，但不能改：这一份已经发出去了。查看器认得出没有 `onReplace`，于是把标注过的
			 * 那份放进剪贴板，而不是悄悄改写一条已经是记录的消息。
			 */}
			{shown.length > 0 && (
				<AttachmentStrip
					files={shown}
					align="end"
					thumbnail={80}
					/*
					 * 铺开，不滚。
					 *
					 * 这一条已经发出去了：它带了九个文件就该看见九个，下面没有什么在等着被挤走。横滚在这里
					 * 还会藏东西——翻旧消息的人不会想到要去横着拨一下。
					 */
					layout="wrap"
					className="ly-user-images mb-2 max-w-[85%]"
					onOpen={(index, event) =>
						openFromEvent(
							event,
							shown.map((file) => ({ src: file.full ?? file.src!, onAttach: attachToComposer(sessionId) })),
							index,
						)
					}
				/>
			)}
			{(said || hasCapsules(message)) && (
				<div className="ly-user-bubble max-w-[85%] rounded-2xl bg-card px-4 py-2.5 sm:max-w-[75%]">
					<MessageCapsules message={message} sessionId={sessionId} />
					{/*
					 * 气泡里只有人自己打的那些字。
					 *
					 * 认不出来的 `【…】` 原样留着：中文里方括号是普通标点，一句「这个【重要】」不是在引用
					 * 任何东西。
					 */}
					{said && <BubbleText text={text} files={spokenFiles} className="text-label leading-6 text-ink" renderFile={token.renderFile} />}
				</div>
			)}
			{token.menu}

			{/* Editing is the one thing a sent message offers that a reply does not. */}
			<MessageActions
				timestamp={message.timestamp}
				text={text}
				className="mt-1 pr-1"
			>
				{!aside && <RevertAction index={index} sessionId={sessionId} running={running} last={index === lastUser} />}
				{/*
				 * 只有最后一条能编辑，同 ZCode：改一条更早的话，等于把它之后几轮连同那几轮改过的文件一起作废，
				 * 这件事交给撤回去做，它会先问清楚。按钮留着、置灰并说明，不因为位置不同而时有时无。
				 */}
				<IconButton
					label={running ? t(aside ? "sideMessage.busy" : "userMessage.turnRunning") : index !== lastUser ? t("userMessage.editNotLast") : t(aside ? "sideMessage.editAndReask" : "userMessage.editResend")}
					ariaLabel={t(aside ? "sideMessage.editAndReask" : "userMessage.editResend")}
					explainDisabled
					disabled={running || index !== lastUser}
					onClick={() => {
						if (running || index !== lastUser) return;
						setDraft(text);
						setEditing(true);
					}}
					icon={<Pencil size={12.5} strokeWidth={1.8} />}
				/>
				{/*
				 * 撤回's sibling, done to a copy: a new conversation from just before this message, with the
				 * message back in its composer — this one stays as it is. Last in the row, where Claude Code
				 * puts its "Fork from here". Offered while a turn runs, unlike the two beside it: it changes
				 * nothing here.
				 */}
				{sessionId && !aside && <ForkAction index={index} message={message} sessionId={sessionId} />}
			</MessageActions>
		</div>
	);
}
