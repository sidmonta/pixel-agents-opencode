/**
 * Opencode diagnostics plugin for Pixel Agents.
 *
 * Logs every raw event to /tmp/opencode-events.jsonl for inspection.
 * Install: copy to ~/.config/opencode/plugins/opencode-diagnostics.mjs
 * Usage: tail -f /tmp/opencode-events.jsonl
 */

import * as fs from 'fs';

const LOG = '/tmp/opencode-events.jsonl';

function log(raw: unknown): void {
  try {
    const line = JSON.stringify(raw) + '\n';
    fs.appendFileSync(LOG, line, 'utf-8');
  } catch {
    // best effort
  }
}

export const DiagnosticsPlugin = async (): Promise<{
  event: (ctx: { event: Record<string, unknown> }) => Promise<void>;
}> => {
  fs.writeFileSync(LOG, '', 'utf-8');
  console.log(`[Pixel Agents] Diagnostics logging to ${LOG}`);

  return {
    event: async ({ event }: { event: Record<string, unknown> }): Promise<void> => {
      log(event);
    },
  };
};
