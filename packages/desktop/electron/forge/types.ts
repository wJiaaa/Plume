/**
 * What a code host is, to this app.
 *
 * Pull requests used to come from `gh`, which meant three things at once: GitHub only, a CLI that
 * had to be installed and separately logged in, and one identity — whichever account `gh` happened
 * to hold. All three were the same limitation wearing different clothes, and none of them are
 * about pull requests.
 *
 * So the shape here is a *driver*: an account plus a token, and six things a review screen needs.
 * GitHub, GitLab, Gitee and Gitea each answer them over their own HTTP API, and a self-hosted
 * instance of any of them is the same driver with a different address. Adding a fifth host is one
 * file that implements this interface, not a change to anything that draws a row.
 */

import type { ForgeAccount, ForgeKind, ForgeKindInfo, PullRequestDetail, PullRequestSummary, ReviewVerdict, WorkspaceDiffFile } from "@plume/contract";

/** An account with its secret, which is the only form a driver can use. */
export interface ForgeConnection {
	account: ForgeAccount;
	token: string;
}

/** Who a token belongs to, which is the one thing worth checking before saving it. */
export interface ForgeIdentity {
	login: string;
	name: string;
	avatarUrl: string | null;
}

/**
 * The six things a review screen asks of a host.
 *
 * Deliberately not "everything the API can do". Each of these is a question the UI already asks —
 * what is waiting on me, what is in this one, what changed, and the three ways of replying — and a
 * driver that answers them is complete regardless of what else its host offers.
 *
 * Every method may throw; the caller turns a throw into a message on a row rather than an empty
 * list, because "GitLab is down" and "you have no merge requests" must not look the same.
 */
export interface ForgeDriver {
	kind: ForgeKind;
	/** Who this token is, used to name the account and to prove the token works before saving it. */
	identify(conn: ForgeConnection): Promise<ForgeIdentity>;
	list(conn: ForgeConnection): Promise<PullRequestSummary[]>;
	detail(conn: ForgeConnection, repo: string, number: number): Promise<PullRequestDetail>;
	diff(conn: ForgeConnection, repo: string, number: number): Promise<WorkspaceDiffFile[]>;
	comment(conn: ForgeConnection, repo: string, number: number, body: string): Promise<void>;
	review(conn: ForgeConnection, repo: string, number: number, verdict: ReviewVerdict, body: string): Promise<void>;
}

export const FORGE_KINDS: ForgeKindInfo[] = [
	{
		kind: "github",
		name: "GitHub",
		baseUrl: "https://github.com",
		tokenUrl: "https://github.com/settings/tokens/new?scopes=repo,read:org,read:user&description=Plume",
		scopes: "repo · read:org · read:user",
		note: "GitHub Enterprise 填自己的地址即可，接口一样。",
	},
	{
		kind: "gitlab",
		name: "GitLab",
		baseUrl: "https://gitlab.com",
		tokenUrl: "https://gitlab.com/-/user_settings/personal_access_tokens?name=Plume&scopes=api",
		scopes: "api",
		note: "自建 GitLab 把地址换成你的域名，路径 /api/v4 由应用自己补。",
	},
	{
		kind: "gitee",
		name: "Gitee 码云",
		baseUrl: "https://gitee.com",
		tokenUrl: "https://gitee.com/personal_access_tokens/new",
		scopes: "projects · pull_requests · user_info",
		note: "Gitee 没有跨仓库的 PR 搜索，应用会扫描你最近推送过的仓库。",
	},
	{
		kind: "gitea",
		name: "Gitea / Forgejo",
		baseUrl: "",
		tokenUrl: "",
		scopes: "read:user · read:repository · write:issue · write:repository",
		note: "自建为主。填服务地址，例如 https://git.example.com。",
	},
];
