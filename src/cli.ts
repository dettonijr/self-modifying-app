import { runHostCommand } from "./host-commands.ts";

const { exitCode, output } = runHostCommand(process.argv.slice(2));
(exitCode === 0 ? console.log : console.error)(output);
process.exitCode = exitCode;
