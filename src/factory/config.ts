import path from "node:path";

// Settings for the issue-to-PR factory, read from environment variables.
// Secrets (tokens, API keys) stay in the environment and never go into workflow
// input data, because Mastra may store workflow snapshots.
export interface FactoryConfig {
  /** Git repository the AI works on. */
  repoDir: string;
  /** "owner/name" of the GitHub repo. */
  repo?: string;
  token?: string;
  /** Local mode: no push, no GitHub API calls; the PR text is written to a file. */
  dryRun: boolean;
  label: string;
  model: string;
  /** Where dry-run output (the PR description) is written. */
  outputDir: string;
}

export function getConfig(): FactoryConfig {
  const repoDir = path.resolve(process.env.FACTORY_REPO_DIR ?? process.cwd());
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  return {
    repoDir,
    repo,
    token,
    dryRun: process.env.FACTORY_DRY_RUN === "1" || !token || !repo,
    label: process.env.FACTORY_LABEL ?? "ai-implement",
    model: process.env.FACTORY_MODEL ?? "google/gemini-3.1-pro-preview",
    outputDir: path.resolve(process.env.FACTORY_OUTPUT_DIR ?? path.join(repoDir, ".factory-output")),
  };
}

export const branchFor = (issueNumber: number) => `ai/issue-${issueNumber}`;
export const screenshotDirFor = (issueNumber: number) => `screenshots/issue-${issueNumber}`;
