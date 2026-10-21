import { mastra } from "./mastra/index";

const workflow = mastra.getWorkflow("greetingWorkflow");
const run = await workflow.createRun();
const result = await run.start({ inputData: { name: process.argv[2] ?? "World" } });

console.log(JSON.stringify(result, null, 2));
