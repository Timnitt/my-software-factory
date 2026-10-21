import "dotenv/config";
import fs from "node:fs";
import { getConfig } from "./factory/config";
import { git } from "./factory/git";
import { commentOnIssue, removeLabel } from "./factory/github";
import { mastra } from "./mastra/index";

// Starts the issue-to-PR workflow.
// - In GitHub Actions: reads the "issues: labeled" event from GITHUB_EVENT_PATH.
// - Locally:  npx tsx src/run-issue.ts --issue examples/sample-issue.json

interface Issue {
  number: number;
  title: string;
  body: string;
  labeler: string;
}

function loadIssue(): { issue: Issue; label: string } {
  const flag = process.argv.indexOf("--issue");
  if (flag !== -1) {
    const file = JSON.parse(fs.readFileSync(process.argv[flag + 1], "utf8"));
    return { issue: { labeler: "local-user", body: "", ...file }, label: getConfig().label };
  }
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("Pass --issue <file.json>, or run inside GitHub Actions.");
  const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  return {
    issue: {
      number: event.issue.number,
      title: event.issue.title,
      body: event.issue.body ?? "",
      labeler: event.sender.login,
    },
    label: event.label?.name,
  };
}

async function main() {
  const config = getConfig();
  const { issue, label } = loadIssue();
  if (label !== config.label) {
    console.log(`Label "${label}" is not "${config.label}". Nothing to do.`);
    return;
  }
  console.log(`Issue #${issue.number}: ${issue.title} (dry run: ${config.dryRun}, model: ${config.model})`);

  const startBranch = git(config.repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const run = await mastra.getWorkflow("issueToPrWorkflow").createRun();
  const result = await run.start({ inputData: { issue } });

  if (result.status === "success") {
    console.log(`Done: ${result.result.prUrl}`);
    return;
  }

  // Failure: explain on the issue, remove the label so it can be re-added to retry.
  const error = (result as { error?: unknown }).error;
  const reason = error instanceof Error ? error.message : String((error as any)?.message ?? error ?? result.status);
  console.error(`Workflow ${result.status}: ${reason}`);
  await commentOnIssue(
    issue.number,
    `⚠️ I couldn't open a pull request for this issue.\n\n**Reason:** ${reason}\n\nRemove and re-add the \`${config.label}\` label to try again.`,
  );
  await removeLabel(issue.number, config.label);

  // In CI, throw away the half-done work. Locally, never reset: it could wipe your own uncommitted changes.
  if (process.env.CI === "true") {
    try {
      git(config.repoDir, ["reset", "--hard"]);
      git(config.repoDir, ["checkout", startBranch]);
    } catch {
      /* best effort */
    }
  } else {
    console.error(`Local run: left the working tree as is. You started on branch "${startBranch}".`);
  }
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
