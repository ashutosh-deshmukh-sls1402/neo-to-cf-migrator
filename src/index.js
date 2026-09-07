/**
 * Programmatic API. Returns data and emits events; never writes to a terminal.
 *
 * This is the UI boundary: a CLI renders the return value, and a future UI
 * subscribes to the same events and renders the same findings. Keeping the rule
 * ("only bin/ and src/report/ may print") costs nothing now and is what makes a
 * UI a rendering job later rather than a rewrite.
 */

import { discover } from './core/intake.js';

export { discover };
export { KIND, classifyFile, classifyFolder } from './core/artifacts.js';
export { flattenEntityName, flattenCallPath, RenameRegistry } from './core/naming.js';
export { targetsFor, importSpecifier } from './core/layout.js';

/**
 * Read-only survey of a NEO tree. Converts nothing, writes nothing.
 * @param {string} root
 * @param {{schema?:string, apps?:string[]}} [opts]
 */
export function inventory(root, opts = {}) {
  return discover(root, opts);
}
