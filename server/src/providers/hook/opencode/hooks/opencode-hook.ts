/**
 * Opencode plugin for Pixel Agents.
 *
 * Loaded by Opencode at startup as an ESM module from
 * ~/.config/opencode/plugins/pixel-agents.mjs.
 *
 * Forwards every lifecycle event to the Pixel Agents HTTP server so the
 * opencode HookProvider can normalize them into AgentEvents.
 *
 * Pure Node built-ins (http, fs) — zero dependencies, bundles to < 2 KB.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import { HOOK_API_PREFIX, SERVER_JSON_DIR, SERVER_JSON_NAME } from '../../../../constants.js';
import type { ServerConfig } from '../../../../server.js';

const SERVER_JSON = path.join(os.homedir(), SERVER_JSON_DIR, SERVER_JSON_NAME);

let cachedConfig: ServerConfig | null = null;
let configLoadAttempted = false;

function getServerConfig(): ServerConfig | null {
  if (configLoadAttempted && cachedConfig) return cachedConfig;
  configLoadAttempted = true;
  try {
    if (fs.existsSync(SERVER_JSON)) {
      cachedConfig = JSON.parse(fs.readFileSync(SERVER_JSON, 'utf-8'));
      return cachedConfig;
    }
  } catch {
    /* server not running yet */
  }
  cachedConfig = null;
  return null;
}

export const pixelAgentsPlugin = async (): Promise<{
  event: (ctx: { event: Record<string, unknown> }) => Promise<void>;
}> => {
  return {
    event: async ({ event }: { event: Record<string, unknown> }): Promise<void> => {
      const config = getServerConfig();
      if (!config) return;

      const body = JSON.stringify(event);
      return new Promise<void>((resolve) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: config.port,
            path: `${HOOK_API_PREFIX}/opencode`,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
              Authorization: `Bearer ${config.token}`,
            },
            timeout: 2000,
          },
          (res) => {
            res.resume();
            resolve();
          },
        );
        req.on('error', () => resolve());
        req.on('timeout', () => {
          req.destroy();
          resolve();
        });
        req.end(body);
      });
    },
  };
};
