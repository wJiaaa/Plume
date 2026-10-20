/**
 * 消息操作排里的「从这里分叉」，问题和回复底下是同一颗按钮。
 *
 * 在问题上分叉，新会话停在它之前、问题回到输入框——撤回的那一套，做在副本上；在回复上分叉，新会话
 * 带着这条回复，输入框是空的，从这里换个方向接着说。原会话两种都不动。见 ADR-0035。
 *
 * 一轮还在跑也照样给：分叉只读到这条消息为止的日志，不改这个会话。
 */

import type { AssistantMessage, UserMessage } from "@plume/core";
import { useState } from "react";
import { Split } from "../../ui/icons/index.ts";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import { useI18n } from "../../i18n/index.ts";
import { useApp } from "../../store/index.ts";

export function ForkAction({ index, message, sessionId }: { index: number; message: UserMessage | AssistantMessage; sessionId: string }) {
	const { t } = useI18n();
	const forkFrom = useApp((s) => s.forkFrom);
	// 按下了、新会话还没开出来：再按一次会从同一处分叉两份。
	const [forking, setForking] = useState(false);
	return (
		<IconButton
			data-message-fork=""
			label={t("messageActions.fork")}
			disabled={forking}
			onClick={() => {
				if (forking) return;
				setForking(true);
				void forkFrom(index, message, sessionId).finally(() => setForking(false));
			}}
			icon={<Split size={12.5} strokeWidth={1.8} className="rotate-90" />}
		/>
	);
}
