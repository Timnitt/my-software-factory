import { getConfig } from "./config";

// Small wrapper around the GitHub REST API. In dry-run mode every call is
// logged instead of sent, so the whole flow can be tested locally.

async function api<T = any>(method: string, route: string, body?: unknown): Promise<T> {
  const { repo, token } = getConfig();
  const res = await fetch(`https://api.github.com/repos/${repo}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`GitHub ${method} ${route} failed: ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export async function commentOnIssue(issueNumber: number, body: string): Promise<void> {
  if (getConfig().dryRun) {
    console.log(`[dry-run] Comment on issue #${issueNumber}:\n${body}\n`);
    return;
  }
  await api("POST", `/issues/${issueNumber}/comments`, { body });
}

export async function removeLabel(issueNumber: number, label: string): Promise<void> {
  if (getConfig().dryRun) {
    console.log(`[dry-run] Remove label "${label}" from issue #${issueNumber}`);
    return;
  }
  try {
    await api("DELETE", `/issues/${issueNumber}/labels/${encodeURIComponent(label)}`);
  } catch (err) {
    console.warn(`Could not remove label: ${(err as Error).message}`);
  }
}

/** True when the user has write, maintain or admin access to the repo. */
export async function canWrite(username: string): Promise<boolean> {
  if (getConfig().dryRun) return true;
  const { permission } = await api<{ permission: string }>(
    "GET",
    `/collaborators/${encodeURIComponent(username)}/permission`,
  );
  return permission === "admin" || permission === "write";
}

export async function createDraftPullRequest(opts: {
  title: string;
  head: string;
  base: string;
  body: string;
}): Promise<string> {
  const pr = await api<{ html_url: string }>("POST", "/pulls", { ...opts, draft: true });
  return pr.html_url;
}

/** URL that renders a file committed on a branch (used for screenshots in the PR body). */
export function rawFileUrl(branch: string, filePath: string): string {
  const { repo } = getConfig();
  return `https://github.com/${repo}/blob/${encodeURIComponent(branch)}/${filePath}?raw=true`;
}
