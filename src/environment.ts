/**
 * Reads a positive number from an environment variable, or `fallback` if it's
 * unset or empty. With `whole`, only whole numbers are accepted. Anything else
 * throws, so a bad setting stops the platform at startup.
 */
export function positiveNumberFromEnvironment(env: NodeJS.ProcessEnv, name: string, fallback: number, options: { whole?: boolean } = {}): number {
  const value = env[name];
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (options.whole ? !Number.isInteger(number) || number < 1 : !Number.isFinite(number) || number <= 0) {
    throw new Error(`${name} must be ${options.whole ? "a whole number of at least 1" : "a positive number"}, not "${value}"`);
  }
  return number;
}
