import { Mastra } from "@mastra/core/mastra";
import { greetingWorkflow } from "./workflows/greeting-workflow";
import { issueToPrWorkflow } from "./workflows/issue-to-pr-workflow";

export const mastra = new Mastra({
  workflows: { greetingWorkflow, issueToPrWorkflow },
});
