/** 独立手机界面只用这组接口，不把整个桌面 IPC 暴露到网络上。 */
export const MOBILE_METHODS = [
	"bootstrap", "sessions.list", "sessions.get", "sessions.create", "sessions.rename", "sessions.archive",
	"agent.prompt", "agent.abort", "agent.approve", "agent.setModel", "agent.setThinking",
] as const;
export type MobileMethod = typeof MOBILE_METHODS[number];

export interface MobileAccessStatus {
	running: boolean;
	port: number;
	addresses: string[];
	token: string | null;
	clients: number;
	/** `state` 在没填中转或访问关着时是 `off`；`paired` 表示此刻有一部手机经中转连着。 */
	relay: { url: string; state: "off" | "connecting" | "online" | "paired" };
}

export interface MobileApi {
	status(): Promise<MobileAccessStatus>;
	start(port: number): Promise<MobileAccessStatus>;
	stop(): Promise<MobileAccessStatus>;
	rotateToken(): Promise<MobileAccessStatus>;
	setRelay(url: string): Promise<MobileAccessStatus>;
}

/*
 * 手机经自己的连接收到的会话变更，和桌面窗口从 `sessions.onChanged` 收到的是同一份。
 *
 * 手机端只经这个入口（`@plume/contract/mobile`）拿契约里的类型：这个文件和 `session.ts` 只从
 * `@plume/core/client-types` 取类型，那是手机本来就在编译的入口。走根入口会顺着 `contract-types`
 * 把 core 的整个 index 拉进手机的类型检查。
 */
export type { SessionChange } from "./session.ts";
