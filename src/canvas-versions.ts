/**
 * How the Canvas addresses its versions, defined once for the Canvas server,
 * the Console and the Canvas's browser scripts.
 */

/** `/@<commit>/<path>`: a file as it is at one commit. */
export const PINNED_PATH = /^\/@([0-9a-f]{40})(\/.*)$/;
/** The query parameter marking a pinned, view-only page, as in `/@<commit>/?version`. */
export const VERSION_MARKER = "version";
/** Set on the platform services' 403 for a change from a view-only page, so the services library can drop it quietly. */
export const VIEW_ONLY_HEADER = "x-platform-view-only";

/** The view-only address of the Canvas's front page at `commit`. */
export function pinnedViewPath(commit: string): string {
  return `/@${commit}/?${VERSION_MARKER}`;
}

/** The identifier a browser script uses for these definitions; the Canvas server fills it in when serving the script. */
const PLACEHOLDER = "__PLATFORM_VERSIONS__";

/** `script` with these definitions in place of `__PLATFORM_VERSIONS__`. */
export function withVersionDefinitions(script: string): string {
  if (!script.includes(PLACEHOLDER)) throw new Error(`Expected ${PLACEHOLDER} in a Canvas browser script`);
  const definitions = `{ PINNED_PATH: ${PINNED_PATH}, VERSION_MARKER: ${JSON.stringify(VERSION_MARKER)}, VIEW_ONLY_HEADER: ${JSON.stringify(VIEW_ONLY_HEADER)} }`;
  return script.split(PLACEHOLDER).join(definitions);
}
