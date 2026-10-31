import { unavailableAgent } from "./agent.ts";
import { configuredCapUsd } from "./budget.ts";
import { startPlatform } from "./platform.ts";

const platform = await startPlatform({
  dataDir: process.env.DATA_DIR ?? "./data",
  agent: unavailableAgent,
  host: process.env.HOST ?? "0.0.0.0",
  consolePort: Number(process.env.CONSOLE_PORT ?? 3000),
  canvasPort: Number(process.env.CANVAS_PORT ?? 3001),
  spendingCapUsd: configuredCapUsd(),
});

console.log(`Console on port ${platform.consolePort}, Canvas on port ${platform.canvasPort}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void platform.close().then(() => process.exit(0));
  });
}
