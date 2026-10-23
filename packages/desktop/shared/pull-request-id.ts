/**
 * What identifies a pull request row, now that rows arrive from more than one account.
 *
 * Both processes ask it — the main process when it merges buckets, the window when it keys its
 * cache and its read marks — and the two must agree, which is why it lives here rather than as two
 * copies kept in step by a comment.
 *
 * The account is part of it because `owner/name` is not unique across hosts — a company's own
 * GitHub Enterprise happily holds a repository with the same name as one on github.com — and
 * because the same pull request seen through two accounts is two different sets of things you are
 * allowed to do to it.
 */
export const rowId = (pr: { accountId: string; repo: string; number: number }) => `${pr.accountId}:${pr.repo}#${pr.number}`;
