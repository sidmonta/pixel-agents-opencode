/**
 * Opencode diagnostics plugin — logs all raw events to /tmp/opencode-events.jsonl
 * Install: cp this file to ~/.config/opencode/plugins/opencode-diagnostics.mjs
 * Usage:   tail -f /tmp/opencode-events.jsonl | jq .
 */
import * as fs from "fs"
const LOG = "/tmp/opencode-events.jsonl"
function log(raw) { try { fs.appendFileSync(LOG, JSON.stringify(raw) + "\n", "utf-8") } catch {} }
export const DiagnosticsPlugin = async () => {
  fs.writeFileSync(LOG, "", "utf-8")
  console.log("[diagnostics] Logging events to", LOG)
  return { event: async ({ event }) => { log(event) } }
}
