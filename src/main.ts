import { agentFromEnvironment } from "./claude-agent.ts";
import { configuredCapUsd } from "./budget.ts";
import { startPlatform } from "./platform.ts";
import { maxParallelRunsFromEnvironment } from "./runs.ts";

const platform = await startPlatform({
  dataDir: process.env.DATA_DIR ?? "./data",
  agent: agentFromEnvironment(process.env),
  host: process.env.HOST ?? "0.0.0.0",
  consolePort: Number(process.env.CONSOLE_PORT ?? 3000),
  canvasPort: Number(process.env.CANVAS_PORT ?? 3001),
  spendingCapUsd: configuredCapUsd(),
  maxParallelRuns: maxParallelRunsFromEnvironment(),
});

console.log(`Console on port ${platform.consolePort}, Canvas on port ${platform.canvasPort}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void platform.close().then(() => process.exit(0));
  });
}
