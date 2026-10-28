/**
 * Folding an agent event into the store.
 *
 * The largest thing the store does, and the one most worth reading on its own: every event the
 * runtime emits arrives here, for every conversation at once — including the ones nobody is
 * looking at. Which is why it starts by updating per-session activity and only then asks whether
 * the event belongs to the conversation on screen.
 */

import { formatList } from "../i18n/list.ts";
import { translate } from "../i18n/translate.ts";
import type { AgentEvent } from "@plume/core";
import { addTurnUsage, type TurnMeter, type CarriedTurn } from "./turn-meter.ts";
import { nextActivity } from "@plume/core/activity";
import { recordReadEvent } from "./read-events.ts";
import { cachedEvent, foldEvent, type SessionSlot } from "./cached-event.ts";
import { coalesce, flushCoalesced, flushCoalescedUnder } from "./coalesce.ts";
import { slotState } from "./derive.ts";
import { freeze, loadCarried, relight, saveCarried } from "./turn-meter.ts";
/*
 * `sideStore.ts` directly, not the domain's index.
 *
 * The index re-exports the dock's panels, which are `.tsx`, and the store is imported by tests that
 * run under `--experimental-strip-types` — which does not handle JSX. Going through the front door
 * here would drag a component tree into a module that only wants one atom of state, and the failure
 * is `Unknown file extension ".tsx"` in a test that has nothing to do with the dock.
 *
 * The rule this bends is `features-through-the-front-door`, and it is bent knowingly: `store/` is
 * below the features rather than beside them, so it is not one domain reaching into another.
 */
import { sideParentOf, useSide } from "../features/dock/sideStore.ts";
import { delegating, useSubAgents } from "./subAgents.ts";
import { waitsOnSession } from "./tool-run.ts";
import type { AppState } from "./index.ts";
import { noticeText } from "../lib/notice-text.ts";
import { bridge } from "../services/index.ts";
import { sessionTitle } from "../lib/session-title.ts";
import { completionNotice } from "../lib/session-notifications.ts";
import { dropHandoff, takeHandoff } from "./handoff.ts";
import { setMonitors } from "./session-monitors.ts";
import { setPeerQueue } from "./peer-queue.ts";
import { setWakeups } from "./session-wakeups.ts";

type Get = () => AppState;
type Set = (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void;

/** Events that can only arrive over a connection that is working again. */
const RECONNECTED = new Set<AgentEvent["type"]>([
  "message_start",
  "message_update",
  "message_end",
  "tool_start",
  "tool_update",
  "tool_end",
]);

export function applyAgentEvent(sessionId: string, event: AgentEvent, set: Set, get: Get): void {
	/*
	 * 定时唤醒的表不是转录的一部分，也不分屏上屏下：按会话记下就走，环境卡片那一节和按钮上的圆点读它。
	 * 不往下走，免得它被当成一条转录事件去折叠、去缓存。
	 */
	if (event.type === "wakeups") {
		setWakeups(sessionId, event.wakeups);
		return;
	}
	if (event.type === "monitors") {
		setMonitors(sessionId, event.running);
		return;
	}
	if (event.type === "peer_queue") {
		setPeerQueue(sessionId, event.letters);
		return;
	}
	/*
	 * 派完子智能体的那一轮干净收尾时，活还没完：结果回来会再开一轮，那一轮收尾才算做完。此刻记成
	 * 「已完成」、报一声做完了都是假的——主进程的系统通知同理（`notifyAgentEvent` 的 `working`）。
	 * 这一段里会话行靠名单亮着（`useRunningBeside`）。报错、中断照旧：那是这一轮的结局。
	 */
	const delegated = event.type === "agent_end" && event.reason === "done" && delegating(useSubAgents.getState().rosters[sessionId]);
	const completion = delegated ? null : completionNotice(event, get().activity[sessionId] ?? null);
  recordReadEvent(sessionId, event);
  /*
   * 被「现在就发」停下的那一轮的收尾：转录照样落定，会话不放下——新的一轮几十毫秒后就开始。
   * 下面凡是 `agent_end` 会把会话放下的地方都看它。见 `handoff.ts`。
   */
  const handoff = event.type === "agent_end" && event.reason === "aborted" && takeHandoff(sessionId);
  if (event.type === "agent_start") dropHandoff(sessionId);
  const aside = sideParentOf(useSide.getState(), sessionId) !== null;
  /*
   * Every conversation's state, not just the one on screen.
   *
   * Turns run in conversations you are not looking at — a scheduled task, another window, an agent
   * that stopped to ask permission twenty minutes ago. The events for those already arrive
   * here and were being dropped; folding each one into a per-session activity is what lets
   * the list say which is which.
   */
  {
    const current = get().activity[sessionId] ?? null;
    const settled = handoff ? current : delegated ? null : nextActivity(event, current);
    /*
     * A conversation you are watching cannot finish unread.
     *
     * `visibleActivity` hides `done` for the conversation on screen, which looked like enough —
     * but hiding is not clearing. The mark stayed in the map, and the instant you clicked away it
     * became a conversation you had never looked at, complete with the dot. Sitting through a
     * turn and then being told you missed it is the opposite of what the mark is for.
     *
     * Only the finished states. `running` and `waiting` are about what is still to come and are
     * worth carrying out of the conversation with you.
     *
     * 侧边聊天也一样：它的结果就在旁边那一格里，而它不在会话列表上，通知里点它只会落到「会话不存在」，
     * 留下的标记永远清不掉。它还在跑的那一段照旧记着，行首靠它亮（`sideChatRunning`）。
     */
    const finished = settled === "done" || settled === "failed";
    const next = finished && (aside || sessionId === get().activeSessionId) ? null : settled;

    if (next !== current) {
      const activity = { ...get().activity };
      if (next) activity[sessionId] = next;
      else delete activity[sessionId];
      set({ activity });
    }
  }

  /*
   * 排在输入框上的那几条，这一轮干净收尾之后轮到下一条。
   *
   * 在这里而不是在下面的 `agent_end` 分支里，理由和上面那段活动状态一样：那个分支只处理屏幕上的
   * 那个对话，而人排完队走开、去看另一个对话，正是排队最常见的用法。
   *
   * 推到微任务里，是因为这一轮的收尾还没写完——下面那个分支才会把 `running` 落成 false，而出队要
   * 在那之后才算数。同步调它，发出去的消息会被紧随其后的收尾覆盖成「没在跑」。
   *
   * 只认 done。中断、报错、卡住都不接着发：按下停止之后继续把排着的灌进去，而屏幕上刚说完「已停
   * 止」，是这个功能最不该做的事。那几条仍旧留在条上，发不发由人决定。
   */
  if (event.type === "agent_end" && event.reason === "done") {
    queueMicrotask(() => void get().flushQueue(sessionId));
  }
  /*
   * 一轮收尾后的自动压缩（`automatic.idle`）期间排的话，等的是它：外面没有轮，不会再来 `agent_end`。
   * 压成了是 `compacted`，没压成是 `failed`——没压成也照发，下一轮开头会照原来的办法再压。被停下的
   * （`cancelled`）不发，理由同上。
   */
  if (
    (event.type === "compacted" && event.command?.automatic?.idle) ||
    (event.type === "command_status" && event.command.automatic?.idle && event.command.status === "failed")
  ) {
    queueMicrotask(() => void get().flushQueue(sessionId));
  }

  /*
   * 主会话开始等另一个会话做完（`ask_session` / `wait_for_session`）时，排着的话不再等。
   *
   * 排队的意思是「等这一轮做完」，而这一轮此刻不是在干活，是在等别人——那可能是十几分钟。所以
   * 一看出它在等，就把队首送进去：运行时收到人说的话，会让那个等待放手（`spoken-waits.ts`）。
   * 子智能体不用这样：它们派出即放手，主会话从来不等它们。
   */
  const parks = event.type === "tool_start" && waitsOnSession(event.toolName);
  if (parks && (get().queued[sessionId]?.length ?? 0) > 0) {
    const activity = get().activity[sessionId];
    if (activity === "running" || activity === "waiting") {
      queueMicrotask(() => {
        const head = get().queued[sessionId]?.[0];
        if (head) void get().steerQueued(sessionId, head.id);
      });
    }
  }

  /*
   * The same, for the turn meter: every conversation's clock, not just the one on screen.
   *
   * It lives here rather than in the branches below because those return early for anything that
   * is not the active session — which is exactly the case this exists for. A turn running in a
   * conversation you are not watching has an elapsed time and a token count the whole time; it was
   * simply nobody's job to write them down, so coming back to it showed a blank where the clock
   * should be.
   */
  {
    /*
     * Only the four events that move a meter touch the map.
     *
     * Every event used to copy it and write it back, whether or not anything in it had changed —
     * and most events are `message_update`, which arrives many times a second per running
     * conversation and has nothing to say about a clock. A new object is a new identity, so each
     * one made every selector in the window run again to discover that nothing had happened. With
     * several conversations working at once that is the bulk of the store's traffic.
     */
    const turns = get().turns ?? {};
    const meter = turns[sessionId];
    let next: TurnMeter | undefined = meter;
    /*
     * What a turn that stopped part-way leaves behind for 继续 to pick up.
     *
     * `undefined` means "do not touch what is stored", which is every event but the one that ends a
     * turn; `null` means "there is nothing to carry", which is how a turn that finished properly
     * clears the one before it.
     */
    let carriedNext: CarriedTurn | null | undefined;
    if (event.type === "agent_start") {
      /*
       * Kept if it is already running: a continuation is the same turn, not a new one. A turn started
       * from elsewhere (no `send` in this window to hand it a meter) picks up what a stop froze for
       * 继续, and takes it off the shelf so it is not picked up twice. 重启之后架上的那份只在磁盘上。
       */
      const carried = get().carried[sessionId] ?? loadCarried(sessionId);
      next = meter ?? relight(carried, Date.now());
      if (carried) carriedNext = null;
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      /*
       * Counted when the reply ends, because that is when there is anything to count.
       *
       * This used to read `message_start`, where `usage.total` is always zero: the adapters fill in
       * `input`/`output` as they go and total them once the stream closes. So the map's count never
       * moved off zero — and since the map is mirrored onto the pair the running line reads, every
       * new reply in a turn overwrote the real figure with it. A turn doing five rounds of tool work
       * counted up to 31.4k, blinked back to 0, counted up again, blinked back: the number was not
       * merely wrong, it was unreadable.
       *
       * One accumulator now, here, for every session rather than only the one on screen. The
       * mirroring below is what carries it to the line.
       */
      if (meter) next = addTurnUsage(meter, event.message.usage);
    } else if (event.type === "subagent_message" && event.message.role === "assistant") {
      /*
       * 委派出去烧的钱也是这一轮烧的。
       *
       * 这条线此前只数主 Agent 自己的 `message_end`，于是一轮里派了四个子代理、它们烧掉五十多万
       * token 的时候，运行指示器上的数字还停在主 Agent 自己的五万八——差了一个数量级，而人正是
       * 靠那个数字判断这一轮花了多少。会话卡片和用量统计页早就把子代理算进去了（见
       * `session/store.ts` 和 `electron/usage/usage-scan.ts` 里各自的说明，那两处都是补过的），唯独
       * 跑起来时看的这条漏着。
       *
       * 只数助手消息，口径和上面那条完全一样：一条助手消息等于一次请求，用量记在它身上；工具结果
       * 和用户消息不带用量，数进来只会重复。
       */
      if (meter) next = addTurnUsage(meter, event.message.usage);
    } else if (event.type === "agent_end" && !handoff) {
      next = undefined;
      /*
       * Frozen for 继续, but only for the two endings 继续 is offered for.
       *
       * `aborted` and `error` are the stops that leave a piece of work half done — the same two
       * `grouping.ts` reads off the transcript when it decides that a 继续 belongs to the turn
       * before it, and the same two its clock stops counting at (`saw`'s `halted`). Keeping the
       * pair in step is the point: they are the live and the settled account of one number, and if
       * they disagreed the elapsed time would jump the moment the turn ended. It did — by a factor
       * of six on a turn full of tool work, until the settled half started counting the wall clock
       * too. See the note at the top of `turn-meter.ts`.
       *
       * `done`, `max_turns` and `stalled` clear it instead. A turn that reached its own end is over;
       * anything carried past it would be added to whatever ran next, under a total nobody could
       * account for — unless what runs next was already spoken, which is the case below.
       */
      const unfinishedTodos = (sessionId === get().activeSessionId ? (get().todos ?? []) : (get().sessionCache?.[sessionId]?.state?.todos ?? [])).filter((todo) => todo.status !== "completed").length > 0;
      const stoppedShort = event.reason === "aborted" || event.reason === "error" || event.reason === "max_turns" || (event.reason === "done" && unfinishedTodos);
      /*
       * And the other kind of unfinished: what is still waiting on the queue.
       *
       * Those were spoken while this turn was running — a requirement added, an instruction
       * sharpened — so they are the back half of the same piece of work, held back only because
       * delivery waits for the turn to finish (see `queue-slice`). The turn reached its own end;
       * the work did not. Clearing the meter here makes the one that goes out next start counting
       * from zero, while the person asking has been waiting on one thing the whole time.
       *
       * Being on the queue is the test, not what the message says: the only way onto it is to
       * speak while the session is busy — an idle composer sends straight out, see `Composer`.
       * What collects this is the send that takes the entry off the queue, in `queue-slice`.
       */
      const awaited = (get().queued[sessionId]?.length ?? 0) > 0;
      // The map is the only account of this turn — the line's pair is mirrored from it — so what is
      // frozen here is exactly the elapsed time and the count the reader was looking at.
      carriedNext = stoppedShort || awaited ? freeze(meter, Date.now()) : null;
    }

    if (next !== meter) {
      const turns = { ...get().turns };
      if (next) turns[sessionId] = next;
      else delete turns[sessionId];
      set({ turns });
    }
    /*
     * And mirror it onto the pair the running line reads, while this is the one on screen.
     *
     * `agent_start` even when the meter did not change: the composer lit it when it sent, and the ~2s
     * of setup before the agent starts is part of the wait — the pair has to say the meter's start,
     * not the agent's. A turn driven from the scheduler has no composer, and gets the meter lit above.
     */
    if ((next !== meter || event.type === "agent_start") && sessionId === get().activeSessionId) {
      set({ turnStartedAt: next?.startedAt ?? null, turnTokens: next?.tokens ?? 0 });
    }

    if (carriedNext !== undefined) {
      const carried = { ...get().carried };
      if (carriedNext) carried[sessionId] = carriedNext;
      else delete carried[sessionId];
      saveCarried(sessionId, carriedNext);
      set({ carried });
    }
  }

  /*
   * 一轮收尾时读一次会话列表。排序和标题跟着 `sessions:changed` 走（见 `session-changes.ts`），不等这里；
   * 侧边聊天的花销（`sideUsage`）只有读列表才算得出来，推送过来的变化里没有。侧边聊天不在列表上。
   */
  if (event.type === "agent_end" && !aside) {
    void bridge.sessions.list().then(
      (sessions) => set({ sessions }),
      (cause: unknown) => get().notify(translate("applyEvent.refreshFailed", { reason: cause instanceof Error ? cause.message : String(cause) }), "error"),
    );
  }

  if (sessionId !== get().activeSessionId) {
		// Delegated work of a conversation that is on screen without being the live one.
		if (event.type === "subagents") useSubAgents.getState().retain(sessionId, event.agents);
		// 侧边聊天答完不另报：人就在它旁边那一格里等着，报一声是把同一件事说两遍。
		if (completion && !aside) {
			const target = get().sessions.find((session) => session.id === sessionId);
			const who = target ? translate("applyEvent.named", { title: sessionTitle(target.title) }) : translate("applyEvent.task");
			get().notify(`${who}${completion.text}`, completion.level, sessionId);
		}
    // 这个会话自己暂存的那几格都以它开头；末尾的冒号让 `a` 不会冲掉 `ab` 的。
    const held = `cache:${sessionId}:`;
    if (event.type === "message_update" || event.type === "tool_update") {
      // Once a tick, like the conversation on screen: see `coalesce`. Read at flush time, so it
      // applies to whatever the cache holds by then. Each tool call holds its own newest update.
      coalesce(() => {
        const cached = get().sessionCache[sessionId];
        if (!cached) return;
        const next = cachedEvent(cached, event);
        if (next !== cached) set({ sessionCache: { ...get().sessionCache, [sessionId]: next } });
      }, event.type === "message_update" ? `${held}message` : `${held}tool:${event.toolCallId}`);
    } else {
      // A held update lands before anything that comes after it — same rule as below, but only this
      // conversation's: see `flushCoalescedUnder`.
      flushCoalescedUnder(held);
      const cached = get().sessionCache[sessionId];
      if (cached) {
        const next = cachedEvent(cached, event, handoff);
        if (next !== cached) set({ sessionCache: { ...get().sessionCache, [sessionId]: next } });
      }
    }
    return;
  }

  /*
   * The reconnection worked, and nothing else was ever going to say so.
   *
   * `retrying` was cleared only when a turn started or ended, so one dropped socket pinned
   * "连接中断，N 秒后重试" to the running line for the rest of the turn — still sitting there a
   * minute later beside a reply that had long since arrived, claiming a wait that was over.
   * Anything streaming in is the proof: the connection is back, so the notice goes.
   */
  if (get().retrying && RECONNECTED.has(event.type)) set({ retrying: null });

  /*
   * Anything that is not a streamed update lands after the one still waiting.
   *
   * Without this a held update could be applied on the next frame — after the `message_end` that
   * settles it, or after the tool card that follows it — and overwrite the newer state with the
   * older one.
   */
  if (event.type !== "message_update" && event.type !== "tool_update") flushCoalesced();

  /** 这一条落到屏上这个会话，规则和停在缓存里的那些是同一份（`foldEvent`）。 */
  const fold = () => {
    const slot: SessionSlot = { ...slotState(get()), messages: get().messages, toolRuns: get().toolRuns };
    const next = foldEvent(slot, event, sessionId, handoff);
    if (next !== slot) set(next);
  };

  switch (event.type) {
    case "message_update":
      coalesce(() => {
        if (get().activeSessionId === sessionId) fold();
      });
      break;

    case "tool_update":
      /*
       * 一拍落一次，每个调用各占一格，理由和 `message_update` 一样：命令输出一秒来几十块，每块都把整张
       * `toolRuns` 换新、跑一遍窗口里每个选择器，而两拍之间的那些块，画出来之前就被下一块盖掉了。
       * 它的 `tool_end` 照常先把它落下（上面的 `flushCoalesced`）。
       */
      coalesce(() => {
        if (get().activeSessionId === sessionId) fold();
      }, `tool:${event.toolCallId}`);
      break;

    case "agent_end":
      fold();
      // 被「现在就发」停下的那一轮：表也不收，新的一轮马上接上。
      if (!handoff) set({ turnStartedAt: null });
      break;

    case "tasks":
      // 记到这条事件自己的会话名下——分屏时屏上不止一个会话，「屏上那个」不再是唯一答案。
      useSide.getState().setTasks(sessionId, event.tasks);
      break;

    /*
     * Delegated work, live.
     *
     * The whole roster on every change rather than a diff: it is a dozen rows, it is only sent
     * when something moved, and a window that has been away is correct on the first one it gets
     * instead of having to have seen every event since.
     */
    case "subagents":
      useSubAgents.getState().sync(event.agents, sessionId, true);
      break;

    /*
     * One message from inside a sub-agent.
     *
     * Kept out of the main transcript deliberately: it belongs to a conversation of its own, and
     * merging it here is exactly the context pollution delegation exists to avoid. Dropped unless
     * that sub-agent's transcript has been opened — opening it later reads the whole thing.
     */
    case "subagent_message":
      useSubAgents.getState().append(event.id, event.message);
      break;

    // 子代理里跑的钩子归它自己的面板，不进上面主会话的 `hookRuns`。
    case "subagent_event":
      if (event.event.type === "hook_run") useSubAgents.getState().hookRun(event.id, event.event.run);
      break;

    case "notice":
      set({
        notices: [
          ...get().notices,
          {
            id: `${Date.now()}-${Math.random()}`,
            level: event.level,
            message: noticeText(event),
          },
        ],
      });
      break;

    case "capabilities_changed": {
      /*
       * 磁盘上的技能或子智能体变了，这个会话已经重新读过了。
       *
       * 说出来，而且要说变了什么。一句「能力已更新」在换分支的时候等于没说——那会换掉半个目录。
       * 两个数都是 0 也是一个真实的情况：有人改了某个技能的正文，而名单没变——那时不说话，
       * 因为「改的东西已经生效了」并不值得打断谁。
       */
      const parts = [
        event.skills !== 0 ? translate("applyEvent.skillsDelta", { delta: `${event.skills > 0 ? "+" : ""}${event.skills}` }) : null,
        event.agents !== 0 ? translate("applyEvent.agentsDelta", { delta: `${event.agents > 0 ? "+" : ""}${event.agents}` }) : null,
      ].filter(Boolean);
      if (parts.length > 0) {
        const changes = parts.join(translate("common.comma"));
        get().notify(event.added.length > 0 ? translate("applyEvent.changesNamed", { changes, names: formatList(event.added) }) : changes);
      }
      break;
    }

    default:
      fold();
  }
}
