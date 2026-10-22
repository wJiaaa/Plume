import { useRef, useState } from "react";

/**
 * 审批、提问、表单三张卡片的「答一次」：答出去之前按钮全灰，再按也不会发第二遍；没送到就把错误摆出来，
 * 按钮放开让人再答。
 *
 * 挡第二遍靠 ref 不靠 `pending`：一次双击的两下落在同一帧里，state 还没渲染出来，两下读到的都是 false。
 */
export function useOnceAnswer<D>(answer: (decision: D) => Promise<void>) {
	const submitting = useRef(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	async function submit(decision: D) {
		if (submitting.current) return;
		submitting.current = true;
		setPending(true); setError("");
		try { await answer(decision); }
		catch (failure) {
			submitting.current = false;
			setPending(false);
			setError(failure instanceof Error ? failure.message : String(failure));
		}
	}
	return { pending, error, submit };
}
