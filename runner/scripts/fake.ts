// pnpm fake: prints the fake runner's events, the shape Midhat's daemon receives.
import { randomUUID } from "node:crypto";
import { createFakeRunner } from "../src/index.js";

const runner = createFakeRunner();
for await (const event of runner.start({ sessionId: randomUUID(), repoPath: ".", prompt: "Fix the failing test", agent: "claude-code" })) {
  console.log(JSON.stringify(event));
}
