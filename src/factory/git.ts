import { execFileSync } from "node:child_process";

function gitRaw(repoDir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function git(repoDir: string, args: string[]): string {
  return gitRaw(repoDir, args).trim();
}

export const currentSha = (repoDir: string) => git(repoDir, ["rev-parse", "HEAD"]);
export const currentBranch = (repoDir: string) => git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);

export function createBranch(repoDir: string, branch: string): void {
  // -B resets the branch if a previous attempt left it behind.
  git(repoDir, ["checkout", "-B", branch]);
}

/** Files that differ from HEAD (modified, added, deleted, untracked), limited to `paths`. */
export function changedFiles(repoDir: string, paths: string[]): string[] {
  if (paths.length === 0) return [];
  // Not trimmed: each line starts with a 2-letter status (" M", "??") whose leading space matters.
  // -z gives raw, unquoted file names separated by NUL.
  const out = gitRaw(repoDir, ["status", "--porcelain", "-z", "--untracked-files=all", "--", ...paths]);
  return out
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(3));
}

/** Commit only the given paths, so stray files (like node_modules) are never committed. */
export function commitPaths(repoDir: string, paths: string[], message: string): void {
  git(repoDir, ["add", "--all", "--", ...paths]);
  git(repoDir, [
    "-c", "user.name=ai-factory[bot]",
    "-c", "user.email=ai-factory[bot]@users.noreply.github.com",
    "commit", "-m", message,
  ]);
}

export function push(repoDir: string, branch: string): void {
  git(repoDir, ["push", "--force", "origin", branch]);
}

/** Check out a commit into a separate folder, used for "before" screenshots. */
export function addWorktree(repoDir: string, dir: string, sha: string): void {
  git(repoDir, ["worktree", "add", "--detach", dir, sha]);
}

export function removeWorktree(repoDir: string, dir: string): void {
  try {
    git(repoDir, ["worktree", "remove", "--force", dir]);
  } catch {
    /* already gone */
  }
}
