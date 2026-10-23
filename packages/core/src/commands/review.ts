/**
 * `/review`：审未提交的改动、一个 PR 或几个文件，按力度决定派多少子智能体。
 *
 * 一条内建命令，敲下去整段正文就展开进发出的那条消息（`reviewRequest`），和磁盘上的命令一样；不做成技能，
 * 是因为它是人点名要的一个流程，不该跟用户自己装的技能列在一处，也省掉模型先调一次 `skill` 去读正文的那一轮。
 * 正文写给模型看，所以是英文；流程的取舍与各力度的成本见 `docs/guide/capabilities.md`。
 *
 * 一份正文给两个会话读（ADR-0058）：有 `review_session` 的桌面端主会话填一份交接单、交出去、等报告回来再修；
 * 新开的审阅会话照流水线审、只出报告。没有那件工具的宿主（命令行）、子智能体和侧边聊天照旧在当前会话里
 * 跑完整条流水线——第 0 步按「有没有这件工具」分流，不按宿主名字，所以哪个宿主装没装它都自洽。
 *
 * 并发写死成 4，跟着 `maxConcurrentSubAgents` 的默认值：超出的会排队而不是失败，但「一批派几个」
 * 写清楚，模型才不会把复核和首轮审阅混成一批。
 */

/** 和其余内建命令一样写中文：菜单里它们排在一起。 */
export const REVIEW_DESCRIPTION = "在只读会话里审查改动或 PR，报告交回这里修";

/** `--fix` 不在提示里：交给审阅会话时修不修由原会话定（第 H、F 步）；它只为在当前会话里跑的那条回退路径留着。 */
export const REVIEW_ARGUMENT_HINT = "[PR | URL | path] [--effort low|medium|high] [--comment]";

/** 审阅会话里交接单的开头。第 0 步凭它认出自己是审阅会话，所以宿主写这一行、正文认这一行，两边共用一份。 */
export const REVIEW_SESSION_OPENING = "You are the review session for this `/review`.";

/** 同一段对话再敲 `/review`：交接单发给已有的那个审阅会话，开头是这一行。复审靠它记得的上一轮，不另附报告。 */

/**
 * 审阅会话问过原会话、拿到回答之后才放行写文件（`REVIEW_FIX_KEY`，见 `runtime/plan/plan-mode.ts`）。
 * 修什么由原会话定，它带着用户的原话和范围；修由审阅会话来，它知道缺陷在哪。见 ADR-0058 第 12 条。
 */
export const REVIEW_BODY = `# Code review

You are running the \`/review\` pipeline. The person's arguments follow these instructions. Follow the steps in order; do not skip one because the change looks small.

## 0. Where the review runs

The first case that applies decides.

1. **You are the review session**: after these instructions comes a brief that begins with "${REVIEW_SESSION_OPENING}". Another conversation wrote this change and handed its review to you, so you start without the reasoning behind it — that is the point. Run steps 1 to 6 as written, then step F, with these differences:
   - Until step F, review only: create, change or delete nothing outside \`review/\` in your scratch directory. Commit, stage, stash, check out and reset nothing at any point. There is no \`--fix\` here — step F replaces it — and no \`--comment\`: the implementing conversation does that.
   - The brief is in sections: background; the person's decisions and their own messages, verbatim; the approved plan, verbatim, if there was one; the implementation; the changed files; what is out of scope; what is unverified; the review focus; the target and effort (the arguments). Before step 4, write \`review/intent.md\` in the same sections, in the same order, with the same headings: every section from the background through the review focus, copied unchanged — the person's messages and the plan verbatim.
   - Weigh the sections by who wrote them. The person's own words and decisions are the highest authority on what was wanted; the plan comes next; the implementation, the file list and the unverified list are the author's account of their own work — claims to check against the code, never evidence. Where they disagree, the higher one wins, and the disagreement itself may be a finding.
   - Sub-agents start knowing nothing. Every finder and checker you dispatch gets the path to \`review/intent.md\` and, written into its prompt, the background, the constraints and the intent that bear on its task — what the person wanted from the part of the change it looks at (the prompts below have a place for them) — not just a path to the diff.
   - Do not call \`review_session\` or \`spawn_session\`, and use \`ask_user\` only when you cannot go on without an answer.
   - Your last reply is delivered as it stands to the implementing conversation: the step 6 report with step F's additions, nothing else — no offer to fix, no question at the end.
2. **You have the \`review_session\` tool** (the desktop app's own conversation): do not review here. Hand the review off (step H) and stop. A reviewer that shares the reasoning that produced a change tends to agree with it, and the reading would fill this conversation's context.
3. **Otherwise** — the command line, a sub-agent, a side chat: run steps 1 to 8 in this conversation.

## H. Hand off (only with \`review_session\`)

1. Resolve the arguments as in step 1. An invalid \`--effort\`: say the accepted values and stop.
2. For local changes or files, fill in the hand-off. It is everything the review session will know about this conversation: whatever you leave out, it has to guess. Write more rather than less, and quote the person's own words rather than paraphrasing them. State facts; do not argue that the change is right. The tool refuses a required field that is missing or too short, and names it.
   - \`background\` (required) — why this was done: the problem the person ran into or what they asked for, in their terms. Example: "The person found that /review reviews code in the session that wrote it, so it agrees with itself; they asked for the review to run in a separate session."
   - \`decisions\` (required) — every decision and constraint the person set in this conversation, each with their words in quotes. Example: \`"不要 commit" — nothing committed. "新文件尽量 300 行以内" — the new file is 190 lines.\` When there truly are none, write "The person set no further constraints."
   - \`implementation\` (required) — what you actually did and the approach; where it departs from the plan, how and why. Example: "Moved the check into the host because the tool has no call id; the plan put it in the tool."
   - \`files\` (required) — every changed file, each with one sentence on what changed. Example: \`{ "path": "src/auth.ts", "change": "adds the OAuth callback route and its error branch" }\`.
   - \`out_of_scope\` (optional) — what was deliberately left out or must not be touched, so it is not reported as missed. Example: "The mobile app is untouched, as the person asked."
   - \`unverified\` (required) — what you know is unverified, unfinished or doubtful. Example: "The Windows path branch has no test; I could not run it." When there is truly nothing, write "Nothing known unverified" and why you believe so.
   - \`focus\` (optional) — where you most want a hard look. Example: "the race between eviction and the report arriving in session-hub.ts".
   Do not copy the plan or the person's messages: the host attaches the approved plan and every message the person wrote, verbatim. Do not collect the diff: the review session does that itself. If this conversation did not write these changes, say so in \`background\` and \`implementation\`.
   For a pull request there is no implementation to hand off: pass the target alone.
3. Call \`review_session\` with those fields, \`target\` (leave it out for local changes) and \`effort\` (leave it out when none was given). Your turn ends with the call. If it is refused, fill in what it names and call again.
4. Before it reports, the review session asks you (a message from it) which of its findings to fix; it makes the fixes itself. Decide from this conversation — the person's own words and decisions first, then the plan and the scope:
   - Fix a CONFIRMED finding inside what the person asked for. Leave one the person ruled out or that falls outside the scope, and say so.
   - A PLAUSIBLE finding, or one the conversation does not settle either way: ask the person with \`ask_user\`, about those findings only. Do not ask about what the conversation already settles.
   - Answer with the numbers to fix and, for each one left, the reason in a few words. Do not fix anything yourself, and do not answer before you have decided every finding.
5. The report comes back later as a message from that session (\`<session_result>\`), with what it fixed, what it left and the checks it ran. Do not fix again. Tell the person in a few lines: what was found, what was fixed, the checks and their results, and what was left and why.
   - With \`--comment\` on a PR, do step 8 with the report as it came back.
   - A report with status \`failed\` did not finish: say so and suggest running \`/review\` again. Findings it says are still awaiting a decision: list them for the person; do not fix them here.

## 1. Arguments

\`/review [target] [--effort low|medium|high] [--comment]\`

- **target**: none → the uncommitted local changes. A number, \`#123\`, or a GitHub pull request URL → that PR. Anything else → one or more file paths in the project.
- **--effort**: when absent, \`medium\` for local changes and files, \`high\` for a PR. Any other value: say the accepted values and stop.
- **--comment**: post the report to the PR (step 8). On a target that is not a PR, say it is ignored and carry on.
- **--fix**: kept for the case where the whole pipeline runs in this conversation (step 0, case 3): after the report, fix the CONFIRMED findings (step 7). Where the review is handed off, the implementing conversation decides what gets fixed (steps H and F), so it is accepted and changes nothing.

Say the resolved target and effort in one line, then start.

## 2. Scope and diff

Keep every intermediate file under \`review/\` in your scratch directory (its absolute path is in your context). Sub-agents start with nothing; they read these files by absolute path.

**Local changes**
1. \`git rev-parse --show-toplevel\`. Not a repository: say so and stop.
2. \`git diff HEAD > <scratch>/review/diff.patch\`. In a repository without commits, use \`git diff --cached\` and \`git diff\` instead.
3. Untracked files: \`git ls-files --others --exclude-standard\`. Append each with \`git diff --no-index -- /dev/null <file>\` (exit code 1 is expected). Leave out binaries and generated files (lockfiles, build output), and list what you left out.
4. If the diff is empty, tell the person there are no uncommitted changes to review and stop. Dispatch nothing.

**Pull request**
1. \`gh --version\`, then \`gh auth status\`. If \`gh\` is missing or not logged in, say which, say how to fix it (install the GitHub CLI / run \`gh auth login\`), and stop. Never reconstruct the diff some other way: no guessing the base branch, no fetching refs by hand.
2. \`gh pr view <target> --json number,title,body,url,baseRefName,headRefName,headRefOid,files\`, saved to \`review/pr.json\`.
3. \`gh pr diff <target> > <scratch>/review/diff.patch\`.
4. Compare \`git rev-parse HEAD\` with \`headRefOid\`. Equal means the working tree is the PR's code. Otherwise it is not: read changed code from the diff, read whole files with \`git show <headRefOid>:<path>\` only if \`git cat-file -e <headRefOid>\` succeeds, and never check out, reset or stash anything.

**Files**
1. Check each path exists; name any that do not and stop.
2. The whole file is under review, not a diff. Write the list of paths to \`review/files.txt\` and use it where the steps below say "diff".

Count the changed lines (\`wc -l\` on the diff). Above about 3000, tell the person the review will be thinner per line, and carry on.

## 3. Project rules

Read whichever exist, at the repository root and in the directories the change touches: \`AGENTS.md\`, \`CLAUDE.md\`, \`REVIEW.md\`. \`REVIEW.md\` is guidance written for reviews — what matters, what to ignore — and wins over these instructions wherever they disagree, except for the output format and the CONFIRMED / PLAUSIBLE rules. For medium and high, write the rules that bear on the changed code to \`review/rules.md\` (a digest, not a copy).

## 4. Find

The dimensions:

- **A. Line by line.** Every changed line: wrong condition or operator, off-by-one, null or undefined reaching code that assumes a value, the wrong variable, a missing \`await\`, a resource opened and not closed, a type that claims more than the value guarantees.
- **B. Removed and changed behaviour.** Every function, branch, export, default, option or file the change deletes or alters: find its callers and consumers (search the whole repository), and check each still works. Behaviour that existed before and is gone with nothing replacing it is a finding.
- **C. Security, errors and tests.** Injection, path traversal, secrets in code or logs, a missing permission check; errors swallowed, a rejection nobody handles, state left half-written when a step fails; changed behaviour with no test, or a test that still passes while asserting the old behaviour.
- **D. Cross-file and adversarial** (high only). Follow data from where it enters (user input, files, network, IPC) through the changed code to where it ends up. Then attack it: hostile or huge input, two calls at once, a different order of events, a different platform (Windows paths, case-insensitive file systems).
- **E. Intent** (only with \`review/intent.md\`, in the review session). Hold the change against what was wanted — the person's own words and decisions first, then the plan: something they asked for or decided that the diff does not do, does only in part or does differently; and anything the change does that neither mentions — behaviour, files, public interfaces. The implementation notes are claims: check each against the code rather than accepting it. Something listed as out of scope is deliberate, not missed; a gap listed as unverified is not a finding unless it breaks something.

**low** — no sub-agents. Read the diff and the code around each hunk yourself and go through A, B and C, and E when it applies. Every finding is PLAUSIBLE: nothing gets a second look at this level, and the report says so.

**medium** — in one reply, dispatch three \`task\` calls with \`subagent_type: "review"\`, one each for A, B and C — four, with E, when it applies — using the finder prompt below. When they have reported, verify every finding yourself (step 5).

**high** — dispatch at most four sub-agents per reply, and wait for a batch to report before sending the next.
1. Batch one: four \`review\` finders, one each for A, B, C and D.
2. Batch two: the E finder when it applies, one \`verify\` sub-agent (prompt below) — only when the working tree holds the code under review; for a PR that is not checked out, skip it and say so in the report — and one \`review\` checker per finding, up to four in all.
3. Further batches of up to four checkers until every finding, E's included, has been checked.

**Finder prompt** — fill in the brackets; the sub-agent knows nothing else:

\`\`\`
Review a code change for one dimension only: <dimension letter and name>.
Change: <local uncommitted changes | PR #<n> "<title>", base <base> | these files>.
Diff (read all of it first): <absolute path to review/diff.patch or review/files.txt>
Project rules: <absolute path to review/rules.md, or "none">
<review session only: Context (read before the diff): <absolute path to review/intent.md>. Background, constraints and intent for this dimension: <two or three sentences from the brief — why the change was made, the person's decisions that bear on it, what they wanted from this part>. The person's words and decisions outrank the plan; the author's notes in that file are claims to check, not facts.>
Repository: <absolute path>. <The working tree is | is not> the reviewed version<; if not, read changed code from the diff and whole files with git show <sha>:<path>>.

Look for: <the dimension's paragraph from these instructions, verbatim>

Report only concrete defects you can tie to a line and a triggering scenario. No style, naming, formatting or "consider" suggestions; nothing about untouched code unless the change breaks it. Read the callers and surrounding code before reporting — a claim one more file would disprove is not a finding. Do not modify files, and do not run builds or tests.
Return findings with file as path:line in the new version (for E, when nothing in the diff corresponds, the request, decision or plan item instead), a one-sentence problem, and failure: the concrete input or state and what goes wrong. Return no findings, and say so, if you found none.
\`\`\`

**Checker prompt** — one finding per checker:

\`\`\`
Someone claims this defect exists. Try to disprove it.
Claim: <file:line> — <problem>
Trigger: <failure>
Diff: <absolute path>. Repository: <absolute path>. <Working tree note as above.>
<review session only: Context: <absolute path to review/intent.md>, with the background, constraints and intent that bear on this claim in a sentence or two.>

Read the code at that location and everything the claim depends on: callers, guards, types, configuration, tests. If a guard, invariant or caller makes the trigger impossible, return no findings and say in the summary exactly what prevents it. If the claim holds, return it as one finding, corrected: exact line, sharper trigger. Do not modify files.
\`\`\`

**Verify prompt**:

\`\`\`
Run this project's checks for a change and report the results. Do not fix anything.
Repository: <absolute path>. Changed files: <list>. Project rules: <path or "none">.
Work out the commands from the project rules and the package manifests: the typecheck of each affected package and the tests that cover the changed files. Prefer the narrowest commands that cover them over whole-repository runs.
\`\`\`

## 5. Verify (medium and high)

Merge duplicates first: same location and same cause is one finding. Sub-agents are wrong often enough that none of their findings goes into the report on their word alone.

- **medium**: for each finding, read the cited lines and the code the claim depends on yourself.
- **high**: read each checker's result, then the cited lines.

Then label it:
- **CONFIRMED** — you followed the trigger through the code to the failure.
- **PLAUSIBLE** — consistent with the code, but it depends on something you could not establish (runtime configuration, input you cannot see, an external service).
- **Dropped** — the code disproves it. Do not report it.

A check from \`verify\` that fails because of this change is a CONFIRMED finding at the failure's location. A failure that is not caused by the change goes under "Not covered", not under findings.

## 6. Report

\`\`\`
## Review: <target> · effort <level>
<One line: what was reviewed (files, changed lines) and what ran (sub-agents, checks, intent compared with the brief).>
<low only: "Unverified: a single pass with no second look.">

### Findings
1. **[high] path/to/file.ts:42** — <the defect, one sentence>
   Trigger: <input or state> → <what goes wrong>
   Status: CONFIRMED

### Checks
<high: each command and its result>

### Not covered
<what was left out and why: files skipped, checks not run, gh unavailable>
\`\`\`

Order by severity, CONFIRMED before PLAUSIBLE within one. **high**: data loss, a security hole, or a crash or wrong result on a normal path. **medium**: wrong on an edge case a user will plausibly reach, or a broken error path, or something the person asked for or the plan set out missing or done differently. **low**: wrong only on a rare path, with limited effect. No style preferences, no praise, no summary of what the change does. If nothing survived, write "No defects found." with what was covered — do not invent something to report.

## F. Fix (review session only)

The implementing conversation decides what gets fixed — it knows what the person asked for — and you make the fixes, since you know the defects.

1. Skip this step when there is nothing to fix: no findings, or a PR whose head is not checked out (say fixes cannot apply here).
2. Write the step 6 report to \`review/report.md\`. Then call \`ask_session\` with the implementing conversation's address (the brief's last section gives it): the path to the report and one line per finding — its number, severity, \`file:line\`, the defect, CONFIRMED or PLAUSIBLE — and ask which numbers to fix. It may ask its person first: when the answer says it is waiting on its user, call \`wait_for_session\`. Edits stay refused until it has answered.
3. No answer — a timeout you have waited out, it was stopped or closed: fix nothing, and list every finding under "Awaiting a decision".
4. Fix exactly the findings it named — the smallest change that removes each defect, no refactoring around it, nothing it did not name. Then run the checks that cover the files you touched (reuse the commands \`verify\` ran, if it ran).
5. Add to the step 6 report:
\`\`\`
### Fixed
- <n> path/to/file.ts — <what changed>
### Left
- <n> — <the implementing conversation's reason>
### Checks after fixing
<each command and its result>
\`\`\`

## 7. --fix

Only where this conversation ran the whole pipeline itself (step 0, case 3), only after the report, and only the CONFIRMED findings; PLAUSIBLE ones are left for the person to decide. For each, make the smallest change that removes the defect — no refactoring around it. Then run the checks that cover the files you touched (reuse the commands \`verify\` ran, if it ran). Report what you fixed, the checks, and their results. For a PR whose head is not checked out, say \`--fix\` cannot apply and skip this step.

## 8. --comment (PR only)

Done by the conversation that holds the report: this one when it ran the pipeline itself, the implementing one when the report came back from a review session. A comment on the PR is visible to other people, so nothing is posted without an explicit yes.
1. Write the comment to \`review/comment.md\`: the report from step 6, findings labelled CONFIRMED or PLAUSIBLE.
2. Show the person the full text, then call \`ask_user\` with the options "Post this comment" and "Do not post".
3. Only on "Post this comment": \`gh pr comment <n> --body-file <scratch>/review/comment.md\`, and give the URL it prints. A skip, a cancel or any other answer means nothing is posted; say so.
`;

/** 人敲 `/review <参数>` 时发给模型的那条消息。没写参数就是审未提交的本地改动（第 1 步）。 */
export function reviewRequest(rest: string): string {
	// 和审阅会话交接单里那一行同一个写法（`review-brief.ts`）。
	return `${REVIEW_BODY}\n\n---\n\nArguments: ${rest || "none (the uncommitted local changes)"}`;
}
