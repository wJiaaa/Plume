import { ChevronDown, ChevronUp } from "../../ui/icons/index.ts";
import { translate } from "../../i18n/translate.ts";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { ApprovalOverlay } from "./ApprovalOverlay.tsx";
import { BackToLatest } from "./BackToLatest.tsx";
import { Composer } from "../composer/index.ts";
import { ResumeRow } from "./ResumeRow.tsx";
import { HiccupRow } from "./HiccupTrace.tsx";
import { ModelSwitchRow } from "./ModelSwitchRow.tsx";
import { leadsTheTurn, looksLikeAnswer } from "@plume/client-runtime/running";
import { RunningRow } from "./RunningRow.tsx";
import { TaskList } from "../task/index.ts";
import { environmentCard, useEnvironmentCard } from "../../store/environment-card.ts";
import { clearTranscriptJump, useTranscriptJump } from "../../store/transcript-jump.ts";
import { proseGrewAt } from "../../store/message-event.ts";
import { GeneratedImages } from "./ImageCanvas.tsx";
import { Scroller } from "../../ui/scroll/Scroller.tsx";
import { ActionSpinner } from "../../ui/motion/loaders.tsx";
import { runs, runKey, type Run } from "./grouping.ts";
import { turnBlocks, withoutThinking } from "./turn-blocks.ts";
import { intact } from "../../lib/transcript.ts";
import { ToolRun as ToolRunGroup, WINDOW_TURNS } from "./runs.tsx";
import { CommandRunRow } from "./CommandRunRow.tsx";
import { HookTrustBanner } from "./HookTrustBanner.tsx";
import { QuestionNav } from "./QuestionNav.tsx";
import { QuoteMenu } from "./QuoteMenu.tsx";
import { questionsIn, timeSeparators } from "./question-navigation.ts";
import { MessageRow } from "./rows.tsx";
import { TurnWork } from "./TurnWork.tsx";
import { WorkStep } from "./WorkStep.tsx";
import { useTranscriptWindow } from "./view-state.ts";
import { flash, settleReveal, useDrawingReveal } from "./reveal.ts";
import { motionReduced } from "../../ui/motion/reduced.ts";
import { useFollowBottom } from "../../ui/scroll/useFollowBottom.ts";
import { Arrival, useArrival } from "../markdown/index.ts";
import { tailSignature } from "../../ui/scroll/signature.ts";
import { useLayout } from "../../app/layout.tsx";
import { useApp } from "../../store/index.ts";
import {
	useScopedCommandRuns,
	useScopedHiccups,
	useScopedLoading,
	useScopedMessages,
	useScopedRunning,
	useScopedSessionId,
	useScopedFromToolRuns,
} from "../../app/session-scope.tsx";
import type { ToolRun } from "../../store/tool-run.ts";

/**
 * The width below which the question rail stops getting a column of its own.
 *
 * Indenting the text 48px to clear the rail costs a tenth of a 520px column and nothing worth
 * noticing above it — and the right side is padded 16px whatever happens, so the whole difference
 * lands as the transcript sitting visibly right of centre. Below this the rail goes against the
 * edge and both sides get 28px.
 */
const NARROW_COLUMN = 520;
/*
 * 环境卡片那一条：卡片 300 宽，右边距 12，和正文之间再留 12。
 *
 * 栏够宽（让出这一条以后正文还有 `NARROW_COLUMN`）时正文和输入框整体往左让，卡片不盖住任何字；
 * 不够宽就像任务清单一样浮在正文上——这时让位会把正文挤成一条缝。
 */
const ENVIRONMENT_CARD = 300;
const ENVIRONMENT_LANE = ENVIRONMENT_CARD + 24;

/**
 * Nothing about the window's shape belongs to the transcript.
 *
 * The transcript takes no props: everything it draws comes from the store, and the store tells it
 * directly when that changes. But it is mounted inside the dock, and the dock is re-rendered by
 * every drag — a pane's boundary, a pane being carried, the sidebar's edge — so a fresh element
 * was handed down forty-five times a second and React rebuilt several hundred rows behind it, each
 * one re-parsing its markdown. Dragging the sidebar across a long session cost 470KB of re-parsed
 * prose per gesture. A memo boundary here is one comparison of two empty objects, and it is where
 * the layout stops being the transcript's business.
 *
 * `side`：画的是一格侧边聊天（`SessionScope` 指向那个会话）。转录、工具卡、审批和主对话完全一样；
 * 主对话外围那几样——环境卡片、任务清单、「接着做」、问题导航、钩子提示、输入框——不画，输入框由
 * 侧边聊天自己摆在底下。
 */
export const Conversation = memo(function Conversation({ side = false }: { side?: boolean } = {}) {
  /*
   * 转录的入口，也是那道闸门的位置。
   *
   * `intact` 放在这里而不是只放在 `runs` 里，是因为这一条数组要交给好几个消费者——`runs`、
   * `timeSeparators`、`questionsIn`、`tailSignature`——它们各自都会去读 `role`。
   * 只挡住其中一个，另外几个照样能把整个窗口掀翻，而报出来还是同一句话。
   *
   * 没有损坏时 `intact` 交回的是同一个引用，所以下面那些 `useMemo` 的依赖不会因此失效。
   */
  const rawMessages = useScopedMessages();
  const messages = useMemo(() => intact(rawMessages), [rawMessages]);
  const running = useScopedRunning();
	const commandRuns = useScopedCommandRuns();
	/*
	 * 这一轮里连接抖过没有，以及最后怎么了。
	 *
	 * 和命令边界一起交给 `runs`，因为它们是同一种东西：转录里按位置插进去的一条记录。
	 * 从前它是转录末尾单独的一丛，一律挂在运行指示器底下——那让一句「重连 2 次后恢复」站在了「此刻」
	 * 的位置上，而它说的是四十分钟前的事。见 `HiccupTrace`。
	 */
	const hiccups = useScopedHiccups();
	const compacting = commandRuns.some((command) => command.status === "running");
  /*
   * How many tool calls there are, and how many have stopped running.
   *
   * Both halves matter and only the first used to be here. A call settling changes the card —
   * output replaces the spinner, a duration appears, an error opens — without touching a message
   * and without changing how many calls exist, so a signature built from the count alone was
   * identical either side of the one moment a tool card changes size the most.
   *
   * Still a count rather than the map: a streamed chunk moves neither number, which is what keeps
   * the layout effect off the per-token path. Growth inside a running card is left to the resize
   * observer, which is what it is for.
   *
   * Returned as a string so the selector compares by value; an object would be a new identity on
   * every store change and re-render the transcript for each one.
   */
  const toolProgress = useScopedFromToolRuns(toolProgressOf);
  const activeSessionId = useScopedSessionId();
  const loadingSession = useScopedLoading();
  const arrival = useArrival(`${activeSessionId}:${loadingSession}`);
  // 推理默认不画，见 `withoutThinking`。
  const showThinking = useApp((s) => s.settings?.showThinking === true);
  const allRuns = useMemo(() => {
    const list = runs(messages, commandRuns, hiccups);
    return showThinking ? list : withoutThinking(list);
  }, [messages, commandRuns, hiccups, showThinking]);
  /*
   * 按内容记住，不按 `messages`：它每个 token 都换，跟着换的话 `draw` 也每个 token 都是新的，
   * `WorkStep` 的 memo 就形同虚设。
   */
  const separatorKey = useMemo(() => [...timeSeparators(messages)].join(","), [messages]);
  const separators = useMemo(() => new Set(separatorKey ? separatorKey.split(",").map(Number) : []), [separatorKey]);
  const questions = useMemo(() => questionsIn(messages), [messages]);
  // 一个 Run 画成哪一行。依赖齐了它才换，`WorkStep` 的 memo 拿它的引用判断画出来的推理行会不会变。
  const draw = useCallback((run: Run) =>
  run.kind === "command" ? <CommandRunRow key={`${activeSessionId}:${runKey(run)}`} command={run.command} /> : run.kind === "hiccup" ? (
    <HiccupRow key={`${activeSessionId}:${runKey(run)}`} hiccup={run.hiccup} />
  ) : run.kind === "model" ? (
    <ModelSwitchRow key={`${activeSessionId}:${runKey(run)}`} from={run.from} to={run.to} />
  ) : run.kind === "message" ? (
    <MessageRow
      key={`${activeSessionId}:${runKey(run)}`}
      viewKey={runKey(run)}
      showTime={separators.has(run.index)}
      message={run.message}
      index={run.index}
      upTo={run.upTo}
      from={run.from}
      /* 页脚只给一轮的最后一句；还在跑的那一轮谁是最后一句还没定，见 `Run.newest`。 */
      continued={!run.closes || (running && run.newest === true)}
      pauses={run.pauses}
      trailer={run.trailer}
      /* Computed with the grouping, so its identity changes only when the transcript
       * does — see `Run` in `grouping.ts` for what recomputing it here used to cost. */
      turnStats={run.turnStats}
    />
  ) : (
    /*
     * Keyed on the first call, not the position: inserting anything above must not
     * make React tear this run down and build it again.
     *
     * 走到这里的工具段只有 `shown` 的那种（一页预览、一张会话建议）：其余的都在 `turnBlocks`
     * 里收成了 `WorkStep`，正在做的那一步的光也由那边给。
     */
    <ToolRunGroup key={`${activeSessionId}:${runKey(run)}`} calls={run.calls} shown={run.shown} />
  ), [activeSessionId, running, separators]);
  /*
   * 先分块，再开窗——顺序反过来就是那个「点了没反应」的 bug。
   *
   * 窗口从前按 `Run` 走，而画出来的单位是 `TurnBlock`。一轮里可以有几百个 Run（一个会话在两次用户
   * 发言之间跑了 400 次工具调用），于是往那种轮次里翻页，60 个 Run 全落进一个已经收起的块，屏幕上
   * 只有「调用工具 N 个」那个数字在变。连点四次，转录一动不动。
   *
   * 按块开窗之后，翻一次必然多出整轮——必然看得见。一轮里同类的调用合成一行、每行默认收着（`WorkStep`
   * 收起时不渲染里面的调用），一轮四百次调用摊开也只是几十行。
   */
  const allBlocks = useMemo(
    // 跑着的那一轮从发出就按有过程分，见 `turnBlocks` 的 `live`。
    () => turnBlocks(allRuns, running),
    [allRuns, running],
  );
  const range = useTranscriptWindow(activeSessionId, WINDOW_TURNS, allBlocks.length);
  /*
   * 窗口挂上目标之后要滚到哪：问题导航点的那一问，或画廊要看的那张图。`lead` 是目标上方留的空，
   * 图放在正中间。
   */
  const [jump, setJump] = useState<{ sessionId: string | null; selector: string; block: number; lead: number | "middle"; flash?: boolean } | null>(null);
  const { compact } = useLayout();
  const gutter = compact ? "ly-content-gutter-compact" : "ly-content-gutter";
  /*
   * The floating card needs its own width plus a readable column left over beside it.
   * 320 for the card, 32 for the gap it keeps from the edge, and 420 of text — below that the
   * reply is a ribbon and the card should go and sit above the composer instead.
   */
  const column = useRef<HTMLDivElement>(null);
  const [roomToFloat, setRoomToFloat] = useState(false);
  const [roomToDock, setRoomToDock] = useState(false);
  const EnvironmentCard = environmentCard();
  const environmentOpen = useEnvironmentCard((state) => state.open) && !side && activeSessionId !== null && EnvironmentCard !== null;
  const docked = environmentOpen && roomToDock;
  /*
   * Too narrow to spend 48px on the question rail and leave the column looking centred.
   *
   * Asked of this column, not of the window. A 1400px window with the sidebar and a file panel
   * open leaves the transcript 460px wide, and 48 against 16 is just as lopsided there as it is on
   * a 380px window — the window is simply not what the reader is looking at. Below this the rail
   * moves to the very edge and the padding goes symmetric; see `QuestionNav`.
   */
  const [narrowColumn, setNarrowColumn] = useState(false);
  useEffect(() => {
    const element = column.current;
    if (!element) return;
    // ResizeObserver 本来就一帧最多回调一次、回调时布局已经算好，拖动时不用再另外节流。
    const measure = () => {
      setRoomToFloat(element.clientWidth >= 320 + 32 + 420);
      setRoomToDock(element.clientWidth >= ENVIRONMENT_LANE + NARROW_COLUMN);
      setNarrowColumn(element.clientWidth < NARROW_COLUMN);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  /** 末尾正在流的正文像结论，或者是这一轮调工具之前的话：运行行原地隐去，不跟着字一跳一跳。见 `RunningRow`。 */
  const answering = useMemo(() => looksLikeAnswer(messages) || leadsTheTurn(messages), [messages]);
  /** 末尾那段正文上一次变长的时刻：一阵子不长了，运行行就回来说耗时和速度，见 `RunningRow`。 */
  const grewAt = useMemo(() => proseGrewAt(messages[messages.length - 1]), [messages]);
  /** 最后一条是一段正常写完的回答：底下的操作行在这时长出来，运行行在同一帧让位，见 `RunningRow`。 */
  const answered = useMemo(() => {
    const last = messages[messages.length - 1];
    if (last?.role !== "assistant" || last.stopReason !== "stop") return false;
    const block = last.content[last.content.length - 1];
    return block?.type === "text" && block.text.trim().length > 0;
  }, [messages]);

  /*
   * Following the bottom, and everything that decides whether to.
   *
   * All of it used to be here: a `pinnedToBottom` ref recomputed from `scrollTop` on every event, a
   * hand-rolled glide, a `missed` flag set from the fact that the messages array had been
   * reassigned. Three surfaces had their own copy of it and none of them agreed. See
   * `scroll/follow.ts` for the rule.
   */
  const follow = useFollowBottom({
    surfaceId: activeSessionId,
    namespace: "transcript",
    ready: !loadingSession,
    live: running,
    count: messages.length + commandRuns.length,
    /*
     * What "something arrived" means here.
     *
     * `toolProgress` is folded in because a card appearing *or completing* changes the page without
     * touching a message — see its selector above for why both numbers are needed.
     */
    tail: tailSignature(messages, toolProgress),
  });
  const scrollRef = follow.scrollRef;

  /*
   * Sending puts you back at the bottom, wherever you had scrolled to.
   *
   * Reading back through a conversation and then asking something is ordinary, and the reply to
   * it arrives at the end — so staying where you were means watching a screen on which nothing
   * appears to happen. Your own message is the one thing you can be certain you want to see.
   */
  const pending = useApp((s) => {
    if (!activeSessionId || s.activeSessionId === activeSessionId) return s.pendingUserMessage;
    return s.sessionCache[activeSessionId]?.state?.pendingUserMessage ?? null;
  });
  const { returnToBottom } = follow;
  useLayoutEffect(() => {
    if (!pending && !compacting) return;
    range.latest();
    returnToBottom(true);
    // The pending object identifies one submission; changing the window is not a new submission.
    // oxlint-disable-next-line exhaustive-deps
  }, [pending, compacting, returnToBottom]);


  const hidden = range.start;
  /*
   * 分块只在转录变了的时候算一次。
   *
   * 它在渲染里被读两次（画每一块、判断哪一块是最后一块），直接调用就是每次渲染跑两遍分组，
   * 而这条转录在一轮里每个 token 都会重渲染。
   */
  const blocks = useMemo(() => allBlocks.slice(range.start, range.end), [allBlocks, range.start, range.end]);
  const { scrollTo, detach } = follow;
  const jumpToQuestion = (index: number) => {
    // 窗口按块走，所以要的是「那条消息在哪个块里」，不是它在 Run 序列里的位置。
    const at = allBlocks.findIndex((block) => block.runs.some((run) => run.kind === "message" && run.index === index));
    if (at < 0) return;
    detach();
    range.reveal(at);
    setJump({ sessionId: activeSessionId, selector: `[data-question-index="${index}"]`, block: at, lead: 40 });
  };
  // 从转录以外要求跳到某一问（环境卡片里的「第 N 轮」）：照问题导航那条路走。
  const externalJump = useTranscriptJump((state) => state.jump);
  useEffect(() => {
    if (!externalJump || externalJump.sessionId !== activeSessionId) return;
    clearTranscriptJump();
    jumpToQuestion(externalJump.index);
    // `jumpToQuestion` is rebuilt every render; the request is what this reacts to.
    // oxlint-disable-next-line exhaustive-deps
  }, [externalJump, activeSessionId]);
  /*
   * 画廊要看的那张图。等这个对话读完才接：读完之前转录是空的，那时接下请求只能答一个「没有」。
   */
  const reveal = useDrawingReveal((state) => (state.sessionId && state.sessionId === activeSessionId ? state : null));
  useLayoutEffect(() => {
    if (!reveal || loadingSession) return;
    settleReveal(reveal.nonce);
    const at = allBlocks.findIndex((block) => block.runs.some((run) => run.kind === "tools" && run.calls.some(({ block: call }) => call.id === reveal.toolCallId)));
    if (at < 0) return;
    detach();
    range.reveal(at);
    setJump({ sessionId: activeSessionId, selector: `[data-ly-image-call="${CSS.escape(reveal.toolCallId)}"]`, block: at, lead: "middle", flash: true });
    // `range.reveal` is rebuilt every render; a new request or a finished read is what this answers.
    // oxlint-disable-next-line exhaustive-deps
  }, [reveal, loadingSession, allBlocks, activeSessionId, detach]);
  useLayoutEffect(() => {
    if (!jump || jump.sessionId !== activeSessionId) return;
    const el = scrollRef.current;
    if (!el) return;
    const target = el.querySelector<HTMLElement>(jump.selector);
    if (!target) {
      // 那一轮已经挂上了，目标还是没有——比如那次调用没留下图卡。没有可滚的，放下这次请求。
      if (jump.block >= range.start && jump.block < range.end) setJump(null);
      return;
    }
    const box = target.getBoundingClientRect();
    const lead = jump.lead === "middle" ? Math.max(40, (el.clientHeight - box.height) / 2) : jump.lead;
    const top = el.scrollTop + box.top - el.getBoundingClientRect().top - lead;
    /*
     * 目标挂着，可它下面挂着的东西不够把它顶上去：先把窗口往后放一截，下一次再滚。
     *
     * 窗口按轮计、一次二十轮，跳到窗口末尾那几轮时，`scrollTo` 会被夹在 scrollHeight − clientHeight
     * 上——问题停在屏幕半中间，而不是顶上 40px。`reveal` 对已经挂着的目标什么都不做，所以这里按
     * 真实像素补一句。放宽窗口的 setState 在 layout effect 里，绘制之前就重渲染完，第一帧不会动；
     * 窗口已经到底就照原样滚，那是真的没有更多可滚。
     */
    if (top > el.scrollHeight - el.clientHeight + 1 && range.end < allBlocks.length) {
      range.later();
      return;
    }
    scrollTo(top);
    if (jump.flash) flash(target, motionReduced());
    setJump(null);
    // `range.later` is rebuilt every render; the window's own edges are what this reacts to.
    // oxlint-disable-next-line exhaustive-deps
  }, [jump, activeSessionId, range.start, range.end, allBlocks.length, scrollRef, scrollTo]);

  return (
    <div ref={column} data-ly-chat-surface={side ? "side-chat" : "conversation"} className="relative flex min-h-0 flex-1 flex-col">
      {docked && EnvironmentCard && <EnvironmentLane card={EnvironmentCard} floatTasks={roomToFloat} />}
      {/*
       * The transcript and the button that scrolls it, in a box of their own.
       *
       * This used to be the same box as the composer, and `bottom` measured from the bottom of
       * *that* — so the button sat inside the field you type in rather than above the last
       * message. What it offers is about the transcript, so the transcript is what it is
       * positioned against.
       */}
      <div className="@container relative flex min-h-0 flex-1 flex-col" style={docked ? { marginRight: ENVIRONMENT_LANE } : undefined}>
      {environmentOpen && !docked && EnvironmentCard && <EnvironmentLane card={EnvironmentCard} floatTasks={roomToFloat} />}
      {/*
       * Over the transcript when there is room beside it, in the column when there is not.
       *
       * The plan is a companion to the conversation rather than part of it: it is one thing that
       * keeps changing, not another entry in a log, so it holds a fixed corner instead of
       * scrolling away with the messages that happened to be on screen when it was written. Below
       * the breakpoint there is no corner to spare — the transcript needs its full width — so it
       * moves to the one place that is always visible, just above where you type.
       */}
      {/*
       * Floating only when it can float clear of the words.
       *
       * The window being wide is not the same as this column being wide: open the side panel and
       * the transcript can be 600px inside a 1400px window, at which point a 320px card in the
       * corner is sitting on top of the reply rather than beside it. Measured here, against the
       * column it would cover.
       */}
      {roomToFloat && !environmentOpen && !side && (
        <div className="pointer-events-none absolute top-3 right-4 z-20 w-[320px]">
          <TaskList placement="floating" />
        </div>
      )}

      <Scroller
        className="flex-1"
        scrollRef={scrollRef}
        /*
         * The rail's room comes out of the column, so in a narrow column it comes out even.
         *
         * `pl-12 pr-4` clears the question rail on the left and leaves the right alone, which reads
         * as centred in a wide column and as visibly off-centre in a narrow one: 48 against 16 is a
         * twelfth of a 380px pane, and the whole transcript sits to the right of its own box. Below
         * `NARROW_COLUMN` the rail moves to the very edge and 28px each side clears it evenly.
         *
         * Reserved from the first message, not from the second question: switching padding when the
         * rail appears shoved the whole transcript sideways in the frame the second message was sent.
         */
        contentClassName={!side ?(narrowColumn ? "px-7" : "pl-12 pr-4 @min-[600px]:pr-8") : gutter}
        /*
         * 32px on top, the depth Claude's desktop transcript uses; the bottom's default 48 already
         * matches it.
         */
        fadeTop={32}
        /*
         * 跟着底部走的时候底下不渐隐：底下没有要提示的东西，只有弹簧还没追上的那几像素。
         *
         * 输出时内容每长一截就离底几像素、追上又贴底，底部渐隐跟着一开一合，每一次都是遮罩深度的一段
         * 过渡、整块转录重画一遍。读者滚开了（`away`）才是「下面还有」，那时再淡。
         */
        bottom={follow.away ? "fade" : "none"}
        onScroll={follow.onScroll}
        onResize={follow.onResize}
        onUserScroll={follow.onUserScroll}
        onHold={follow.hold}
      >
        {/* 切进来、从隐藏里回来时，正在写的那条回复直接画出已有的字，见 `Arrival`。 */}
        <Arrival.Provider value={arrival}>
        {/*
         * One tree per conversation. The pane keeps the last few mounted, so this
         * key only resets scroll when *this* session's id changes. No enter fade —
         * a 340ms opacity ramp after a click is the lag the list was already accused of.
         */}
        <div
          /* `--ly-bottom-inset` keeps 「回到最新」 off the newest message; see `styles/scroll.css`. */
          key={activeSessionId}
          className="ly-transcript ly-no-enter relative min-h-full mx-auto w-full max-w-[var(--ly-content)] pt-5 pb-[var(--ly-bottom-inset)]"
          data-ly-session={activeSessionId ?? ""}
          aria-busy={loadingSession}
        >
          {loadingSession && (
            <div
              role="status"
              /* `ly-defer-in`: a read that finishes just past `openSession`'s wait must not flash a spinner. */
              className={
                allBlocks.length === 0
                  ? "ly-defer-in absolute inset-0 flex items-center justify-center pointer-events-none"
                  : "ly-defer-in flex items-center justify-center py-4"
              }
            >
              <ActionSpinner size={allBlocks.length === 0 ? 20 : 14} className="text-ink-faint" />
            </div>
          )}
          {/*
           * Only the tail is mounted until you ask for the rest.
           *
           * A day-long session runs to thousands of messages, each with its own cards and
           * expanders. Mounting all of them costs memory that never comes back and makes every
           * repaint walk the whole tree, which is what turns scrolling to treacle. The recent
           * end is what anyone is reading; the rest is one click away and stays unmounted until
           * then.
           */}
          {hidden > 0 && (
            /*
             * 这颗按钮说的是整句话，不是一个数字。
             *
             * 它一度只画一个箭头和「60」，句子藏在 tooltip 里。一个数字不会自己解释自己——60 条
             * 什么？加载？未读？剩余？——而要读懂它得先把鼠标停上去等一秒，那是一次「先猜、再验」
             * 的交互，代价由每一个看到它的人付。键盘和读屏的人则连猜的机会都没有：`aria-label`
             * 是另一套说法，和眼睛看到的对不上。
             *
             * 一整行的宽度本来就摆在那儿，写完这句话绰绰有余。
             */
            <div className="mb-4 flex items-center justify-center">
              <button
                type="button"
                data-ly-show-earlier
                onClick={range.earlier}
                className="group/earlier inline-flex h-7 items-center gap-1.5 rounded-full border border-line-soft bg-card/40 px-3.5 text-detail text-ink-faint shadow-xs transition-colors duration-[var(--ly-t-quick)] hover:border-line hover:bg-card hover:text-ink-muted active:scale-[0.98]"
              >
                <ChevronUp size={12} strokeWidth={2} aria-hidden className="transition-transform duration-[var(--ly-t-quick)] group-hover/earlier:-translate-y-0.5" />
                {/*
                 * 「共 N 条」只在它确实是另一个数字时才出现。
                 *
                 * 最后一页里 n 和 total 是同一个数，「显示更早的 60 条（共 60 条）」把同一件事说了
                 * 两遍——而读到括号的人会以为里面有新消息。
                 */}
                <span className="tabular-nums">
                  {hidden > WINDOW_TURNS
                    ? translate("conversation.showEarlier", { n: WINDOW_TURNS, total: hidden })
                    : translate("conversation.showEarlierRest", { n: hidden })}
                </span>
              </button>
            </div>
          )}

          {/*
           * 按回合分块，不是逐条铺开。
           *
           * 一轮读下来是「想 → 做 → 说」。前两步是过程——跑的时候你在看着它，跑完之后它挡在答案
           * 前面就只是噪音。`turnBlocks` 在 Run 那一层把这件事定下来（规则性的东西要能单独测），
           * 这里只负责把有过程的一轮交给 `TurnWork` 一行行摊开。
           */}
          <div className="flex flex-col gap-2.5" data-ly-transcript-rows>
          {blocks.map((block, at) => {
            if (block.kind === "plain") return draw(block.runs[0]);
            /*
             * 按开这一轮的那句话起名，不按锚下面第一行：跑着的那一轮刚发出时下面是空的，第一行等它开口
             * 才有（见 `turnBlocks` 的 `live`）。按第一行起名，开口那一下整块就卸掉重建。没有开口那句的
             * （会话的第 0 轮）才退回第一行。
             */
            const opener = allBlocks[range.start + at - 1];
            const key = `${activeSessionId}:process:${runKey((opener?.turn === block.turn ? opener : block).runs[0])}`;
            /*
             * 按**回合**算，不是按块的位置算：正文一开始流式输出，过程就不再排在末尾。
             */
            const live = running && block.turn === blocks[blocks.length - 1].turn;
            const tail = block.items[block.items.length - 1];
            return (
              <TurnWork
                key={key}
                entries={block.items.flatMap((item) => {
                  const entry = {
                    key: `${activeSessionId}:${item.key}`,
                    // 正在做的那一段是这一轮的最后一行：后面有了别的（下一段活、一句话），它就做完了。
                    node: item.kind === "step" ? <WorkStep step={item.step} live={live && item === tail} draw={draw} /> : draw(item.run),
                  };
                  if (item.kind !== "step") return [entry];
                  /*
                   * 图紧跟在产出它的那段活后面，不排到整轮末尾：末尾是收尾那句话和它的结算行，排在那后面，
                   * 时间、耗时就压在了这一轮产出的东西上面。挂在段外面而不是段里面，见 `GeneratedImages`。
                   */
                  const drawn = item.step.calls.filter(({ block: call }) => call.name === "image_generate").map(({ block: call }) => call.id);
                  return [
                    entry,
                    ...(drawn.length > 0 ? [{ key: `${entry.key}:images`, node: <GeneratedImages calls={drawn} /> }] : []),
                  ];
                })}
              />
            );
          })}
          </div>

          {range.end < allBlocks.length && (
            <div className="my-3 flex items-center justify-center">
              <button
                type="button"
                data-ly-tip={translate("conversation.showLaterN", { n: Math.min(WINDOW_TURNS, allBlocks.length - range.end) })}
                aria-label={translate("conversation.showLaterN", { n: Math.min(WINDOW_TURNS, allBlocks.length - range.end) })}
                onClick={range.later}
                className="group/later inline-flex h-7 items-center gap-1.5 rounded-full border border-line-soft bg-card/40 px-3.5 text-detail text-ink-faint shadow-xs transition-colors duration-[var(--ly-t-quick)] hover:border-line hover:bg-card hover:text-ink-muted active:scale-[0.98]"
              >
                <ChevronDown size={12} strokeWidth={2} aria-hidden className="transition-transform duration-[var(--ly-t-quick)] group-hover/later:translate-y-0.5" />
                <span className="tabular-nums">{Math.min(WINDOW_TURNS, allBlocks.length - range.end)}</span>
              </button>
            </div>
          )}
          {range.end === allBlocks.length && <>
          {/*
           * 一整轮都在，不随每次工具调用来去：从前只在最后一条定下来时出现，它的 46px 跟着进出，转录整轮
           * 上下抖。结论在来的时候这一行只是看不见、高度不变，答完时当帧让位给操作行——见 `RunningRow`。
           */}
          <RunningRow running={running} answering={answering} grewAt={grewAt} answered={answered} compacting={compacting} />
          {/* Where the running indicator would have been, saying why it is not there. */}
          {!side && <ResumeRow />}
          {/*
           * The end of the transcript, as an element.
           *
           * Marking the newest message read is the one question that cannot be answered by
           * arithmetic: someone who scrolls up two screens, reads the paragraphs that arrived and
           * stops there has caught up, and no distance-from-bottom test tells that apart from
           * someone who has not. This entering the viewport is the fact itself. Zero height, so it
           * changes nothing about the layout it reports on.
           */}
          <div ref={follow.tailRef} aria-hidden className="h-px w-full shrink-0" />
          </>}
        </div>
        </Arrival.Provider>
      </Scroller>

      {/*
       * Over the transcript's last few pixels, not in the flow.
       *
       * A button that took a row of its own would push the transcript up by its own height the
       * moment it appeared, and a control offering to move you should not itself move the thing
       * it is about.
       */}
      {/* 侧边聊天里划下的一段拿去侧边聊天问，问的就是它自己——只有主对话有。 */}
      {!side && <QuoteMenu scrollRef={scrollRef} />}
      {questions.length > 1 && !side && <QuestionNav key={activeSessionId} questions={questions} viewport={scrollRef} edge={narrowColumn} onSelect={jumpToQuestion} />}
      <BackToLatest
        show={follow.away || range.end < allBlocks.length}
        unread={follow.unread}
        onClick={() => { range.latest(); follow.returnToBottom(); }}
      />
      </div>

      {/*
       * Approvals sit directly above the composer.
       *
       * They used to be pinned to the bottom of the whole pane, which put them over the field
       * you type in — the one control you might want while deciding, and the place your eye is
       * already resting. A normal-flow card now reserves its own height, so the transcript
       * scrolls above the decision instead of disappearing behind it.
       */}
      <div className="relative shrink-0" style={docked ? { marginRight: ENVIRONMENT_LANE } : undefined}>
        <ApprovalOverlay />
        {!side && <HookTrustBanner className={`${gutter} pb-1.5`} />}
        {/*
         * 只有卡片在的时候才留那道缝。清单是空的（或者做完收起了）时这一层什么都不画，
         * 却照样垫着 6px，输入框上方平白多出一截空白。
         */}
        {!roomToFloat && !side && (
          <div className={`${gutter} has-[[data-ly-task-list]]:pb-1.5`} data-ly-task-inline="">
            <div className="mx-auto w-full max-w-[var(--ly-content)]">
              <TaskList placement="inline" />
            </div>
          </div>
        )}
        {!side && <Composer />}
      </div>
    </div>
  );
});

/** 工具调用一共几个、停下了几个，见 `toolProgress`。 */
function toolProgressOf(toolRuns: Record<string, ToolRun>): string {
  let total = 0;
  let settled = 0;
  for (const run of Object.values(toolRuns)) {
    total += 1;
    if (run.status !== "running") settled += 1;
  }
  return `${total}/${settled}`;
}

/**
 * 环境卡片，和开着它时的任务清单——叠成一列，卡片在上。
 *
 * 两样都想要右上角那一块：任务清单本来就浮在那里。各占一个角会让一张盖住另一张，于是卡片开着时
 * 清单搬进这一列，排在卡片下面；卡片太长就自己滚，清单始终看得见。
 */
function EnvironmentLane({ card: Card, floatTasks }: { card: ComponentType; floatTasks: boolean }) {
  return (
    <div className="pointer-events-none absolute top-3 right-3 bottom-3 z-20 flex flex-col gap-3" style={{ width: ENVIRONMENT_CARD }}>
      <Card />
      {floatTasks && (
        <div className="shrink-0">
          <TaskList placement="floating" />
        </div>
      )}
    </div>
  );
}

/**
 * Stand-in for a transcript that is still being read off disk.
 *
 * Opening a stored session replays its whole log and starts its MCP servers. The selection in
 * the sidebar lands immediately; without something here the main column would show the empty
 * state in the meantime, which reads as "this session has no messages".
 */
export function ConversationSkeleton() {
  const { compact } = useLayout();
  // Uneven widths so it reads as prose rather than as a loading bar.
  const rows = [72, 94, 61, 88, 47];

  return (
    <div data-ly-chat-surface="skeleton" className="flex min-h-0 flex-1 flex-col">
      <div
        className={`ly-defer-in min-h-0 flex-1 overflow-hidden ${compact ? "ly-content-gutter-compact" : "ly-content-gutter"}`}
        aria-busy
      >
        <div className="mx-auto w-full max-w-[var(--ly-content)] py-5">
          <div className="ly-pulse flex flex-col gap-3">
            <div className="ml-auto h-[38px] w-[45%] rounded-2xl rounded-br-md bg-card" />
            {rows.map((width, index) => (
              <div
                key={index}
                className="h-[13px] rounded bg-card"
                style={{ width: `${width}%` }}
              />
            ))}
            <div className="mt-2 h-[38px] w-full rounded-xl bg-card" />
          </div>
        </div>
      </div>

      <Composer />
    </div>
  );
}
