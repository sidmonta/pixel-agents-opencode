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

const agentBySession = new Map<string, string>();

// ── SIGINT / process-exit handler ──

let shutdownSetup = false;
function setupShutdown(): void {
  if (shutdownSetup) return;
  shutdownSetup = true;
  const handler = (): void => {
    const config = getServerConfig();
    if (!config || agentBySession.size === 0) return;
    console.log('[Pixel Agents] Sending session end to server...');
    const promises: Promise<void>[] = [];
    for (const [sessionId, agentName] of agentBySession) {
      promises.push(
        forwardToServer(
          {
            type: 'session.deleted',
            sessionId,
            properties: { sessionID: sessionId, info: { agent: agentName } },
            data: { reason: 'process.exit' },
          },
          config,
        ),
      );
    }
    Promise.all(promises).catch(() => {});
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

function forwardToServer(event: Record<string, unknown>, config: ServerConfig): Promise<void> {
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
}

function trackAgent(event: Record<string, unknown>): void {
  const evt = event as Record<string, unknown>;
  const type = evt.type;
  const props = evt.properties as Record<string, unknown> | undefined;
  if (!props) return;

  let sessionID: unknown;
  let agentName: unknown;

  if (type === 'session.created' || type === 'session.updated') {
    const info = props.info as Record<string, unknown> | undefined;
    agentName = info?.agent;
    sessionID = props.sessionID ?? evt.sessionId;
  } else if (type === 'message.updated') {
    const info = props.info as Record<string, unknown> | undefined;
    if (info?.role !== 'user') return;
    agentName = info.agent;
    sessionID = info.sessionID ?? props.sessionID ?? evt.sessionId;
  } else {
    return;
  }

  if (typeof agentName !== 'string' || agentName.length === 0) return;
  if (typeof sessionID === 'string' && sessionID.length > 0) {
    agentBySession.set(sessionID, agentName);
  }
}

function maybeInjectAgent(event: Record<string, unknown>): Record<string, unknown> {
  const props = (event as Record<string, unknown>).properties as Record<string, unknown> | undefined;
  if (!props) return event;
  const sessionID = props.sessionID;
  if (typeof sessionID !== 'string') return event;
  const existingInfo = props.info as Record<string, unknown> | undefined;
  if (existingInfo?.agent) return event;
  const cachedAgent = agentBySession.get(sessionID);
  if (!cachedAgent) return event;
  return {
    ...event,
    properties: {
      ...props,
      info: {
        ...(existingInfo || {}),
        agent: cachedAgent,
      },
    },
  };
}

export const pixelAgentsPlugin = async (): Promise<{
  event: (ctx: { event: Record<string, unknown> }) => Promise<void>;
}> => {
  return {
    event: async ({ event }: { event: Record<string, unknown> }): Promise<void> => {
      const config = getServerConfig();
      if (!config) return;

      setupShutdown();
      trackAgent(event);
      const modifiedEvent = maybeInjectAgent(event);
      await forwardToServer(modifiedEvent, config);
    },
  };
};
