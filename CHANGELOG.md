# 更新日志

这个文件由 `pnpm release` 生成，条目来自提交信息。写得含糊的提交在这里也含糊，所以值得在提交时就写清楚。

## [0.9.53](https://github.com/wJiaaa/Plume/releases/tag/v0.9.53) - 2026-10-25

<!-- plume:notes en -->

### New

- **Adding something in Settings opens a dialog, and nothing is saved until it is filled in.** This covers commands, code hosting, hooks, MCP servers, model providers and subagents. Before, some of these opened a form inside the page, and others saved an empty entry first for you to edit: an MCP server running `npx` that could not connect, or a provider named "New provider" with the address `https://`. Leave halfway and the empty entry stayed in the list. Hooks and subagents are also edited in the same dialog now.
- **Add a provider starts from a template**: OpenAI, Anthropic, DeepSeek, OpenRouter, Moonshot, SiliconFlow, Ollama, or Custom. The template fills in the Base URL and the API format, which is the field people most often get wrong and whose error is the hardest to read. You paste the key. "Fetch the model list after adding" is on by default.
- **Adding an MCP server by hand is in one place**: the ⋯ menu on the MCP tab, which has both a stdio and an HTTP option. The **Add** button at the top of Settings and the ⋯ menu in the marketplace could only add stdio servers, and both are gone.
- **Fewer one-call round trips.** The read, search, glob and shell tools now tell the model to send calls that don't depend on each other in one go. In 110 local sessions, 67% of tool turns made a single call, and 14.8% of those could have gone out with the turn before.

### Fixes

- **The main agent wrote its answer before its sub-agents came back.** In 7 local runs that wrapped up while sub-agents were still working, 3 wrote a conclusion anyway. The longest wrote 10,500 characters, then rewrote 5,765 of them when the sub-agents returned two and a half minutes later. Now it waits, and every 4 tool requests it is reminded which sub-agents are still out.
- **A sub-agent's result could be taken as your answer.** If it arrived right after the agent asked "shall I continue?", the agent read it as you saying yes and carried on. Results delivered in the background now start by saying they are not from you and do not answer any question.
- **Pipelines showed "No runs yet" for GitHub Enterprise on a non-standard port** such as `:8443`. The port was dropped from the remote address, so it did not match your signed-in account and the request went out without it.
- **A page that sends you to an app link as soon as it opens** (a `lark://…` redirect, for example) sometimes left a blank tab with no explanation, about one time in four. It now always shows "This page wants to open an app" with **Open in system browser**.
- **A hook matcher on UserPromptSubmit or Stop meant the hook never ran.** These events don't use a matcher, so the field is now disabled and nothing in it is saved. For the other events, the dialog explains what the matcher is compared against.
- **In the subagent editor**, the shuffle button on the avatar no longer cuts a square notch out of its frame. Cancelling with unsaved changes asks "There are unsaved changes" in the footer, next to the button you pressed, instead of at the top of the dialog.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 新功能

- **设置里新建东西，一律在弹窗里填，填齐了才存。** 涉及命令、代码托管、钩子、MCP 服务、模型供应商、智能体。原来有的在页面里就地展开表单，有的先存一个空壳让你去改：MCP 是一台命令为 `npx`、一开就连不上的服务，供应商是一个地址只有 `https://` 的「新供应商」。改到一半切走，空壳就留在列表里。钩子和智能体的编辑现在也在同一个弹窗里。
- **添加供应商先挑模板**：OpenAI、Anthropic、DeepSeek、OpenRouter、Moonshot、SiliconFlow、Ollama，或者自定义。地址和 API 格式由模板填好。API 格式最容易选错，选错了报错又最看不懂。你只管贴 Key。「添加后拉取模型列表」默认开着。
- **手动添加 MCP 服务只留一个入口**：MCP 标签的 ⋯ 菜单，stdio 和 HTTP 两种都在。设置页右上角的「添加」和插件市场的 ⋯ 都只能建 stdio 服务，这两个入口去掉了。
- **少一些一次只发一个调用的来回。** 读文件、搜索、glob、bash 这几个工具的说明里写明了：互不依赖的调用一次发出去。本机 110 个会话里，67% 的工具回合只发了一个调用，其中 14.8% 本可以和上一回合一起发。

### 修复

- **子 Agent 还没回来，主 agent 就先交了结论。** 本机 7 次在子 Agent 还在干活时收尾的运行里，有 3 次照样写了结论。最长的一次先写了 10500 字，两分半后子 Agent 回来，又重写了 5765 字。现在它会等，每隔 4 次工具请求还会提醒它在等哪几个。
- **子 Agent 的结果会被当成你的回答。** agent 刚问完「要不要继续」，结果正好送到，它就当你说了「要」，接着往下做。后台送来的结果现在开头先说明：这不是你说的话，也不算对任何提问的回答。
- **非标准端口（比如 `:8443`）的 GitHub Enterprise，流水线页显示「暂无运行记录」。** 远端地址里的端口被丢掉了，对不上你登录的账号，请求就没带上它。
- **网页一打开就跳去唤起应用**（比如 302 到 `lark://…`）时，大约四次里有一次会停在一张白页上，什么也不说。现在每次都会盖上「这个网页要打开一个应用」，并给出「在系统浏览器中打开」。
- **UserPromptSubmit、Stop 两种钩子填了匹配器，就一次也不会跑。** 这两种事件不看匹配器，现在框置灰，填了也不存。其余事件，弹窗里写明了匹配器比的是什么。
- **智能体编辑器里**，头像角上换脸的骰子不再把头像框切出一个方缺口。有未保存的修改时按取消，「尚有未保存的修改」出现在底栏、就在你按的那颗按钮旁边，不再跑到弹窗顶上。

</details>

## [0.9.52](https://github.com/wJiaaa/Plume/releases/tag/v0.9.52) - 2026-10-23

<!-- plume:notes en -->

### New

- **`/review` hands the review to a separate review chat.** The conversation that wrote the code tended to agree with itself, and reading the diff filled up its context. Now `/review` is a built-in command, listed under Commands in the `/` menu. It writes a hand-off and opens a read-only review chat under it in the sidebar, named "Review ·" and the conversation's title, in the same folder or worktree. The review chat gets your plan and your own messages word for word, not a summary of them. When it is done it asks the original conversation which findings to fix. That conversation decides from what you said, and asks you only about the ones it cannot settle. The review chat makes the fixes, runs the checks and sends the report back, with what was fixed and what was left. Until that answer comes, it cannot edit files. Run `/review` again and you get a new review chat. A different model for reviews can be picked in Settings › Subagents.
- **The agent can watch a long-running command instead of polling it.** A dev server or a test watcher sends its new output back in batches, and the agent picks it up from there. In the Environment card these commands are tagged "monitor", and the button shows a dot while one runs even when the card is closed. Each batch wakes the agent for a turn.
- **The agent can come back later on its own**, once ("check the build in 10 minutes") or on a repeat. Pending ones are listed under Scheduled wakeups in the Environment card, where you can cancel them. They last only while the app is open: quitting it or pressing Stop cancels them.
- **Export as Markdown** in a chat's menu: a file for people to read, next to the existing raw records export.
- **Follow-ups under a chat can be collapsed in the sidebar.** Hover the parent and the status dot becomes an arrow; once collapsed, a small count shows how many are hidden, with a spinner if one of them is running. It is remembered across restarts.
- **When memory comes up with a suggested skill, you hear about it.** A notice names the skill, and **Take a look** opens the skills page on that project. Before, suggestions only sat in Settings, and none had ever been approved or rejected.
- **Pictures in a message are called "Image 1", "Image 2"** instead of their file names. Camera and chat-app names like `dji_mimo_…_photo.JPG` filled a whole line and pushed the label to wrap. The real name is still shown on hover and still sent to the model. Documents keep their names.

### Fixes

- **Side chat tasks and scheduled tasks that stopped early were shown as done.** A task stopped by a provider error, by repeating the same call, or by the turn limit got a green check and "Done". It is now marked unfinished with the reason and can be retried. A scheduled task records the error and sends a failure notice.
- **Scheduled tasks no longer pile up** when they run longer than their interval. The next run waits until the current one, including its sub-agents, has finished; runs that came due meanwhile are made up once.
- **A chat asked to report back sent "dispatched, waiting for results" instead of its answer.** If its first turn dispatched sub-agents, that sentence was what came back, and the real conclusion never arrived. It now waits until the chat has finished.
- **Dev servers started by a sub-agent kept running after it finished**, out of sight in the Environment card and impossible to stop until the app quit. They are stopped when the sub-agent is done.
- **Memory no longer loses old conclusions or repeats your instructions.** It was rewritten from scratch every day from the last 30 days of chats, so anything learned from an older chat disappeared, and many entries restated AGENTS.md or learned.md. It now edits the previous version, reading only the chats since the last pass. On one project, 10 entries went down to 7, and the three removed were those repeats.
- **The agent is told when a sub-agent did not finish.** The result used to say `status="done"` with only a ⚠ in the text. Sub-agents now also list what they changed and what they checked. Sub-agents that write files in parallel are each given their own files, so they do not overwrite one another.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 新功能

- **`/review` 交给一个单独的审阅会话去审。** 写代码的那个会话审自己，容易认同自己，读 diff 还会占满它的上下文。现在 `/review` 是内建命令，在 `/` 菜单的「命令」组里。敲下去，原会话写一份交接单，在侧栏里它下面开一个只读的审阅会话，叫「审阅 · 原会话标题」，目录（或工作树）和原会话相同。审阅会话拿到的是你批准的计划和你说过的原话，不是转述。审完它先问原会话修哪几条：原会话按你说过的话定，定不下来的才问你。修由审阅会话来，修完跑检查，报告连同修了什么、留下什么交回原会话。答复之前它改不了任何文件。再敲一次 `/review` 就另开一个审阅会话。审阅用的模型可以在 设置 › 智能体 里单独选。
- **长跑的命令，agent 可以盯着看，不用反复去查。** dev server、监听模式的测试有了新输出就成批送回去，agent 接着处理。这类命令在「环境」卡片里标着「监视」，卡片收着时按钮上也有亮点。每送一批，agent 就会被叫醒跑一轮。
- **agent 可以过一会儿自己回来接着做**，一次（「10 分钟后看看构建」）或者循环。排着的都列在「环境」卡片的「定时唤醒」里，可以取消。只在应用开着时有效：退出应用或按停止都会取消。
- **会话菜单里可以「导出为 Markdown」**，是给人读的版本，原来的「导出原始记录」还在。
- **侧栏里，会话下面的后续会话可以收起。** 悬停父会话，状态点变成折叠箭头；收起后行尾标出收了几条，里面有在跑的就显示转圈。重启后保持。
- **记忆里总结出新技能时会提示你。** 提示里写着技能名，点「去看看」直接打开那个项目的技能页。原来候选只躺在设置里，从来没人批准或否决过一个。
- **消息里的图片一律叫「图片 1」「图片 2」**，不再摆出文件名。相机、聊天软件起的名字（`dji_mimo_…_photo.JPG` 这种）一放就是一整行，标签还被挤到折行。悬停照样看得到真名，发给模型的也还是真名。文档照旧显示文件名。

### 修复

- **侧边聊天的任务和定时任务半路停下，却显示成做完了。** 服务商出错、反复做同一个调用、到了轮数上限，任务都会打绿勾、显示「已完成」。现在标成没做完，写明原因，可以重试；定时任务会记下错误并发失败通知。
- **定时任务跑得比间隔还久时，不再一次叠一次。** 下一次等这一次连同它的子 Agent 全部收尾才开始；这期间到期了几次，事后只补跑一次。
- **要求「交回这里」的会话，交回来的是「已派出，等结果」。** 第一轮派了子 Agent 的会话，送回去的就是这句话，真正的结论再也到不了。现在等它把事做完再交。
- **子 Agent 起的 dev server，它收工后还一直在跑。** 「环境」卡片里看不见，也停不掉，要等应用退出。现在子 Agent 收工时一起停掉。
- **记忆不再丢掉旧的结论，也不再复述你的指令。** 原来每天拿最近 30 天的会话整份重写，比 30 天更早的会话里学到的东西就此消失，不少条目在复述 AGENTS.md、learned.md 里已有的话。现在在上一版上增删改，只读上次之后的会话。拿一个项目实测，10 条降到 7 条，去掉的正是那三条重复。
- **子 Agent 没做完，主 agent 会知道。** 原来结果上写着 `status="done"`，只有正文里一个 ⚠。现在子 Agent 还会列出改了哪些文件、验证过什么。并行派出去改文件的几个子 Agent，各自分到不同的文件，不再互相覆盖。

</details>

## [0.9.51](https://github.com/wJiaaa/Plume/releases/tag/v0.9.51) - 2026-10-23

<!-- plume:notes en -->

### New

- **Undoing or resending a message can put the files back too.** Undo used to cut only the conversation: files changed in the turns after that message stayed changed, so asking again started from code written by turns that no longer existed. The confirmation now lists those files with lines added and removed, and offers **Undo chat and files** or **Undo chat only** (for a resend, **Restore files and send** or **Resend only**). It is all or nothing. If any of the files was changed since by you or another conversation, was written by a command, or was not recorded, only the chat goes back and no file is touched. Resending with files is offered on the last message only.
- **The sub-agent panel shows the model a sub-agent runs on and its reasoning effort**, in the spot where the main composer shows yours. Sub-agents pick their own model and effort, so these were often not what you saw in the main composer. When the panel is narrow, the other labels give way first so the model name stays readable.
- **A finished auto-compaction is a divider line**, like switching models: "Context compacted (messages: 363 → 44)". Before, it was a row that looked like the replies around it.

### Fixes

- **Deleting a worktree from Settings could reach the main repository.** `git worktree list` puts the main checkout first and it was not excluded, so the removal could go on to delete that folder. Settings no longer force-removes a worktree; if it has uncommitted changes, it tells you how many. **Clean up old worktrees** showed as on in Settings while the app treated it as off; it is off in both now.
- **A conversation in its own worktree starts from the project's memory.** Memory is kept per folder and a worktree is a different folder, so these conversations started with an empty memory, and what they learned went somewhere nobody read once the worktree was gone. They now read and write the main checkout's memory. A project opened through a symlink still does not match up.
- **The first edit to a TypeScript file came back without diagnostics.** If the language server failed to start once in a folder, it was never tried there again.
- **Sub-agents lost their report after a restart**, so their result and "continue" were both gone. Switching to another sub-agent in the panel no longer carries over the previous one's "Put in the composer".
- **The sub-agent panel folds each turn the way the main conversation does.** A sub-agent that thinks and then runs two commands showed alternating thinking and tool rows; consecutive work is one line now.
- **The sweep on the running line no longer freezes when the window loses focus.** With windows side by side, a frozen sweep looked like a stuck turn. It stops only when the window is minimized.
- **Switching back to a conversation no longer regrows the end of each work step.** The failure mark and +N −M disappeared and grew back from 0 to full width over about 350 ms every time.
- GitLab and Gitee pull requests no longer show a made-up "+0 −0 · 0 files".
- Turning on plan mode in the middle of a turn takes effect. A hook config changed outside the app no longer stays trusted for commands you have not seen.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 新功能

- **撤回、重新发送一条消息时，可以连文件一起退回。** 原来撤回只截对话，之后那几轮改过的文件原样留在磁盘上：重新问的时候，模型面对的是「已经不存在的那几轮」写下的代码。现在确认框会列出这些文件和各自的增删行数，可以选「撤回对话和文件」或「只撤回对话」（重新发送时是「退回文件并发送」或「只重新发送」）。要退就全退：只要有一个文件之后被你或别的会话改过、是命令写的、或者没有记下来，就只撤回对话，一个文件都不动。连文件重新发送只对最后一条消息开放。
- **子 Agent 面板显示它跑在哪个模型上、推理强度多少**，位置和主输入框显示这两项的地方一样。子 Agent 的模型和推理强度是单独选的，常常和主输入框上看到的不一样。面板窄时其他字先让位，保证模型名读得出。
- **自动压缩完成后画成一条分隔线**，和换模型那条一样：「已压缩上下文：363 条消息整理为 44 条」。原来是一行和旁边回复长得一样的字。

### 修复

- **在设置里删除工作树，可能删到主仓库。** `git worktree list` 第一条就是主仓库，判断时没有排除，删除可能一路走到删掉那个目录。设置页不再强制删除；工作树里还有未提交的改动时，会说明有几处。「自动删除旧工作树」在设置页显示为开、应用实际按关处理，现在两边都是关。
- **开在独立工作树里的会话，读得到项目的记忆。** 记忆按目录存，工作树是另一个目录，于是这些会话从一份空记忆开始，学到的东西又存进一个工作树收回后就没人再读的地方。现在读写的都是主仓库那一份。从软链路径打开的项目，两边仍然对不上。
- **第一次改 TypeScript 文件拿不到诊断。** 语言服务在某个目录启动失败一次后，那里就再也不重试。
- **重启后子 Agent 的回报丢了**，结果和「接着跑」都没了。面板切到另一个子 Agent 时，按钮不再带着上一个的「已填入输入框」。
- **子 Agent 面板按回合收拢，和主会话一样。** 子 Agent 想一下、再并行跑两条命令，原来是思考、工具一行一行交替排下去，现在连着的活合成一行。
- **窗口失焦时，运行行上的扫光不再定住。** 几个窗口并排摆着时，扫光一停，看上去就是这一轮卡死了。现在只在最小化时停。
- **切回会话时，工作步骤的行尾不再重新长一遍。** 原来每次切回，失败记号和 +N −M 都先消失，再花约 350ms 从 0 长到原宽。
- GitLab、Gitee 的 PR 不再显示凭空的「+0 −0 · 0 个文件」。
- 一轮跑到一半打开计划模式，现在会生效。钩子配置在应用外被改过以后，不再对没看过的命令沿用原来的信任。

</details>

## [0.9.50](https://github.com/wJiaaa/Plume/releases/tag/v0.9.50) - 2026-10-22

<!-- plume:notes en -->

### Fixes

- **The time under a turn could be a tenth of what it really took.** When the model stopped with items still open on its task list, the footer counted only up to that first stop: a turn that ran 66 s read 6 s. Tool calls that run after it now count; the time spent waiting for you to say "continue" still does not.
- **Long pasted messages are no longer cut off at the edge of the bubble.** URLs, base64 and minified JSON have no spaces to break at, so they ran past the bubble and the overflow was clipped out of sight. They wrap now. A message longer than 14 lines shows its first 10 with **Show more**, so a 20,000-character paste no longer pushes the reply several screens away.
- **Switching to a conversation that is streaming lands at the bottom.** It used to open 89–119 px short and then slide up for about 200 ms, because the text written while you were away was treated as text arriving right now.
- **Scrolling up in a short conversation no longer stops it following.** One flick on the trackpad while the model was still thinking left the view stuck at the top while the reply grew past the window, and it came back there after switching away.
- **The running line comes back when an answer stalls.** It hides while the answer streams so it does not jump along under the text, and the time and speed under a reply only appear when the turn ends, so a slow or stuck answer showed nothing but text. After 2 s without new text it now shows how long the turn has run and how fast; as soon as text arrives again it hides. The second or two some gateways leave between the last word and the end of the reply no longer counts as stalling, and switching away and back does not restart the wait.
- **Text written while you were in another conversation no longer fades in as one block** when you come back.
- **Editing and checking a preview over and over reads as one step.** A turn that edited a page and checked its preview twenty times was drawn as alternating command and preview rows (21 in one real turn); it is 6 now, broken only where the model says something.
- **"Work outside a project" and archiving a whole project leave a clean conversation.** The blank conversation could keep the previous one's state: a stop button, its task list, its "paused" row.
- **A turn the app found had already stopped no longer leaves its timer behind**, which made the next message continue from a start time long gone.
- **"Back to bottom" in the subagent panel glides** instead of jumping.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 修复

- **一轮底下的耗时，可能只有实际的十分之一。** 模型停下时清单上还有没勾的，页脚只算到第一次停下：跑了 66 秒的一轮显示 6 秒。现在之后工具接着跑的时间照样算，等人说「继续」的那段仍然不算。
- **长消息贴进来，不再被气泡边缘裁掉。** URL、base64、压成一行的 JSON 没有空格可断，顶出气泡后超出的部分被裁掉看不见。现在会折行。超过 14 行的消息只露出前 10 行，留一颗「展开全文」，两万字的一段粘贴不再把回复顶到好几屏以外。
- **切进正在输出的会话，直接落在底部。** 原来先落后 89–119px，再花约 200ms 往上滑：离开期间写下的字被当成了此刻正在出的字。
- **内容不满一屏时往上滚一下，不再从此不跟。** 模型还在想的时候碰一下触控板，回复写过几屏也停在顶上，切走再回来恢复的还是顶部。
- **结论写着写着停住时，运行行回来。** 结论流出来时运行行会藏起来，免得挂在字底下一跳一跳；而回复底下的时间、速度要等这一轮结束才有。两头一夹，写得慢或卡住的结论屏幕上只有字。现在 2 秒没长新字，运行行就回来说跑了多久、多快；字一接着长，它又藏回去。有的网关在最后一个字和回复收尾之间空一两秒，这段不算停住；切走再切回来，也不会重新等这 2 秒。
- **在别的会话时这里写下的字，切回来不再整段淡入。**
- **改一次、看一次预览的反复，合成一行。** 改页面、检查预览来回二十次的一轮，原来画成命令、预览交替的一长串（真实会话里一轮 21 行），现在是 6 行，只在模型中途说话处断开。
- **「不在项目中工作」和归档整个项目之后，留下的是一个干净的对话。** 原来空白对话上可能还挂着上一个会话的停止按钮、清单和「已暂停」那一行。
- **发现某一轮其实已经停了时，计时一起收走。** 原来留着的那份会让下一条消息接着一个早就过去的起点计时。
- **子智能体面板里的「回到底部」是滑过去的**，不再一下跳到底。

</details>

## [0.9.49](https://github.com/wJiaaa/Plume/releases/tag/v0.9.49) - 2026-10-22

<!-- plume:notes en -->

### New

- **MCP servers are shared between conversations.** Every live conversation used to start its own copy of each server, so three open chats meant three processes of the same stdio server, and eight meant eight. Now each server runs once, conversations borrow it, and it stops when the last one lets go. A server that keeps state per conversation, such as one driving a browser or holding a database connection, can be switched to **Separate for each conversation** in its MCP settings to get one copy per chat again. When a shared server asks a question mid-call, it goes to the conversation that made the call; if nobody is calling it, the request is declined instead of shown to whichever chat happens to be first.

### Changes

- **Opening an old conversation no longer starts it.** The context meter beside the composer asked for a breakdown as soon as it appeared, and answering that started the agent with its skills, plugins and every MCP server — five new processes on a setup with five servers, a 65 ms freeze with thirty. A conversation that is not running now answers from its log, the subagent list included, and with a side chat open the parent is no longer pulled up either. Switching back to a conversation holds the main process for 3–9 ms instead of 21–40 ms.
- **Long conversations no longer get heavier to draw as they grow.** With a main chat and side chats streaming at once, or a model calling tools in parallel batches, the renderer's CPU climbed with the length of the conversation. Text reveal, fades, counters and the thinking orb now share one ~30 Hz tick, the main process sends only the part of a reply that changed instead of the whole message for every token, and each row listens only to what it draws. On the same probe (batches of six read-only calls, about 170 turns) the renderer ends near 52% instead of 63%, with 602 React commits per 12 seconds instead of 1,558. A background conversation running a noisy command also stops dragging the foreground stream back to one store write per event.
- **One language server per project.** Three conversations in the same folder, or one that sent out subagents, ran three copies of tsserver at a few hundred MB each. They share one now; a worktree has its own files and still gets its own.
- **Read-only shell commands skip the workspace snapshot.** Each command was wrapped in five or six git processes and a read of every modified file, only to record what it changed. A read-only command changes nothing: in a repository with 55 modified files, six of them in parallel spent about 200 ms of main-process time and 0.8 CPU-seconds of git on snapshots.
- **Fewer git processes.** Every filename-only link in a reply ran its own `git ls-files`, and opening one conversation once started 44 of them. A project's files are now listed once and searched in memory. The change count under the composer runs two git processes instead of five (median 51 ms → 45 ms).
- **Plume starts a little sooner.** The splash screen stays at least 0.9 s instead of 2 s: the sidebar's data arrives in about 300 ms, so every launch spent 1.7 s in front of a screen that was already ready. Setting the Dock icon now waits until the window is shown, and the window appears at a median of 517 ms instead of 555 ms.
- **Compaction happens before the price goes up.** On a model whose input price doubles past a line (272k for gpt-6.1-sol), compaction used to trigger above that line, so every turn after crossing it was billed at the higher rate. It now triggers at the line. Lines below 128k are ignored: a 1M-window model with a 32k tier had been compacting at 32k, leaving about 4k for the conversation after the prompt and tools, and summarizing almost every turn.

### Fixes

- **A conversation whose subagents are still working no longer shows as finished.** The turn that sends a subagent off ends right away, so the list marked the conversation "Finished · unread" and announced it, then lit up again and announced it a second time when the results came in. It now counts as running until its subagents report back.
- **The running indicator no longer disappears before a tool call, or jumps along under an answer.** It hid as soon as text started streaming, and most providers don't label the short line a model writes before calling tools, so it blinked out before every batch of calls. Streaming text now counts as the answer once it has a line break or passes 150 characters. Measured on 1,447 such opening lines and 410 answers from real sessions: the opening lines have a median of 58 characters, the answers 885; 2.8% of opening lines are taken for answers (the indicator comes back when the tool call arrives), and a typical answer is recognized by its 73rd character.
- **The reasoning effort picked on the new-chat page no longer snaps back a second later.** One click sent two saves, and whichever came back last carried the old level.
- **The update dialog checks again when you open it.** It showed the result from launch, or from the check six hours earlier, so after a release it could still offer — and download — the previous version. A check that fails while offline no longer hides an update that was already found.
- **File links with a GitHub line anchor open at that line.** `pricing.go#L449` and `#L42-L50` were read as part of the file name, and the file could not be found. Other anchors (`README.md#usage`) open the file; a `#` in a folder name (`src/C#/a.cs`) is left as part of the path.
- **In very large repositories, a filename-only link no longer lands in `node_modules`.** Listing every file overflowed git's 32 MB output limit, Plume fell back to walking the folder without `.gitignore`, and found a file of the same name in dependencies or build output. It now asks git about that one name.
- **Turning on Reduce motion stops a thinking orb that is already spinning.** It only looked at the setting when it first appeared.
- **On macOS, the Dock icon is set even when the first window is closed before it shows.**

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 新功能

- **MCP 服务器在会话之间共用。** 以前每个在线会话各连一遍：开着三个会话，同一台 stdio 服务器就是三个进程，开八个就是八个。现在每台只起一个，会话借着用，最后一个用完才关。要按会话分开状态的服务器（驱动浏览器的、攥着数据库连接的），在 MCP 设置里打开「每个会话独立」，就回到一个会话一份。共用的服务器中途发来提问时，问的是正在调用它的那个会话；没人在调用就直接拒绝，不去猜该问谁。

### 变化

- **点开历史会话，不再把它拉起来。** 输入框旁的上下文表一出现就要读数，而回答它要先拉起 agent，连同技能、插件和每一台 MCP 服务器：配了 5 台 MCP 就新起 5 个进程，配 30 台主进程卡 65ms。没在跑的会话现在从日志里回答，子智能体名单也一样；开着侧边聊天时点旧会话，也不再连带拉起它的父会话。切回一个会话，主进程最长卡 3–9ms，原来是 21–40ms。
- **会话越长、界面越吃 CPU 的情况收住了。** 主会话和几个侧边聊天同时输出，或者模型一批批并行调工具时，渲染进程的 CPU 跟着会话长度往上走。现在放字、淡入、数字爬升和思考球共用一个约 30Hz 的拍子，主进程只发回复里变了的那一截、不再每个 token 发一整条消息，每一行只订阅自己画的那部分。同一个探针（每批 6 个只读调用、跑到约 170 轮）收尾时，渲染进程从 63% 降到 52% 上下，每 12 秒的提交次数从 1558 降到 602。后台会话跑着一个输出很多的命令时，前台的流式输出也不会再被拖回每个事件写一次。
- **同一个项目只起一个语言服务器。** 同一个目录开三个会话，或者一个会话派出子智能体，原来就是三套 tsserver，每套几百 MB。现在共用一套；worktree 是另一批文件，仍然各用各的。
- **只读命令不再拍工作区快照。** 每条命令前后各起五六个 git、把每个改过的文件读一遍，只为记下它改了什么，而只读命令什么都不改。55 个改动文件的仓库里，6 条并行的只读命令光是快照就占掉主进程约 200ms、git 约 0.8 CPU 秒。
- **少起 git 进程。** 回复里只写文件名的链接，原来每个各跑一次 `git ls-files`，打开一个会话起过 44 个。现在一个项目只列一遍文件、在内存里找。输入框下的改动统计从 5 个 git 进程减到 2 个，中位数 51ms → 45ms。
- **启动快了一点。** 启动画面最短停留从 2 秒改成 0.9 秒——侧边栏的数据约 300ms 就到齐，每次启动都对着一个早已准备好的界面多等 1.7 秒。Dock 图标改到窗口显示之后再设，窗口出现的中位时间从 555ms 到 517ms。
- **压缩赶在涨价之前。** 有分档定价的模型（gpt-6.1-sol 输入过 272k 单价翻倍）上，压缩原来在分档线之上才触发，越线以后每一轮都按高一档计费。现在正好在分档线上压。低于 128k 的分档线不再算数：1M 窗口的模型挂着一条 32k 的分档，原来在 32k 就压，扣掉提示词和工具只剩约 4k 给对话，几乎每一轮都在做摘要。

### 修复

- **子智能体还在跑，会话列表不再显示「已完成」。** 派出子智能体的那一轮当场就结束了，列表于是标成「已完成 · 未查看」、报一次完成，结果回来又亮起来、再报一次。现在子智能体交差之前，这个会话都算在跑。
- **调工具前的那句话不再让运行指示器消失，结论流出来时它也不再一跳一跳。** 原来正文一开始流，指示器就藏起来；可大多数服务商不会给「我先看一下这个文件」这种开场白打标记，于是每批工具调用之前它都闪没一次。现在正在流的正文要出现换行、或者超过 150 字才算结论。拿本机 1447 条开场白和 410 条结论量过：开场白中位 58 字，结论中位 885 字；2.8% 的开场白会被当成结论（工具调用一到，指示器就回来），一条结论通常在第 73 个字就被认出来。
- **新对话页选的推理档位，不再过一秒跳回原档。** 点一下发出了两次保存，后返回的那次带着旧档位，把刚选的盖了回去。
- **点开更新弹窗时会重新检查。** 原来显示的是启动时、或者 6 小时前那次检查的结果：发了新版以后弹窗里还是上一版，点下载下的也是上一版。离线时检查失败，也不会再把已经发现的新版本一起抹掉。
- **带 GitHub 行号锚点的文件链接，能定位到那一行。** `pricing.go#L449`、`#L42-L50` 原来被当成文件名的一部分，点开找不到文件。别的锚点（`README.md#usage`）去掉锚点直接打开文件；目录名里的 `#`（`src/C#/a.cs`）照常当作路径。
- **超大仓库里，只写文件名的链接不再找到 `node_modules` 里的同名文件。** 一次列出全部文件超过了 git 32MB 的输出上限，于是退回去直接遍历目录，而遍历不认 `.gitignore`，依赖和构建产物里的同名文件就被找了出来。现在只按这一个名字去问 git。
- **打开「减少动态效果」，正在转的思考球当场停下。** 它原来只在出现的那一刻看一次设置。
- **macOS 上第一个窗口还没显示就被关掉时，Dock 图标照样会设置。**

</details>

## [0.9.48](https://github.com/wJiaaa/Plume/releases/tag/v0.9.48) - 2026-10-22

<!-- plume:notes en -->

### New

- **A file link in a reply opens at the line it names.** Models pointing at a piece of code used to link the file alone, so you landed at the top and went looking by hand. The link now ends with the line or the range — `src/auth.ts:42`, `src/auth.ts:42-50` — the link shows `:42`, and opening it scrolls that file's pane to those lines and highlights them for a moment. It works when the file is already open, and when the pane has been popped out into its own window.
- **An edit that broke the file comes back with the errors.** After a file is written or edited, any type or syntax errors in it are appended to the result, at most ten, so a mistake shows up in the turn that made it instead of whenever a check is next run. A clean file adds nothing. Diagnostics had also been answering from the copy of the file from before the edit, and a missing closing brace counted as no error; both are fixed.

### Changes

- **Previews in a reply stop drawing while Plume is behind another window.** Background throttling stays off — screenshots flash white without it, and a covered pane stops reporting its size — so a page kept rendering at full rate while you worked elsewhere; one inline WebGL page held the GPU process at about 15%. A preview now holds its last frame and pauses its CSS animation when the window is not in front, and picks up where it stopped when you come back. Pages in the sidebar are separate tabs and are not affected.
- **On DeepSeek, a compaction an hour after the last request still reads its summary from cache.** The summary request was only branched off the main request while the two were within 4.5 minutes of each other; later than that it became a separate request that paid full price for the system prompt and the whole history again. DeepSeek normally keeps its cache for hours to days, so for DeepSeek that window is an hour.

### Fixes

- **A compacted conversation no longer loses what it was working on.** On a 64k window the messages kept after the summary were trimmed down to the last one, so a conversation that had been editing a file came back with no memory of that file and read it again. The kept tail no longer runs into a ceiling that only existed to stop compaction from firing twice in a row.
- **`git mv` no longer leaves a ghost file in the Git panel.** The old path stayed in both the staged and the unstaged list, so a one-file rename was counted as two files with two added lines.
- **Starting Plume from a git hook no longer reads another repository.** Launched from a hook, or from a terminal with `GIT_DIR` set, the checkout found through `origin` and the file contents read from it both came from a different repository.
- **Text typed in one chat no longer appears in another.** An unsent draft was written under a key that another conversation then read, so switching chats showed the other chat's text for a frame.
- **The dialog for discarding an untracked folder had an empty name in its title.** For a path ending in a slash, such as `.claude/`, taking the last segment after splitting on `/` left nothing, and the dialog asked whether to discard `""`.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 新功能

- **回复里点文件链接，直接到那一行。** 模型指向某处代码时以前只链到文件，点开停在开头，还得自己去找。现在链接末尾带着行号或行范围——`src/auth.ts:42`、`src/auth.ts:42-50`，链接上显示 `:42`，点开文件那一格滚到这几行并亮一下。文件已经开着也照样跳，面板弹到单独窗口里点也一样。
- **改坏了当场就报出来。** 写入或编辑一个文件之后，这个文件里现有的类型错误和语法错误会附在结果末尾，最多十条，所以错误出现在改动的那一轮，而不是等到下次有人跑检查。文件本身干净就一个字不加。诊断原来还会拿改动前的内容回答，少一个右括号也算「没有错误」，这两处一起修了。

### 变化

- **Plume 被别的窗口挡住时，回复里的预览停住不画。** 后台节流是关着的（关掉是为了截图不闪白、被挡住的窗格还报尺寸），代价是页面在你看别处时仍按满帧率画，一张内联的 WebGL 页面让 GPU 进程常驻 15% 上下。现在窗口不在前台时，预览停在最后一帧、CSS 动画一起暂停，切回来接着走。侧栏里的页面是独立的浏览器标签，不受影响。
- **DeepSeek 上，隔一小时再压缩，摘要请求照样吃缓存。** 摘要请求原来只在距上一次请求 4.5 分钟以内才从主请求分叉，再晚就换成独立请求，系统提示词和整段历史按原价再读一遍。DeepSeek 的缓存通常要几小时到几天才清，这个窗口对它放到了一小时。

### 修复

- **压缩之后，长对话不再忘了刚才在做什么。** 64k 窗口上，摘要写好以后保留的那几条被一路删到只剩最后一条，正在改的文件跟着没了，下一轮只能重读一遍。现在保留的尾部按它自己的预算留着，不再撞那条只为「防止刚压完又压」设的天花板。
- **`git mv` 之后，Git 面板不再多出一个已经不存在的旧路径。** 已暂存和未暂存里都有它，一个文件的重命名统计成 2 个文件、加 2 行。
- **从 git hook 启动 Plume，不再读到另一个仓库。** 从 hook、或者带着 `GIT_DIR` 的终端启动时，按 origin 找检出、批量读文件内容都落到别的仓库去了。
- **在一个会话里打的字，不会再出现在另一个会话。** 没发出去的草稿被写在另一处，切换会话时另一个会话的屏幕上闪了一下这段字。
- **丢弃未跟踪文件夹的确认框，标题里的名字是空的。** 问的是要不要丢弃「」。像 `.claude/` 这样带结尾斜杠的路径，按 `/` 切完最后一段是空的。

</details>

## [0.9.47](https://github.com/wJiaaa/Plume/releases/tag/v0.9.47) - 2026-10-22

<!-- plume:notes en -->

### Fixes

- **The 0.9.46 download for Apple Silicon Macs did nothing when opened.** No window and no error appeared, and opening it again did nothing either, because the first copy was still running in the background. The package had been corrupted during the build: one file was edited while the archive was being written, and every file after it was read 210 bytes off. This version is built cleanly. If you installed 0.9.46 on an Apple Silicon Mac, the app can't update itself, so download this version and install it over the old one. Intel Macs and Windows were not affected.
- **Links to folders in a reply now open the folder.** Models often link to where they saved something, such as the `source-images/` folder. Clicking it used to say the path couldn't be read, even though the folder was there. It now opens in Finder or Explorer. The same applies to folder paths clicked in the terminal. A link ending in `/` shows a folder icon.
- **A file name on its own in a reply now opens in projects that are not git repositories.** In such a project, a reply mentioning `ink_splat_06.png` opened `<project root>/ink_splat_06.png` and said it couldn't be read, because the file was looked up only through git. Plume now searches the project folder itself and skips dependencies, build output and hidden folders. A 20,000-file Unity project takes about 35ms.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 修复

- **0.9.46 的 Apple Silicon 安装包打开没有反应。** 不出窗口也不报错，再点一次还是没反应——第一次打开的那个一直挂在后台。这个包在打包时被弄坏了：写归档的同时有一个文件被改了，后面所有文件读出来都错开 210 个字节。这一版是干净重打的。在 Apple Silicon 的 Mac 上装了 0.9.46 的，应用没法自己更新，需要手动下载这一版覆盖安装。Intel Mac 和 Windows 不受影响。
- **回复里链到文件夹，点开就是那个文件夹。** 模型常把保存位置写成指向 `素材原图/` 这类文件夹的链接，以前点开弹「读不到 …/素材原图」，而文件夹明明就在那里。现在交给访达或资源管理器打开，终端里点到文件夹路径也一样。以 `/` 结尾的链接显示文件夹图标。
- **不是 git 仓库的项目里，回复只写文件名也能点开。** 这类项目里回复写 `ink_splat_06.png`，点开会拼成「项目根/ink_splat_06.png」然后读不到，因为找文件只问 git。现在改为自己在项目目录里找，跳过依赖、构建产物和隐藏目录，两万个文件的 Unity 工程找一遍约 35ms。

</details>

## [0.9.46](https://github.com/wJiaaa/Plume/releases/tag/v0.9.46) - 2026-10-21

<!-- plume:notes en -->

### New

- **The chat background has separate switches for new chats and ongoing chats.** Until now there was one switch, so you couldn't keep the image on the new chat page and have a plain transcript once the conversation starts, or the other way round. Appearance settings now has Show on new chats and Show in ongoing chats. If you had turned the background off, both stay off after the update. With only the ongoing chat switch on, the preview shows the faded version you will actually see.
- **A file that is still being written shows its path and how far it has got.** Generating a few hundred lines can take a dozen seconds, and until now that time showed only a shimmering "Created files", so you couldn't tell progress from a stall. The row now shows the path and the line it has reached, and so does the collapsed process row above it.

### Changes

- **A finished process row counts what it did again.** It reads "Thought 4 times · Read files ×4, Ran commands ×2" with a stack icon, instead of quoting the first two command descriptions followed by "39 total". While the work is running, the row still shows the description of the current command.

### Fixes

- **A command queued behind a long file write no longer looks stuck.** Tools run only after the whole reply is written, so a command could wait ten seconds or more. During that wait its title fell back to "Ran commands", a timer counted from the moment the row appeared, and the output area said it was waiting. A command that took 32ms could look like it had hung for 12 seconds. A queued command now shows its own description and has no timer, and it can be expanded only once it starts.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 新功能

- **会话背景图在新对话和对话中分开开关。** 原来只有一个开关，没法只在新对话页留着图、进了会话就干净，反过来也不行。外观设置里换成了「新对话里显示」和「对话中显示」两项。之前关掉过背景图的，升级后两项都是关的。只开「对话中显示」时，预览按压淡后的样子画，和实际看到的一致。
- **正在写的文件显示路径和已写行数。** 几百行的文件要生成十几秒，这段时间以前只有「创建文件」几个字在扫光，看不出是在往前走还是卡住了。现在这一行带上路径，行尾写「已写 N 行」，收起的那一行过程上也这样显示。

### 变化

- **跑完收起的一行过程重新按数量说。** 写成「思考 4 次 · 读取文件 4 个、执行命令 2 个」，行首是叠层图标，不再写前两条命令的说明再接「等 39 项」。还在跑的时候，这一行照旧显示当前那条命令的说明。

### 修复

- **排在长文件后面的命令不再像是卡住了。** 工具要等整条回复写完才执行，一条命令可能要排十几秒。这段时间里标题退回「执行命令」，秒数从这一行出现时就开始数，展开还写着在等输出，实际只跑了 32ms 的命令看上去像卡了 12 秒。现在排队的命令直接显示自己的说明、不计时，开跑之后才能展开。

</details>

## [0.9.45](https://github.com/wJiaaa/Plume/releases/tag/v0.9.45) - 2026-10-21

<!-- plume:notes en -->

### New

- **Usage shows when requests happened and how fast each provider and model responded.** Filter by date, provider or model, search the results, and export the selection as CSV. The charts can show tokens, cost, requests or output speed, with cache hit rate and time to first token alongside the totals. Today is shown by hour; longer ranges are shown by day. Small costs stay distinguishable on the chart, and the CSV keeps a count of requests whose price is unknown.
- **Two new rings show what uses the tokens and where the time goes.** Token breakdown separates system instructions, tool definitions, conversation history and other context, estimating their shares of the billed input. Time breakdown separates waiting for the first token, thinking, writing the reply and running tools.
- **Chat backgrounds stay visible after the first message.** A layer of the page colour covers half the image once the conversation has messages, keeping the text readable. Appearance settings now has a Show background image switch; turning it off keeps your image, effect and intensity settings for later.

### Changes

- **Tool calls between two passages of text collapse into one process row.** Browser actions, skills, commands and file changes no longer split into separate rows just because their kinds differ. Subagent dispatches keep their own rows. Background command results join the process, with failures marked there; replies from subagents and other sessions still appear separately.
- **Opening a page no longer adds a browser card to the transcript.** The page still opens in the browser sidebar, and links in a reply can still be opened in the built-in browser. Links to that session's local previews can reopen them there too.

### Fixes

- **Returning to a session that is still writing shows the text produced while you were away straight away.** It no longer pauses on the old text and then catches up in a burst; newly arriving text keeps streaming at its usual pace.
- **Messages between sessions are easier to follow.** Notify, ask and wait actions now say what they did and name the other session, rather than showing a bare tool name. Reports delivered together also have space between them instead of touching.

### Known limitation

- Forks created in 0.9.44 or earlier did not record where inherited history ends. Their activity rings, turn and tool counts, and durations may include that history again. Cost totals and request counts remain deduplicated. New forks record the boundary; the missing boundary in old forks cannot be reconstructed reliably.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 新功能

- **用量页能看什么时候发了请求、哪个供应商和模型回得快。** 可以按时间、供应商、模型筛选，搜索后把选中的范围导出成 CSV。柱状图可以切换 Token、费用、请求数和输出速度，汇总栏也能看缓存命中率和首字时间。今天按小时看，更长的区间按天看。小额费用在图上也能分清，CSV 会保留查不到价格的请求数。
- **两张环图分别看 Token 花在哪、时间花在哪。** Token 构成把系统指令、工具定义、对话历史等内容分开，估算它们各占实际计费输入的多少。耗时构成分成等首字、思考、写回复和跑工具。
- **会话背景图发出第一条消息后也留着。** 有消息时在图上盖一层 50% 的页面底色，让正文读得清。外观设置里多了「显示背景图」开关，关掉后图、效果和浓度都保留，以后可以再打开。

### 变化

- **两段话之间的工具调用收成一行过程。** 操作网页、调用技能、跑命令、改文件，不再因为类别不同就各起一行，派发子智能体仍单独显示。后台命令的结果合进过程，失败也在那里标出来，子智能体回复和其他会话的来信照旧单独显示。
- **打开网页不再往对话里加浏览器卡片。** 页面照旧在浏览器侧栏展开，回复里的链接也仍能用内置浏览器打开，同一会话的本地预览链接也能从这里重开。

### 修复

- **切回仍在写的会话，离开期间写下的字直接显示。** 不再先停在旧内容上，再一下子追上来，之后新到的字照常逐步显示。
- **会话之间的传话更容易看懂。** 通知、询问、等待会写清做了什么、对哪个会话做，不再只露出工具名。同一批送达的几份报告也留出了间距，不再贴在一起。

### 已知限制

- 0.9.44 及更早版本创建的分叉没有记录继承历史的截止位置，活动环图、轮次、工具次数和耗时可能把这段历史重复算入。费用总账和请求数不重复计入。新版分叉会保存标记，旧分叉缺失的边界无法可靠恢复。

</details>

## [0.9.44](https://github.com/wJiaaa/Plume/releases/tag/v0.9.44) - 2026-10-20

<!-- plume:notes en -->

### New

- **An approved plan can be carried out in a new session.** The plan approval card has a new option, Run in a new session. The plan is saved to a file, a new session under the same project starts on it, and the session where the plan was discussed stops there and stays around to answer questions from the new one. Earlier drafts, review comments and the code read while checking them no longer follow the work into implementation. In one real session, 60 of 124 messages were three rounds of plan review, all in the session that was about to implement it.
- **A built-in plan-review subagent checks a plan against the code before it is carried out.** It sees only the plan, not the discussion that produced it, and reads the code to check that paths, APIs and versions are right, that nothing the goal needs is missing, that the steps can be done in order, and that the verification would really show the goal was met. Each blocker comes with evidence and the smallest change that fixes it. On a second pass it checks the earlier blockers first. Like review, it is worth giving a different model in Settings › Subagents: a model reviewing its own plan mostly agrees with it.
- **Sessions that talk to each other no longer get their replies mixed up.** When two sessions asked a third one something at about the same time, both could get back the same reply, half of it answering the other. Now each request gets its own run and its own answer. Sessions can ask and wait for the answer (several at once), tell another session something without making it start a run (it reads the note before its next step, or at the start of its next turn if it is idle), or wait for a session to finish what it is doing.

### Fixes

- **The tooltip on a task sent from a side chat stays inside the window.** A side chat often hands the main conversation a plan dozens of lines long, and the tooltip grew past the bottom of the window, pushing the status line ("The main conversation is busy") out of sight. It now shows the first six lines, at most 160 characters, with the status line underneath. The full text is still in both transcripts.
- **Only the model list scrolls in Models settings.** With many models, the whole right column used to scroll, and a few rows down Base URL and API Key were gone from view. The list now scrolls inside its own card.
- **Editing a subagent shows its scope as text instead of a dropdown that does nothing.** An existing subagent's scope cannot be changed, and the disabled dropdown looked exactly like a working one. It now shows the current scope with "Duplicate it to change scope". New and duplicated subagents still get the dropdown.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 新功能

- **批准的计划可以交给新会话去实施。** 计划审批卡多了一项「在新会话里执行」：计划存成文件，同一个项目下开一个新会话照着做，讨论计划的这个会话停在这里，留着回答那边的提问。旧版计划、打回意见、为核实而读的代码，不再跟着一路带进实施。一个真实会话里，124 条消息有 60 条是三轮计划审核，而它正是接下来要去实施的那个会话。
- **内置子智能体 plan-review，计划在动手前先对着代码核一遍。** 它只拿到计划，看不到讨论计划的那段对话；读代码核实路径、接口、版本对不对，目标需要的有没有漏，步骤能不能照顺序做，验收能不能真的证明做成了。每个阻塞项都带着证据和最小的修改办法；复审时先逐条看上一轮的阻塞项解决了没有。和 review 一样，值得在「设置 › 智能体」里给它换个模型：同一个模型审自己写的计划，多半是同意。
- **会话之间互相传话，回答不再串。** 两个会话差不多同时问第三个会话，原来两边可能拿回同一段话，一半在回答另一边。现在每个请求各跑一轮、各拿各的回答。会话之间可以问了就等回答（可以同时问几个），可以只告诉对方一件事、不让它为此专门跑一轮（对方在下一步之前读到，闲着就在下一轮开头读到），也可以等对方把手上的事做完。

### 修复

- **侧边聊天派出去的任务，悬停提示不再长出窗口。** 侧边聊天交给主会话的常是几十行的计划，提示气泡一路长出窗口底部，最后那行状态（「主会话执行中」）被挤得看不见。现在只显示前六行、最多 160 字，状态行留在下面。完整内容在两边的对话记录里都有。
- **模型设置里只滚模型列表。** 模型一多，原来整个右栏一起滚，往下翻几行 Base URL 和 API Key 就看不见了。现在列表在自己的卡片里滚。
- **编辑智能体时，生效范围直接写成文字，不再是点了没反应的下拉框。** 已有智能体的范围本来就不能改，禁用的下拉框看上去和能用的一模一样。现在显示当前范围，旁边写着「要换范围请复制一份」；新建和复制时仍是下拉框。

</details>

## [0.9.43](https://github.com/wJiaaa/Plume/releases/tag/v0.9.43) - 2026-10-20

<!-- plume:notes en -->

### New

- **You can fork from a reply, not only from a question.** Under a finished reply, click Fork from here next to the other message actions. The new conversation keeps that reply and everything before it, with an empty message box, so you can take it in another direction. The fork button in the Trace panel is gone: most entries there were not a point you could carry on from, and forking at a tool call left the model with calls that never got a result.

### Changes

- **Replies stream in steadily even when the provider sends them in bursts.** Some providers deliver text in spurts — DeepSeek through a relay pauses for 200–400 ms about every half second — and the reply used to stop, dump a whole sentence, and stop again. Text is now spread out over time at the provider's recent speed, holding back at most 700 ms. English is shown a word at a time, so you never see half a word.
- **The conversation scrolls smoothly as a reply reaches the bottom.** It used to jump one line, stop, then jump again. Measured in a real window, the share of frames where nothing moved during output dropped from 41–47% to 4–14%, and the largest jump in one frame went from up to 107 px to about 20 px.
- **The agent goes ahead with changes that can be undone.** When you ask it to change something, it no longer stops to ask before reversible steps. When you only describe a problem or ask a question, it tells you what it found and does not fix anything on its own. On long tasks it now says what it has learned about once a minute, and the final answer says what changed, how it was checked and what risk is left.
- **Turning Plan mode on or off partway through a conversation no longer throws away the prompt cache.** The tool list sent with each request used to gain or lose one tool when Plan mode changed, and the whole cached prefix had to be written again. It now stays the same either way.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 新功能

- **回复上也能分叉了，不只是提问。** 在说完了的回复底下那排操作里，点「从这里分叉」。新对话带着这条回复和之前的全部内容，输入框是空的，可以从这里换个方向接着聊。轨迹面板里的分叉按钮撤掉了：那里的大多数条目不是能接着说下去的位置，在某次工具调用上分叉，模型拿到的是一串没有结果的调用。

### 变化

- **服务商一阵一阵地给字，回复也连成一条地出。** 有的服务商出字是一阵一阵的，DeepSeek 走中转时大约每半秒停 200–400ms，原来屏幕跟着停住、整句蹦出来、再停住。现在按上游最近的速度把字铺开，最多落后 700ms。英文按词出，不会出现半个词。
- **回复写到窗口底部时，对话连续地往上移。** 原来是移一行、停一下、再移一行。真窗口里量：输出过程中画面原地不动的帧从 41–47% 降到 4–14%，单帧最大位移从最多 107px 降到 20px 上下。
- **能撤回的改动，agent 直接做，不再停下来问。** 你让它改东西时，可逆的步骤不再逐一确认；你只是描述问题或提问时，它交代发现，不自己动手修。长时间干活时大约每分钟说一句学到了什么，最后的回答会讲清楚改了什么、怎么验的、还剩什么风险。
- **对话中途开关计划模式，不再让提示词缓存整段作废。** 原来切换计划模式时，每次请求带的工具表会多一个或少一个工具，前面缓存过的整段都要重写。现在开关前后工具表一样。

</details>

## [0.9.42](https://github.com/wJiaaa/Plume/releases/tag/v0.9.42) - 2026-10-19

<!-- plume:notes en -->

### New

- **Any source folder can become the project's main folder.** In Edit project, hover a folder and click Make main. New conversations then run in that folder and git reads it; conversations you already have stay in the folder they started in, and the old main folder stays in the list. An empty new conversation that is open at the time moves over with it. The main folder can also be taken out of the project now, as long as one folder is left.

### Changes

- **The model speaks between tool calls only when it has something to tell you.** Since 0.9.40 it said a sentence before every batch of calls, and most of them were announcements like "First I'll check the source state and the released versions to determine the version number". Now it speaks when it finds something that matters (a version, a failure, a cause, something missing or unexpected), makes a decision, or sees a risk, and it leads with the finding. On the same architecture question in a real repository (deepseek-v4.1-flash, two runs each), 15 notes that were almost all announcements became 12 notes, 10 of them with a concrete finding.
- **A finished run of commands says what the commands did.** The collapsed line used to read "Ran commands ×5". It now shows the first two commands' own descriptions and the total, for example "List the project root, Read the README, 5 total". Reads and edits work the same way; browser actions still show counts, since "Opened todo.html, Clicked ×2" already says enough.
- **Long answers open with the answer.** What you asked for — the design, the cause, the decision — comes first, in something you can take in from one screen. Detail you did not ask about waits for a follow-up question.

### Fixes

- **The text at the top of the Retries settings uses the full width.** It wrapped at about 62 characters while the card under it ran across the whole page.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 新功能

- **项目里任一源文件夹都可以设为主文件夹。** 在「编辑项目」里把鼠标移到某个文件夹上，点「设为主文件夹」。之后新对话在这个文件夹里跑，git 也读这里；已有的对话留在原来的文件夹，原来的主文件夹也还在列表里。当时开着的空白新对话会跟着换过去。主文件夹现在也能移出项目，只要还剩一个文件夹。

### 变化

- **模型在调用工具的间隙，只在有话可说时才开口。** 0.9.40 起，它每批调用前都要说一句，说出来的多是「我先查看当前源码状态和线上已有版本，以确定新版本号」这种预告。现在只在有发现（版本号、失败、原因、缺了什么或出乎意料的地方）、做了决定、或看到风险时才说，而且先说发现本身。在一个真实仓库上问同一个架构问题对照（deepseek-v4.1-flash，前后各两次）：原来 15 句几乎全是预告，现在 12 句，其中 10 句带具体发现。
- **跑完的一段命令，折叠的那一行写出它们各自在做什么。** 原来写的是「执行命令 5 个」，现在是前两条命令自己的说明再加总数，比如「列出项目根目录、读项目说明 等 5 项」。读文件、改文件也一样；浏览器操作照旧报次数，「打开网页 todo.html、操作网页 2 次」本来就说清楚了。
- **长回答先给答案。** 你要的那件事——方案、原因、结论——放在最前面，一屏之内能看完。没问到的细节，等你追问再展开。

### 修复

- **「请求重试」设置顶部那段说明不再缩成窄窄一栏。** 原来它大约 62 个字符就折行，下面的卡片却占满整页宽。

</details>

## [0.9.41](https://github.com/wJiaaa/Plume/releases/tag/v0.9.41) - 2026-10-19

<!-- plume:notes en -->

### New

- **New conversations can have a background image.** Pick one in Settings → Appearance → Chat background. It only shows in a conversation that has no messages yet, and goes away as soon as there is something to read. Besides the original image there are five effects: Dither, ASCII, Halftone, Scanlines and Haze, and the strength can be turned down. The image is copied to `~/.plume/backgrounds` and stays on this computer.

### Changes

- **Next-step suggestions no longer cost an extra request.** The grey text in the message box used to come from a second request after every turn, which only saw one instruction and mostly guessed "continue" or "commit this". The model now writes the suggestion at the end of its own reply, where it knows what it just did. The line itself is never shown in the reply or copied with it. The setting is still off by default (Settings → General → Next-step suggestions), and side chats don't get suggestions.
- **Images saved on this computer show up in the reply.** When the model puts an image it just saved into its reply, such as a QR code or a screenshot, you now see the picture instead of a link. A path relative to the project works too, and anything that can't be read stays a link. Images taller than two lines of text get a line of their own, and while the path is still being written a placeholder holds the space, so nothing jumps when the image lands.
- **Read-only batches of tool calls get their sentence too.** Since 0.9.40 the model says what each batch of tool calls is for, but it often skipped batches that only read files, listed folders or searched. Those count now. On the same task, the longest run of calls with no word in between went from 84 (deepseek-v4.1-flash) and 42 (gpt-6.1-sol) down to 9.

### Fixes

- **⌘Q quits Plume completely after the window was closed.** On macOS, closing the window with the red button and then quitting left Plume running with no windows: the dot under the Dock icon stayed, and the only way out was Force Quit. This happened when no conversation had been used since launch.
- **The running indicator stays visible while the model announces its next step.** With models that narrate before calling tools (the Responses API, e.g. gpt-6.1-sol), the bottom of the conversation went blank for about three seconds after each announcement, as if the turn had stopped.
- **A conversation that opens with a question gets a proper title.** For a first message like "what does finding new keywords for a global site even mean?", the title model sometimes answered the question, and the sidebar showed the first 30 characters of the answer, cut mid-sentence. In 90 tries per model this went from 2 to 0.
- **An image overwritten at the same path shows the new version.** Writing a second QR code to the same `feishu-auth-qr.png` used to keep showing the first one, in the reply and in the file panel.
- **Links that try to open an app no longer leave the built-in browser on a blank page.** When a site redirects to an address like `lark://`, the tab now says what it tried to open and offers to hand the page to your system browser, which asks before launching the app. The agent's `browser_open` gets the same explanation.
- **Previews come back after switching conversations.** Pages that size themselves to the window, three.js scenes in particular, stayed blank when you returned to a conversation and needed a manual rerun. They now reload on their own at the same height, and state saved with `plume.setState` is restored.
- **Opening a conversation for the first time no longer flashes an empty page.** For one frame the pane showed a spinner and the message box at the bottom before the messages appeared. Plume now waits up to 120 ms for the conversation to load before switching; a larger one that takes longer still shows the spinner.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 新功能

- **新对话可以铺一张背景图。** 在 设置 → 外观 → 会话背景 里选图。只在还没有消息的新对话里出现，有了内容就撤掉。除了原图还有抖动、ASCII、网点、扫描线、雾化五种效果，浓度可以调低。图会复制到 `~/.plume/backgrounds`，只存在这台电脑上。

### 变化

- **下一步建议不再多花一次请求。** 输入框里的灰字，原来是每轮结束后另发一次请求去猜，那次请求只看得到一条指令，猜出来的多半是「继续」「提交一下」。现在由回复的模型在回复末尾顺带写出，它知道自己刚做了什么。这一行不会出现在回复里，复制时也不带。设置默认还是关的（设置 → 常规 → 下一步建议），侧边聊天里不给建议。
- **存在本机的图片直接显示在回复里。** 模型在回复里放上刚存到本机的图片，比如二维码、截图，现在看到的是图，不再是一条链接。相对项目的路径也行，读不到的照旧是链接。高过两行字的图单独占一行；路径还在往外写的时候先放一块占位，图出来时不跳。
- **只读的那几批工具调用，前面也会说一句。** 0.9.40 起模型每批调用前会先说这批要做什么，但读文件、列目录、搜索这种只读的批次经常被跳过。现在也算。同一个任务对照：中间一句话都没有、连着跑的调用，最长从 84 个（deepseek-v4.1-flash）、42 个（gpt-6.1-sol）降到 9 个。

### 修复

- **点过红色关闭按钮后，⌘Q 能把 Plume 退干净了。** 在 macOS 上先关窗再退出，Plume 会留在后台：窗口都没了，Dock 图标下面的小点还亮着，只能强制退出。启动后还没用过任何对话时必现。
- **模型播报下一步时，运行指示不再消失。** 调工具前会先说一句的模型（走 Responses 接口的，比如 gpt-6.1-sol），每说完一句，对话底部就空出三秒左右，看着像这一轮已经停了。
- **用提问开场的对话，标题不再是半句回答。** 首条消息是「做出海网站 找新词 这种事什么意思啊？」这类问句时，起标题的模型偶尔会去回答它，侧栏里就留下答案的前 30 个字，断在半句。每个模型各试 90 次，从 2 次降到 0 次。
- **同一路径的图片被覆盖后，显示的是新图。** 第二次把二维码写进同一个 `feishu-auth-qr.png`，回复里和文件面板里看到的都还是第一张。
- **网页要唤起客户端时，内置浏览器不再停在白页上。** 网站把标签页跳到 `lark://` 这类地址时，页面上会说明它想打开什么，并可以把这一页交给系统浏览器，由系统浏览器问你要不要启动客户端。agent 的 `browser_open` 也会收到同样的说明。
- **切走再切回对话，预览不再是空白。** 按窗口大小排版的页面，尤其是 three.js 场景，切回来时一片空白，要手动点重新运行。现在会自动重新加载，卡片高度不变，用 `plume.setState` 存下的状态也会交还。
- **第一次打开某个对话时，不再先闪一下空页面。** 消息出来之前，窗格会先画一帧加载圈、输入框落在底部。现在最多先等 120ms，读到了再换过去；更大的对话读得更久，照旧先显示加载圈。

</details>

## [0.9.40](https://github.com/wJiaaa/Plume/releases/tag/v0.9.40) - 2026-10-19

<!-- plume:notes en -->

### Changes

- **Read-only shell commands no longer wait for approval.** `cd src && grep -rn foo | head`, `git status | head` and `sed -n '1,80p' a.ts` used to count as writes because of the pipe, the `&&` or the `sed`, so each one asked first and they ran one at a time. Now a command passes if every part of it is on the read-only list, and several can run at once. Redirects, `$`, heredocs and background jobs still ask. On 536 real commands from this machine, read-only went from 3 to 188, and none went the other way.
- **Plan mode only blocks editing files.** Before, any command with a pipe, `&&` or `cd`, and any CLI it didn't recognise, was refused outright. Shell commands in plan mode now run in a read-only sandbox instead: writes (other than to `/dev/null`) fail, and if the machine has no sandbox the command doesn't run at all. MCP tools, the browser and network access work as usual, which also means plan mode no longer stops those from reaching outside.
- **Tool rows say what was touched.** Reading a file or listing a folder shows the path relative to the project, so `apps/web/src/main.tsx` and `apps/cli/src/main.ts` no longer both read as "main". A partial read adds the line range, e.g. `:10-29`. Checking a background task's output names the task, and repeated checks on the same task collapse into one row ("Read output of “Run the test suite” 3 times").
- **The model says what each batch of tool calls is for.** It used to say one sentence and then work silently for a dozen replies, which showed up as a single row of 80 calls. Each batch now starts with a sentence, so the work splits into readable steps.
- **Long-running commands are checked less often.** A test or install that keeps printing used to be checked every few seconds, each time a full model request. Output is now held for up to 30 seconds unless the command finishes first; the first check still answers immediately, so a dev server's "ready" line isn't delayed.
- **File search results are shorter, and a wrong path gets suggestions.** Search results group files under their folder instead of repeating the full path on every line (replaying 11 real searches, 57% fewer characters). When a file isn't found, the error lists up to 5 files in the repository with the same name.

### Fixes

- **A subagent's result no longer produces a second full answer.** If the model thought a subagent was gone, it wrote its own long answer, then rewrote the whole thing when the result arrived. Now it says what it's waiting for and stops; when the result comes, it only says what changed.
- **With GPT models that narrate as they go (e.g. gpt-6.1-sol), each sentence appears once.** The final answer repeated the progress updates before it, and the repeat also reached subagent results and the CLI.
- **Pressing Stop while MCP servers are still connecting stops right away**, instead of waiting up to 5 seconds while the conversation kept showing as running.
- **Pressing Stop halfway through an answer no longer brings back a "Thinking…" line** as the status row closes.
- **Several subagents sent in a row show their faces at the end of the row again.** Since related calls were merged into one collapsed row, there was no way to see who was working without opening it.
- **In a narrow window, the Panels button in the title bar stays inside the window.** At the minimum width (380 px) it was drawn off-screen and couldn't be clicked. Shortcut buttons now fold away first; all of them are also in the Panels menu.
- **In an empty conversation, the top rows of the slash menu are no longer hidden under the pane's title bar**, and the menu scrolls again.
- **The usage trend chart no longer keeps growing after the window is narrowed and widened again.** It could reach over 10,000 px tall, and hovering stopped showing values.
- **In the sidebar, the row just below the pinned "Chats" heading no longer fades early.**
- **Corners are consistent at 8 px.** Text fields, dropdowns, panel tabs, settings cards and navigation, tool rows and the browser address bar had a mix of pill shapes, 6 px and 12 px. The prompt box in Scheduled tasks was the last one at 12 px.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 变化

- **只读的命令不再等审批。** `cd src && grep -rn foo | head`、`git status | head`、`sed -n '1,80p' a.ts` 这类命令，原来因为带了管道、`&&` 或者用了 `sed` 就被当成写操作：每条都要先点头，而且只能一条条排队跑。现在拆开来看，每一段都在只读表上就放行，也能同时跑几条。重定向、`$`、heredoc、后台任务照旧要问。拿本机 536 条真实命令对过：算只读的从 3 条到 188 条，没有一条反过来。
- **计划模式只拦改文件。** 原来命令里有管道、`&&`、`cd`，或者是它没见过的命令行工具，整条直接拒掉。现在计划模式里的命令一律放进只读沙箱跑：除了 `/dev/null`，写什么都失败；机器上没有沙箱就干脆不跑。MCP、浏览器、联网照常能用——也就是说，这几样往外写的事，计划模式不再替你拦。
- **工具行说清动的是哪个。** 读文件、列目录写相对项目的路径，`apps/web/src/main.tsx` 和 `apps/cli/src/main.ts` 不再都只显示 main；只读了一段的带上行号，比如 `:10-29`。查看后台任务的输出会写是哪个任务，连着查同一个任务的几次合成一行：「查看「运行测试」的输出 3 次」。
- **每一批工具调用前，模型先说这一批要干什么。** 原来它开头说一句，之后十几次回复一声不出，界面上就是一行塞着 80 个调用。现在每批都有一句，一段活能分成看得懂的几步。
- **长时间跑的命令，不再被几秒一问。** 测试、安装这种一直在打印的命令，原来每隔几秒就被查一次输出，每次都是一整轮模型请求。现在最多攒 30 秒再给，命令先结束就立刻给；第一次查照旧马上答，开发服务器起没起来那一行不会被耽搁。
- **文件搜索结果更短，路径写错了会给候选。** 搜索结果按目录分组，不再每行重复完整路径：拿 11 次真实搜索回放，字数少了 57%。读文件找不到时，会列出仓库里最多 5 个同名文件。

### 修复

- **子智能体的结果回来后，不再整份重写一遍回答。** 模型以为子智能体已经没了，就自己写了一份长回答收尾，结果送到后又整份重写。现在它会说在等什么然后停下；结果来了，只讲它改变了什么。
- **边做边播报的 GPT 模型（比如 gpt-6.1-sol），每句话只显示一次。** 原来最终答复会把前面的播报再说一遍，交给上级的子智能体结果和命令行输出也跟着重复。
- **MCP 服务器还在连接时按停止，当场停下。** 原来要再等最多 5 秒，这期间会话一直显示在运行。
- **回答写到一半按停止，底下不再冒出一行「Thinking…」。**
- **连着派出去的几个子智能体，行尾重新摆出它们的头像。** 相关调用合成一行之后，那一行默认收起，不点开就看不到谁在干活。
- **窄窗口里，标题栏的「面板」按钮不再被挤到窗口外面。** 最小宽度（380px）时它画在窗外，点不到。现在先把快捷按钮收起来，它们在「面板」菜单里都有。
- **空白对话里，斜杠菜单的头几行不再压在窗格标题栏底下**，列表也能滚了。
- **窗口改窄再改宽后，用量趋势图不再越长越高。** 最高能长到一万多像素，悬停读不到数。
- **侧栏里紧挨着钉住的「聊天」标题的那一行，不再提前淡掉一截。**
- **圆角统一成 8px。** 输入框、下拉、面板标签、设置页的卡片和导航、工具行、浏览器地址栏，原来胶囊、6px、12px 混着用。定时任务里的提示词框是最后一处 12px。

</details>

## [0.9.39](https://github.com/wJiaaa/Plume/releases/tag/v0.9.39) - 2026-10-18

<!-- plume:notes en -->

### Changes

- **DeepSeek is now a web search provider.** In Settings › Web search it sits beside Tavily, Exa and Brave. Pick it if you ask in Chinese: its own index returns far more relevant pages, and it understands `site:`, `lang:` and `after:` in the query. There is no free tier — about ¥5 per 1,000 searches, billed by DeepSeek. Each result also carries a 600–800 character summary instead of a one-line snippet, so the model has more to work with before it decides to open a page.

### Fixes

- **Sending a second message no longer shifts the whole conversation 24 px to the right.** The question rail on the left only appears once there are two questions, and the text column took its narrower padding in the same frame. The space is now reserved from the first message, except in side chats, which have no rail.
- **A finished answer no longer drops the conversation a line and then pushes it back up.** Three things moved on the last frame: the status line closed, the time-and-copy row under the answer was still opening, and the two differed by 2 px in height. A transcript scrolled to the bottom fell about 30 px and was shoved back. They now swap in the same frame at the same height, and the last reply's action row no longer animates in. Measured frame by frame in the app: 29 px before, 0 now.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 变化

- **网页搜索多了 DeepSeek。** 在「设置 › 网页搜索」里和 Tavily、Exa、Brave 并列。问中文问题选它：自家索引在中文上的结果对题得多，查询里也认识 `site:`、`lang:`、`after:`。没有免费额度，按次计费，每 1000 次 5 元。每条结果附的是 600～800 字的摘要，不是一两句话的片断，模型在决定点开网页之前能看到更多。

### 修复

- **发出第二条消息时，整段对话不再往右挪 24px。** 左侧的问题导航条要在有两个问题时才出现，正文的边距在同一帧跟着变窄。现在除了没有导航条的侧边对话，从第一条消息起就把位置留好。
- **一轮答完时，对话不再先往下掉一行、再被顶回来。** 收尾那一帧同时动了三处：底部那行状态收起了，回答底下带时间和复制的那一行还在长出来，两行高度还差 2px。贴着底部的对话先掉约 30px，再被顶回去。现在两行在同一帧、同样高度一换一，收尾那句的操作行也不再演进场。在应用里逐帧量过：改之前掉 29px，现在 0。

</details>

## [0.9.38](https://github.com/wJiaaa/Plume/releases/tag/v0.9.38) - 2026-10-17

<!-- plume:notes en -->

### Changes

- **A project is now a project, not just its folder.** One folder can belong to several projects, and two projects can have the same name. Each conversation remembers the project it was started in, instead of being sorted into one by its folder. Opening a folder no longer adds it to the sidebar as a project, and removing a conversation from a project leaves it in its folder.
  - **After updating, all your existing conversations show up under Chats.** They were never recorded as belonging to a project, and guessing from the folder is what caused the project bugs below. Move the ones you want back with Move to a project in the conversation's menu.
- **Hovering a project in the sidebar shows a card** with how many conversations it has and the full path of each of its folders. Paths wrap instead of being cut off, because two projects with the same name usually differ only in the last few folders.
- **A forked conversation now sits under the one it came from**, indented the same way as conversations started from a suggestion card. Forks made before this update stay at the top level.
- **Right-click a link in a reply** to open it in your default browser (the menu names it, e.g. "Open in Google Chrome"), open it in the built-in browser, or copy it. Left click works as before. On Linux the browser's name often isn't available, and the item reads "Open in system browser".

### Fixes

- **Adding an existing project as an extra folder no longer takes its conversations away.** They were moved under the new project, the old project's row went empty, and archiving or removing the new project archived them too.
- **New chat from a conversation in a worktree no longer drops the project.** The composer showed the folder's name, and the next conversation didn't belong to any project.
- **A scheduled task created while a worktree conversation was open no longer runs inside that worktree.** It ran every day in a copy checked out for another conversation, and broke once that copy was cleaned up. It now uses the main checkout.
- **On mobile, the conversation list, chat header and search show the project's current name.** They showed the folder name recorded when the conversation was created, so renamed projects kept their old name there.
- **Work without a project is no longer offered when you're already not in one.** Clicking it did nothing.
- **Toasts no longer stay on screen while new ones keep coming.** Every new notice, including ones that are never shown, restarted the timer of every card already on screen; one "Marked as unread" stayed for 10.4 seconds. A card now only restarts its timer when the same message is repeated.
- **Folding the right column no longer makes the top bar buttons jump 30 px left before sliding right.** Show side panel used to appear at full width in the first frame while the conversation was still narrow. Its space now grows with the panel, and shrinks the same way when you open it again. The panel's own New window and Full screen buttons no longer hop right before the panel starts moving either.
- **Menus with a search box or a footer no longer fade the list out right next to the separator line.** The line already marks the edge; the fade on top of it looked like two layers. This applies to the project, model, branch and worktree menus.
- **A paragraph that a subagent's result arrived right after now shows its time, duration and copy on hover.** Because the result was slipped into the same turn, the paragraph wasn't the turn's last, and hovering the space under it showed nothing. The duration is that paragraph's own; the turn's totals stay with the final answer.
- **The "From @agent" caption is spaced like a tool row wherever it appears.** Below a tool row it used to sit 10 px away while elsewhere it was 38 px, and a reply that stopped before writing a word added another 10 px of blank space above it.
- **Conversations going through Magpie now show a cost instead of "Unpriced".** Magpie hands Plume its models without prices, so every request was recorded as $0. Prices now come from the model catalog by model family, with gateway prefixes like `company/gpt-6-astra` stripped. Route group names and models not in the catalog stay unpriced. Prices are recorded at request time, so existing conversations aren't recalculated.
- **An empty project no longer gets 4–5 px taller when you expand it.**

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 变化

- **项目不再等于它的文件夹。** 一个文件夹可以放进好几个项目，两个项目也可以重名。会话记住自己是在哪个项目里开的，不再按文件夹去猜。打开一个文件夹，侧栏不再给它登记成项目；把会话从项目里移出来，它还留在原来的文件夹。
  - **升级以后，已有的会话全部出现在「聊天」下面。** 旧会话从来没记过自己属于哪个项目，而按文件夹猜正是下面那几个项目问题的根源。想放回项目的，在会话菜单里点「移动到项目」。
- **鼠标停在侧栏的项目上，会出一张卡**，写着有几个聊天、每个文件夹的完整路径。路径折行，不截断：两个同名项目通常就差在末尾那几级。
- **分叉出来的会话挂在原会话下面**，缩进的样子和从建议卡开出来的会话一样。这次更新之前分叉的会话仍在顶层。
- **回复里的链接可以右键了**：在默认浏览器中打开（菜单里写出浏览器的名字，比如「在 Google Chrome 中打开」）、在内置浏览器打开、复制链接。左键照旧。Linux 上常常拿不到浏览器名字，这时写「在系统浏览器中打开」。

### 修复

- **把已有项目加成附加文件夹，它的会话不再被划走。** 原来它的会话全被归到新项目下，旧项目那一行变空；归档或移除新项目，还会把它们一起归档。
- **在工作树会话里点「新对话」，不再丢掉项目。** 输入框上写的是文件夹名，接下来开的会话不属于任何项目。
- **开着工作树会话去新建定时任务，任务不再跑在那棵工作树里。** 它每天跑进为另一场对话检出的副本，副本一清理就跑不起来。现在用主检出。
- **手机上的会话列表、聊天页头和搜索，显示的是项目现在的名字。** 原来读的是建会话时记下的文件夹名，项目改过名，手机上还是旧名字。
- **已经不在项目里时，项目菜单不再给「不在项目中工作」。** 点了也是原地不动。
- **提示卡片不再因为后面接连来消息而迟迟不走。** 每来一条新通知（哪怕是不显示的），屏幕上所有卡片都重新计时，一张「已标记为未读」挂了 10.4 秒。现在只有同一句话再说一遍，那张卡才续期。
- **收起右栏时，顶栏那几颗按钮不再先往左跳 30px 再往右滑。** 收起的第一帧，「展开右侧面板」就整颗挂了上去，而对话那一格还窄着。现在它占的宽度跟着面板一点点长出来，展开时同样一点点缩回去。面板标题栏里的「新窗口」「全屏」也不再在面板还没动时先往右跳一格。
- **带搜索框或页脚的菜单，列表不再紧挨着分隔线渐隐。** 分隔线已经画出了边界，再叠一层渐隐，看着像两层。项目、模型、分支、工作树菜单都一样。
- **子 Agent 结果紧跟着插进来的那段话，悬停能看到时间、耗时和复制了。** 结果插进了同一轮，这段话就不算这一轮的最后一句，悬停它底下那块空白什么也没有。耗时是这段话自己的，整轮的统计还在最后那句回答底下。
- **「消息来自 @谁」这一行，不管出现在哪，间距都和工具行一样。** 原来在工具行下面只隔 10px，别处是 38px；一条一个字没写就停了的回复，还会在它上面多空出 10px。
- **走 Magpie 的会话现在显示花费，不再是「未定价」。** Magpie 交过来的模型不带价格，每次请求都按 0 美元记。现在按型号家族从模型目录取价，`company/gpt-6-astra` 这类网关前缀会先去掉。路由组名和目录里没有的型号照旧不定价。价格在请求当时记下，已有的会话不会回头重算。
- **没有会话的项目，展开时不再比收起高出 4–5px。**

</details>

## [0.9.37](https://github.com/wJiaaa/Plume/releases/tag/v0.9.37) - 2026-10-16

<!-- plume:notes en -->

### Fixes

- **Sending a message no longer freezes the window for a moment.** As a turn started, six or seven updates arrived within a few dozen milliseconds and each one redrew the whole window. In a 1,031-message conversation one frame took 100 ms, right as your bubble appeared. Updates are now applied once per frame and the sidebar only redraws the row that changed. The longest frame is now 17–33 ms.
- **Saying "wait" mid-task no longer costs two extra requests.** If you stopped a turn and the model replied with one short line, Plume still asked it whether the task list was finished, then treated its empty answer as a glitch and pushed it again. Each of those resent the whole conversation, about 180k tokens. That follow-up question now only comes when the model actually did something, and an empty answer to it ends the turn.
- **Messages from other conversations no longer wait until a long task is over.** A queued message used to sit until the receiving conversation finished its turn. In one real case that was 12 minutes, and the message was a warning that the sender was about to edit the same files. The model is now told that queued messages can take many minutes and when to interrupt instead. Several queued messages that arrive back to back are read together in one turn instead of one turn each.
- **After switching back to a conversation, the running row no longer vanishes for 2.5 seconds.** It happened when you switched away while the model was thinking between two pieces of text. And if the window had been reloaded, the row showed no elapsed time, only a stray dot ("Thinking… · ·"). It now shows the same time as the summary under the reply. Tokens used by subagents can't be counted in that case.
- **The time, duration and tok/s line no longer appears in the middle of a turn that's still running.** When the model kept working after an automatic reminder about its task list, the line was drawn under the earlier answer. In English it also happened after "(auto-continue)", because the check compared against the translated text. It now goes under the last answer, once the turn is over.
- **A "Writing…" line no longer pops up under the first words of an answer and slides away.** It now disappears the moment text arrives, without the 150 ms fade, and the conversation doesn't move.
- **In a turn that generates an image, the time and duration now come after the image.** The image used to be drawn last, below the turn's summary line. It now sits right after the call that made it.
- **Switching back to a conversation with subagents running no longer flips the side panel to Subagents.** Reading the list back from disk counted as new subagents starting, so whatever page you had open was replaced, and the bar above the composer collapsed and grew back. It now stays put, and its entrance animation only plays once.
- **A side chat no longer leaves a "New chat" in Notifications that you can't clear.** It had no project and no time, and clicking it led to "conversation not found". A finished side chat no longer leaves a notification; its answer is already in the panel beside you.
- **A background task with no output no longer opens to a blank terminal.** Commands like `go test … > run.log 2>&1` write their output to a file, so the task's own log is empty and it looked as if the reason for "exit code 1" had been lost. It now says "No output", and when the command redirected it, names the file it went to.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 修复

- **发消息那一下，窗口不再卡顿。** 一轮开始时，几十毫秒里会连着来六七条更新，每条都把整个窗口重画一遍。在 1031 条消息的会话里，有一帧要 100ms，正好卡在气泡出现的时候。现在更新按帧合并，侧栏只重画变了的那一行，最长一帧降到 17–33ms。
- **中途喊「等一下」，不再多花两次请求。** 打断之后模型只回了一句，Plume 还会追问它清单做完没有，再把它的空回复当成抽风，催它接着答。每次都要把整段对话重发一遍，一次约 18 万 token。现在只有模型真的干了活才追问清单，对追问一个字没回就直接结束。
- **别的会话发来的消息，不再压到长任务做完才读到。** 排队的消息要等收件的会话跑完这一轮。一次实际情况里等了 12 分钟，而那条消息是在说「我要改你也在改的文件」，送到时已经没用了。现在模型知道排队可能要等很多分钟，也知道什么情况该直接插话。紧挨着排队的几条消息合成一轮读，不再一条开一轮。
- **切回会话后，运行行不再先消失 2.5 秒。** 模型在两段话之间思考时切走再切回，就会这样。窗口刷新过的话，运行行上没有耗时，只剩一个孤零零的点（「Thinking… · ·」）。现在它和回复底下那行统计用同一份时间。这种情况下子 Agent 用掉的 token 数不到。
- **一轮还没跑完，时间、耗时和 tok/s 那一行不再先贴到中间那段回答底下。** 模型收到关于清单的自动提示后接着干活，这一行就画在了前一段回答下面。英文界面下遇到「（自动继续）」也会这样，因为比对的是译文。现在等这一轮结束，落在最后一段回答下面。
- **回答一开始，字底下不再冒出一行「Writing…」又滑走。** 现在正文一来它当帧就隐去，不再淡出 150ms，对话也不跟着动。
- **生成图片那一轮，时间和耗时现在排在图后面。** 图原来画在最后，压在这一轮的统计行下面。现在紧跟着生成它的那次调用。
- **切回子 Agent 还在跑的会话，侧边面板不再被翻到「子 Agent」。** 从磁盘读回名单那一下被当成了新派出的子 Agent，你停着的那一页被换掉，输入框上方那一条也收起再长出来一遍。现在都停在原处，那一条的入场动画只播一次。
- **侧边聊天答完，通知里不再留下一条点不掉的「新对话」。** 那一条没有项目、没有时间，点进去是「会话不存在」。现在侧边聊天跑完不再留通知，回答就在旁边那一格里。
- **后台任务没有输出时，展开不再是一块空白终端。** `go test … > run.log 2>&1` 这类命令把输出写进了文件，任务自己的日志是空的，挂在「退出码 1」底下，像失败原因被吞了。现在直接写「没有输出」，命令里有重定向的，再说出写进了哪个文件。

</details>

## [0.9.36](https://github.com/wJiaaa/Plume/releases/tag/v0.9.36) - 2026-10-16

<!-- plume:notes en -->

### Changes

- **A few buttons that were a pixel or two off their neighbours now line up.** Apply next to the browser's viewport size was 24 px tall beside two 26 px boxes; it is 26 px now. Select all in Import providers and in each group when fetching models had their own sizes and weights, and now match the other small buttons. The month arrows in Settings › Storage gained tooltips.

### Fixes

- **Taking a screenshot on macOS no longer strips the shadows off every other window.** The moment a screenshot started, other apps' windows lost their shadow and their 1 px outline, and got them back when you pressed Esc. The frozen frame came from Electron's `desktopCapturer`, which leaves both out on macOS. On macOS 15.2 and later it is now captured the way the system's own screenshot is, in 16–19 ms. Older systems work as before.
- **Leaving a screenshot with Esc no longer makes the screen shake.** Three things happened at once: the dimming, selection and toolbar vanished in a single frame, the window underneath flicked between its inactive and active look, and the whole frozen frame jolted as the overlay closed. Esc now fades out the same way Cancel does, focus goes back to your window before the overlay leaves, and the overlay turns transparent before it is hidden.
- **Folding or opening the right column no longer turns the panel grey or opens a light gap beside the conversation.** With the translucent window background on, the panel faded as it slid and the lighter window showed through (#2b2b2b behind a #171717 card in dark mode). In long conversations the conversation also lagged behind the panel, leaving a gap of up to a hundred pixels. The panel now stays opaque all the way and nothing shows through.
- **Mermaid diagrams in dark mode no longer have a white glow around every box.** Mermaid 12 put a light grey shadow on nodes and groups, and groups and edge labels were filled with a grey meant for a #333 page, not our #171717. Boxes, groups, lines, text and labels now use the app's own colours with no gradients or shadows, and redraw when you change colours in Appearance.
- **Some controls that only looked like buttons now work with a keyboard and a screen reader.**
  - In Import providers, each row's checkbox was read out as just "button", without the provider's name or whether it was ticked, and showed no focus ring.
  - The ⓘ in Release and the warning icon shown when the marketplace can't be read were buttons that did nothing; what they meant was only in a hover tooltip. Screen readers now read the explanation, and the reason the marketplace failed.
  - In the task list's collapsed row, Pause sat inside the button that expands the row, so screen readers read the whole row as one name. They are now two separate buttons.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 变化

- **几颗和旁边差一两像素的按钮对齐了。** 内置浏览器视口尺寸旁的「应用」高 24px，左边两个输入框是 26px，现在也是 26px。「导入供应商」里的「全选」和拉取模型时每组的「全选」各有各的大小和字重，现在和其他小按钮一样。设置 › 存储里翻月份的箭头有了提示。

### 修复

- **macOS 上截图时，其他窗口的阴影不再全部消失。** 一开始截图，其他应用窗口的阴影和那圈 1px 描边就没了，按 Esc 退出又回来。原因是冻结画面用 Electron 的 `desktopCapturer` 拍，它在 macOS 上拍不到这两样。macOS 15.2 起改成和系统截图同一种方式取屏，耗时 16–19ms。更早的系统照旧。
- **截图时按 Esc 退出，屏幕不再抖一下。** 原来同时有三件事：压暗、选框和工具条在一帧之内消失；底下的窗口在失焦和激活两种样子之间闪一下；浮层关闭时整张冻结画面跟着动了一下。现在 Esc 和点「取消」走同一段淡出，焦点先还给你的窗口再收浮层，浮层先变透明再隐藏。
- **右栏收起、展开时，面板不再泛灰，和对话之间也不再闪出一条亮缝。** 开着毛玻璃时，面板边滑边淡，底下更亮的窗口透了出来（暗色下卡片是 #171717，窗口是 #2b2b2b）。对话一长，对话那一格还会跟不上面板，中间拉开上百像素。现在面板全程不透明，滑动时什么也透不出来。
- **暗色下的 mermaid 图，每个框外不再有一圈白光。** mermaid 12 给节点和分组加了浅灰阴影；分组和连线标签的底色又是按 #333 的页面算的，放在 #171717 的对话里是几块不相干的灰。现在框、分组、连线、文字、标签都用界面自己的颜色，不带渐变和阴影，在外观设置里改颜色，图也会跟着重画。
- **几处看着像按钮的控件，键盘和读屏现在能用了。**
  - 「导入供应商」每行的勾选框，读屏只念「按钮」，听不出是哪个供应商、勾没勾上，键盘移过去也没有焦点框。
  - 「发版中心」里的 ⓘ，和市场读取失败时的感叹号，都是按下去没反应的按钮，说明只在鼠标悬停时出现。现在读屏会念出说明，以及读取失败的原因。
  - 任务清单收起时那一行，「暂停」套在展开整行的按钮里，读屏把整行念成一个名字。现在是并排的两颗按钮。

</details>

## [0.9.35](https://github.com/wJiaaa/Plume/releases/tag/v0.9.35) - 2026-10-16

<!-- plume:notes en -->

### New

- **Notifications open in a panel, and you can tell at a glance which one needs you.** The bell used to open an ordinary 224 px menu: long conversation titles wrapped in the middle of a word, and every finished item said "Done" right next to a green tick that already said so. Each notification now starts with a coloured block for its state (waiting for approval, failed, done), followed by the title on one line and "project · time ago" under it. Only "Waiting for your approval" keeps its words, because a hand icon on its own doesn't tell you what to do.
- **Deleting a conversation tells you how many are nested under it.** Conversations started from a suggestion sit under the one that suggested them. The confirmation used to mention only the message count, and once you deleted, the nested ones quietly became standalone. It now says how many are nested and offers "Delete only this one" or "Delete all N". Archived ones count too, since only archived conversations can be deleted and their children are often archived as well.

### Changes

- **The "⚓ N" button under replies only appears when a hook didn't go through.** Every reply used to carry something like "⚓ 80", which only meant your hooks ran as usual. Now it appears only when a hook in that stretch blocked a tool call, failed or timed out, and opening it still lists every hook from that stretch. Subagent panels follow the same rule.
- **Settings › Plugins no longer has an Extensions tab.** Runtime extensions (third-party code under `.plume/extensions/`, run in a worker) were never documented, and the tab only ever said "No extensions". They have been removed. Skills, plugins, MCP servers and hooks are not affected.
- **After your first message from the welcome page, the composer rises into place instead of sliding down.** In 0.9.34 it travelled from where it sat on the welcome page to the bottom while widening. It now appears at the bottom at full width and rises 16 px as it fades in. With "Reduce motion" on it is simply there.
- **The highlight in Settings' left column jumps straight to the section you pick.** It used to slide 220 ms between rows. Hovering a row highlights it instantly as well.

### Fixes

- **Opening an existing conversation from the welcome page no longer slides the composer down from under the title.** It is at the bottom from the first frame.
- **The time and actions under a reply sit right under the text again.** There were 14 px between the end of a reply and that row, so on hover it looked like a paragraph of its own. It is now 4 px, the same as under your own messages.
- **A conversation pinned to the bottom no longer jumps while Plume is answering.** The status line at the end shrank the moment an answer started, grew back whenever the answer paused, and the time and copy row popped in when it finished — each one moved the conversation by 5 to 38 px. The line now fades in and out without changing height, and when the answer finishes it gives way to the actions row, which moves things by 8 px.
- **Sending a message while Plume is answering no longer makes the queue above the composer jump.** It overshot when a message joined the queue and grew by an extra 1 px at the end. When a queued message went out, the conversation was dragged back 10–14 px for 26 frames. Dragging to reorder made rows shrink and grow back, ending up to 68 px off, and deleting cut the last 14 px of the animation short. Each of these is now one movement in one direction.
- **Picking an option after scrolling a question card's list no longer pushes the card out of view.** The question and the first options went off the top of the card and left an empty space below. Scrolled far enough (1812 px in our test), only the title bar was left.
- **Ticking off the task list after an answer no longer shows up as an extra line under the reply.** If an answer finished with an item still in progress, the model ticked it with one more `todo_write`, and that call was drawn under the reply and its footer, as if work had carried on after the answer. It now belongs to the answer.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 新功能

- **通知改成一块面板，哪条在等你、哪条出错，一眼就能看出来。** 从前点铃铛弹出的是一个 224px 宽的普通菜单：会话标题长了会在词中间折行，每条已完成的通知都写着「已完成」，旁边的绿勾说的是同一件事。现在每条通知左边是按状态着色的色块（等批准、出错、完成），右边一行标题，下面一行「项目 · 多久以前」。只有「等你批准」保留文字，因为光一个手形图标看不出要你去做什么。
- **删除会话时，会先说清下面嵌套着几个会话。** 从建议里开出来的会话嵌套在发起建议的会话下面。原来确认框只提消息条数，删完以后，下面那几个悄悄变成了独立会话。现在确认框写明嵌套了几个，并给出「删除此会话」和「删除 N 个会话」两个选择。已归档的也算在内：只有归档的会话能删，它下面的会话往往也一起归档了。

### 变化

- **回复底下的「⚓ 数字」按钮，只在有钩子没顺利跑完时出现。** 原来每条回复底下都挂着一个「⚓ 80」，意思只是钩子照常跑了。现在只有这一段里有钩子拦下了工具调用、失败或超时，按钮才出现；点开照样能看到这一段的全部钩子。子代理面板也按这条规则显示。
- **设置 › 插件里不再有「扩展」标签。** 运行时扩展（放在 `.plume/extensions/` 里、在 worker 中运行的第三方代码）从来没有文档，那个标签也只显示过「暂无扩展」。这次整个删掉了。技能、插件、MCP 服务和钩子都不受影响。
- **在欢迎页发出第一条消息后，输入框改为在底部原地升起，不再滑下来。** 0.9.34 里，它从欢迎页上的位置一路滑到底部，同时横向拉宽。现在它第一帧就在底部、宽度就是对话栏的宽度，上升 16px 并淡入。开了「减少动态效果」时直接到位。
- **设置页左侧切换章节时，选中底色直接换到新的一行。** 原来底色要用 220ms 从上一行滑过去。鼠标悬停时的高亮现在也是即时出现的。

### 修复

- **从欢迎页点开已有会话时，输入框不再从标题下面滑到底部。** 现在第一帧就在底部。
- **回复底下的时间和操作按钮不再离正文隔一大截。** 回复末尾到这一行原来有 14px，鼠标悬停时看上去像是另起了一段。现在是 4px，和你自己的消息底下一样。
- **Plume 回答时，贴着底部的对话不再来回跳。** 对话末尾那行状态，回答一开始就收起，回答停顿时又长回来，写完时下面再冒出时间和复制那一行，每一次都让对话跳 5 到 38px。现在一轮里它只淡入淡出、高度不变；回答写完时给操作行让位，对话只挪 8px。
- **Plume 回答时发消息，输入框上方的排队条不再来回跳。** 新消息进队时会先冲过头，最后一帧还会多出 1px；排着的消息送出时，对话被往回拖 10–14px，持续 26 帧；拖动调整顺序时，几行先缩没再长出来，最远偏离 68px；删除时动画的最后 14px 被一刀切掉。现在这几种情况都是一次朝一个方向的移动。
- **提问卡的选项列表滚下去以后再点选项，卡片不再被推出视野。** 原来问题和前几个选项会被推出卡片顶部，下面空出一块；滚得够多时（我们测到 1812px），整张卡只剩标题栏。
- **回答之后补勾任务清单，不再在回复下面单独多出一行。** 回答写完时清单里还有一项是进行中，模型会再调一次 `todo_write` 把它勾掉，这次调用原来画在回复和页脚的下面，看上去像回答完又接着干了点什么。现在它归在这条回答里。

</details>

## [0.9.34](https://github.com/wJiaaa/Plume/releases/tag/v0.9.34) - 2026-10-15

<!-- plume:notes en -->

0.9.33 was never published (its Android build failed), so this release also carries everything from 0.9.33.

### New

- **Skills, global instructions and MCP servers from Magpie's Library reach Plume.** Pick Plume in Magpie's Library and it hands over all three, not just the model. Skills land in `~/.plume/skills` and show up like any other skill. Global instructions are read from `~/.plume/magpie/AGENTS.md` on every turn, together with your own Custom instructions. MCP servers are read from `~/.plume/magpie/mcp.json` when Plume starts, so restart Plume after changing them. In Settings they are marked "Managed by Magpie": name, switch, launch settings and delete are locked and changed in Magpie, while connection status, Reconnect and OAuth sign-in still work in Plume. Nothing is copied into `settings.json`, so withdrawing them in Magpie leaves nothing behind. Needs a Magpie version with the Library.
- **Plans open in a panel on the right, and you can comment on any part of them.** A plan used to be squeezed into the approval card above the composer: a long one meant scrolling inside a small box, and objecting to one step meant typing "about step two…" after "Revise" and hoping the model guessed which step. Now, when a plan comes in, a "Plan" tab opens on the right with the whole thing laid out. Select any text to leave a comment there. The approval card is two lines: the title with "Open plan", then Reject / Revise… / Accept. Esc revises, ⌘↵ presses the main button, ⇧⌘↵ accepts. In a narrow window the panel would cover the card, so the plan is shown in the card instead.
- **Comments go along when you accept.** Accepting with comments used to drop them silently, though most of them were "watch out for this when you do it" rather than "rewrite the plan". They are now listed on the approval card, numbered, with a box to add more, and Accept carries them to the model as notes without another round of planning. Revise… sends them back as feedback with the quoted text attached.
- **"Accept and turn on auto mode".** When the composer is set to "Ask for approval", the card has a fourth button that switches to "Auto approve" and then accepts the plan. It isn't offered if you're already on "Auto approve" or "Full access", so it never steps you down.
- **The plan panel survives a restart.** Close the app or switch conversations and come back, and the plan is still there, with the notes it was approved with.

### Changes

- **Releases no longer include the Android app.** Building the APK was the slowest part of every release, and in 0.9.33 a corrupt NDK download stopped the release altogether. Each release now carries the Windows and macOS packages only.
- **Plans read as a write-up, not a checklist.** A plan used to be a list of steps copied straight into the task list on approval, so what you reviewed was a list of actions with no word on what things looked like before or how the change would be checked. A plan is now ordinary Markdown — usually a title, a summary, the main changes, how it will be tested, and the assumptions it makes, in three to five sections sized to the job. The model writes its own task list once it starts working.
- **Plan mode asks before it submits.** It almost never asked anything; it now asks about intent, scope and trade-offs it can't find in the code, and if you skip a question it goes with its recommendation and records it as an assumption. This has only been tried against a scripted model, not a real one.
- **Chats under a suggesting chat are indented further in the sidebar.** The "└" sat right under the parent's status dot and the child's dot almost touched the parent's title. Child titles now start 27 px in instead of 22 px.

### Fixes

- **Plan mode no longer ends with the plan written as a reply and no approval card.** The model could investigate, write the plan out as ordinary text and stop without submitting it, so there was nothing to approve until you asked where the plan was. It is now reminded once to submit it; if it still doesn't, the turn ends there.
- **On macOS, restarting to install an update no longer crashes Plume when a terminal is open.** The terminal's exit callback ran after Node had stopped running JavaScript, the app aborted on its way out, and macOS reported that Plume quit unexpectedly. It now closes sessions and terminals and quits normally.
- **The composer no longer teleports when you send your first message from the welcome page.** Its top edge jumped 261 px in one frame (1200×800 window) and only then stretched sideways along the bottom. It now slides down and widens in one movement; the biggest step between two frames is 44 px. With "Reduce motion" on it goes straight there.
- **The line you're typing in the composer is no longer faded out.** After a line break the browser only scrolled the caret line into view, not the 14 px of padding below it, so the bottom fade stayed over the last line. The composer has no top or bottom fade any more; other multi-line boxes keep theirs.
- **A suggested chat no longer shows up as a broken card while it is still being written.** An icon, an empty title and a Start button that did nothing appeared first. It is now one line, "Suggesting a chat · title", with the title filling in as it's written, and the full card appears once it's done.
- **File links no longer flash a path or plain text before turning into a card.** Right after switching conversations, a relative path in inline code showed as the full raw path until the project info arrived. While a reply was streaming, a link's label appeared as text and then shrank to a card with just the file name. Both now show the card straight away.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

0.9.33 因为 Android 打包失败没有发布出去，它的改动都在这一版里。

### 新功能

- **Magpie 资源库里的技能、全局指令和 MCP 服务能分发到 Plume 了。** 在 Magpie 资源库里选 Plume，交过来的不再只有模型，这三样也一起到。技能放进 `~/.plume/skills`，和别的技能一样出现；全局指令放在 `~/.plume/magpie/AGENTS.md`，每轮都读，和你自己的「自定义指令」一起生效；MCP 服务放在 `~/.plume/magpie/mcp.json`，Plume 启动时读，改了要重启 Plume。设置页里这些服务标着「由 Magpie 管理」：名称、开关、启动参数和删除都锁住，要去 Magpie 里改；连接状态、重连和 OAuth 登录照旧在 Plume 里操作。它们不会被抄进 `settings.json`，在 Magpie 里撤回以后不留副本。需要支持资源库的 Magpie 版本。
- **计划交上来时在右栏摊开，哪一段都能划线评论。** 从前整份计划挤在输入框上方的审批卡里：长计划要在小框里滚，想对某一步提意见，只能在「修改」后面手打一句「第二步那个……」，模型还得猜说的是哪一步。现在计划一交上来，右栏就开一个「计划」标签整份摊开，选中一段字就地留评论。审批卡改成两行：标题加「打开计划」，下面一排拒绝 / 修改… / 接受。Esc 是修改，⌘↵ 按主按钮，⇧⌘↵ 接受。窗口太窄时面板会盖住审批卡，这时不开面板，计划画在卡里。
- **带着评论点「接受」，评论会一起交给模型。** 从前带着评论接受，评论悄悄作废，而多数评论是「做的时候注意一下」，不值得为它打回重写整份计划。现在评论按序号列在审批卡上，下面有个补充框；点「接受」时它们作为注意事项带过去，计划不重写。点「修改…」则连同被评的原文一起发回去。
- **「接受并开启自动模式」。** 输入框的权限档在「请求批准」时，卡上多一颗按钮：先切到「帮我批准」再接受计划。已经是「帮我批准」或「完全访问」时不给，免得把档位降下来。
- **计划面板重启后还在。** 关掉应用、换个会话再回来，计划还在，批准时带的注意事项也在。

### 变化

- **发布页不再附带 Android 安装包。** 每次发版最慢的就是打 APK，0.9.33 还因为 NDK 下载到一个坏包，整个版本没发出去。之后每个版本只带 Windows 和 macOS 的安装包。
- **计划写成一份方案，不再是一张任务清单。** 从前计划是一串步骤，批准时原样抄进任务清单，你审到的是一串动作，看不出改之前是什么样、打算怎么验。现在计划就是一段 Markdown，通常是标题、概要、主要改动、测试、假设这几节，按事情大小写三到五节。任务清单由模型开始干活时自己列。
- **计划模式交之前会先问。** 以前它几乎从不提问；现在代码里查不到的意图、范围、取舍，交计划之前先问清。你跳过不答，它就按自己推荐的走，并记成一条假设。这一点只在假模型上演练过，真实模型的提问效果还没验证。
- **侧栏里子会话缩进更明显。** 「└」原来落在父会话状态点正下方，子会话的状态点几乎贴着父会话标题。子会话标题的缩进从 22px 改成 27px。

### 修复

- **计划模式不再把计划写成一段回复就收工、不出审批卡。** 模型查完代码，可能把方案写成普通文字就停下、不提交，你得追问一句「计划呢」才有东西可批。现在它会被提醒一次改成正式提交；提醒过还不交，这一轮就停在那里。
- **macOS 上开着终端时，重启安装更新不再让 Plume 崩溃。** 退出时 Node 已经停止执行 JavaScript，终端的退出回调还在跑，应用在退出途中中止，系统报「意外退出」。现在先收掉会话和终端，再正常退出。
- **在欢迎页发出第一条时，输入框不再一帧瞬移。** 原来顶边一帧跳 261px（1200×800 的窗口），然后才在底部横着拉开。现在它一边滑到底部一边变宽，一次做完，相邻两帧最多移动 44px。开了「减少动态效果」时直接到位。
- **输入框里正在打的那一行不再被虚化。** 换行后浏览器只把光标所在行滚进可见区，底部那 14px 内衬没滚进来，下方的渐隐就一直压在最后一行上。主输入框去掉了上下渐隐，其他多行输入框不变。
- **建议新会话还在写的时候，不再先冒出一张像坏了的卡片。** 原来会先出现图标、空标题和一颗按不动的「开始」。现在写的过程中只有一行「建议新会话 · 标题」，标题跟着写出来，写完才换成整张卡片。
- **文件链接不再先露出路径或文字、闪一下才变成卡片。** 刚切到一个会话时，项目信息还没到，行内代码里的相对路径先画成一整段原始路径；回复流式输出时，链接的文字先露出来，再缩成只剩文件名的卡片。现在两种情况都直接出现卡片。

</details>

## [0.9.33](https://github.com/wJiaaa/Plume/releases/tag/v0.9.33) - 2026-10-15

<!-- plume:notes en -->

### New

- **Plans open in a panel on the right, and you can comment on any part of them.** A plan used to be squeezed into the approval card above the composer: a long one meant scrolling inside a small box, and objecting to one step meant typing "about step two…" after "Revise" and hoping the model guessed which step. Now, when a plan comes in, a "Plan" tab opens on the right with the whole thing laid out. Select any text to leave a comment there. The approval card is two lines: the title with "Open plan", then Reject / Revise… / Accept. Esc revises, ⌘↵ presses the main button, ⇧⌘↵ accepts. In a narrow window the panel would cover the card, so the plan is shown in the card instead.
- **Comments go along when you accept.** Accepting with comments used to drop them silently, though most of them were "watch out for this when you do it" rather than "rewrite the plan". They are now listed on the approval card, numbered, with a box to add more, and Accept carries them to the model as notes without another round of planning. Revise… sends them back as feedback with the quoted text attached.
- **"Accept and turn on auto mode".** When the composer is set to "Ask for approval", the card has a fourth button that switches to "Auto approve" and then accepts the plan. It isn't offered if you're already on "Auto approve" or "Full access", so it never steps you down.
- **The plan panel survives a restart.** Close the app or switch conversations and come back, and the plan is still there, with the notes it was approved with.

### Changes

- **Plans read as a write-up, not a checklist.** A plan used to be a list of steps copied straight into the task list on approval, so what you reviewed was a list of actions with no word on what things looked like before or how the change would be checked. A plan is now ordinary Markdown — usually a title, a summary, the main changes, how it will be tested, and the assumptions it makes, in three to five sections sized to the job. The model writes its own task list once it starts working.
- **Plan mode asks before it submits.** It almost never asked anything; it now asks about intent, scope and trade-offs it can't find in the code, and if you skip a question it goes with its recommendation and records it as an assumption. This has only been tried against a scripted model, not a real one.
- **Chats under a suggesting chat are indented further in the sidebar.** The "└" sat right under the parent's status dot and the child's dot almost touched the parent's title. Child titles now start 27 px in instead of 22 px.

### Fixes

- **The composer no longer teleports when you send your first message from the welcome page.** Its top edge jumped 261 px in one frame (1200×800 window) and only then stretched sideways along the bottom. It now slides down and widens in one movement; the biggest step between two frames is 44 px. With "Reduce motion" on it goes straight there.
- **The line you're typing in the composer is no longer faded out.** After a line break the browser only scrolled the caret line into view, not the 14 px of padding below it, so the bottom fade stayed over the last line. The composer has no top or bottom fade any more; other multi-line boxes keep theirs.
- **A suggested chat no longer shows up as a broken card while it is still being written.** An icon, an empty title and a Start button that did nothing appeared first. It is now one line, "Suggesting a chat · title", with the title filling in as it's written, and the full card appears once it's done.
- **File links no longer flash a path or plain text before turning into a card.** Right after switching conversations, a relative path in inline code showed as the full raw path until the project info arrived. While a reply was streaming, a link's label appeared as text and then shrank to a card with just the file name. Both now show the card straight away.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 新功能

- **计划交上来时在右栏摊开，哪一段都能划线评论。** 从前整份计划挤在输入框上方的审批卡里：长计划要在小框里滚，想对某一步提意见，只能在「修改」后面手打一句「第二步那个……」，模型还得猜说的是哪一步。现在计划一交上来，右栏就开一个「计划」标签整份摊开，选中一段字就地留评论。审批卡改成两行：标题加「打开计划」，下面一排拒绝 / 修改… / 接受。Esc 是修改，⌘↵ 按主按钮，⇧⌘↵ 接受。窗口太窄时面板会盖住审批卡，这时不开面板，计划画在卡里。
- **带着评论点「接受」，评论会一起交给模型。** 从前带着评论接受，评论悄悄作废，而多数评论是「做的时候注意一下」，不值得为它打回重写整份计划。现在评论按序号列在审批卡上，下面有个补充框；点「接受」时它们作为注意事项带过去，计划不重写。点「修改…」则连同被评的原文一起发回去。
- **「接受并开启自动模式」。** 输入框的权限档在「请求批准」时，卡上多一颗按钮：先切到「帮我批准」再接受计划。已经是「帮我批准」或「完全访问」时不给，免得把档位降下来。
- **计划面板重启后还在。** 关掉应用、换个会话再回来，计划还在，批准时带的注意事项也在。

### 变化

- **计划写成一份方案，不再是一张任务清单。** 从前计划是一串步骤，批准时原样抄进任务清单，你审到的是一串动作，看不出改之前是什么样、打算怎么验。现在计划就是一段 Markdown，通常是标题、概要、主要改动、测试、假设这几节，按事情大小写三到五节。任务清单由模型开始干活时自己列。
- **计划模式交之前会先问。** 以前它几乎从不提问；现在代码里查不到的意图、范围、取舍，交计划之前先问清。你跳过不答，它就按自己推荐的走，并记成一条假设。这一点只在假模型上演练过，真实模型的提问效果还没验证。
- **侧栏里子会话缩进更明显。** 「└」原来落在父会话状态点正下方，子会话的状态点几乎贴着父会话标题。子会话标题的缩进从 22px 改成 27px。

### 修复

- **在欢迎页发出第一条时，输入框不再一帧瞬移。** 原来顶边一帧跳 261px（1200×800 的窗口），然后才在底部横着拉开。现在它一边滑到底部一边变宽，一次做完，相邻两帧最多移动 44px。开了「减少动态效果」时直接到位。
- **输入框里正在打的那一行不再被虚化。** 换行后浏览器只把光标所在行滚进可见区，底部那 14px 内衬没滚进来，下方的渐隐就一直压在最后一行上。主输入框去掉了上下渐隐，其他多行输入框不变。
- **建议新会话还在写的时候，不再先冒出一张像坏了的卡片。** 原来会先出现图标、空标题和一颗按不动的「开始」。现在写的过程中只有一行「建议新会话 · 标题」，标题跟着写出来，写完才换成整张卡片。
- **文件链接不再先露出路径或文字、闪一下才变成卡片。** 刚切到一个会话时，项目信息还没到，行内代码里的相对路径先画成一整段原始路径；回复流式输出时，链接的文字先露出来，再缩成只剩文件名的卡片。现在两种情况都直接出现卡片。

</details>

## [0.9.32](https://github.com/wJiaaa/Plume/releases/tag/v0.9.32) - 2026-10-15

<!-- plume:notes en -->

### New

- **A suggested chat gets its own card in the conversation, and can report back.** It used to leave a single "Suggested a chat" line at the end of the turn, and starting it meant finding the environment card in the top right. The chat it opened sat in the sidebar next to this one as if the two were unrelated, and its result had no way back. The card now stands where the model suggested it, on its own line; once started it shrinks to one line that shimmers while the chat runs. In the sidebar the new chat hangs under the one that suggested it. "Report back" is off by default — the model can turn it on, and you can change it on the card. When it's on, the reply that ends the new chat's first turn comes back here, marked "From chat · title". Only the first turn reports back, and not if you stopped it.
- **Previews fold to one line, like tool calls.** A preview could be resized but never folded away. It now has an icon, a title and an arrow; fold it and open it again and the page keeps its state and height.
- **Closing a side chat that has something in it asks first.** Closing a side chat deletes it, along with anything typed and not sent, and its ✕ looks just like the ones that only hide a panel. It now asks when there's a conversation, a reply in progress, or text or an attachment in the box. "Don't ask again" is only remembered if you go ahead and close it. An empty side chat, or one holding only a quoted selection, still closes straight away.

### Changes

- **The subagent panel shortcut is now ⌥⌘U (Ctrl+Alt+U on Windows).** ⌥⌘A is the screenshot key in QQ and TIM on Windows.
- **The code font menu only lists fonts installed on this machine.** A font that's in use but missing is marked "(not available here)".
- **Previews use the full width of the conversation.** The 22 px indent they inherited from tool details is gone.
- **The spinner on a running project uses the theme's accent colour.** It used the pale grey of the chat count and was easy to miss.
- **Dialog buttons in the light theme no longer look washed out.** Danger buttons used the red brightened for dark backgrounds, #f2555a, which measured 2.98:1 on its own pink tint. Light now uses #c92a30, 4.59:1 on the same tint. Cancel uses the body text colour instead of muted grey.

### Fixes

- **The gallery opens without a 300 ms skeleton first.** The first visit waited on a code chunk from local disk, and React holds a skeleton for at least 300 ms once it shows one. Those chunks are now fetched while the app is idle. Coming back to the gallery no longer re-renders an album whose list hasn't changed.
- **Images in the file panel refit when you resize it.** "Fit to panel" was worked out once, when the image loaded. After the panel grew from 396 px to 678 px, a 1600×900 image stayed at 23% in the middle with empty space all round.
- **The task list above the composer no longer jumps 12 px the wrong way when the subagent bar opens or closes.** The composer's top margin switched in one frame while the bar grew over 340 ms; the two now move together.
- **Code blocks, formulas and Mermaid diagrams wider than the column get a thin scrollbar on hover** that you can drag.
- **Image annotations are sharp on Retina, and the toolbar can be dragged out of the way.** Lines and text are sized in screen points, and the canvas is drawn at screen resolution.
- **Stacked subagent avatars no longer let the face underneath show through.**
- **`glob` understands `[abc]`, `[a-z]` and `[!x]`.** `glob src/**/*[Pp]review*` answered "No files match" while `PreviewCard.tsx` was right there, and the model spent two more rounds switching between grep and glob.
- **`grep` on a path that doesn't exist says so.** A `path` of `ToolCall.tsx` (the file is `ToolCard.tsx`) came back as "No matches", and the model concluded the file didn't contain what it was looking for.
- **`ls skill://…` lists skill directories.** `ls skill://huashu-art-motion/references` said "Not a directory or not found" although the directory was there, and `read skill://x/references/` with a trailing slash said there was no `references/`.
- **Windows:**
  - After maximising or restoring, the title bar's buttons on the right are no longer covered by the system buttons.
  - Panels and split view no longer get a system title bar.
  - A dialog's backdrop dims the system buttons too, and nothing under it can drag the window.
  - Ctrl+V pastes in the terminal.
  - Opening the same file through two spellings of its path opens it once.
  - The window remembers being maximised and no longer grows a few pixels each launch.
  - Ctrl+M no longer minimises the window.
  - Shortcut hints say Win and Backspace.
  - Bold Markdown uses semibold, and the code font falls back to Microsoft YaHei for Chinese.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 新功能

- **建议的新会话在对话里自成一张卡片，跑完可以交回结果。** 从前一轮末尾只留一句「建议了新会话」，要开始得去右上角的环境卡片里找；开出来的会话在侧栏里和提建议的对话并排，看着像两件不相干的事，结果也没法拿回来。现在卡片就站在模型提建议的位置、自成一行，开始以后缩成一行，在跑的时候有一道扫光。侧栏里新会话挂在提建议的那个会话下面。「交回这里」默认关，模型可以打开，你在卡片上也能改；打开时，新会话第一轮最后那段回复会送回这里，标着「来自新会话 · 标题」。只交第一轮，被你停下的不交。
- **预览能像工具行一样收成一行。** 从前预览只能调高度，收不起来。现在有图标、标题和展开箭头，收起再展开，网页的状态和高度都还在。
- **关掉有内容的侧边聊天之前先问一句。** 关侧边聊天就是删掉它，连同框里没发出去的字；而它的 ✕ 和别处只收起面板的 ✕ 长得一样。现在里面有对话、正在回答，或者框里打了字、贴了附件时，点 ✕ 先弹确认框。「不再询问」只在你真的关掉时才记住。空的侧边聊天，或者只挂着一段划词引文的，照旧一点就关。

### 变化

- **子智能体面板的快捷键改成 ⌥⌘U（Windows 上 Ctrl+Alt+U）。** ⌥⌘A 在 Windows 上是 QQ、TIM 的截图键。
- **代码字体菜单只列这台机器装了的字体。** 正在用却没装的那个，标「本机不可用」。
- **预览占满对话的宽度。** 从工具详情沿用过来的 22px 左缩进去掉了。
- **项目运行中的加载圆环用主题强调色。** 原来跟着会话计数用淡灰色，不仔细看注意不到。
- **浅色主题下弹窗按钮不再发虚。** 危险按钮沿用了给深色底提亮的 #f2555a，压在它自己的浅粉底上只有 2.98:1；浅色现在单独用 #c92a30，同样的底上 4.59:1。取消按钮的字从次要灰换成正文色。

### 修复

- **第一次打开画廊不再先挂 300ms 骨架。** 第一次进要等本机磁盘上的一个分包，而 React 一旦露出骨架，至少留它 300ms。现在这些分包在空闲时先取好。再次进入画廊时，列表没变的相册不再整本重新渲染。
- **拖宽拖窄文件面板，图片跟着重新适配。** 「适应面板」只在图片载入那一刻算一次：面板从 396px 变成 678px 后，1600×900 的图还按 23% 缩在中间，四周大片空白。
- **子智能体条展开收起时，输入框上方的任务清单不再先反向跳 12px。** 输入框的上边距一帧就切过去，而条要 340ms 才长出来；现在两者合成一次移动。
- **代码块、公式、Mermaid 图比栏宽时，指针移上去有一条能拖的细滚动条。**
- **图片标注在 Retina 上不再发虚，工具栏能拖开。** 线和字按屏幕点数定大小，画布按屏幕分辨率画。
- **叠在一起的子智能体头像，下面那张脸不再透上来。**
- **`glob` 认得 `[abc]`、`[a-z]`、`[!x]`。** `glob src/**/*[Pp]review*` 答「No files match」，而 `PreviewCard.tsx` 就在那里，模型在 grep 和 glob 之间来回又多走两轮。
- **`grep` 搜不存在的路径时直说找不到。** `path` 写成 `ToolCall.tsx`（实际叫 `ToolCard.tsx`），交回去的是「No matches」，模型据此以为文件里没有要找的东西。
- **`ls skill://…` 能列技能目录。** `ls skill://huashu-art-motion/references` 目录明明在，却报「Not a directory or not found」；`read skill://x/references/` 带尾斜杠时说没有 `references/`。
- **Windows：**
  - 最大化、还原以后，标题栏右侧的按钮不再被系统按钮盖住。
  - 面板和分屏不再带系统标题栏。
  - 弹窗的遮罩把系统按钮也压暗，遮罩下面拖不动窗口。
  - 终端里 Ctrl+V 能粘贴。
  - 同一个文件换一种路径写法，不再开出第二格。
  - 窗口记得自己是最大化的，也不再每次启动长大几像素。
  - Ctrl+M 不再把窗口最小化。
  - 快捷键提示写 Win、Backspace。
  - Markdown 加粗用 semibold，代码字体的中文回退到微软雅黑。

</details>

## [0.9.31](https://github.com/wJiaaa/Plume/releases/tag/v0.9.31) - 2026-10-15

<!-- plume:notes en -->

### New

- **Subagents are let go as soon as they're dispatched, and each reports back when it finishes.** `task` used to wait for its subagents unless you spoke up, so with three running in parallel the main agent sat silent until the slowest was done, then all three conclusions came out in one paragraph. Dispatching now returns "dispatched", the turn wraps up, and you can keep talking. Each result is delivered as it comes back — ones that land within 400 ms of each other share a turn — naming who is still out and saying only what this one brought; when the last is in, they are merged into one answer. Whatever waits for the conversation to go idle (`wait_for_session`, archiving, idle compaction, the CLI, the "done" notification) waits for the last one. Subagents still running when Plume quits are interrupted, and the main conversation is told so the next time you speak. The price is requests: three subagents coming back separately take the main conversation from 2 requests to 5.
- **Tool calls in a row read as one line that grows.** Consecutive calls merge into one line that counts from the first call — "Read 2 files, listed 4 directories" — and new calls are added at the end, so the words already there stay put; the width eases over, and the arrow and +N −M at the end slide along instead of jumping. Read-only shell commands (`rg`, `sed -n`, `git log`: every piped segment read-only, no redirect into a file) belong to the same exploring line as reading files. Editing, exploring and terminal work next to each other merge too, so "edit failed → `sed -n` → python → edit failed → read → edit" is one line instead of six. The browser, dispatch and preview only merge with their own kind, and the model saying something still starts a new line. The expanded/collapsed "Tool calls" switch in Settings → Appearance is gone.
- **A running line says which call it's on.** It used to show totals ticking up — "Read 12 files, searched 5" — so a minute of exploring told you nothing about which file it was looking at. While running it names the first call still in progress and holds each phrase for at least 650 ms, so reads and greps 100–200 ms apart don't roll past before you can read them; once an answer or other work follows, it rolls over to the totals. `read`, `grep`, `glob` and `ls` take an optional description, and when the model writes one it is shown, as with bash; otherwise it falls back to "Read a.ts".
- **Split view looks like two screens.** The gap between screens was as wide as the one between a conversation and its panels, so a terminal on each side made four identical cards with no telling which two belonged together, or which screen had focus. Each screen is now one card with the conversation on it and the tab bar floating inside (6 px from the card's edge, 3 px from the conversation, outlined, no shadow). The unfocused screen's content is a step dimmer, its composer one more, and its title grey. A single screen is unchanged.

### Changes

- **The model's reasoning is hidden by default.** It is a draft the model writes for itself and often runs longer than the answer. Settings → General → "Show reasoning" brings it back, in the main conversation and subagent panels alike; the bottom of the chat still says when the model is thinking.
- **No more "Worked N s" line over each turn.** The steps lie flat in the conversation with the answer at the end, and nothing folds itself away when the turn finishes. The line repeated the number the running indicator already shows, and for models that don't stream reasoning — GPT through a proxy, say — it took ages to appear and arrived already at tens of seconds. A turn woken by a finished subagent or background command doesn't get a second header on top of the delivery line either.
- **The task list opens expanded.** Collapsed, it showed only the current step, and how many are left and what comes next — what the card is there for — took a click. Clicking the title still folds it to one line.
- **Icons no longer animate on hover.** They are plain lucide icons now; the 218 animated versions are gone, along with the `motion` dependency they needed.
- **Corners and shadows come from one scale.** There were 22 radii in use, with 10, 11, 13 and 14 px side by side. 10 px corners (settings cards, tool cards, code blocks, gallery tiles) are 8 px now, 18 px ones (the message editor, slash and @ menus, the commit dialog) 16 px, and 11/13/14 px ones 12 px. Segmented controls are the same everywhere — 8 px outside, 6 px on the thumb — where the plugin page's tab strip and scope buttons were pills beside small-cornered controls on the same page.
- **Secondary text is darker on menus and cards.** The two greys were tuned to the page background and washed out on lighter surfaces: muted text measured 3.9:1 on a dark menu, faint text 2.3:1 in the light theme. Muted is now at least 4.5:1 on every surface and faint at least 3:1. Windows' light theme used to get one extra step darker on its own; every platform now sits above that.
- **The sidebar's top and bottom rows aren't greyed out.** They faded towards the edges, which looked like something lying over them; the project heading and the settings row are solid already and rows pass beneath them.
- **The conversation fades 32 px at the top and 48 px at the bottom, all the way down to the composer.** In dark themes a light image or preview card scrolled to the top edge picked up a dirty dark band from the 36 px mask. The composer also kept a fixed 12 px top margin, so the fade stopped short and left a strip above it; that margin is now 0 unless an approval card, hook banner or task list sits there.
- **Updates come from `wJiaaa/Plume`.** The repository was renamed from Lyra. Update checks and the release link in Settings → About use the new name instead of relying on GitHub's redirect.

### Fixes

- **A preview that is checked before publishing stays where it is.** Checking and publishing are two calls with a whole round of the model's thinking in between: the draft vanished once the check finished, the conversation sat empty for ten-odd seconds, then the page turned up somewhere lower down. 115 of the 139 preview calls on this machine were checks, so this happened to nearly every page. The draft now stays in place marked "checked, not published yet", and the published page fades in on the same spot. If the turn ends unpublished the draft goes away; a page published in a later turn is still drawn there.
- **A terminal opened once in an empty conversation no longer comes with every new one.** Sending the first message copied the empty conversation's panels to the new session and left the copy on disk, so every later "New conversation" brought that terminal, and so did everything sent from it. Switching back to that session from an empty conversation also kept bringing closed terminals back.
- **Paths from `grep` and `glob` with a `path` can be read.** They were written relative to the searched directory while `read` and `edit` resolve against the workspace root: a grep with `path: "src"` reported `pages/Login/index.tsx`, `read` said File not found, and the model spent a round with glob finding `src/` again. Results are relative to the workspace root now, and absolute when the searched directory is outside it.
- **`ls` and `preview` understand `scratch://`.** `ls scratch://` said "Not a directory or not found", and `preview scratch://todo-templates.html` went looking for `<project>/scratch:/todo-templates.html`.
- **Models whose thinking can't be switched off get conversation titles.** The title request asks for no thinking and 60 output tokens. DeepSeek V4 Flash through magpie only offers low/high/max, so it thought at low, spent all 60 tokens on reasoning and left the title empty — all 34 attempts in the logs here. Such models get 2048 tokens now; models that can switch thinking off still get 60.
- **Dialogs no longer twitch after opening.** A centred card often lands on half a pixel, and when the opening animation ended the text snapped to the pixel grid about a quarter of a device pixel away. Opening now scales up from 0.95 and fades in over 150 ms (closing reverses in 100 ms), instead of rising 6 px, which made a centred card look like it drifted in from below.
- **Double-clicking a word no longer pops the quote menu in the way of a triple-click.** The menu opened right after the second click, closed on the third and opened again on the paragraph. A double-click now waits 400 ms first; dragging and triple-clicks open it immediately. A single selected character no longer counts as a quote.
- **Expanding history no longer makes +N −M and the failed and stopped marks bounce.** The pop is for a tool finishing in front of you; cards that only appeared because you expanded a group played it too.
- **The file path pinned at the top of the changes panel isn't faded out.** The panel's 36 px top fade swallowed the 38 px sticky file header as soon as you scrolled.
- **A second terminal's header and border follow the code theme.** Only the first terminal and file panel matched, so under Dracula or Solarized later ones had a window-coloured frame around a differently coloured terminal. The default dark theme happens to use #171717 for both, which hid it.
- **The idle ring in the conversation list is visible in dark mode.** It measured 1.09:1 against the sidebar; it is 1.27:1 now, and 1.21:1 in light.
- **Clicking a project row no longer flashes.** Pressing it darkened the row and releasing it undid that, on every expand and collapse; it keeps the hover colour while held.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 新功能

- **子代理派出去就放手，跑完一个送回一个。** 从前 `task` 默认等子代理交差，只有你插话才放手：并行派三路时，主智能体一声不吭地等最慢的那一路，三路的结论最后挤在一段话里出来。现在派出去就回一句「已派出」，这一轮先收尾，你可以接着说话。每回来一个送一份，前后脚 400ms 内回来的合成一轮；还有没回来的就点名在等谁、只说这一份带来了什么，全回来了再合成一份回答。等会话闲下来的那些（`wait_for_session`、归档、闲时压缩、命令行、「做完了」的通知）都等最后一个回来。退出 Plume 时还在跑的子代理会被打断，你下次开口时主会话会知道。代价是请求数：三路分开回来，主会话的请求从 2 次变成 5 次。
- **连着的工具调用合成一行，往句尾接。** 一行从第一次调用起就说累计的「读取文件 2 个、列出目录 4 个」，新的调用接在句尾，前面的字不动；宽度缓过去，行尾的箭头和 +N -M 是被推过去的，不是跳过去的。`rg`、`sed -n`、`git log` 这类只读命令（管道里每一段都只读、没有写文件的重定向）和读文件归成同一行探索。改代码、探索、终端挨在一起也合：「edit 失败 → `sed -n` 看一眼 → python 改 → edit 失败 → read → edit」从六行变成一行。浏览器、派发、预览仍然只和同类合，模型说了话照旧另起一行。设置 › 外观里「调用链」的展开 / 折叠开关删掉了。
- **跑着的那一行说正在跑的那次调用。** 从前跑着时只说总数「读取文件 12 个、搜索内容 5 个」，一段探索跑一分钟，只看得到数字在涨，不知道它正在看哪个文件。现在说的是第一个还在跑的调用，每一句至少停 650ms——连着的 read、grep 一两百毫秒一换，不停一下字还没读完就滚走了；后面接上回答或别的活，再滚成总数。`read`、`grep`、`glob`、`ls` 多了可选的说明，模型写了就用它，和 bash 一样；没写退回「读取文件 a.ts」。
- **分屏时看得出是两屏、焦点在哪一屏。** 从前屏与屏之间的缝和屏内对话、面板之间的缝一样宽，两屏各开一个终端就是四张一样的卡，看不出哪两张是一组，也不知道自己在哪个会话下面。现在每一屏是一张卡，对话铺在上面，标签栏浮在屏卡里（离边 6px、挨对话一边 3px，只有描边不投影）。非焦点屏的内容淡一档、输入框再淡一档，标题变灰。单屏不变。

### 变化

- **对话里默认不再摊开模型的推理。** 推理是模型写给自己的草稿，常常比回答还长。设置 › 常规 →「显示思考过程」可以打开，主会话和子智能体面板同一个开关；模型在想的时候，底部的运行指示照旧会说。
- **不再给每一轮挂「已工作 N 秒」那一行。** 过程一行行摊在对话里，回答跟在最后，跑完也不自己收起。那一行说的和底部运行指示是同一个数，而经代理的 GPT 这类不流推理的模型，它要么迟迟不出，要么一出来就是几十秒。子智能体或后台命令跑完叫醒的那一轮，也不再在送达那一行上面多挂一个标题。
- **任务清单默认展开。** 收起时只看得到当前那一步，「还剩几步、接下来做什么」正是这张卡片要回答的，却得先点一下。点标题照样能收成一行。
- **悬停时图标不再动。** 统一用 lucide 原版，218 个动画版图标和只为它们装的 `motion` 依赖一起删掉了。
- **圆角和阴影收成一套刻度。** 从前界面里有 22 种圆角，10、11、13、14px 并排出现。现在 10px 那一组（设置卡片、工具卡片、代码块、画廊方块）是 8px，18px 那一组（消息编辑框、斜杠和 @ 菜单、提交弹窗）是 16px，11/13/14px 是 12px。分段控件处处一样：外框 8px、滑块 6px——插件页的标签条和范围按钮从前是胶囊，同一页上别的分段控件是小圆角。
- **次要文字在菜单、卡片上更深了。** 两档灰原来按页面底色定，落到更浅的表面上就发灰发飘：深色菜单上次要文字只有 3.9:1，浅色下最浅那档只有 2.3:1。现在次要文字在每种表面上都 ≥4.5:1，最浅那档 ≥3:1。Windows 浅色原来单独多深一步，现在所有平台都在那一步之上。
- **侧边栏上下两头的行不再像盖了一层灰。** 两头原来往边上淡出，看着像被什么压住；项目标题和底部设置行本来就是实心的，行是从它们下面穿过去的。
- **会话区渐隐收成顶 32px、底 48px，一直淡到输入框边上。** 深色主题下，浅色图片、预览卡滚到顶边，会被 36px 的遮罩压出一条发脏的暗带。输入框上方原来固定留 12px，渐隐到它上面就停了，中间空出一条；现在只有对话时这 12px 收掉，上面叠着审批卡片、Hook 提示条或任务清单时照旧留着。
- **更新改从 `wJiaaa/Plume` 取。** 仓库从 Lyra 改了名，更新检查和设置 › 关于里的发布页链接都换成新名字，不再靠 GitHub 的重定向。

### 修复

- **先检查再发布的网页预览，不再写完就消失、再在下面另起一张。** 检查和发布是两次调用，中间隔着模型一整轮推理：检查完草稿就撤了，对话里空着十几秒，页面再换个位置出现。本机 139 次 preview 调用里 115 次是检查，几乎每一页都这样。现在草稿留在原地、标着「检查过了，还没发布」，发布的页面就在那个位置淡入接上。这一轮结束还没发布的，草稿撤掉；隔一轮才发布的，页面仍画在发布那里。
- **空白对话里开过一次终端，之后的新对话不再都带着它。** 发出第一条消息时，空白对话摆好的面板是抄给新会话的，草稿那份留在盘上，于是之后每个「新对话」都带着那个终端，从它发出去的会话也一个个继承。从空白对话点回那个会话时，关掉的终端也会再冒出来。
- **grep、glob 带 `path` 搜出的路径，拿去读不再报找不到。** 结果原来相对搜索目录写，而 `read`、`edit` 按工作区根解析：grep 带 `path: "src"` 报出 `pages/Login/index.tsx`，原样去读得到 File not found，又要搭一轮 glob 才找回 `src/`。现在都相对工作区根写，搜索目录在工作区外时给绝对路径。
- **`ls`、`preview` 也认 `scratch://`。** 从前 `ls scratch://` 报「Not a directory or not found」，`preview scratch://todo-templates.html` 去找 `<项目>/scratch:/todo-templates.html`。
- **关不掉思考的模型也能生成会话标题。** 标题请求要求不思考、输出上限 60。经 magpie 接入的 DeepSeek V4 Flash 只有 low/high/max 三档，「不思考」被就近提到 low，60 个 token 全花在推理上，标题是空的——本机日志里它的 34 次全是这样。这类模型现在给 2048，能关思考的仍是 60。
- **弹窗打开后文字不再抖一下。** 居中的卡片常落在半像素上，进场动画一结束，文字重新对齐像素网格，挪了约四分之一个设备像素。进场也改成从 0.95 倍原地放大、淡入（150ms），退场反过来（100ms）；原来往上升 6px，一个居中的卡片看着像从下面飘上来的。
- **双击选词不再立刻弹出划词菜单、打断三击选段。** 从前第二下松开就弹，接着点第三下时菜单先被收起、松开又在整段上弹一次，一次三击闪两回。现在双击先等 400ms，拖选和三击照旧立刻弹。只选中一个字不再算引文。
- **展开历史时，+N -M 和失败、停止的标记不再弹一下。** 那一下是给眼前刚跑完的工具的，展开分组时才出现的卡片也跟着播了。
- **文件变更面板滚动后，钉在顶上的文件路径不再被淡掉一截。** 面板 36px 的顶部渐隐，一滚动就把 38px 高的文件头整个盖进去。
- **第二个终端的标题栏和边框也跟代码主题走。** 从前只有第一个终端和文件面板换底色，换成 Dracula、Solarized 这类主题时，后开的那个是一圈窗口底色套着一块别的颜色。默认深色主题下两者恰好都是 #171717，所以一直没露出来。
- **深色模式下，会话列表空闲态的状态圆环看得见了。** 从前在侧栏上只有 1.09:1，现在 1.27:1，浅色 1.21:1。
- **点项目行不再闪一下。** 按下时底色加深、松手退回，而点项目行就是在折叠展开，每点一次闪一次；现在按住和悬停同色。

</details>

## [0.9.30](https://github.com/wJiaaa/Lyra/releases/tag/v0.9.30) - 2026-10-14

<!-- plume:notes en -->

### New

- **Worktrees belong to a conversation now, and a conversation can hand its work back.** A new conversation's composer carries a ⑂ switch; the switch in settings is only the default, and what you pick travels down with the first message. The conversation stays filed under the project it came from instead of growing a same-named project beside it, and a worktree that couldn't be created says so in amber on the composer rather than quietly working in the project directory. From the ⑂ chip (`⑂ branch ↑2 ↓1`) you can merge the conversation's commits back into main and pull main's new ones in: `--no-ff` in place when the project is checked out here, without a checkout when it is checked out nowhere, refused when another worktree holds the branch. A merge conflict aborts at once and leaves the project as it was; a sync conflict stays in the worktree for you to settle or abandon. Leading and trailing counts don't count merge commits.
- **Deleting or archiving a conversation takes its worktree with it.** Neither used to touch the worktree, so `~/.plume/worktrees` only ever grew; the automatic cleanup couldn't tell which worktrees Plume had made, skipped only the sessions running in memory, and ran with `--force`, so uncommitted work went with it. A worktree with uncommitted changes in it is not reclaimed now, and the delete confirmation says what stays behind; un-archiving checks it out again where it was. The automatic cleanup only reclaims clean `plume/session-*` worktrees that no unarchived conversation is using, and never with `--force`.
- **Tab fills in a guess at your next message.** Off by default — Settings → General → "Next-step suggestions" — because it costs one more request per turn. It is forked from the request just sent, so it mostly pays for cache reads, and it isn't sent at all when the last request neither read nor wrote the cache, since that would re-read the whole conversation at full price. It reads the end of the reply for what's next and what your options are, keeps to what you asked for, and guesses nothing when the turn failed or the conversation has fewer than two replies.
- **The model dialog filters by vendor.** With a few relays configured there are thirty models in one list, and searching by name means knowing how each relay spells it. The vendor rail on the left — All / Favourites / each vendor — pools a maker's models across providers while still grouping by provider, and appears once there are eight models from at least two vendors. Focus stays in the search box: typing highlights the first match, ↑/↓ move, Enter takes it, and an Enter that belongs to an IME is left alone.
- **An interface block has a shape while it is still being written.** A chart or a table used to be blank until the data had finished streaming, then appear in one frame. A placeholder stands where the tag is going: dot matrix, ripple, probe line, dashed frame with corner handles. When the tag closes, charts and tables are first traced along their own frames, grid lines, bars and cells, and a line sweeps down to reveal them; the rest of the block is simply revealed. Containers get neither — measured by height, the whole card would be hidden as one element and what was written into it wouldn't show until the sweep reached it. (The look is from transitions.dev's generation effect, reimplemented here without its size labels, counters and coordinate readouts.)

### Cheaper

- **Summaries cost about a quarter of what they did.** On this machine the same conversations asked for 315 and now ask for 82: the first summary waits until you have said three things, and then two more each time; messages the runtime writes in — a subagent's result, mail from another conversation — are not you saying something. Half of the 187 conversations here have exactly one thing said in them, and the title already says what that was.
- **They are no longer spent just for opening a conversation.** The renderer clocked the request while the environment card was open, so opening a long-finished conversation spent one immediately, and a conversation actually working got none unless you opened the card. The main process generates it now, a minute after a turn ends with nothing following — a next turn cancels it, and a turn still running at the minute doesn't get one. The card reads what has been stored and listens for the new one; with no summary it takes up no room, and a failure leaves a "Retry".
- **The agent reads web pages for less.** `read` returns its elements one per line with a ref, about 28% of the size it was, and screenshots come out in CSS pixels, which is three-quarters fewer tokens on a Retina display.

### Changes

- **The system prompt no longer invites abstractions and defensive code.** Three similar lines beat a premature abstraction, and a helper with one call site is a change made bigger for nothing. Validation goes at the boundaries — what you typed, what an API returned — not around internal calls that cannot fail.
- **A dropped connection gives up after ten attempts, about four minutes.** It used to retry without a limit, one attempt every five seconds: one run on this machine couldn't reach a relay (ECONNREFUSED), resent 646 times and hung for 54 minutes while the conversation showed "running" and messages queued behind it. Ten attempts, backing off from 5 seconds to 30, rides out a network switch or a VPN reconnect, and "unlimited" is still an option. Fixed while there: normalisation dropped a missing strategy into `fixed` instead of leaving the family's own default, which would have quietly turned the new backoff back into every five seconds. A settings file saved before this keeps its old value — nothing is migrated.
- **A chart of data you already have goes into an interface block.** Asked to summarise something as a chart, the model read `plume://preview` and wrote an HTML page for data that was in hand. Both the preview tool's description and the interface-block prompt claimed "a chart", and the tool's description is much longer, so it always won. The chart example is out of preview's description, which now points at ```ui; diagrams, interactive tables, little games and layout drafts stay with preview.
- **Three rows that no longer earned their place are gone from the model dialog:** "Close thinking" (reasoning effort already has "Off"), "Manage providers and models", and "Make default for new conversations" — the default belongs in Settings → Models, and what you pick with no conversation open is the default anyway.

### Fixes

- **Writing a file outside the project asks, instead of being refused and then written through the shell.** `write` and `edit` refused anything outside the workspace root with "Path escapes the workspace root", while `bash` writing outside was only a `write-outside-project` risk that one click cleared. Told to save a file on the desktop, the model was refused and turned around with `cat > … <<EOF`: the door stopped nothing and pushed the write off the path that keeps a diff card, reads before it writes and records the change. It goes through the approval the tool already knows how to ask for: every time in "ask", judged as write-outside-project in "auto", not at all in "full", the same as bash. Two places still refuse — `~/.plume` outside the scratch directory, where settings, credentials and skills live, and a symlink inside the project that points outside it, because the card shows the path it was handed (the error now gives the real one).
- **The main agent stops waiting on a subagent when another conversation writes in.** Only you speaking made it let go and read what had arrived; mail another conversation sends with `steer` is written by the runtime, so it sat unread until every subagent had handed in — and a long turn waits on a subagent for seven-odd minutes here, while the sender is usually sitting in `wait_for_session` waiting for exactly that. One rule covers both now. Background results still don't let go — a subagent let go of would release the ones waiting beside it — and neither does mail queued for after this turn.
- **Video and audio in the file panel can seek.** Every file went through `net.fetch(file://)`, answered 200 with the whole file, and with no Range response Chromium decides the source can't seek: `seekable` was [0, 0] and dragging the bar or setting `currentTime` snapped back to the first frame. Audio and video are answered 206 with `Content-Range` and `Accept-Ranges`, 416 past the end; everything else takes the old path.
- **Opening a page in the built-in browser no longer reports that the panel isn't ready, and a crashed page no longer takes Plume down with it.** A site that didn't answer within 30 seconds failed with "the browser panel wasn't ready within 30 seconds", because the panel only checked in with the main process once the page was dom-ready; it checks in on did-attach now, and the "document ready" wait the agent needs is separate — 30 seconds, then the site is reported unreachable with its tab left open. A renderer crash segfaulted Plume's main process, in shipped versions too (killing the page process reproduces it): the panel added an error row that made the page shorter, then resized a guest that no longer existed. Zoom and viewport are applied to the page by `applyView`, skipping a crashed one; the first crash reloads by itself, and a second within 15 seconds stops on the error. Failures and crashes are a layer over the page area that says why and offers a reload instead of pushing the page around, and the failed state clears when you navigate.
- **Dialogs nobody could answer no longer cost the agent 15 seconds each.** A page's `alert`, `confirm` or before-unload prompt made every step wait its full 15 seconds and a new tab 30, because the renderer can't answer the system dialog Electron puts up; agent-side calls answer it now and write the answer into the result. `read` returns elements one per line with a ref, numbered across tags, and a ref from an older page reports itself stale rather than clicking the wrong thing. A click checks the target is visible, enabled, not moving and not covered, waiting up to 3 seconds and naming whatever covers it. `back`, `forward`, `reload` and `wait` — for text, an element or an expression, across a navigation — are there, and clicking a link no longer waits 15 seconds for nothing. `browser_open` says why a site wouldn't open instead of handing back a blank error page.
- **A path typed into the address bar works with "Open in external browser".** The button only knew about the page the tab had loaded, so with `~/Desktop/…html` typed and no Enter pressed on a blank tab it stayed grey — and pressing it blurred the input, which restores the page's address, which on a blank tab is nothing. What you have typed is handed over now, and with nothing typed it is what's on screen; the button no longer takes focus away. Addresses still pass through the main process: web addresses go to the system, local paths have `~` expanded and only `.html` opens.
- **The line for a message from another conversation is no longer bold from end to end.** Every step row's title is `font-medium` and the others are two or three words ("Thinking"), where that reads as a label; this one holds "From + conversation title", so it read as one long bold line, louder than the summary. "Open this conversation" also sat at the bottom of the expanded body, so you had to read the whole message to find it — it is a permanent icon button at the end of the line now, with the same tooltip.
- **GLM models show Zhipu's Z instead of a neutral square.** The brand table had no Zhipu and nothing matched an id like `opencode-go/glm-5.3-flash`, so those rows drew the placeholder. The mark comes from z.ai's favicon — bigmodel.cn uses the same Z — with the dark rounded plate taken off, so it works as a single-colour mark like OpenAI's.
- **With reduced motion, an interface block is no longer clickable before it has finished writing.** Its "writing" state rode on `fade`, and `fade` doesn't light up when motion is reduced.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 新功能

- **工作树跟着会话走，会话也能把活交回来。** 新会话的输入框上多了一颗 ⑂ 开关，设置里那个原来全局的开关退成默认值，选的结果随第一条消息下去。会话建好后仍归在原来的项目下，不再每开一个就在侧栏多一个同名项目；工作树没建成时，输入框上一直挂一条琥珀色提醒，而不是一声不吭地回到项目目录里改。从 ⑂ 芯片（`⑂ 分支 ↑2 ↓1`）可以把会话里的提交合回 main、把 main 的新提交拉进来：项目正好检出在这里时就地 `--no-ff` 合并，哪里都没检出时不动工作区就合，分支被别的工作树占着时拒绝。合并冲突立刻 abort、项目原样留下；同步冲突留在工作树里，交给你处理或放弃。领先落后不算合并提交。
- **删掉或归档会话，工作树跟着收回。** 从前删除和归档都不管工作树，`~/.plume/worktrees` 只增不减；自动清理也认不出哪些是自己建的，只放过内存里在跑的会话，而且带 `--force`，没提交的改动跟着一起没了。现在有没提交改动的目录不收，删除确认框里画出会剩下什么；取消归档照原样检出回来。自动清理只收 `plume/session-*` 里没有未归档会话在用、且干净的，不再带 `--force`。
- **Tab 填入猜的下一句。** 默认关，开关在 设置 → 常规 →「下一步建议」：每轮多一次请求，开不开你自己定。这次请求从刚发出去的那次分叉，基本只付缓存读的钱——上一次请求既没读也没写缓存时干脆不发，那等于整段对话按原价重读一遍。它读回复末尾写了什么下一步、有哪些选项，以你原本要的为准；这一轮出过错时不猜，只说过两轮的对话也不猜。
- **模型弹窗按厂商筛。** 接了几个中转之后二三十个模型挤在一个列表里，而按名字搜的前提是你知道这个中转是怎么拼它的。现在左边一列厂商（全部 / 收藏 / 各家），点一下只看这一家，跨供应商汇总、仍按供应商分组；模型少于 8 个或只来自一家时不显示这一列。焦点一直在搜索框里：打完字高亮落在第一个匹配上，↑/↓ 移动、回车选中，输入法组字时的回车不算。
- **界面块在写的时候就有形状。** 图表、表格这类要等数据整段写完才画的块，从前在那之前一片空白、写完又在同一帧整块冒出来。现在还没写完的标签先在那个位置立一块点阵占位（涟漪、探针线、虚线外框和四角手柄）；写完时图表和表格先按自己的外框、网格线、柱子、单元格描一遍虚线，再由一条线自上而下揭开，其余元素只揭开。容器不给占位也不描线——按高度判断时整张卡片会被当成一个元素藏起来，后面写进去的内容要等线扫到才看得见。外观参考 transitions.dev 的 generation 效果，自己实现，不带它的尺寸标签、计数和坐标读数。

### 更省

- **摘要的请求量降到约四分之一。** 本机同样的会话从前要 315 次摘要，现在 82 次：第一次要等你已经说过三句，之后每多两句才再要一次，子 Agent 结果、别的会话发来的信这些运行时写进去的消息不算你说的。本机 187 个会话里一半只说过一句，而标题已经说清了那是什么。
- **也不再为「点开一个旧会话」花掉一次。** 从前是环境卡片开着的时候由渲染层掐表去要：点开一个早就停下的旧会话立刻花一次，而真在干活的会话不点开卡片就一直没有。现在主进程在每轮结束、一分钟内没有下一轮时自己在后台生成——下一轮开始就撤掉，到点还在跑也不要。卡片只读存着的那份、听推来的新一份，还没有摘要时整节不占位，失败了留一颗「重试」。
- **agent 读网页更省。** `read` 的元素一行一个、带 ref，体积降到原来约 28%；截图按 CSS 像素出图，Retina 上少花四分之三的 token。

### 变化

- **系统提示词不再鼓励用不上的抽象和兜底。** 三行相似的代码好过过早的抽象，只用得着一次的 helper 是把改动撑大。校验只放在用户输入、外部 API 这类真正的边界上，不给不可能失败的内部分支加兜底。
- **断线重试十次、约四分钟后报错。** 从前默认无限重试、每 5 秒一次：本机有一次连不上中转（ECONNREFUSED），重发了 646 次、挂了 54 分钟，期间会话一直显示在跑、发给它的消息都排着。现在默认重试 10 次、5 秒起递增到 30 秒，够熬过换网、VPN 重连；「无限重试」这个选项还在。顺带修了规范化时缺 strategy 一律落成 `fixed`、不看这一类自己默认的问题——不修的话新的递增默认会被悄悄改回每 5 秒。保存过设置的用户盘上还是旧默认，这次不迁移。
- **手里已经有数据的图表交给界面块。** 「总结一下会话数量，给我个图表看看」这种不需要脚本的图表，模型直接去读 `plume://preview` 写了一页 HTML。preview 的工具说明和界面块那段提示词都写着自己负责 "a chart"，而工具说明长得多，两边都认领时总是它赢。现在 preview 的例子里没有图表了，并指向 ```ui；图示、可交互的表、小游戏、布局稿照旧走 preview。
- **模型弹窗里少了三行。**「关闭思考」（推理强度里已经有「关」）、「管理供应商与模型」，以及「设为新会话的默认模型」——默认模型在设置页的模型里设，首页未开会话时选的本来就是默认。

### 修复

- **把文件存到项目外会弹审批，而不是先拒了再被 shell 偷偷写过去。** `write` / `edit` 对工作区外一律报 `Path escapes the workspace root`，而 `bash` 写到项目外只是 `write-outside-project` 风险、点一下就过。用户说「存到桌面上」时，模型被拒后转身用 `cat > … <<EOF` 写了过去：这道门什么都没挡住，只把写入从「卡片上有 diff、先读后写、留改动记录」的那条路推到了什么都没有的路上。现在工作区外交给工具本来就会发起的审批——ask 每次问，auto 判成 write-outside-project 而问，full 不问，和 bash 一致。仍然拒绝的两处：`~/.plume` 里除 scratch 之外的地方（设置、凭据、技能在那儿，能写就能改掉自己的权限），以及工作区里指向外面的符号链接（卡片按字面路径显示，借链接写出去时卡上只有链接的名字，报错里现在给出真实路径）。
- **别的会话插进来的信，也让主代理不再干等子代理。** 从前只有人插话会让它放手先读消息，而另一个会话用 `steer` 插进来的信是运行时写的，于是一直压到子代理全部交差才被读到——本机实测长轮里等一次子代理平均七分多钟，而发信那一方往往正卡在 `wait_for_session` 上一起等。现在人说的话和别会话插进来的信是一条判断；后台结果的送达仍然不算（放掉一个跑完的子代理，会把其余还在等的也一并放掉），排队等这一轮做完再看的那种信也不算。
- **文件面板里的音视频能拖进度条了。** 所有文件都走 `net.fetch(file://)`、回 200 和整个文件，而拿不到 Range 响应时 Chromium 就认定这个源不能跳：`seekable` 是 [0, 0]，拖进度条或设 `currentTime` 都落回第一帧。音视频现在按 Range 回 206，带 `Content-Range`、`Accept-Ranges`，越界回 416；其余文件仍走原来那条路。
- **内置浏览器开页不再报「面板没就绪」，网页崩溃也不再带走整个应用。** 站点 30 秒不回第一个响应，开页就报「浏览器面板没有在 30 秒内就绪」——面板要等 dom-ready 才向主进程报到；现在 did-attach 就报到，agent 要等的「文档就绪」另算，最多 30 秒，超时就说站点打不开、标签留着。网页进程崩溃会让 Plume 主进程段错误退出（已发布版本就有，杀掉页面进程即可复现）：崩溃后面板插了一行错误把页面挤矮，随后又对一个已经不存在的 guest 调设备仿真。缩放与视口改由 `applyView` 落到页面上、跳过崩溃的；第一次崩溃自动重新加载，15 秒内再崩就停在错误上等人。加载失败和崩溃改成盖在页面区域上的一层，写原因、带重新加载，不再挤动页面，换页后红字也跟着清掉。
- **agent 操作网页不再为没人应答的对话框付时间。** 页面的 `alert`、`confirm`、离开提示会让每一步等满 15 秒、开新页等满 30 秒，因为渲染层应答不了 Electron 弹的系统对话框；现在 agent 调用期间由主进程那一侧应答，并把结果写进返回值。`read` 的元素一行一个、带 ref，编号按标签接续，旧页的 ref 只报失效不会点错；点击前确认目标可见、未禁用、不在动、没被遮挡，最多等 3 秒，被挡住时说清是谁挡的。新增 `back`、`forward`、`reload`、`wait`（跨跳转等文字、元素或表达式），点链接不再每次白等 15 秒。`browser_open` 打不开站点时报出原因，不再交回一页空白错误。
- **地址栏里打了没回车的路径，「在外部浏览器中打开」也能打开。** 那颗按钮原来只认标签上已经打开的那一页：空白标签上贴一条 `~/Desktop/…html` 不回车，它是灰的；而按下按钮那一刻输入框先失焦，失焦又把地址还原成页面的，空白标签上就是清空。现在有打字就交出去回车会打开的那一个，没打字才是屏幕上那一页，按钮按下也不再夺走输入框的焦点。地址照旧在主进程过一遍：网页地址交给系统，本地路径展开 `~` 后只开 `.html`。
- **跨会话消息那一行不再整段加粗。** 过程行的标题统一是 `font-medium`，别的行标题是「思考」这种两三个字的词，加粗读作标签；这一行标题装的是「来自 + 会话名」，整段加粗成了一行粗字，比摘要还抢眼，改回常规字重。「打开这个会话」原来挂在展开后正文的最底下，要先把整封信读完才找得到，现在挪到这一行末尾，做成常驻的图标按钮，悬停提示原文案。
- **GLM 模型显示智谱的 Z，不再是一个中性方块。** 品牌识别表里没有智谱，`opencode-go/glm-5.3-flash` 这类 id 匹配不到任何一家，只能画占位方块。标志取自 z.ai 的 favicon（bigmodel.cn 用的是同一个 Z），去掉原图的深色圆角底板，按单色标志处理，和 OpenAI 一样。
- **减弱动效时，界面块不再在写完之前就能点。** 它那个「正在写」的状态挂在 `fade` 上，而减弱动效时 `fade` 不会亮。

</details>

## [0.9.29](https://github.com/wJiaaa/Lyra/releases/tag/v0.9.29) - 2026-10-13

<!-- plume:notes en -->

### New

- **A gallery of every picture you have drawn, from every conversation.** It sits in the sidebar under Plugins. Pictures are laid out like an album — grouped by day (Today, Yesterday, then the date), newest first, each one at its own aspect ratio rather than cropped into a square. Hovering brings up what you asked for and which conversation it came from, and a picture that took several steps wears a "3 steps" chip in its corner. The search box looks through what you asked, the prompts the model wrote and conversation titles. Clicking one opens it over the gallery, ← → move through the rest, Esc closes; the conversation's title takes you back to that conversation, and "Show in conversation" jumps to the picture where it sits in the transcript, opening the conversation first if it wasn't open.
- **How each picture was made.** Next to the picture is the chain that led to it, one thumbnail per step, top to bottom, each step labelled with what you said at the time plus "Drawn" or "Edited" and when. A picture you attached yourself says so; a copy you marked up says so; a step that can no longer be traced back says "original not found" rather than guessing. Clicking any step switches to that picture.
- **Change a picture without going back to find it.** Under the picture there is a pencil to annotate it, a box to say what should change, and the same send button the composer uses: Enter sends that picture back into the conversation it came from, attached as it is, so the new one is linked to the old. Marks without a word don't send anything — they open that conversation with the marked copy in the composer and wait for you to say what should change. When the new picture lands, the gallery settles on it (it waits up to ten minutes, and won't pull you away if you've moved on to another picture).
- **Projects close on hover.** Hovering the project chip next to the composer brings out a ✕ on its right; clicking it leaves the project without opening the switch-project menu first. The highlight stays on the whole chip while the pointer moves over to the ✕, and in a split view it focuses that pane and leaves the other one's conversation and draft alone.

### Changes

- The title bar keeps side chat, terminal and diff; the browser moved into the "⋮" panel menu with the other panels. Its shortcut is unchanged.
- After 20 requests without a word to you, the automatic nudge no longer asks the agent what it has finished — that asked for a conclusion before the evidence was in, and one was wrong. It now asks what it's doing and what's next, and says not to state unverified findings as fact.

### Fixes

- **A refusal written as an answer is no longer retried every 5 seconds.** When a provider refuses a request, some relays deliver the refusal as ordinary reply text ("The prompt could not be submitted … Generative AI Prohibited Use policy") and then a generic in-stream error; Plume read only the error, called it a server fault, said "server error, retrying in a few seconds" and resent every five seconds, streaming the same refusal again, until you stopped it by hand. The refusal is now recognised — a short piece of visible text (under 600 characters) matching what providers actually write when they refuse — and the turn ends saying it was refused under the content policy, with the request not worth sending again unchanged. For image models on the chat route the card says the same thing. A long answer that merely mentions safety still retries as before.
- **An MCP tool whose array parameter has no element type no longer breaks every turn.** `{"type": "array"}` is legal JSON Schema and common in MCP servers, but relays that send the tool list as protobuf reject the whole request over it ("parameters.properties[machineIds].items: missing field"), so every turn failed for old and new conversations alike, and there was nothing to connect it to the MCP server you had installed. Arrays without an element type are now filled in as accepting anything, which changes nothing for providers that took the bare array.
- **Closing a browser tab no longer raises "browser tab closed".** Clicking ✕ while a page was still loading, or refreshing just as the agent closed the tab, surfaced the internal timing error with its `Error invoking remote method` prefix. The panel just puts that cell away now; the agent's own browser tool still learns its tab is gone.
- **`edit` works on `scratch://` addresses.** It used to read `scratch://x` as the relative path `<project>/scratch:/x`, so the read-before-edit record never matched and every edit to a temporary file was refused with "read it first" — and rereading it, as the error suggested, didn't help; one session spent four rounds going around this. Read, write and edit now resolve the same address to the same file on disk.
- **The plan mode switch doesn't shift its icon 2px.** Off and on were two different buttons — 6px from the left edge and 8px — so toggling rebuilt it and the icon jumped sideways, with the background snapping instead of fading. It's one button in both states now.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 新功能

- **画廊：所有对话里画过的图，收在一处。** 入口在侧栏「插件」下面。图按相册排：按天分组（今天、昨天，再往前是月日和星期），最新的在最上面，每张按自己的原始比例排而不是裁成方块。指上去浮出你当时说的那句话和它来自哪个对话，要经过好几步才画成的图，角上有一枚「3 步」的胶囊。顶上的搜索框会翻你说过的话、模型写的提示词和会话标题。点开一张就盖在画廊上，← → 翻下一张，Esc 关掉；右边的会话标题点一下回到那个对话，「在对话中查看」跳到转录里那张图的位置，对话没开着就先打开它。
- **每张图是怎么来的。** 图旁边是它的生成链路，一步一张缩略图，从上到下，每一步写的是你当时说的那句话，配「生成」或「修改」和当时的时间。你自己附进去的图、在图上标注过的副本都标出来是哪一步；倒推不出来的那一步写「原图找不到了」，不猜。点链路里任意一步就切到那张图。
- **改图不用再回对话里把图翻出来。** 图下面一条编辑栏：左边一支笔用来在图上标注，中间写想怎么改，右边是和对话里同一颗发送按钮——回车就把这张图带着发回它所在的对话，字节原样回去，所以新图和原图连着。只标注、没写字时不自动发，而是打开那个对话、把标注图放进输入框，等你说要改什么。新图画好之后画廊自己停到那张上（最多等十分钟，你已经翻到别的图就不会被拉走）。
- **悬停就能关掉项目。** 输入框旁边的项目芯片指上去，右边浮出一颗 ✕，点它直接不在这个项目里工作，不用先打开「切换项目」菜单。鼠标从名称移到 ✕ 上的过程中整块高亮不消失；分屏里点它会先聚焦那一屏，另一屏的会话和草稿都不动。

### 变化

- 标题栏常驻的只剩侧聊、终端和 diff，浏览器按钮并进「⋮」面板菜单里和其他面板一起。快捷键照旧。
- 连续 20 次请求没对你说过话时的自动提示，不再要它讲「做完了什么」——那是在证据没齐时要阶段性结论，出过错。现在只问在做什么、下一步做什么，并明说没核实的发现别说成定论。

### 修复

- **被拒不再每 5 秒重试一次。** 服务商拒绝某个请求时，有的中转让这段拒绝从回答正文里流出来（`The prompt could not be submitted … Generative AI Prohibited Use policy`），随后再补一个泛泛的流内错误；Plume 只认了那个错误，判成服务端故障，界面上写「服务端故障，几秒后重试」，每 5 秒把同一段拒绝再流一遍，直到手动按停。现在认得出这是被拒：只有一小段可见文字（600 字符以内）命中服务商真在用的拒绝句式才算，这一轮到此为止，并写明是按内容策略被拒、原样再发还是会被拒。生图走对话接口时卡片上也这么写。长回答里顺口提到 safety 的情况和以前一样照常重试。
- **MCP 工具的数组参数没写元素类型，不再让每一轮都失败。** `{"type": "array"}` 是合法的 JSON Schema，MCP 服务器里很常见，但把工具列表按 protobuf 发出去的中转会因此拒掉整个请求（`parameters.properties[machineIds].items: missing field`），新旧会话一律失败，而且人不会把它和自己装的那台 MCP 服务器联系起来。现在这种数组按「元素任意」补全，本来就接受裸数组的服务商不受影响。
- **关掉网页标签后不再弹「浏览器标签已关闭」。** 页面还在加载时点 ✕，或者 agent 刚关掉标签、人正好在刷新，会把主进程内部这个时间差连 `Error invoking remote method` 前缀一起弹成报错。现在面板把那一格收掉就算了；agent 自己的浏览器工具照样知道标签没了。
- **`edit` 能直接改 `scratch://` 里的文件。** 以前它把 `scratch://x` 当成相对路径读成 `<项目>/scratch:/x`，「先读再改」的记录永远对不上，每次编辑临时文件都报「先读再改」，照着报错重读一遍也没用——有一个会话为此多花了 4 轮。read、write、edit 现在把同一个地址解析到磁盘上同一个文件。
- **点计划模式开关，图标不再横移 2px。** 关着和开着原本是两颗不同的按钮，离左沿分别是 6px 和 8px，一点开关就重建元素、图标跟着横跳，背景也跟着硬切而不是渐变。现在两种状态是同一颗按钮。

</details>

## [0.9.28](https://github.com/wJiaaa/Lyra/releases/tag/v0.9.28) - 2026-10-13

<!-- plume:notes en -->

### New

- **The image tool works the way upstream's does**, under the name `image_generate`. It calls the provider's Images API first and falls back to the chat endpoint when that provider has none, remembering which one it is. Aspect ratio, quality, count and background are translated into each family's own spelling by Plume — the model used to guess, and relays that only draw through the chat endpoint didn't work at all.
- **Changing a picture** uses `#1`, `#2` to name the ones in the conversation, newest first. Each picture gets three attempts; a spent quota or a key that isn't allowed that model is not retried — the card says which, and about when the quota comes back.
- **Image models are their own kind.** Turn on "Image model" for a provider's model in Models: conversation pickers no longer offer them (picking gpt-image-1 there failed every turn), and an image model's "Test by drawing one small picture" really draws one, billed.
- **The card in the conversation** holds the shape it will fill while the picture is drawn, with the stage on its top line and an estimate in the corner, "Connection hiccup — retrying" when it retries, a picture that goes from blurred to sharp without the frame moving, and the model and size once it's done. Hovering gives Edit and Download.
- **Viewing a picture:** the zoom no longer starts as a 0.4 ghost with the backdrop black on its first frame, and the annotation canvas sits over the picture instead of replacing it, so Edit goes straight into annotating. Annotating a picture in the conversation and pressing Done puts the annotated copy into that conversation's composer.
- **The fetch-models dialog removes as well as adds.** Models you have are checked, ones the endpoint didn't list are marked as such, unchecking removes, and typing an id and pressing Enter adds one it didn't list. The model list can delete several at once; before it was one at a time, each with its own confirmation.
- **Long pages are checked in parts.** When a page is taller than 2160px, the result says where the next part starts, and passing that back photographs that part. The model used to split the page into p1~p5.html and check each one — a dozen extra calls for one landing page. The result also always says which width it was checked at.
- **The thinking row counts seconds.** While it runs it shows how long this stretch has been going (from the start of this thinking, not of the turn) beside the word, and the word changes as the thinking gets longer, dropping into place while the seconds after it slide over rather than jump.
- **Edits replace the text you can see again.** Changing one word no longer means retyping the whole line; where one line is a thousand characters (LaTeX, a Markdown paragraph), models wrote a script to batch the change rather than edit the file. The model now gives the passage and what it becomes, with the same safety as before: the file was read, hasn't changed since, and the passage is unique in it. A passage that doesn't match gets the familiar deviations tried first — curly quotes, a line-number prefix, escaping — and the edit goes through only when one reading fits.

### Cheaper

- The preview tool's 5,300-character description no longer rides along with every request. Ten of 142 real conversations used it, and none of the 27 pages used the page API; the page API is read from `plume://preview` and the interface-block syntax from `plume://ui`, both just before they are needed.
- A web page cut off by `web_fetch` goes into the conversation's scratch directory, with the path and the full length in the result. A 130,000-character source file arrived as its first 35,000, and the model downloaded it again with bash.

### Changes

- The agent verifies before handing something over — runs the tests, runs the build, pastes a failure as it came — instead of stopping at types that line up.
- Describing a problem or asking a question gets you a judgement, not an edit; asking for a change gets the change rather than a plan.
- Changes in your project that the agent didn't make are treated as yours: unrelated ones are left alone, related ones are built on, and neither is thrown away with checkout, reset or stash.

### Fixes

- **Relays and gateways.** Mistral's array content no longer becomes `[object Object]`; OpenRouter's in-stream errors are no longer swallowed as "upstream failed", so an exhausted quota and an over-long context are recognised; TGI's and Mistral's `finish_reason` aliases no longer throw away a whole good answer and retry; Kimi's usage under `choices[0]` is read, so the cost isn't recorded as 0; MiniMax's resent reasoning snapshot no longer adds a second thinking block; tool arguments that arrive again or split across objects no longer lose keys; a host that doesn't close the connection after `finish_reason` no longer makes Plume wait out the idle gate and resend an answer it already had.
- **How failures are classified.** A 200 that isn't SSE (an error written as JSON, a URL pointing at a web page, one non-streaming JSON body), an error frame with no `error`, and reasoning that used up the output limit all used to land as "empty answer", be resent four times, and have the original thrown away. A certificate error now looks at the innermost cause, a 407 from a proxy no longer counts as a dropped connection to retry forever, and a server's stated wait is honoured up to five minutes instead of one.
- **Thinking is turned off the way each vendor documents it.** Gemini and the o-series reject "off", newer Claude wants adaptive, DeepSeek and GLM-5.2+ take `output_config.effort` instead of `budget_tokens`, and GLM-5.3 and Kimi K3 can't turn thinking off at all, so the setting no longer offers it. These rules were spread across three adapters, which is how turning thinking off on Gemini failed on the chat link entirely.
- **Stopping a turn on Responses no longer wrecks the conversation.** A reasoning item gets its id when it starts but its encrypted content only when it finishes; stopping mid-reasoning replayed an item with just an id, the server couldn't find it, and every turn after that failed. An unfinished reasoning item from an interrupted or failed turn is no longer replayed.
- **One rejected signature no longer turns off Anthropic reasoning replay for the whole process.** The downgrade was written to a process-wide table and never undone when a retry succeeded, so a problem in one conversation's own history left every conversation on that model without replayed thinking blocks until a restart. It now applies to that one retry, and, once that works, to that conversation.
- **Errors raised before the request goes out are not retried forever.** A zero-width character in a key, https against a local server that only speaks http, an untrusted certificate — all of these were classified as network errors, and network errors retry without limit, so the window just said "Connection dropped" and kept reconnecting. They now end the turn and say what happened.
- **A long reasoning stream is no longer cut off at five minutes.** The idle gate says ten minutes, but Node's built-in fetch cuts the body after 300 seconds with no bytes, so a legal five-minute silence was treated as a dropped connection and resent from the start, billed again. The clock now resets on bytes that arrive.
- A call to a tool that takes no arguments, with its arguments written as `null`, is no longer refused as unfinished JSON: `null` is complete, legal JSON and means the same as `{}`.
- **A batch of interface problems fixed upstream after the v0.9.22 fork**, which this code has too: overlays and dialogs that vanished without playing their exit when a button or the caller dismissed them; a dialog that jumped back to full opacity before fading when Esc was pressed during its entrance; the projects menu landing on the button for a frame when there are many projects; a sidebar title flashing back to the old one when it is rewritten twice in a row; the screenshot magnifier appearing as an empty black box the first time; the "running" row disappearing in a single frame when a turn ends with no text (tools only, stopped, or an error); a picture dropped into the composer being deleted by the next keystroke and the attachment tray vanishing for a frame; Done on a picture annotated inside a sent message doing nothing, because the canvas was tainted by `ly-media://` and the failed export was silent; and a preview card stuck at 440px while the machine was busy.
- Two high-severity dependency advisories cleared: undici to 7.30.0 and linkify-it to 5.0.2.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 新功能

- **画图的工具改成上游的做法**，名字也改成 `image_generate`。先请求服务商的 Images 接口，这家没有这个接口时改走对话接口出图，并记住它属于哪种。比例、清晰度、张数、背景由 Plume 按模型家族换算成各家的写法——以前模型得自己猜，只能经对话接口出图的中转干脆用不了。
- **改图时用 `#1`、`#2` 指对话里的图**，按新到旧数。每张最多试 3 次；额度用完、密钥没开这个模型就不重试，卡片上直接写是哪种，以及额度大约什么时候恢复。
- **生图模型单算一类。** 在「模型设置」里给供应商的模型打开「生图模型」：对话模型的列表里不再出现它们（以前在那里选中 gpt-image-1，每一轮都失败），生图模型自己的「画一张小图测试」是真画一张，会计费。
- **对话里的卡片**按要的比例先把地方占住，上面一行写进行到哪一步，角上是估计的进度；重试时写「连接不稳，正在重试」；图到了从模糊变清晰、框不动；画完写用的是哪个模型、多大尺寸，指上去有「编辑」和「下载」。
- **看图**：放大不再从 0.4 的淡影起步、遮罩第一帧也不再全黑；标注画布叠在图上而不是替换它，从「编辑」直接进标注。对话里的图标注完按「完成」，带标注的副本进这一屏的输入框。
- **拉取模型的弹窗现在能删也能加。** 已经添加的默认勾着，这次端点没列出的标出来，取消勾选就是移除，敲一个模型名回车能加一个没列出的。模型列表可以勾选后一次删掉多个，以前只能一个一个删、每个确认一次。
- **长页面分几段检查。** 页面比 2160px 高时，结果会给出下一段的起点，带上它再检查一次就截那一段。以前模型只能自己把页面切成 p1~p5.html 逐个检查，一个宣传页多花十几次调用。结果也总会写明按多宽检查。
- **思考行会走秒。** 运行中的思考行除了那个词，还写这一段已经想了多久（从这一段思考开始算，不是整轮），词也随想的时间往下换；换词时新词落入，后面的秒数被推过去而不是跳。
- **改文件改回按原文替换。** 改一个词不用再把整行原样重打——一段一行的文本（LaTeX、Markdown 段落）一行上千字，模型宁可写脚本批量套改动也不直接改文件。现在它给出一段原文和要替换成什么，安全照旧：那个文件读过、读完之后没有被改过、原文在文件里唯一。原文对不上时先试弯引号、行号前缀、转义这些常见偏差，只有一种解释对得上才替换。

### 更省

- preview 那 5,300 字符的工具说明不再跟着每次请求走。142 个真实会话里只有 10 个用到它，27 个页面没有一个用过页面里那组接口；现在页面接口从 `plume://preview` 读、界面块的写法从 `plume://ui` 读，都在要用之前才读。
- `web_fetch` 截断的正文存进会话的临时目录，结果里给出路径和完整长度。一份 13 万字的源码以前只给前 3.5 万，模型只好用 bash 再下一遍。

### 变化

- agent 交东西之前会先跑起来验证：跑测试、跑构建，失败贴原文，不再停在类型对得上。
- 你在描述问题、问它问题的时候，它给的是判断，不会顺手改；要它改的时候也不停在方案上。
- 项目里不是你做的改动，它当成你的：无关的不碰，有关的接着改，不用 checkout、reset、stash 丢掉。

### 修复

- **中转和网关。** Mistral 把 content 写成数组时不再变成 `[object Object]`；OpenRouter 的流内错误不再被吞成「上游失败」，额度不足和上下文超长都认得出；TGI、Mistral 的 `finish_reason` 别名不再把整段回答作废重试；Kimi 放在 `choices[0]` 里的 usage 读得到，花费不再记成 0；MiniMax 重发的推理快照不再多出一个思考块；工具参数被重发或按对象分片时不再丢键；收到 `finish_reason` 之后不关连接的宿主，不再让 Plume 干等满空闲闸、把已经答好的回答丢掉重发。
- **失败怎么分类。** 200 却不是 SSE 的（错误写成 JSON、地址指到了网页、整份非流式 JSON）、不写 `error` 的错误帧、推理把输出上限用完的空回答，从前都落成「空回答」、重发四次、原文丢掉。证书不受信任现在看 cause 链最里层，代理的 407 不再当断线无限重试，服务端给的等待时间最多认到 5 分钟而不是 1 分钟。
- **思考按各家文档的写法关。** Gemini 和 o 系列拒绝「关闭」，新 Claude 要 adaptive，DeepSeek 与 GLM-5.2+ 改发 `output_config.effort` 而不是 `budget_tokens`，GLM-5.3 和 Kimi K3 根本关不掉，所以界面上不再给这一档。这些判断原来散在三个适配器里，Gemini 上关思考在对话链上全挂就是这么来的。
- **在 Responses 上按停止，会话不再报废。** 推理块的 id 在项开始时就有了、密文要到结束才有；推理到一半按停止，下一轮会回放一个只有 id 的推理项，服务端找不到它，之后每一轮都失败。中断或出错那一轮没写完的推理块现在不回放。
- **一次签名被拒，不再让整个进程关掉 Anthropic 的思考回放。** 降级原来写进进程级的表，重发成功了也不撤销，于是一个会话自己历史里的问题，让同模型的所有会话都不再回放思考块，直到重启。现在降级只用于这次重发，成功了记在这个会话上。
- **请求发出之前就失败的错误不再无限重连。** 密钥里混进零宽字符、用 https 连了只开 http 的本地服务、证书不受信任——这些在请求发出前就抛的错误从前一律判成网络问题，而网络问题不限次数重试，界面上只看见「连接中断」一直转。现在判终局，并说明是怎么回事。
- **长推理流不再五分钟被切断。** 空闲闸写的是十分钟，但 Node 内置的 fetch 默认 300 秒没有字节就切断响应体，一条合法沉默五分钟的推理流会被当成断线、从头重发、重新计费。空闲计时改成按收到的字节重置。
- 不带参数的工具，参数被写成 `null` 时不再当成没写完的 JSON 拒绝：`null` 是完整合法的 JSON，意思和 `{}` 一样。
- **一批上游在 v0.9.22 分叉之后修过、我们也有同样毛病的界面问题**：浮层和对话框点按钮或由调用方关掉时直接消失，不播退场；对话框入场途中按 Esc，会先跳回不透明再淡；项目多的时候「项目」菜单打开的第一帧盖在按钮上；侧栏标题连着改两次会先闪回旧标题；截图放大镜第一次出现是一个空的黑框；一轮没有正文就结束（只调了工具、被停、出错）时「运行中」那一行一帧就没了；递到输入框里的图一打字就被删、附件托盘收起时一帧消失；已发消息里的图标注完按「完成」没反应，因为画布被 `ly-media://` 污染、导出失败又没出声；预览卡片在机器忙的时候锁死在 440px。
- 依赖里两条 high 清掉：undici 升到 7.30.0，linkify-it 升到 5.0.2。

</details>

## [0.9.27](https://github.com/wJiaaa/Lyra/releases/tag/v0.9.27) - 2026-10-12

<!-- plume:notes en -->

### New

- **Plan mode.** Turn it on with `/plan` or the "Plan mode" chip on the input box. The agent then only reads and investigates: edits are refused, and shell commands are limited to read-only ones in a read-only sandbox. It hands you a plan as an approval card; once you approve it, the plan becomes the task list and stays there through compaction. You can switch it on in a new conversation before sending anything, so the first message doesn't run as a normal turn first.
- **Select text in a reply to ask about it.** A small menu appears above the selection: "Ask in side chat" or "Quote in message". Quotes sit above the input box as "2 quotes" instead of filling it with `> …` lines; hover to read them and remove them one at a time. `/btw <question>` asks in a new side chat and leaves nothing in the main conversation.
- **Side chat can edit files and run commands.** It is now a conversation attached to the main one, with its own short prompt and 13 tools. Before each question it is told what's new in the main conversation, and when it changes files, the main conversation hears about it at the start of its next turn. Side chats saved in `~/.plume/sidechats` by earlier versions are not carried over.
- **An Environment card in the title bar** collects what used to be scattered: how the conversation is opened, background jobs, subagents, the pull request for this branch, side chats, a running summary, and the images and files that came into the conversation. Each row opens the panel or viewer that already exists. In wide windows the conversation moves 324px to the left so the card doesn't cover it. The summary model is set under Settings › Subagents and follows the conversation's model by default.
- **Pages the agent makes can be copied as an image**, as you left them after clicking around. The whole page is copied, including the part folded below 720px or scrolled out of view.
- **Those pages remember what you set.** Values you change with a page's controls are kept when you reopen the conversation, and the model gets them with your next message. Design pages can offer sliders, colors, switches and menus under "Adjust design": dragging updates the page without asking the model, and "Apply these settings" sends only the values you changed.
- **The thinking row says "Thought for 12s"** instead of printing the reasoning word by word. While it runs it shows one label such as "Brainstorming". Under a second, or when a relay sends all the reasoning at once, it says "Thought for a while".
- **Switching models draws a line in the conversation** saying which model it switched from and to. It goes by which model actually answered, so changing the menu without sending anything leaves no line. Older conversations show it too.
- **The conversation hover card leads with what it cost**: main conversation, subagents and side chats added together, "Unpriced" when the model has no price instead of $0. A second row splits the tokens between those three. Side chats and subagent panels now have their own context meter.
- **Files can be dropped anywhere on the conversation**, not only on the input box. A dropped folder becomes an attachment chip instead of a long `@"/var/folders/…"` path, and chips use the file tree's icons for each file type.
- **MCP servers that need a sign-in can connect**, such as the official GitHub, Linear and Notion servers; Plume handles the OAuth flow and keeps the tokens in its vault. Server prompts show up in the `/` menu, and a server can ask you to fill in a form partway through a task.
- **Many MCP servers no longer crowd the context.** When their tool descriptions add up to more than 3,000 tokens, the model gets a catalog and two tools to search and call them. With 30 servers, that is 9.8k tokens instead of 38.7k. A server that hangs no longer holds up the conversation for 32 seconds; the first turn waits at most 5.
- **`lsp` works for Python, Go, Rust and C/C++** when basedpyright or pyright, gopls, rust-analyzer or clangd is on your PATH. If the server isn't installed, the result says which one to install instead of quietly falling back to text search.
- **ripgrep comes with the installer.** Started from the Dock or the Start menu, Plume couldn't see your own `rg`, and every search used the slow fallback: 1,789ms against 46ms on this repository.
- **Questions about Plume itself are answered from its own help.** "How do I add an MCP server", or a pasted error message, is answered from 21 bundled pages on commands, settings, permissions, extensions and common errors. Before, the model searched through the app's files.
- **Two new hook events: `StopFailure` and `SessionEnd`.** `StopFailure` runs when a turn ends with an error, is stopped, or hits a limit; `SessionEnd` when a conversation is deleted, archived, moved or the app quits. Dashboards like Vibe Island no longer show a session as working forever.
- Hooks run inside a subagent show up in that subagent's panel, and hook input now includes `agent_id`, so two subagents of the same type can be told apart.
- After 20 requests without reporting back, the model is asked where things stand: the task list is read back to it if there is one, otherwise it is asked for a sentence or two. It is never stopped for this. In 367 past runs, 301 finished within 20 requests and would never have been asked.
- Magpie can manage Plume's models; new conversations go through its gateway.

### Cheaper

- **A new conversation starts 24% lighter.** Before you type anything, the context meter reads 10.6k instead of 14.1k, with the same tools.
- **Compaction reads from the cache.** The summary request is the previous request sent again with one instruction added, so the conversation before it costs cache price instead of full price. If a turn ends past the line, compaction runs right away while the cache is still warm; anything you send in the meantime goes out after it.
- After an edit, the result shows the changed lines with their new line numbers. In past conversations, 71 of 154 edits were followed by reading the same file again.
- Files under 300 lines are read in full instead of being folded into an outline, which the model then read back piece by piece. The symbol index now covers the whole project; on this repository it used to stop halfway.
- Checking a background job that has no new output waits up to 30 seconds for output or for the job to end. Before, 39 of 47 checks came back with "(no new output)", each one a full request.
- Web pages and MCP results close to 40,000 characters were cut to their first 4k and last 1k before the model saw them. They now arrive whole.

### Changes

- Subagents no longer start subagents of their own; splitting work is left to the main conversation. An extension that blocks a call in the main conversation now blocks the same call in a subagent.

### Fixes

- **In "Auto approve" mode, a `PreToolUse` hook that asks for confirmation now gets it.** The approval policy answered in its place, and the call ran without asking.
- **`git checkout .`, `git restore .`, `git push origin +main`, `--mirror`, `git stash clear` and `git worktree remove --force` ask first.** They used to run without asking. Switching branches and unstaging still don't ask.
- Messages sent from the phone while a task is running wait for the turn to finish instead of cutting into it.
- **Chats outside a project each get their own folder.** They all shared `~/.plume/workspaces/general`, so a new chat could find files from older ones; one took a landing page made in another chat as your design preference. Existing chats keep their folder.
- With "Create a worktree for every new conversation" on and no root set, worktrees were made next to the repository, and staging, committing and pushing in them failed with "not inside an open project". They now go in `~/.plume/worktrees`. Existing worktrees are not moved.
- Settings › Commands was missing `/plan`. Several settings descriptions now say what actually happens: for example, "Ask for approval" said it asks before going online, but web search and web fetch never ask. The hook matcher placeholder reads `Write|Edit|Bash`; the comma-separated version it showed before matched nothing.
- **`glob`, `grep` and the symbol index see the same files git does.** Ignored build output is skipped, a committed folder that happens to be called `build/` is not, and hidden files such as `.github/workflows/package.yml` are found. Without ripgrep, a search across this repository dropped from 1.8s to 0.2s, and matches close together no longer print the same context twice.
- When the macOS sandbox blocks `top` or `sudo`, the model is told the sandbox refused it, not that a file write was denied, so it stops trying other ways to write a file.
- When the model writes an interface block without the ` ```ui ` fence, it shows up as text. The model is now told so on the next turn.
- Checking or stopping a background job shows "Read output" or "Stopped a command", not a job uuid.
- A file name in a reply that matches several files in the project opens a menu of their folders instead of "Cannot read this file".
- A long page title no longer pushes a right-column tab's close button out of view. Titles stop at 160px.
- Going back to a conversation with a panel open no longer moves what you were reading about 270px down.
- The "Chats" heading in the sidebar stays at the top while you scroll through it, like project names do.
- Running conversations in the sidebar show the breathing dot again instead of a column of spinning rings.
- The hover card no longer says "1 steps", or calls 12.3k cached tokens "12.3k cache reads".
- MCP tools meant only for a server's own web page are no longer given to the model.

### Removed

- **The compaction model setting.** A different model can't read the main conversation's cache, so compaction always uses the conversation's own model.
- The switch for building local memory from tool-assisted chat. Nothing ever read it.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 新功能

- **计划模式。** 用 `/plan` 或输入框上的「计划模式」芯片打开。打开后 agent 只读、只调查：改文件会被拒，命令只放只读的，跑在只读沙箱里。调查完交一份计划，以审批卡片的形式给你；批准后计划变成任务清单，压缩之后也还在。新对话还没发第一句话时就能打开，不必先让第一句话按普通模式跑完一轮。
- **对话里划一段文字，可以直接拿去问。** 选区上方出现一枚小菜单：「在侧边聊天中提问」或「引用到输入框」。引文不再以 `> …` 塞满输入框，而是在框上方显示成「2 条对话引用」，指上去看原文，可以逐条删。`/btw 问题` 会新开一格侧边聊天去问，主对话里什么也不留。
- **侧边聊天能改文件、跑命令了。** 它现在是挂在主会话旁边的一段对话，有自己的一份简短提示词和 13 件工具。每次提问前，它会收到主会话里的新进展；它改了文件，主会话下一轮开头会知道。旧版本存在 `~/.plume/sidechats` 里的侧边聊天不迁移。
- **标题栏多了一张「环境」卡片**，把原来散在各处的东西收在一起：会话用什么打开、后台任务、子智能体、这个分支的拉取请求、侧边聊天、会话摘要，以及进过这段对话的图片和文件。每一行都是入口，点了去已有的面板或查看器。窗口够宽时对话整体往左让 324px，卡片不盖字。摘要用的模型在「设置 › 智能体」里选，默认跟随会话模型。
- **agent 做的页面能复制成图片**，复制的是你点过之后的样子，而且是整页：折在 720px 以下的、滚出对话的部分都在。
- **这些页面记得你调过的值。** 用页面上的控件改过的值，重开对话还在，下一句话会一起交给模型。设计稿可以在「调整设计」里放滑块、颜色、开关、下拉：拖一下页面当场变，不经过模型；点「按这组设置修改」，模型只收到改过的那几项。
- **思考行写「思考了 12 秒」**，不再逐字滚动推理。运行中只显示一个说法，比如「头脑风暴中」。不满一秒，或者中转把整段推理一次吐出来时，写「思考了一会儿」。
- **换了模型，对话里会画一条线**，写着从哪个换到哪个。按实际回答的模型来认：只在菜单里换一下、一句没发，不会画线。旧对话也能看到。
- **会话悬停卡片先写这段对话花了多少钱**：主会话、子智能体、侧边聊天加在一起；模型没有单价时写「未定价」，不写 0 美元。第二行把 token 按这三处拆开。侧边聊天和子智能体面板也有了自己的上下文表。
- **文件拖到对话的任何位置都能添加**，不必瞄准输入框。拖进来的文件夹变成一枚附件标记，不再是一长串 `@"/var/folders/…"`；附件标记按文件类型用文件树里的图标。
- **需要登录的 MCP 服务器能连上了**，比如 GitHub、Linear、Notion 的官方 MCP。OAuth 由 Plume 走完，令牌存进它的保险库。服务器带的提示词出现在 `/` 菜单里；服务器也能在任务中途弹一张表单让你填。
- **接很多 MCP 服务器时不再挤占上下文。** 工具说明合计超过 3,000 token 时，模型拿到的是一份目录和两件工具，用来搜索和调用。接 30 台服务器时，这部分从 38.7k 降到 9.8k token。一台服务器卡住不再拖住会话 32 秒，首轮最多等 5 秒。
- **`lsp` 支持 Python、Go、Rust 和 C/C++**，前提是 PATH 上有 basedpyright 或 pyright、gopls、rust-analyzer、clangd。没装语言服务器时，结果会写明要装哪个，不再一声不吭地退回文本搜索。
- **安装包自带 ripgrep。** 从程序坞或开始菜单启动时，Plume 找不到你自己装的 `rg`，每次搜索都走慢的兜底：在本仓库上是 1789ms 对 46ms。
- **问 Plume 自己的事，它查自带的说明。** 「怎么加 MCP 服务器」，或者贴一句界面报错，模型会从随包带的 21 篇说明里找答案，涵盖命令、设置、权限、扩展和常见报错。以前它会去翻应用自己的文件。
- **钩子新增 `StopFailure` 和 `SessionEnd` 两个事件。** 一轮出错、被停下或撞上上限时跑 `StopFailure`；会话被删除、归档、移走或退出应用时跑 `SessionEnd`。Vibe Island 这类看板不会再让一个会话永远停在「工作中」。
- 子智能体里跑的钩子显示在它自己的面板上。钩子输入里多了 `agent_id`，同类型的两个子智能体能分得清。
- 连着 20 次请求都没汇报时，模型会被问一句进度：有任务清单就把清单念给它，没有就让它用一两句话说说现状。只问，不会因此停下。在过去 367 次真实运行里，301 次在 20 次以内就做完了，一次都不会被问。
- Magpie 能接管 Plume 的模型，新会话走它的网关。

### 更省

- **新对话一开始就轻了 24%。** 还没打字时，上下文表从 14.1k 降到 10.6k，工具一件没少。
- **压缩能吃到缓存了。** 写摘要的请求是把上一次请求原样再发一遍、末尾加一句指令，于是前面那一大段按缓存价计，不再按原价重读。一轮结束时已经过线，就趁缓存还热当场压掉；这期间你发的话排在压缩后面发出。
- 改完文件，结果里直接带上改动那几行和新行号。以前的会话里，154 次改动有 71 次紧接着又把同一个文件读一遍。
- 300 行以下的文件整份读出，不再先折叠成结构视图、再被模型一段段读回来。符号索引覆盖整个项目，以前在本仓库上只覆盖到一半。
- 查看一个没有新输出的后台任务时，最多等 30 秒，等到有输出或任务结束再回答。以前 47 次查看里有 39 次拿回的是「(no new output)」，每次都是一整次请求。
- 接近 40,000 字的网页和 MCP 结果，以前在模型看到之前就被剪成前 4k、后 1k，现在完整送到。

### 变化

- 子智能体不再派自己的子智能体，拆活交给主会话。扩展在主会话里拦下的调用，在子智能体里也一样拦得住。

### 修复

- **「帮我批准」模式下，`PreToolUse` 钩子要求确认的调用会先问你。** 以前审批策略替你答了，调用一声不响地跑了。
- **`git checkout .`、`git restore .`、`git push origin +main`、`--mirror`、`git stash clear`、`git worktree remove --force` 会先问一句。** 以前直接执行。切分支、取消暂存照常不问。
- 任务跑着时从手机发的消息，排到这一轮结束之后，不再插进正在跑的那一轮。
- **不在项目里的聊天各用各的目录。** 以前它们共用 `~/.plume/workspaces/general`，新对话会翻到旧对话留下的文件：有一次模型把另一段聊天做的宣传页当成了你的设计偏好。已有的聊天保留原目录。
- 打开「新建会话时自动创建独立工作树」、根目录又留空时，工作树建在了仓库旁边，在里面暂存、提交、推送都报「该目录不在已打开的项目内」。现在放在 `~/.plume/worktrees`。已经建好的不迁移。
- 「设置 › 命令」里漏了 `/plan`。几处设置说明改成和实际一致：比如「请求批准」说访问网络时会问，其实网页搜索和抓取从来不问。钩子匹配器的占位改成 `Write|Edit|Bash`，以前那种逗号分隔的写法什么也匹配不上。
- **`glob`、`grep` 和符号索引看到的文件和 git 一致。** 被忽略的构建产物不再搜，提交进仓库、只是恰好叫 `build/` 的目录不再被跳过，`.github/workflows/package.yml` 这种隐藏文件也搜得到。没有 ripgrep 时，全库搜一次从 1.8 秒降到 0.2 秒；挨得近的命中不再把同一段上下文印两遍。
- macOS 沙箱拦下 `top`、`sudo` 时，模型收到的是「被沙箱拒绝」，不再是「文件写入被拒」，不会再换着法子去写文件。
- 模型写界面块时漏了 ` ```ui ` 围栏，界面上会显示成一段文字；现在下一轮会告诉它。
- 查看或停止后台任务时，活动行写「查看输出」「停止命令」，不再是一串任务 uuid。
- 回复里的文件名在项目里有好几份时，点开会弹一个菜单列出各自的目录，不再弹「读不到」。
- 右栏标签的网页标题太长时，关闭按钮不再被挤出视野。标题截到 160px。
- 切回一个开着面板的会话时，正在读的那一段不再往下跳约 270px。
- 侧栏滚进「聊天」那一节时，「聊天」标题和项目名一样钉在顶上。
- 侧栏里正在跑的会话改回呼吸灯，不再是一列各自转圈的环。
- 英文界面的悬停卡片不再写「1 steps」，也不再把 12.3k 缓存 token 写成「12.3k cache reads」，读起来像读了一万多次缓存。
- 只给 MCP 服务器自己页面用的工具，不再交给模型。

### 移除

- **压缩模型设置。** 换一个模型就读不到主会话的缓存，所以压缩一律用会话自己的模型。
- 「允许基于工具辅助聊天生成本地记忆」开关。从加上起就没有代码读过它。

</details>

## [0.9.26](https://github.com/wJiaaa/Lyra/releases/tag/v0.9.26) - 2026-10-10
<!-- plume:notes en -->

### New

- **"Send now" stops the current turn and starts over with your message.** It used to wait until the model finished the step it was on. In one real conversation that step was three and a half minutes of thinking plus a long page of HTML, so for four minutes pressing it did nothing. Now the new request goes out right away. Whatever the model had written stays in the conversation, and it reads that on the next request.
- **Replies can draw interface blocks.** A ` ```ui ` block in a reply renders as the app's own controls. A button in it sends a message for you along with the values in the block, then shows "Sent". Side chat can draw them too, and the Android app shows them read-only.
- **Page previews show up inside the conversation**, drawn while they are being written. Pages taller than 720px are folded; "Show all" opens them in place, and the corner button opens them in the panel. Local HTML files open without starting a server.
- **The terminal finds the same tools as your own terminal.** When Plume was launched from the Dock, brew, mise and starship were missing because the shell didn't start as a login shell. On macOS it now does; on Windows, Git Bash starts with `--login`, and a new terminal sees tools installed after Plume started.
- **More in the terminal:** ⌘-click (Ctrl-click on Windows and Linux) opens a URL or a path like `src/a.ts:12:3`. ⌘F or Ctrl+Shift+F finds text. Dropping a file from the Finder or the file tree inserts its quoted path without running anything. The tab shows the program running in it, and closing a terminal while a program is running asks first. Text after an emoji is no longer one column off.
- **Closing a tab in the right column closes it for good.** Side chat used to come back with its old content; now closing it deletes it, and the Reset button is gone. Shortcuts and toolbar buttons only open panels: pressing the terminal shortcut twice used to end the running shell.
- **The browser opens one page per tab.** The address bar loads into its own page; with several pages open, it used to load into whichever page the conversation had used last. Pages the agent opens run in the background until you click the card to open them.
- **The Code font menu lists monospaced fonts installed on your computer**, such as PT Mono or Maple Mono, after the presets. "(not installed)" now shows on presets you don't have. Before, every name counted as installed, even made-up ones.
- **Other apps can open a specific conversation** with `plume://open-session?id=<id>` (macOS). Notch panels like Vibe Island can now jump straight to it instead of only bringing Plume to the front.

### Fixes

- **The task list no longer stops halfway.** In one conversation all five steps were done while the list still said 1 of 5. When unchecked items haven't been updated for 10 turns, the list is read back to the model; when a turn ends with an item still in progress, the model is asked once to update it.
- **Bare file names in replies and in the terminal open the right file.** Models often write just `approvals.ts:125`, or a path relative to a subfolder. If the path doesn't exist from the project root, Plume looks for the file in the project and uses it when exactly one matches.
- Clicking a file that can't be read no longer opens an empty "Cannot read this file" tab. A message says which path it tried. "Show in the Finder" on a deleted file no longer opens the folder it used to be in.
- **The conversation hover card counts turns instead of messages.** Every tool result used to count, so one turn with forty tool calls showed eighty-odd messages. A second row shows input, output and cache reads; input plus output is the session usage.
- The cache hit rate on that card covers only the main conversation. Subagents, titles and compaction each start their own prefix, and mixed in they could hide a broken cache. A rate below 100% is no longer rounded up to 100%.
- **Expanding reasoning while it's being written no longer freezes the window.** Replaying a real 170,000-character reasoning, the window dropped to 4–6 frames per second; it now stays at 120. While it's being written, the expanded text sits in a box up to 320px tall and shows only the latest part as plain text. The full Markdown comes back when it finishes.
- The thinking row no longer shrinks back to its icon each time a new sentence starts, so clicking the middle of it no longer lands on nothing.
- A finished thinking row settles on its first sentence right away instead of waiting for the whole turn. When short bursts of reasoning come one after another, each sentence is written out and stays for about a second; before, most were cut off halfway.
- **Opening or closing the sidebar or the right column no longer makes the conversation jump.** Scrolled up, it jumped by about 120px; at the bottom, it flashed. The text column is now 864px wide and stays centered in wider panes instead of rewrapping. It no longer widens to 1120px in panes over 1280px.
- Switching between light and dark mode no longer makes the window buttons on macOS jump.
- The title of an approval card or a "Connection dropped" row can be clicked to fold it, not only the arrow at the end.
- Opening a conversation that no longer exists, from a notification for example, no longer leaves nothing highlighted in the sidebar.
- With oh-my-zsh's tmux plugin set to autostart, reading your login environment no longer times out at every launch and comes back empty.

### Removed

- **The recap above the input box**, along with `/recap` and its model setting. It spent tokens every time you opened a conversation and added them to that conversation's usage. What it already spent stays in Settings › Usage.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 新功能

- **「现在就发」改成停下这一轮、拿你这句话重新开始。** 以前它要等模型把手上这一步做完。真实会话里那一步是三分半的思考加一大段 HTML，按下去四分多钟没有动静。现在新请求当场发出；被停下的回复写到哪儿就留到哪儿，模型下一次请求读得到。
- **回复里能画界面块。** 回复里的 ` ```ui ` 块画成应用自己的控件，块里的按钮会替你发一句话、带上块里填的值，发过的显示「已发送」。侧边聊天也能画，Android App 上只读显示。
- **网页预览直接长在对话里**，边写边显示。比 720px 高的先折起来，「展开全部」在原地展开，右上角才开进面板。本地 HTML 不用起服务器就能打开。
- **终端里找得到你自己终端里的那些工具了。** 从程序坞启动 Plume 时，shell 没按登录方式启动，brew、mise、starship 全都找不到。现在 macOS 上按登录 shell 启动；Windows 上 Git Bash 带 `--login`，Plume 开着时新装的工具，新开的终端也能看到。
- **终端还多了几样：** ⌘ 点（Windows、Linux 上 Ctrl 点）打开网址和 `src/a.ts:12:3` 这样的路径；⌘F 或 Ctrl+Shift+F 查找；从访达或文件树拖进文件，只插入加了引号的路径，不回车执行。标签上写着正在跑的程序名，程序还在跑时关终端会先问一句。emoji 后面的字不再错开一格。
- **右栏的标签关了就是关了。** 侧边聊天以前关掉再开还是原来的内容，现在关掉即删除，「重置」按钮去掉了。快捷键和工具栏按钮只负责打开：以前按两下终端快捷键，会把正在跑的 shell 结束掉。
- **浏览器一个网页一个标签。** 地址栏只加载到自己那一页；以前开着几个网页时，会加载到会话最后用过的那一页上。agent 开的网页在后台跑，点卡片才变成标签。
- **代码字体菜单列出本机装的等宽字体**，比如 PT Mono、Maple Mono，排在预设后面。没装的预设现在会标「（未安装）」——以前任何名字都算装了，连编出来的也是。
- **别的应用能直接打开某个会话**：`plume://open-session?id=<会话 id>`（macOS）。Vibe Island 这类刘海面板点卡片时，能落到那个会话上，不再只是把 Plume 带到前台。

### 修复

- **任务清单不再停在中途。** 有个会话五步都做完了，清单还停在 1/5。现在清单有没勾的项、又 10 轮没更新，就把整张清单念给模型听；一轮结束时还有「进行中」的项，就问模型一次。
- **回复和终端里只写了文件名的路径能点开。** 模型常只写 `approvals.ts:125`，或者写相对某个子目录的路径。从项目根拼不出来时，Plume 在项目里找，只有一个同名文件才打开它。
- 点开读不到的文件，不再开出一个只写着「读不到这个文件」的空标签，而是提示一句读的是哪个路径。文件已删掉时，「在访达中显示」不再打开它原来所在的文件夹。
- **会话悬停卡片数的是轮次，不再是消息条数。** 以前每条工具结果都算一条，一轮跑四十次工具就是八十多条。卡片加了第二行：输入、输出、读缓存，输入加输出就是全程用量。
- 卡片上的缓存命中只算主对话。子智能体、起标题、压缩各起一段前缀，混在一起时主对话的缓存坏了也看不出来。不足 100% 的命中率不再四舍五入成 100%。
- **推理还在写时展开，窗口不再卡住。** 拿一段 17 万字的真实推理回放，以前窗口掉到每秒 4–6 帧，现在稳在 120 帧。写着的时候正文放在最高 320px 的框里，只显示最后一段纯文本；写完换回完整的 Markdown。
- 思考行写着时不再每换一句就缩回只剩图标，点行的中间不会点空。
- 思考写完，行马上收成第一句，不再等整轮跑完。短推理一段接一段时，每句都会写完、停留一秒左右；以前大多写到一半就被切掉。
- **开合侧栏或右栏时，对话不再跳。** 往上翻着时会一下跳开约 120px，停在底部时会闪一下。正文栏改成固定 864px，窗格更宽时居中，不再重新断行；代价是 1280px 以上的窗格里正文不再放宽到 1120px。
- macOS 上切换明暗主题时，左上角红绿灯不再上下跳一下。
- 审批卡片和「连接中断」那一行，点标题文字也能收起展开，不只是末尾的箭头。
- 从通知等地方打开一个已经不存在的会话后，侧栏里不再一个高亮的会话都没有。
- 用了 oh-my-zsh 的 tmux 插件并打开自启时，读取登录环境不再每次启动都等到超时、拿回空结果。

### 移除

- **输入框上方的会话回顾**，连同 `/recap` 和回顾模型设置。它在每次打开会话时自己花 token，还算进那个会话的用量。已经花掉的仍在「设置 › 使用统计」里。

</details>

## [0.9.25](https://github.com/wJiaaa/Lyra/releases/tag/v0.9.25) - 2026-10-09
<!-- plume:notes en -->

### Before you update

- **On macOS, screen recording and other permissions have to be granted once more, and this is the last time.** The Mac build is now signed with a certificate instead of ad-hoc. macOS used to treat every update as a different app and drop its permissions; from this version on, updates keep them. The first update onto this version still counts as a different app.

### Fixes

- In the subagent panel, a tool row no longer sits flush against the thinking row after it. Rows were 0px apart there and 12px everywhere else, so the transcript read as pairs; every row is now 10px apart, the same as in the main conversation and side chat.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 更新之前

- **macOS 上屏幕录制等权限要再授权一次，这是最后一次。** Mac 安装包改用证书签名，不再是 ad-hoc 签名。以前 macOS 把每次更新都当成另一个应用，授权跟着作废；从这一版起，更新后授权会保留。只是第一次更新到这一版时，它仍被当成另一个应用。

### 修复

- 子智能体面板里，工具行不再和下一步的思考行贴在一起。以前这两行之间是 0px、其他行之间是 12px，看上去一对一对的；现在每行之间都是 10px，和主会话、侧边聊天一样。

</details>

## [0.9.24](https://github.com/wJiaaa/Lyra/releases/tag/v0.9.24) - 2026-10-09
<!-- plume:notes en -->

### Before you update

- **0.9.23 cannot update itself, so install this version by hand.** From 0.9.24 on, Plume finds and installs new versions on its own. Installers are now published on [wJiaaa/Lyra](https://github.com/wJiaaa/Lyra/releases).
- **On macOS, screen recording and other permissions have to be granted once more.** This build is signed differently from 0.9.23, so macOS treats it as a different app.

### New

- **Settings › About and in-app updates are back.** About shows the version you are on and what changed in it, and checks for a newer one: at launch and every 6 hours, or as often as you set there. When there is one, a small dot appears at the end of the Settings row in the sidebar. A download can be paused and resumed, and a package whose checksum does not match the release's `SHA256SUMS` is not installed.
- **An Android app.** `Plume-<version>-arm64-v8a.apk` connects to Plume on your computer and carries on its conversations from the phone. Pair it with the QR code in Settings › Mobile access; when the phone is not on the same network, it can go through a relay.
- **Conversations can hand work to each other.** The model can send a message to another conversation, wait for it to finish, and get the result back as the answer, without you copying text between the two.
- **Images in conversations.** The model can generate images. Images can be copied, brought into a chat from the right-click menu, or opened in a panel. Images a tool reads back show in its card; click one to see it full size.
- **Pages the agent draws are part of the reply.** They sit between the work and the answer, follow the app's theme, and are no longer folded away with the work. The model loads each page off screen first and sees a screenshot; a page that throws an error is not shown.
- **Fork from a message.** "Fork from here" on one of your messages starts a new conversation from just before it and puts that message back in the input box. The original conversation is not changed.
- **Command palette.** The magnifier at the top of the sidebar opens one dialog for finding conversations and running commands.
- **A recap when you come back.** Open a conversation that finished while you were away, and one sentence above the input box says where it got to. It stays until you start typing.
- **Smart titles, recaps and memory tidying each choose their own model** in Settings › Subagents › Conversation. Before, they read a hidden `@fast` role that nothing in Settings could change.
- **Files in replies have a right-click menu**: open in Zed, open with, reveal in Finder, copy path.
- **Something you say while the agent is working is marked as said mid-task**, so the model answers it and then carries on with the original task. If it is still writing a reply that hands work to a subagent, it answers you without waiting for the subagent to finish.
- **A new window layout.** The sidebar is back on frosted glass with its content on cards, and the title bar and icon rail are gone. The sidebar holds one list of chats; Pull requests, Scheduled and Plugins put their own navigation there. A + next to Chats starts a conversation outside any project. The right column's tabs move up into the window's title bar, the column can be collapsed, and tabs that do not fit scroll with the mouse wheel.
- Icons move a little when you hover over them.

### Fixes

- **Opening or closing the sidebar or the right column no longer makes the conversation jump.** Text used to rewrap mid-slide, the input box jumped at both ends, and the right panel shook; it now slides straight to where it ends up.
- **Test connection on Chat Completions relays no longer fails with 404**, and Gemini with reasoning off is no longer rejected.
- **A link in a reply to a file outside the project opened as "Cannot read this file".** It now opens the file.
- **On Windows, Chinese punctuation is no longer drawn in SimSun.** Chinese text size, grey and weight now match the Mac.
- **A new conversation that failed to start no longer leaves its first message in the next new conversation's input box.**
- Runtime notices, `/compact` results and project config warnings follow the interface language. A manual compaction no longer says "1 messages".
- Closing an image preview no longer puts a grey veil over the thumbnail, and the file panel no longer draws an image at full size before shrinking it into the panel.
- Coming back to a conversation no longer replays the animation at the bottom of the reply.

### Removed

- **Web access**, which opened the desktop app in a browser. The phone now uses the Android app.
- **The network access switches and allow list.** Commands and web fetches can reach public, local network and localhost addresses. The file sandbox, approval for writes and checks on fetched pages still apply.
- **Side-by-side panels.** Panels open as tabs only, and the drag handle went with them.
- The "frosted sidebar" switch, which no longer did anything to the sidebar.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 更新之前

- **0.9.23 没法自己更新，这一版要手动安装。** 从 0.9.24 起，Plume 会自己发现新版本并安装。安装包改在 [wJiaaa/Lyra](https://github.com/wJiaaa/Lyra/releases) 发布。
- **macOS 上屏幕录制等权限要再授权一次。** 这一版和 0.9.23 的签名不同，macOS 把它当成另一个应用。

### 新功能

- **「设置 › 关于」和应用内更新回来了。** 关于页写着当前版本和这一版改了什么，并检查有没有更新：启动时查一次，之后每 6 小时查一次，间隔可以在这里改。有新版本时，侧栏底部「设置」那一行末尾会出现一个小圆点。下载可以暂停、接着下，安装包的校验值和发布里的 `SHA256SUMS` 对不上就不装。
- **Android App。** `Plume-<版本>-arm64-v8a.apk` 连上电脑上的 Plume，在手机上接着它的会话干活。在「设置 › 手机连接」扫二维码配对；手机和电脑不在同一个网络时，可以经中转连接。
- **会话之间可以互相交代事情。** 模型能给另一个会话发消息、等它做完，结果作为回答拿回来，不用你在两个对话之间来回复制。
- **对话里的图片。** 模型能生成图片；图片可以复制、从右键菜单带进聊天，或者在面板里打开。工具读回来的图片直接显示在卡片里，点开看大图。
- **agent 画的页面成了回复的一部分。** 页面排在工作过程和回答之间，跟着应用主题换色，不再随工作过程一起收起。发布前模型先在屏幕外加载一遍、看到截图；抛异常的页面不展示。
- **从某条消息分叉。** 在自己的消息上点「从这里分叉」，新会话从这条之前开始，这条回到输入框；原来的会话不动。
- **命令面板。** 侧栏顶上的放大镜打开一个弹窗，会话和命令都在里面找。
- **回来时有一句回顾。** 打开一个在你离开时跑完的会话，输入框上方一句话说明它做到了哪一步，你开始打字才收起。
- **智能标题、会话回顾、记忆整理各自选模型**，在「设置 › 智能体 › 会话」里。以前它们读的是一个设置页上改不了的隐藏角色 `@fast`。
- **回复里的文件可以右键了**：在 Zed 中打开、打开方式、在访达中显示、复制路径。
- **agent 干活时你插的话，会注明是工作中说的**，模型回应完接着做原来的事。它正在写一条派活给子智能体的回复时，你插话也不用等子智能体跑完才有回应。
- **窗口换了排法。** 侧栏回到毛玻璃上，内容各是一张卡片，顶栏和图标栏去掉了。侧栏只留一张聊天列表，拉取请求、定时任务、插件三页把各自的导航放进侧栏；「聊天」旁边的 + 直接开一段不属于任何项目的对话。右栏的标签条并进窗口顶栏，右栏可以收起，标签排不下时用鼠标滚轮横着滚。
- 鼠标移到图标上时，图标会动一下。

### 修复

- **开合侧栏或右栏时，对话不再跳。** 以前正文边滑边重新断行，输入框首尾各跳一下，右侧面板跟着抖；现在一路滑到终点。
- **Chat Completions 中转上「测试连接」不再报 404**，关掉推理的 Gemini 也不再被拒。
- **回复里指向项目外文件的链接，点开只显示「读不到这个文件」。** 现在能打开。
- **Windows 上中文标点不再是宋体**，汉字字号、灰字和粗细与 Mac 一致。
- **新对话没能启动时，开头那句话不再留到下一个新对话的输入框里。**
- 运行时提示、`/compact` 的结果和项目配置的问题都跟着界面语言走；英文界面手动压缩后不再写「1 messages」。
- 关闭图片预览时缩略图上不再罩一层灰；文件面板打开图片时，不再先按原尺寸画出来再缩进面板。
- 切回会话时，回复底部的展开动画不再重播一遍。

### 移除

- **Web 访问**（在浏览器里打开桌面应用）。手机上改用 Android App。
- **网络访问开关和白名单。** 命令和网页抓取可以访问公网、局域网和本机地址；文件沙箱、写操作审批和抓取页面的校验照旧生效。
- **面板分栏排法。** 面板只以标签页打开，拖动面板的把手一起去掉。
- 「毛玻璃侧边栏」开关，它早就管不到侧栏了。

</details>

## [0.9.23](https://github.com/wJiaaa/Lyra/releases/tag/v0.9.23) - 2026-10-04
<!-- plume:notes en -->

### Before you update

- **Conversations from 0.9.22 do not carry over.** Conversations are now kept in one database, `~/.plume/sessions/sessions.db`, instead of one file each. The old files are left where they are but are no longer read, so the sidebar starts empty after updating.

### New

- **Background commands report back when they finish.** When a command started in the background exits, its exit code and output go back to the conversation: into the current turn if one is running, or as a new turn if the conversation is idle. The model no longer has to keep calling `bash_output` to check on it; one real conversation spent 6 requests doing that for 3 commands. In the conversation it shows as one line with the command, whether it succeeded, and the exit code. Clicking it opens the Tasks panel at that task, where each background task expands into a read-only terminal that follows its output.
- **"Continue" picks up the same subagent** after the app was restarted or the turn was stopped. Before, the subagent's id was lost and the model started a new one, which read the same files again. A subagent you closed in the panel stays closed after reopening.
- **Quitting during a tool call is recorded as it happened.** After a crash, a force quit, or quitting while a tool was running, reopening the conversation shows where each call stopped. A call that was running keeps the output it had printed and is marked as possibly having taken effect. A call that was waiting for approval or had not started is grey "Stopped", and the model is told it did not run. Nothing is resumed or run again by itself.
- **Subagents can open the `artifact://` and `scratch://` addresses** the main conversation passes them. They used to get "File not found". Long output cut from a subagent's context can now be read back in full.
- **Replies stream in smoothly.** Text arrives at an even pace and fades in, and half-written Markdown (bold, inline code, links) no longer flickers between two renderings. Code blocks stay fast while streaming: on a 300-line block at 150 characters a second, frames over 33ms went from 358 to 1. At the bottom of the window, the transcript follows the reply smoothly instead of jumping a line at a time.
- **Models settings, redesigned.** Providers are listed on the left, connection and models are in cards on the right. Rename and delete sit next to the on/off switch instead of in the ⋯ menu. The Test button shows the result itself: the latency when it passes, red when it fails, with the reason next to the API key.
- **New Plume icon.** The app icon has its own background, so macOS 26 no longer puts a grey plate behind it. The Dock icon is light blue or bright blue depending on the theme.
- A new project with no conversations yet has a row in the sidebar, so its first conversation can be started from there.
- Show more and show less in the sidebar now animate the list height. Rows no longer appear or vanish all at once.
- The terminal button in the title bar opens a new terminal on every press, like the side chat button. It used to stay highlighted, and a second press closed the terminal.

### Fixes

- **Tool calls from some OpenAI Responses servers could run with empty arguments.** Servers such as llama.cpp that leave out `output_index` could give one parallel call's arguments to another, and the first one ran with `{}`. A call whose arguments were cut off when the stream ended also ran with `{}`; in the case we reproduced, it was a truncated `rm -rf /tmp/build`. Each call now gets its own arguments, and a stream that ends in the middle of a call is retried.
- **Compaction summaries and memory extraction now appear in Usage.** Both cost money and were never counted.
- **Changing a global setting briefly turned off the project's `.plume/config.json`**, such as a stricter approval mode. With two quick changes in a row, an older read could also overwrite the newer setting.
- **Deleting a conversation leaves nothing behind in `~/.plume`.** Images only that conversation used, its side chats, thumbnails, and symbol indexes (a few MB each once its worktree was gone) used to stay. Images another conversation still uses are kept. Leftovers from before are cleaned up at startup, and the screenshot debug log is capped at 256KB.
- **A message could be lost right after sending it**, if Plume released the conversation as idle at that moment. The same could happen when editing and resending, or reverting to an earlier message.
- **A message you sent to a running subagent showed up twice** after switching away and back, splitting its tool-call row in two. The subagent panel could also draw a message twice now and then.
- **Opening a conversation no longer scrolls the whole history past you** when a card or image at the end loads late.
- **Settings › Index has its own project picker**, defaulting to the first project. It used to follow the open conversation, so seeing another project's index meant opening one of its conversations, and nothing showed when the open conversation had no project.
- Settings › Plugins, Subagents, Commands and Hooks now share one search box, card and row style, and the subagent and hook editors have breadcrumbs. Deleting a subagent moves it to the Trash, the same as commands and skills.
- The sidebar scrolls smoothly with many projects: with 200 projects expanded, the slowest 5% of scroll frames went from 192ms to 16.8ms.

### Removed

- The ? circle at the bottom of the sidebar, which did not open anything, and the Guide button at the bottom of the settings navigation, which only went to Models.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### 更新之前

- **0.9.22 的会话不会带过来。** 会话现在存在一个数据库 `~/.plume/sessions/sessions.db` 里，不再是一条会话一个文件。旧文件原样留着，但不再读取，所以更新后侧边栏是空的。

### 新功能

- **后台命令跑完会自己回报。** 放到后台的命令结束后，退出码和输出直接送回会话：这一轮还在跑就插进这一轮，会话闲着就开一个新回合。模型不用再一遍遍调 `bash_output` 去查——本机一个真实会话为 3 条后台命令花了 6 次请求。对话里显示成一行：哪条命令、成功还是失败、退出码多少，点它会打开任务面板并定位到那条任务；任务面板里每条后台任务都能展开一个只读终端，实时跟着输出。
- **应用重启或这一轮被停之后，说「继续」接上的是原来那个子智能体。** 以前子智能体的 id 丢了，模型只能重新派一个，把读过的文件再读一遍。在面板上关掉的子智能体，重开后也不会再回来。
- **工具调用中途退出，重开时如实交代。** 崩溃、强制退出，或者工具还在跑时退出，重开会话能看到每个调用停在哪一步：正在执行的带着已经打印的输出，标明可能已经生效；等审批的和还没开始的显示为灰色「已停止」，也告诉模型它们没有执行。不会自动续跑，也不会重跑。
- **子智能体能打开主会话交给它的 `artifact://`、`scratch://` 地址**，以前读到的是「File not found」。子智能体上下文里被剪掉的长输出，现在也能完整取回。
- **回复平滑地出字。** 字按均匀的速度出来并逐字淡入，写到一半的 Markdown（加粗、行内代码、链接）不再在两种样子之间闪。输出中的代码块也不卡：300 行的代码块、每秒 150 字，超过 33ms 的帧从 358 帧降到 1 帧。输出到窗口底部时，对话平滑地跟着上移，不再一行一顿。
- **模型设置页换了样子。** 左边是服务商列表，右边连接和模型各一张卡片。重命名和删除从 ⋯ 菜单里拿出来，常驻在开关旁边。「测试」的结果直接显示在按钮上：通过显示延迟，失败变红，原因写在 API Key 那一行。
- **新的 Plume 图标。** 应用图标自带底色，macOS 26 不会再在后面垫一块灰底；Dock 图标随主题在浅蓝和亮蓝之间切换。
- 刚建好、还没有会话的项目在侧边栏里有一行，可以从那里开第一个会话。
- 侧边栏「展开显示」和收起时，列表高度有过渡，不再整段冒出来或消失。
- 标题栏的终端按钮每点一次新开一个终端，和侧边聊天按钮一样。以前它开着就一直高亮，再点一下反而把终端关掉。

### 修复

- **部分 OpenAI Responses 服务上，工具调用可能以空参数执行。** llama.cpp 这类不带 `output_index` 的服务，并行的两个调用会串参数，前一个以 `{}` 执行；流结束时参数被截断的调用也以 `{}` 执行——我们复现的那次，原文是被截断的 `rm -rf /tmp/build`。现在每个调用拿到各自的参数，调用写到一半流就结束的，整条重试。
- **压缩摘要和记忆提取花的钱算进「使用统计」了。** 这两类调用一直在花钱，却没有记账。
- **改全局设置时，项目的 `.plume/config.json`（比如更严格的审批模式）会短暂失效**；连着改两次，旧的读取结果还可能盖掉新设置。
- **删掉的会话不再在 `~/.plume` 里留东西。** 只有这条会话用到的图片、它的侧边聊天、缩略图和符号索引（工作树清掉后每个还剩几 MB）以前都留着。别的会话还在用的图片会保留。之前留下的在启动时清理，截图调试日志最多 256KB。
- **消息刚发出去可能丢掉**：那一瞬间会话被当成闲置释放了。编辑重发、回退到之前的消息也有同样的问题。
- **发给正在运行的子智能体的话，切走再切回会出现两遍**，还会把工具调用那一行切成两段。子智能体面板偶尔也会把同一条消息画两遍。
- **打开会话时，末尾的卡片或图片晚到，不再把整段历史从眼前滚过去。**
- **「设置 › 索引库」自己选项目**，默认第一个。以前跟着当前会话走：想看别的项目，只能先去打开它的某个会话；当前会话不属于任何项目时，这一页什么都没有。
- 设置里的插件、智能体、命令、钩子四页统一成同一个搜索框、同一种卡片和行，智能体和钩子的编辑页有了面包屑。删除智能体改为移入废纸篓，和命令、技能一样。
- 项目多时侧边栏滚动不再掉帧：200 个项目全展开，最慢的 5% 滚动帧从 192ms 降到 16.8ms。

### 移除

- 侧边栏底部那个点了没反应的 ? 圆圈，以及设置导航底部只会跳到模型设置的「引导」按钮。

</details>

## [0.9.22](https://github.com/wJiaaa/Lyra/releases/tag/v0.9.22) - 2026-09-29
<!-- plume:notes en -->

### Lyra is now Plume

- **New name, new data folder, nothing carried over.** Settings, chats and keys live in `~/.plume` instead of `~/.lyra`. In a project, Plume reads `PLUME.md` (then `AGENTS.md`, then `CLAUDE.md`) and keeps its files in `.plume/`; environment variables start with `PLUME_`. The old names are not read at all, so add your providers again after installing, and rename `LYRA.md` and `.lyra/` in projects you want to keep using them in.
- **Updates are downloaded by hand.** The in-app updater, the About page and "Check for updates…" in the tray are gone. New versions are published on this Releases page.

### New

- **More than one side chat per conversation.** Each side chat has its own tab and closes on its own. The side chat button in the conversation title bar opens a new one every time you press it.
- **Panels as tabs.** Appearance › Panels › Tabs, now the default, puts files, terminal, browser and side chats in a single pane on the right, one tab each. Switching tabs does not restart the terminal or reload the page in the browser. Split keeps the previous arrangement, and switching back puts every panel where it was.
- **A turn can fold into one line.** Appearance › Tool calls › Collapsed shows the whole turn under one line, with one row per call. What the model says between calls now stays outside the folded part, so collapsing a turn no longer hides it.
- **Web access.** Open Plume from a browser on the same local network: the same conversations, replies as they stream, and you can send, stop and approve from there. The terminal, writing files and changing settings stay on the desktop.
- **Skills can be switched off one at a time.** Skills are grouped by the folder they come from (such as `~/.agents/skills`), and a skill that came with a plugin names that plugin. A switched-off skill disappears from the `/` menu and from new conversations.
- **Hooks use the Claude Code format**: a `hooks.json` grouped by event, with SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure and Stop. Hooks that come with a project do not run until you trust them, and changing one asks again.
- **The MCP tab shows whether each server connects, and its tools, without an open conversation.** Before, it could only say "Enabled".
- **Fill in from the model catalogue.** The model editor can copy context window, output limit, capabilities and price from the pi.dev catalogue once. Everything stays editable afterwards, and the model ID is never changed. The catalogue refreshes every hour.
- **Usage › Cache misses** lists requests that should have reused the prompt cache and did not, with the first thing that changed: tools, system prompt, rewritten history or provider.
- Settings for plugins, subagents, hooks and commands have a project picker. They start at user level instead of silently following whichever conversation is open.
- Folders can be dragged into the message box. Anything dropped from Finder or the file tree becomes an `@` reference.
- A conversation can be marked as unread from its menu. The translucent sidebar on macOS can be turned off in Appearance.

### Fixes

- **Edits could land on an out-of-date copy of a file.** Editing or writing a file now requires the version the model last read. A line-number edit touching several places could swallow the lines between them; all changes are now applied to the original file in one pass, and overlapping ranges are refused. Windows line endings and the final newline are kept.
- **Reading a long file could throw away code read earlier.** A plain read of a long source file returns an outline, and that outline was taken as a full read, so function bodies the model had already read were dropped from context. Outlines, truncated reads and failed reads no longer replace anything.
- **After one retry mid-reply, the context was counted twice.** About 10k tokens was reported as 20k, which started compaction on small context windows for no reason.
- **Tool results and summaries could overflow the context window together.** Each result was measured on its own, so ten results of 8,000 characters passed untouched and a summary request reached 18k tokens on a 10k window. They are now measured as a whole.
- **A reply that stops at the output limit carries on by itself.** A tool call whose arguments were cut off is not run; the model is told to split it up.
- **When the model looked up earlier messages, a long message came back as its start and end, not the part that matched.** It now gets the text around each match.
- **Checking ten different images in a row ended the turn.** The model now gets a reminder at the fifth; only the same call with the same arguments and result, repeated ten times, stops it.
- **Commands treated as read-only could run or write through their options**, such as `fd -x`, `rg --pre`, `git branch -D` and `git remote set-url`. Those no longer skip approval.
- **MCP tools that declare themselves read-only run in parallel and no longer ask for approval** in the default permission mode.
- Images returned by a tool are sent to models that can read images, over both OpenAI protocols.
- Anthropic replies no longer lose text or thinking that arrives with the start of a block. A model's refusal is shown as a refusal rather than an empty reply, and is not retried. Rate-limit waits follow `Retry-After`, "try again in" and `x-ratelimit-reset-*`, up to 60 seconds.
- In the dark theme the faintest text goes from 30% to 50% (contrast about 2.2:1 to 3.9:1), so thinking and tool rows are readable. A colour typed without `#`, such as `1A1C1F`, no longer makes the swatch transparent.

### Removed

- Rules: the Rules tab, the rule tool, the suggestion to save a correction as a rule, and rules read from Cursor, Windsurf, Cline, Copilot and Codex.
- The mobile app and Settings › Mobile sync.
- Interface languages other than English and Simplified Chinese. Chinese regions use Simplified Chinese.
- Code formatting. The file panel is a read-only preview, without editing or saving.
- Custom request headers for providers. OpenCode Go gets its session header automatically.
- Pinned projects (conversations can still be pinned), the Tools page in Settings, and the settings for when to send work to subagents: the model decides, with up to 4 at a time and 2 levels deep.
- Font weight settings for the interface and for code, conversation width, default message box height, and the bundled fonts; system fonts are used.

<!-- plume:notes zh-CN -->

<details>
<summary>中文（简体）</summary>

### Lyra 改名为 Plume

- **名字、数据目录都换了，旧数据不会带过来。** 设置、会话和密钥现在放在 `~/.plume`，不再是 `~/.lyra`。在项目里，Plume 读 `PLUME.md`（其次 `AGENTS.md`、`CLAUDE.md`），自己的文件放在 `.plume/`；环境变量改为 `PLUME_` 开头。旧名字一概不再读取：装好后要重新添加服务商；项目里的 `LYRA.md` 和 `.lyra/` 想继续用，就改成新名字。
- **更新要自己下载。** 应用内更新、关于页和托盘里的「检查更新…」都去掉了，新版本发在这个 Releases 页面上。

### 新功能

- **一个会话可以开多个侧边聊天。** 每个侧边聊天占一个标签，可以单独关掉。会话标题栏上的侧边聊天按钮，每点一次就新开一个。
- **面板可以收成标签页。** 「外观 › 面板 › 标签页」现在是默认值：文件、终端、浏览器和侧边聊天都收在右侧同一个面板里，每个占一个标签。切换标签不会重启终端，也不会让浏览器重新加载。选「分栏」是原来的排法，切回去时各个面板回到原位。
- **一轮可以收成一行。** 「外观 › 调用链 › 折叠」把整轮收在一行下面，每次调用各占一行。模型在两次调用之间说的话现在留在折叠区外面，收起一轮不会把它藏掉。
- **Web 访问。** 在同一局域网的浏览器里打开这台电脑上的 Plume：看到的是同样的会话，回复实时出现，也能发消息、停止和审批。终端、写文件、修改设置只在桌面端可用。
- **技能可以一个个关掉。** 技能按所在目录分组（比如 `~/.agents/skills`），插件带来的技能会写明是哪个插件。关掉的技能不会出现在 `/` 菜单里，新会话也不会用到它。
- **钩子改用 Claude Code 的格式**：`hooks.json` 按事件分组，支持 SessionStart、UserPromptSubmit、PreToolUse、PermissionRequest、PostToolUse、PostToolUseFailure、Stop 七个事件。项目里带的钩子要你信任之后才会运行，改过之后会再问一次。
- **不开会话，MCP 标签里也能看到每个服务连没连上、有哪些工具。** 以前只能显示「已启用」。
- **从模型目录填入。** 模型编辑器可以从 pi.dev 的模型目录把上下文、输出上限、能力和价格填进来，只填这一次，之后随便改，模型 ID 不会被动。目录每小时同步一次。
- **「使用统计 › 缓存未命中」** 列出本该用上提示缓存却没用上的请求，并指出最先变化的是哪一处：工具、系统提示词、改写过的历史，还是服务商。
- 设置里的插件、智能体、钩子、命令页多了项目选择器，默认是用户级，不再暗中跟着当前打开的会话走。
- 输入框可以拖入文件夹。从访达或文件树拖进来的东西，都会写成 `@` 引用。
- 会话菜单里可以「标记为未读」。macOS 上的毛玻璃侧边栏可以在「外观」里关掉。

### 修复

- **编辑可能改在文件的旧版本上。** 现在编辑或写入文件之前，必须对得上模型最后读到的那一版。按行号编辑一次改多处时，可能把中间的行吞掉；现在所有修改都基于原文件一次完成，区间重叠的直接拒绝。Windows 换行符和文件末尾的换行都会保留。
- **读长文件可能把之前读过的代码挤掉。** 直接读一个很长的源文件，拿到的是大纲，而这份大纲被当成读了全文，模型读过的函数正文就被从上下文里清掉了。现在大纲、被截断的读取和失败的读取都不会顶替已读的内容。
- **回复中途重试一次，上下文就按两倍算。** 大约 10k 的上下文被算成 20k，小窗口的模型会无故开始压缩。
- **工具结果和摘要加在一起可能超出上下文窗口。** 以前每条结果单独衡量，十条 8000 字符的结果原样放行，10k 的窗口上摘要请求到了 18k tokens。现在按总量衡量。
- **回复停在输出上限时会自己接着写。** 参数被截断的工具调用不会执行，模型会被提示把它拆小。
- **模型回查之前的消息时，长消息只拿到开头和结尾，拿不到命中的那一段。** 现在给的是每个命中词附近的原文。
- **连续检查十张不同的图，这一轮就被掐断。** 现在第 5 次时提醒一次；只有同一个调用、同样的参数和结果重复 10 次才会停下。
- **被当成只读的命令，可以借参数执行或写入**，比如 `fd -x`、`rg --pre`、`git branch -D`、`git remote set-url`。这些不再跳过审批。
- **声明为只读的 MCP 工具可以并行执行**，在默认权限模式下不再请求批准。
- 工具返回的图片会发给能读图的模型，两种 OpenAI 协议都一样。
- Anthropic 的回复不再丢掉跟着内容块开头一起到的正文和思考。模型拒答时显示为拒答，不再当成空回复，也不重试。限流等待会遵守 `Retry-After`、「try again in」和 `x-ratelimit-reset-*`，最长等 60 秒。
- 深色主题下最浅一档文字从 30% 提到 50%（对比度约从 2.2:1 到 3.9:1），思维链和工具行看得清了。颜色框里手打不带 `#` 的值（比如 `1A1C1F`），色块不再变成透明。

### 移除

- 规则：规则标签页、rule 工具、纠正后建议存成规则，以及从 Cursor、Windsurf、Cline、Copilot、Codex 读取的规则。
- 手机端和「移动端同步」设置。
- 英文和简体中文以外的界面语言。中文地区统一使用简体中文。
- 代码格式化。文件面板改为只读预览，不能编辑和保存。
- 服务商的自定义请求头。OpenCode Go 需要的会话头会自动带上。
- 项目置顶（会话仍然可以置顶）、设置里的「工具」页，以及什么时候派活给子智能体的设置：改由模型自己决定，最多同时 4 个、嵌套 2 层。
- 界面和代码的字重设置、对话宽度、输入框默认高度，以及自带字体；改用系统字体。

</details>
