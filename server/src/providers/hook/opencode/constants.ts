/**
 * Opencode-specific constants. Same layering principle as Claude's constants:
 * kept separate so a single-provider build doesn't accumulate unwanted deps.
 */
/** Output filename after esbuild compiles opencode-hook.ts to ESM */
export const OPENCODE_PLUGIN_NAME = 'pixel-agents.js';

/** Opencode plugin events. Each fires a callback in the plugin loaded by Opencode. */
export const OPENCODE_PLUGIN_EVENTS = [
  'session.created',
  'session.status',
  'session.idle',
  'session.deleted',
  'tool.execute.before',
  'tool.execute.after',
  'permission.asked',
  'permission.replied',
] as const;

/** Terminal name prefix when launching Opencode in VS Code. */
export const OPENCODE_TERMINAL_NAME_PREFIX = 'Opencode';

/** Directory where Opencode stores its plugin files. */
export const OPENCODE_PLUGINS_DIR = '.config/opencode/plugins';
