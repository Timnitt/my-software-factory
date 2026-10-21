import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

// Step 1: build a greeting from the person's name.
const createGreeting = createStep({
  id: "create-greeting",
  inputSchema: z.object({ name: z.string() }),
  outputSchema: z.object({ greeting: z.string() }),
  execute: async ({ inputData }) => {
    return { greeting: `Hello, ${inputData.name}!` };
  },
});

// Step 2: take the greeting from step 1 and add some details.
const formatGreeting = createStep({
  id: "format-greeting",
  inputSchema: z.object({ greeting: z.string() }),
  outputSchema: z.object({ message: z.string(), length: z.number() }),
  execute: async ({ inputData }) => {
    const message = `${inputData.greeting.toUpperCase()} Welcome to Mastra.`;
    return { message, length: message.length };
  },
});

// The workflow: run step 1, then step 2.
export const greetingWorkflow = createWorkflow({
  id: "greeting-workflow",
  inputSchema: z.object({ name: z.string() }),
  outputSchema: z.object({ message: z.string(), length: z.number() }),
})
  .then(createGreeting)
  .then(formatGreeting)
  .commit();
