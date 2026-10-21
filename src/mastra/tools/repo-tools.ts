import fs from "node:fs";
import path from "node:path";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { git } from "../../factory/git";

// Paths the AI may never read or write. This keeps it away from the factory
// itself (workflow + GitHub Action), dependencies and secrets.
const BLOCKED_PREFIXES = [".git/", ".github/", "src/mastra/", "src/factory/", "node_modules/", "screenshots/", ".factory-output/", ".mastra/"];
const BLOCKED_FILES = ["package.json", "package-lock.json", "tsconfig.json", "src/run-issue.ts"];
const MAX_READ_BYTES = 200_000;

export function isBlocked(relPath: string): boolean {
  const base = path.posix.basename(relPath);
  return (
    base.startsWith(".env") ||
    BLOCKED_FILES.includes(relPath) ||
    BLOCKED_PREFIXES.some((p) => relPath === p.slice(0, -1) || relPath.startsWith(p))
  );
}

/** Turn a path from the AI into a safe repo-relative path, or throw. */
function safePath(repoDir: string, input: string): { rel: string; abs: string } {
  const rel = path.posix.normalize(input.replace(/\\/g, "/").replace(/^\.\//, ""));
  if (path.posix.isAbsolute(rel) || rel.startsWith("..") || /^[a-zA-Z]:/.test(rel)) {
    throw new Error(`Path must be inside the repository: ${input}`);
  }
  if (isBlocked(rel)) throw new Error(`This path is off-limits: ${input}`);
  return { rel, abs: path.join(repoDir, rel) };
}

export interface AgentReport {
  status: "done" | "cannot_complete";
  summary: string;
  reason?: string;
}

/**
 * File tools bound to one repository. `touched` collects every path the AI
 * wrote or deleted; `report` holds the AI's final answer.
 */
export function createRepoTools(repoDir: string) {
  const touched = new Set<string>();
  const state: { report?: AgentReport } = {};

  const listFiles = createTool({
    id: "list-files",
    description: "List all files in the repository (paths relative to the repo root).",
    inputSchema: z.object({}),
    outputSchema: z.object({ files: z.array(z.string()) }),
    execute: async () => {
      const files = git(repoDir, ["ls-files", "--cached", "--others", "--exclude-standard"])
        .split("\n")
        .filter((f) => f && !isBlocked(f) && fs.existsSync(path.join(repoDir, f)));
      return { files };
    },
  });

  const readFile = createTool({
    id: "read-file",
    description: "Read a text file from the repository.",
    inputSchema: z.object({ path: z.string().describe("Repo-relative path") }),
    outputSchema: z.object({ content: z.string() }),
    execute: async ({ path: p }) => {
      const { abs } = safePath(repoDir, p);
      if (!fs.existsSync(abs)) throw new Error(`File not found: ${p}`);
      const buf = fs.readFileSync(abs);
      if (buf.length > MAX_READ_BYTES) throw new Error(`File too large to read (${buf.length} bytes): ${p}`);
      return { content: buf.toString("utf8") };
    },
  });

  const writeFile = createTool({
    id: "write-file",
    description: "Create or overwrite a text file with the full new content.",
    inputSchema: z.object({
      path: z.string().describe("Repo-relative path"),
      content: z.string().describe("The complete new file content"),
    }),
    outputSchema: z.object({ ok: z.boolean() }),
    execute: async ({ path: p, content }) => {
      const { rel, abs } = safePath(repoDir, p);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
      touched.add(rel);
      return { ok: true };
    },
  });

  const deleteFile = createTool({
    id: "delete-file",
    description: "Delete a file from the repository.",
    inputSchema: z.object({ path: z.string().describe("Repo-relative path") }),
    outputSchema: z.object({ ok: z.boolean() }),
    execute: async ({ path: p }) => {
      const { rel, abs } = safePath(repoDir, p);
      if (fs.existsSync(abs)) fs.rmSync(abs);
      touched.add(rel);
      return { ok: true };
    },
  });

  const finish = createTool({
    id: "finish",
    description:
      "Call exactly once at the end. Use status 'done' with a summary of what you changed, or 'cannot_complete' with the reason if the issue is unclear or impossible.",
    inputSchema: z.object({
      status: z.enum(["done", "cannot_complete"]),
      summary: z.string().describe("Markdown bullet list of the changes made (for the pull request)"),
      reason: z.string().optional().describe("Why the issue could not be completed"),
    }),
    outputSchema: z.object({ ok: z.boolean() }),
    execute: async (report) => {
      state.report = report;
      return { ok: true };
    },
  });

  return {
    tools: { listFiles, readFile, writeFile, deleteFile, finish },
    touched,
    getReport: () => state.report,
  };
}
