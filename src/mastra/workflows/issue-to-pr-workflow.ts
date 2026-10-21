import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { branchFor, getConfig, screenshotDirFor } from "../../factory/config";
import { addWorktree, changedFiles, commitPaths, createBranch, currentBranch, currentSha, push, removeWorktree } from "../../factory/git";
import { canWrite, commentOnIssue, createDraftPullRequest, rawFileUrl } from "../../factory/github";
import { capturePages, pagesToCapture } from "../../factory/screenshots";
import { createDeveloperAgent } from "../agents/developer-agent";

const issueSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string(),
  labeler: z.string(),
});

const preparedSchema = z.object({
  issue: issueSchema,
  baseSha: z.string(),
  baseBranch: z.string(),
  branch: z.string(),
});

const implementedSchema = preparedSchema.extend({
  changedFiles: z.array(z.string()),
  summary: z.string(),
});

const screenshotSchema = z.object({
  page: z.string(),
  before: z.string().optional(),
  after: z.string(),
});

const capturedSchema = implementedSchema.extend({
  screenshots: z.array(screenshotSchema),
});

// Step 1: check who added the label, announce the run, create the work branch.
const prepare = createStep({
  id: "prepare",
  inputSchema: z.object({ issue: issueSchema }),
  outputSchema: preparedSchema,
  execute: async ({ inputData: { issue } }) => {
    const { repoDir } = getConfig();
    if (!(await canWrite(issue.labeler))) {
      throw new Error(`@${issue.labeler} does not have write access, so the AI was not started.`);
    }
    await commentOnIssue(issue.number, "🤖 Working on it. I'll open a draft pull request when I'm done.");

    const baseSha = currentSha(repoDir);
    const baseBranch = currentBranch(repoDir);
    const branch = branchFor(issue.number);
    createBranch(repoDir, branch);
    return { issue, baseSha, baseBranch, branch };
  },
});

// Step 2: the AI agent reads the repo and edits files.
const implement = createStep({
  id: "implement",
  inputSchema: preparedSchema,
  outputSchema: implementedSchema,
  execute: async ({ inputData }) => {
    const { repoDir } = getConfig();
    const { agent, touched, getReport } = createDeveloperAgent(repoDir);
    const { issue } = inputData;

    await agent.generate(
      `Implement GitHub issue #${issue.number}.\n\nTitle: ${issue.title}\n\nDescription:\n${issue.body || "(no description)"}`,
      { maxSteps: 60 },
    );

    const report = getReport();
    if (!report) throw new Error("The AI stopped without reporting a result.");
    if (report.status === "cannot_complete") {
      throw new Error(`The AI could not complete this issue: ${report.reason ?? report.summary}`);
    }
    const files = changedFiles(repoDir, [...touched]);
    if (files.length === 0) throw new Error("The AI finished but did not change any files.");

    return { ...inputData, changedFiles: files, summary: report.summary };
  },
});

// Step 3: before/after screenshots of pages affected by .html/.css changes.
const captureScreenshots = createStep({
  id: "capture-screenshots",
  inputSchema: implementedSchema,
  outputSchema: capturedSchema,
  execute: async ({ inputData }) => {
    const { repoDir } = getConfig();
    const pages = pagesToCapture(repoDir, inputData.changedFiles);
    if (pages.length === 0) return { ...inputData, screenshots: [] };

    const outDir = path.join(repoDir, screenshotDirFor(inputData.issue.number));
    const after = await capturePages({ rootDir: repoDir, pages, outDir, suffix: "after" });

    // "Before" = the same pages from the commit we started from.
    const beforeDir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-before-"));
    fs.rmSync(beforeDir, { recursive: true });
    let before: Record<string, string> = {};
    try {
      addWorktree(repoDir, beforeDir, inputData.baseSha);
      before = await capturePages({ rootDir: beforeDir, pages, outDir, suffix: "before" });
    } finally {
      removeWorktree(repoDir, beforeDir);
    }

    const screenshots = pages
      .filter((page) => after[page])
      .map((page) => ({ page, before: before[page], after: after[page] }));
    return { ...inputData, screenshots };
  },
});

function buildPrBody(data: z.infer<typeof capturedSchema>, imageUrl: (file: string) => string): string {
  const lines = [`Closes #${data.issue.number}`, "", "## Summary", "", data.summary.trim(), ""];
  lines.push("## Changed files", "", ...data.changedFiles.map((f) => `- \`${f}\``), "");
  if (data.screenshots.length > 0) {
    lines.push("## Screenshots", "");
    for (const shot of data.screenshots) {
      const beforeCell = shot.before ? `<img src="${imageUrl(shot.before)}" width="400">` : "_new page_";
      lines.push(
        `### \`${shot.page}\``,
        "",
        "| Before | After |",
        "| --- | --- |",
        `| ${beforeCell} | <img src="${imageUrl(shot.after)}" width="400"> |`,
        "",
      );
    }
  }
  lines.push("---", "_Opened automatically by the ai-implement workflow. Please review before merging._");
  return lines.join("\n");
}

// Step 4: commit, push, open the draft PR and link it on the issue.
const openPullRequest = createStep({
  id: "open-pull-request",
  inputSchema: capturedSchema,
  outputSchema: z.object({ prUrl: z.string(), branch: z.string() }),
  execute: async ({ inputData }) => {
    const config = getConfig();
    const { repoDir } = config;
    const { issue, branch } = inputData;
    const shotDir = screenshotDirFor(issue.number);

    const paths = [...inputData.changedFiles];
    if (inputData.screenshots.length > 0) paths.push(shotDir);
    commitPaths(repoDir, paths, `AI: implement #${issue.number} ${issue.title}`);

    const title = `AI: ${issue.title} (#${issue.number})`;
    let prUrl: string;
    if (config.dryRun) {
      fs.mkdirSync(config.outputDir, { recursive: true });
      const bodyFile = path.join(config.outputDir, `pr-issue-${issue.number}.md`);
      const imageUrl = (file: string) =>
        path.relative(config.outputDir, path.join(repoDir, shotDir, file)).replace(/\\/g, "/");
      fs.writeFileSync(bodyFile, `# ${title}\n\n${buildPrBody(inputData, imageUrl)}\n`);
      prUrl = bodyFile;
      console.log(`[dry-run] Skipped push. PR description written to ${bodyFile}`);
    } else {
      push(repoDir, branch);
      const imageUrl = (file: string) => rawFileUrl(branch, `${shotDir}/${file}`);
      prUrl = await createDraftPullRequest({
        title,
        head: branch,
        base: inputData.baseBranch,
        body: buildPrBody(inputData, imageUrl),
      });
    }

    await commentOnIssue(issue.number, `✅ Draft pull request ready: ${prUrl}`);
    return { prUrl, branch };
  },
});

export const issueToPrWorkflow = createWorkflow({
  id: "issue-to-pr",
  inputSchema: z.object({ issue: issueSchema }),
  outputSchema: z.object({ prUrl: z.string(), branch: z.string() }),
})
  .then(prepare)
  .then(implement)
  .then(captureScreenshots)
  .then(openPullRequest)
  .commit();
