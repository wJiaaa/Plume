# ADR-0058：`/review` 交给一个新开的审阅会话：先只读地审，修哪几条由原会话定，审阅会话来修

- 状态：已采纳
- 日期：2026-10-23
- 相关：core `src/commands/review.ts`（正文两半、`REVIEW_SESSION_OPENING`）、`src/commands/builtin.ts`、`src/commands/invoke.ts`、`src/runtime/plan/plan-view.ts`
  （`latestApprovedPlan`）、`src/runtime/plan/plan-mode.ts`（`planModeTools` 的 `review`）、`src/runtime/agent-session/session-turn.ts`、
  `src/session/types.ts`（`SpawnedFrom.review`）；desktop `electron/session/review-session.ts`、`electron/session/review-brief.ts`（交接单与第一条消息）、
  `electron/session/session-hub.ts`（注入、`createSessionIn`）、`electron/session/session-report-back.ts`、
  `shared/session-suggestion.ts`（`ReviewSessionDetails`）、`src/features/conversation/SessionSuggestionCard.tsx`
  （`ReviewSessionRow`）；测试 `desktop/test/review-session.test.ts`、`desktop/test/review-brief.test.ts`、`desktop/test/review-session-hub.test.ts`、
  `desktop/test/ui/session-suggestions.test.ts`、`desktop/test/session-report-back.test.ts`、`core/test/builtin-review-command.test.ts`、`core/test/plan-mode.test.ts`；
  指南 [内置能力 › 代码审阅](../guide/capabilities.md#代码审阅review)；[ADR-0044](0044-plan-mode.md)、[ADR-0049](0049-session-level-operations.md)

## 背景

`/review` 最早在当前会话里跑：low 由主模型自己审，medium、high 派 `review` 子智能体分维度审、主会话核实，
`--fix` 就地改。两个问题：审代码的就是写代码的那个会话，它带着「为什么这么写」的全部上下文，容易认同自己；
读 diff、派子智能体、核实又都压在实现的上下文上。子智能体只解决了一半——派它、核实它的还是那个会话。

## 决定

1. **桌面端主会话不审自己，交出去。** 正文第 0 步按「有没有 `review_session` 这件工具」分流：有就写一份实现
   总结、调它、结束这一轮；没有（命令行、子智能体、侧边聊天）照旧在当前会话里跑完整条流水线。按工具分流而不是
   按宿主名字，哪个宿主装没装它都自洽。

2. **交接单是必填字段，计划和用户原话由运行时附原文。** 原会话交的不是一段自由的总结，而是 `background`、
   `decisions`（用户原话加引号，没有也要明写）、`implementation`、`files`（每个附一句）、`unverified`（没有也要明写）
   这几项必填，加上选填的 `out_of_scope`、`focus`。工具逐项卡最短长度、一次点名缺哪几项：一段总结模型一句话就能
   打发，而审阅者缺的正是那句话没说的前因后果。计划由主进程从记录里取最后一份批准的（`latestApprovedPlan`：往回
   找到的第一份批准结果，连注意事项；之后被打回的不算；「在新会话里执行」批准的跳过，实施不在这里；压缩后读快照）；用户原话取所有非合成的用户消息（和计划一样读存储里的完整显示历史，不读压缩过的眼下历史：压缩最先换掉的就是最初的需求），按时间
   顺序，总长一万二千字（约三到六千 token，再多就挤审阅读 diff 的上下文），超了留最早一条和最近几条、注明省略
   几条，单条先截到三千字。两样都不让模型转述：转述会改写、截短，`decisions` 里漏写的约束审阅者还能从原话里看到。
   第一条消息照任务说明的顺序排，原话包在 `<user_messages>` 里；每节都在，没填的写「未提供」。`review/intent.md` 按同样的分节写。

3. **审阅会话先只审，多一维意图对照。** 第一条消息是 `/review` 的正文加交接单，交接单以 `REVIEW_SESSION_OPENING` 开头，正文凭它认出自己：走流水线、
   原会话答复之前不改文件、没有 `--fix` 和 `--comment`，最后那段回复是报告加上修复的结果（第 12 条）。有交接单或计划时多一维 E：说要做的有没有做、做偏、
   漏做，以及做了计划之外的事。依据有先后：用户原话和决定最高，计划次之，实现说明是作者自述、要对着代码核实；
   派子智能体时把相关背景和约束写进它们的提示词。

4. **只读在工具层强制，借计划模式那一层，但不进计划模式。** `spawnedFrom.review` 的会话每轮把工具包进
   `planModeTools(…, review)`：原会话答复之前（`REVIEW_FIX_KEY`），`write`、`edit`、`lsp` 的 `rename` 一律拒绝，提示是
   审阅会话自己的话（先审完、用 `ask_session` 问原会话），不提计划。包的只是 `execute`，工具定义逐字节不变，它派的子智能体拿到的也是这张表。不进计划模式：
   计划模式会换系统提示、要它交计划，和审阅冲突。
   **`bash` 不压只读沙箱，留给权限档。** 计划模式把命令压进只读沙箱，那是「不改文件」在 shell 里唯一可靠的线；
   但审阅要的不止是读——high 力度派的 `verify` 要跑类型检查和测试，`tsc --incremental`、测试运行器、`node_modules/.cache`
   都会写文件，压进只读沙箱就整条失败，等于审阅会话跑不了检查。代价是命令里的写（`git checkout`、`sed -i`）只靠正文里的约束
   和权限档拦；这比让 high 力度的检查失效便宜。提权（`escalate`）同样照权限档走。

5. **人敲 `/review` 就是同意，不经建议卡片。** 工具只校验、把要开的写进 `details`、`terminate` 结束这一轮；
   主进程在 `broadcast` 里看到这次调用结束再建会话（那时才有调用 id，和计划交接同一个做法），直接发第一条消息。
   没建出来就在原会话里报一条错：那一轮已经按「交出去了」停下。

6. **目录和原会话完全相同。** 原会话在工作树里，审阅会话就开在那棵工作树里，否则看不到未提交的改动。所以不走
   `createSession`：它经 `ownWorkspace`、按设置另开工作树；也不复制 `worktree`，那样删审阅会话会顺手收走原会话
   的工作树。这一点和建议卡片、计划交接相反，那两处开在项目上。

7. **交回复用建议会话那一条。** `spawnedFrom = { sessionId, toolCallId, reportBack: true, review: true }`：侧栏挂在
   原会话下面，报告经 `receiveSessionReport` 送回，原会话里多一行「来自新会话」。送的时机不是第一次 `agent_end`：
   子智能体派出即放手（ADR-0051），medium、high 派完那一轮当场收尾，那时最后那段话是「已派出、等结果」，真正的报告
   在送达之后那几轮里才写出来。所以 `session-report-back.ts` 在第一次 `agent_end` 当场撕条子、定下交不交，等会话闲下来
   （`whenIdle`）再按最后那一轮的话和收场送；这一处对建议会话同样成立，ADR-0049 第 9 条一起改了。`review` 不随第一轮
   撕掉，审阅会话凭它拒绝再转交——它自己也是主会话，也拿得到这件工具。对话里那次调用直接画成建议卡片开始以后
   那一行，名字叫「审阅会话」，没有交回开关。

8. **模型：设置 › 智能体里给 `review` 选过、这台机器上找得到的优先，否则沿用原会话的。** 同一个模型审自己写的
   东西容易得到认同；那一栏本来就是为了换一个模型家族。找不到时退回而不是报错：不为一个偏好开不出审阅。

9. **`--fix` 留作兼容。** 交出去时修不修由原会话定（第 12 条），`--fix` 在这条路上接受但什么都不变；回退路径（审和修
   在同一个会话）照旧要它才修——命令行里自动改文件不该因为这次改动变成默认。`/` 菜单的提示里不再列它。
   `--comment` 留在原会话：发评论是对外动作，照旧先 `ask_user`。

10. **`review_session` 常驻、定义压到最短。** 它在每个桌面端主会话的工具表里，不是敲了 `/review` 才注册：中途换
    工具表会让整段前缀缓存作废（ADR-0044，`submit_plan` 常驻是同一个理由）。所以定义只有一句说明加「照 `/review` 说明第 H 步用」，
    字段不带说明，怎么写全在正文里——正文只在 `/review` 时展开。改前定义（名字、说明、参数 JSON）2688 字符，改后 676。

11. **`/review` 是内建命令，不是技能。** 和 `/compact`、`/plan` 并列在 `/` 菜单的「命令」组，任何宿主都有
    （`BUILTIN_COMMANDS` 里没有 `action` 的那一类）；敲下去由 `resolveInvocation` 把整段正文加参数展开进发出的
    消息，气泡里只显示人敲的那一行。最初做成随代码发的技能，菜单里它落在「技能」组、和用户装的技能混在一起，
    设置 › 技能里多一个关不掉也打不开的条目，还得为「没有目录的技能」在资源、胶囊、对比几处开特例；模型也要先
    调一次 `skill` 才读到正文，多一轮。审阅会话不经命令，宿主在第一条消息里把正文放在交接单前面，气泡里只显示交接单。
    同名的磁盘命令盖不住它，和其余内建命令一样。

12. **修哪几条由原会话定，修由审阅会话来，不经人点头。** 最初是报告交回原会话、由原会话修。那样修复落在写实现的那个
    上下文里，每条发现还要从报告转述一次；复审时新的审阅会话也不知道上一轮修了什么。改成审阅会话审完、先写好报告，用
    `ask_session` 问原会话修哪几条（地址由宿主写进交接单），自己修、修完跑检查，报告里加「Fixed / Left / Checks after
    fixing」三节交回。原会话收到报告只转述，不再修。
    **由原会话定、不直接问人**：该不该修取决于人说过什么、范围多大，这些都在原会话里；人只在原会话也定不下的那几条
    （多半是 PLAUSIBLE）被问一次，用的是原会话的 `ask_user`。一度设计成计划审批卡让人逐次点头，被否掉了：多数
    CONFIRMED 的发现不需要人再判断一遍。
    **放行靠宿主看到回答**：`review-session.ts` 观察审阅会话的 `ask_session` / `wait_for_session`，问的是原会话
    （地址的 ref 对得上）、结果是 `done` 才写 `REVIEW_FIX_KEY`；原会话还在问它的人（`blocked`）、超时都不算。答复
    说「都不修」也会放行——闸门保证的是「问过才动」，修哪几条由正文要求照答复做。开关只在状态图里，应用重开后又是
    只读，被拒时照拒绝里的话再问一次即可。等不到答复就不修，报告里列出还在等决定的发现。
13. **一次审阅一个会话，再敲 `/review` 就另开一个。** 审、问原会话、修、修完跑检查都在同一个审阅会话里做完；人再敲
    一次 `/review` 是一次新的审阅，从这次的交接单开始。曾做过把复审发回上一个审阅会话、以及把上一轮报告附进交接单，
    都撤了：上一轮修了什么已经交回原会话，原会话写这次的交接单时看得到，不必由宿主再搬一遍。

## 没做的

- 原会话用「在新会话里执行」把计划交给了别的会话时，实施在那个会话里、计划在原会话里。在实施会话里敲 `/review`
  拿不到那份计划，只交总结；要跟着 `spawnedFrom` 去父会话取，等真有人这么用再加。
