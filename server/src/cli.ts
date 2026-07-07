#!/usr/bin/env node

/**
 * Standalone CLI entry point: `npx pixel-agents`
 *
 * Starts the Fastify server in standalone mode with SPA serving and WebSocket.
 * Loads all assets (PNGs -> SpriteData) on startup and caches in memory.
 * Each connecting WebSocket client receives the full state on webviewReady.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AgentRuntime } from './agentRuntime.js';
import { AgentStateStore } from './agentStateStore.js';
import {
  loadCharacterSprites,
  loadDefaultLayout,
  loadFloorTiles,
  loadFurnitureAssets,
  loadPetSprites,
  loadWallTiles,
} from './assetLoader.js';
import type { AssetCache } from './clientMessageHandler.js';
import { FileStateAdapter } from './fileStateAdapter.js';
import type { SessionRoomInfo } from './layoutBuilder.js';
import { addSessionRoom, removeSessionRoom } from './layoutBuilder.js';
import { readLayoutFromFile, writeLayoutToFile } from './layoutPersistence.js';
import {
  claudeProvider,
  copyHookScript,
  copyPluginScript,
  opencodeProvider,
} from './providers/index.js';
import { PixelAgentsServer } from './server.js';
import type { AgentState } from './types.js';

// ── Argument parsing ──────────────────────────────────────────

interface CliArgs {
  port: number;
  host: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { port: 3100, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--port' || argv[i] === '-p') && argv[i + 1]) {
      args.port = parseInt(argv[i + 1], 10);
      i++;
    } else if (argv[i] === '--host' && argv[i + 1]) {
      args.host = argv[i + 1];
      i++;
    } else if (argv[i] === '--help') {
      console.log(`Usage: pixel-agents [options]

Options:
  --port, -p <number>   Port to listen on (default: 3100)
  --host <string>       Host to bind to (default: 127.0.0.1)
  --help                Show this help message`);
      process.exit(0);
    }
  }
  return args;
}

// ── Opencode agent discovery ──────────────────────────────────

const OPENCODE_CONFIG_PATH = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');

/** Agenti di sistema nascosti che non devono apparire nell'ufficio. */
const HIDDEN_SYSTEM_AGENTS = new Set(['compaction', 'title', 'summary']);

/** Read agent names from `opencode agent list`. Falls back to config file keys. */
function readOpencodeAgentNames(): string[] {
  try {
    const out = execSync('opencode agent list', { encoding: 'utf-8', timeout: 5000 });
    const names: string[] = [];
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      // Lines like: "explore (subagent)" or "plan (primary)"
      const match = trimmed.match(/^(\S+)\s+\(/);
      if (match) {
        const name = match[1]!;
        if (!HIDDEN_SYSTEM_AGENTS.has(name)) {
          names.push(name);
        }
      }
    }
    if (names.length > 0) return names;
  } catch {
    // command not available or failed
  }
  // Fallback: read config file keys
  try {
    const raw = fs.readFileSync(OPENCODE_CONFIG_PATH, 'utf-8');
    const config = JSON.parse(raw);
    const agents = config.agent;
    if (agents && typeof agents === 'object') {
      return Object.keys(agents).filter((k) => !HIDDEN_SYSTEM_AGENTS.has(k));
    }
  } catch {
    // Config not found or invalid
  }
  return [];
}

// ── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // dist/ contains both the CLI bundle and the assets/ + webview/ directories
  const distRoot = __dirname;
  const staticDir = path.join(distRoot, 'webview');

  // ── Load assets on startup (same pipeline as VS Code extension) ──
  console.log('[Pixel Agents] Loading assets...');
  const assetCache: AssetCache = {
    characters: await loadCharacterSprites(distRoot),
    pets: await loadPetSprites(distRoot),
    floorTiles: await loadFloorTiles(distRoot).then((t) => t?.sprites ?? null),
    wallTiles: await loadWallTiles(distRoot).then((t) => t?.sets ?? null),
    furniture: await loadFurnitureAssets(distRoot),
    defaultLayout: loadDefaultLayout(distRoot),
  };
  const charCount = assetCache.characters?.characters.length ?? 0;
  const petCount = assetCache.pets?.pets.length ?? 0;
  const furnitureCount = assetCache.furniture?.catalog.length ?? 0;
  console.log(
    `[Pixel Agents] Assets loaded: ${charCount} characters, ${petCount} pets, ${furnitureCount} furniture items`,
  );

  // ── Store + adapter (shared settings + standalone-scoped agents/seats) ──
  const store = new AgentStateStore();
  const adapter = new FileStateAdapter({ namespace: 'standalone' });
  store.setAdapter(adapter);

  // ── Create server ──
  const server = new PixelAgentsServer();

  try {
    // Create runtime first (before server.start, so we can pass it in)
    // Register all providers: Claude (file-fallback capable) + Opencode (hook-only)
    const runtime = new AgentRuntime(store, [claudeProvider, opencodeProvider]);

    // Track session→room mapping for dynamic layout rooms (Opencode sessions)
    const sessionRooms = new Map<string, SessionRoomInfo>();

    runtime.setLifecycleCallbacks({
      onExternalSessionDetected: (sessionId, transcriptPath, cwd, agentName) => {
        console.log(`[Pixel Agents] cli: onExternalSessionDetected(sessionId=${sessionId.slice(0, 8)}..., transcriptPath=${!!transcriptPath}, cwd=${cwd?.slice(0, 30)}, agentName=${agentName ?? 'undefined'})`);
        if (sessionRooms.has(sessionId)) {
          console.log(`[Pixel Agents] cli: sessionRooms GUARD HIT for ${sessionId.slice(0, 8)}...`);
          return;
        }
        try {
          if (!assetCache.defaultLayout) return;
          const existingSessionCount = new Set([...store.values()].map((agent) => agent.sessionId)).size;
          if (transcriptPath) {
            // File-based provider (Claude/Codex): one agent per session.
            // Agent was already created by adoptExternalSessionFromHook.
            const saved = readLayoutFromFile() ?? assetCache?.defaultLayout ?? null;
            if (!saved) return;
            if (existingSessionCount <= 1) return;
            const { layout, roomInfo } = addSessionRoom(
              saved,
              sessionId,
              assetCache.defaultLayout,
              sessionRooms.size,
            );
            writeLayoutToFile(layout);
            sessionRooms.set(sessionId, roomInfo);
            store.broadcast({ type: 'layoutLoaded', layout });
          } else if (agentName) {
            // Hook-only provider (Opencode), sub-session: known agent name,
            // create exactly one agent for this session (no duplicates).
            const saved = readLayoutFromFile() ?? assetCache?.defaultLayout ?? null;
            if (!saved) return;
            if (existingSessionCount === 0) {
              console.log('[Pixel Agents] cli: first session uses bundled base room');
            } else {
              const { layout, roomInfo } = addSessionRoom(
                saved,
                sessionId,
                assetCache.defaultLayout,
                sessionRooms.size,
              );
              writeLayoutToFile(layout);
              sessionRooms.set(sessionId, roomInfo);
              store.broadcast({ type: 'layoutLoaded', layout });
            }

            console.log(`[Pixel Agents] cli: Creating agent ${agentName} for session ${sessionId.slice(0, 8)}...`);
            const agentId = store.nextAgentId.current++;
            const agent: AgentState = {
              id: agentId,
              sessionId,
              terminalRef: undefined,
              isExternal: true,
              projectDir: cwd ?? process.cwd(),
              jsonlFile: '',
              fileOffset: 0,
              lineBuffer: '',
              activeToolIds: new Set(),
              activeToolStatuses: new Map(),
              activeToolNames: new Map(),
              activeSubagentToolIds: new Map(),
              activeSubagentToolNames: new Map(),
              backgroundAgentToolIds: new Set(),
              isWaiting: false,
              permissionSent: false,
              hadToolsInTurn: false,
              hookDelivered: true,
              hooksOnly: true,
              lastDataAt: Date.now(),
              linesProcessed: 0,
              seenUnknownRecordTypes: new Set(),
              folderName: cwd ? path.basename(cwd) : undefined,
              inputTokens: 0,
              outputTokens: 0,
              agentName,
              providerId: 'opencode',
            };
            store.set(agentId, agent);
            runtime.registerAgent(sessionId, agentId, agentName);
            store.broadcast({ type: 'agentTeamInfo', id: agentId, agentName });
            store.persist();

            // Inform webview of the project root for backlog / folder picker
            const projectDir = cwd ?? process.cwd();
            store.broadcast({
              type: 'workspaceFolders',
              folders: [{ name: path.basename(projectDir), path: projectDir }],
            });
          } else {
            // Hook-only provider (Opencode), root session (no specific agentName):
            // create one agent per configured name so all agents appear in the office.
            const agentNames = readOpencodeAgentNames();
            if (agentNames.length === 0) return;
            const saved = readLayoutFromFile() ?? assetCache?.defaultLayout ?? null;
            if (!saved) return;
            if (existingSessionCount === 0) {
              console.log('[Pixel Agents] cli: first session uses bundled base room');
            } else {
              const { layout, roomInfo } = addSessionRoom(
                saved,
                sessionId,
                assetCache.defaultLayout,
                sessionRooms.size,
              );
              writeLayoutToFile(layout);
              sessionRooms.set(sessionId, roomInfo);
              store.broadcast({ type: 'layoutLoaded', layout });
            }

            console.log(`[Pixel Agents] cli: Creating ${agentNames.length} agents for session ${sessionId.slice(0, 8)}... names=[${agentNames.join(',')}]`);
            for (let i = 0; i < agentNames.length; i++) {
              const agentId = store.nextAgentId.current++;
              const agentName = agentNames[i]!;
              console.log(`[Pixel Agents] cli:   agentId=${agentId} agentName=${agentName}`);
              const agent: AgentState = {
                id: agentId,
                sessionId,
                terminalRef: undefined,
                isExternal: true,
                projectDir: cwd ?? process.cwd(),
                jsonlFile: '',
                fileOffset: 0,
                lineBuffer: '',
                activeToolIds: new Set(),
                activeToolStatuses: new Map(),
                activeToolNames: new Map(),
                activeSubagentToolIds: new Map(),
                activeSubagentToolNames: new Map(),
                backgroundAgentToolIds: new Set(),
                isWaiting: false,
                permissionSent: false,
                hadToolsInTurn: false,
                hookDelivered: true,
                hooksOnly: true,
                lastDataAt: Date.now(),
                linesProcessed: 0,
                seenUnknownRecordTypes: new Set(),
                folderName: cwd ? path.basename(cwd) : undefined,
                inputTokens: 0,
                outputTokens: 0,
                agentName,
                providerId: 'opencode',
              };
              store.set(agentId, agent);
              runtime.registerAgent(sessionId, agentId, agentName);
              store.broadcast({ type: 'agentTeamInfo', id: agentId, agentName });
            }
            store.persist();

            // Inform webview of the project root for backlog / folder picker
            const projectDir = cwd ?? process.cwd();
            store.broadcast({
              type: 'workspaceFolders',
              folders: [{ name: path.basename(projectDir), path: projectDir }],
            });
          }
        } catch (err) {
          console.error('[Pixel Agents] Failed to add session room:', err);
        }
      },
      onSessionEnd: (agentId) => {
        const agent = store.get(agentId);
        if (!agent) return;
        const roomInfo = sessionRooms.get(agent.sessionId);
        if (!roomInfo) return;
        try {
          const saved = readLayoutFromFile();
          if (!saved) return;
          const layout = removeSessionRoom(saved, roomInfo);
          writeLayoutToFile(layout);
          sessionRooms.delete(agent.sessionId);
          store.broadcast({ type: 'layoutLoaded', layout });

          // Remove ALL agents for this session (supports compound-key multi-agent)
          const agentIdsToRemove = [...store.values()]
            .filter((a) => a.sessionId === agent.sessionId)
            .map((a) => a.id);
          for (const id of agentIdsToRemove) {
            runtime.removeAgent(id);
          }
        } catch (err) {
          console.error('[Pixel Agents] Failed to remove session room:', err);
        }
      },

    });

    // Wire hook events: HTTP POST -> runtime -> hookEventHandler -> agents
    server.onHookEvent((providerId, event) => {
      runtime.handleHookEvent(providerId, event);
    });

    // onSetHooksEnabled side effect: install/uninstall hooks when user toggles in UI.
    // Installs/uninstalls EVERY provider that supports hooks.
    let currentConfig: { port: number; token: string } | null = null;
    const onSetHooksEnabled = async (enabled: boolean): Promise<void> => {
      if (!currentConfig) return;
      if (enabled) {
        await claudeProvider.installHooks(
          `http://127.0.0.1:${currentConfig.port}`,
          currentConfig.token,
        );
        copyHookScript(distRoot);
        await opencodeProvider.installHooks?.(
          `http://127.0.0.1:${currentConfig.port}`,
          currentConfig.token,
        );
        copyPluginScript(distRoot);
        console.log('[Pixel Agents] Hooks installed (user toggle)');
      } else {
        await claudeProvider.uninstallHooks();
        await opencodeProvider.uninstallHooks?.();
        console.log('[Pixel Agents] Hooks uninstalled (user toggle)');
      }
    };

    const config = await server.start({
      store,
      runtime,
      embedded: false,
      host: args.host,
      port: args.port,
      staticDir,
      assetCache,
      onSetHooksEnabled,
      projectRoot: process.cwd(),
    });
    currentConfig = { port: config.port, token: config.token };

    // Sync runtime refs with persisted settings BEFORE first scan tick
    runtime.hooksEnabled.current = adapter.getSetting('pixel-agents.hooksEnabled', true);
    runtime.watchAllSessions.current = adapter.getSetting('pixel-agents.watchAllSessions', true);

    // Install hooks on startup if the persisted setting says so
    if (runtime.hooksEnabled.current) {
      try {
        await claudeProvider.installHooks(`http://127.0.0.1:${config.port}`, config.token);
        copyHookScript(distRoot);
        await opencodeProvider.installHooks(`http://127.0.0.1:${config.port}`, config.token);
        copyPluginScript(distRoot);
        console.log('[Pixel Agents] Hooks installed');
      } catch (err) {
        console.error('[Pixel Agents] Failed to install hooks:', err);
      }
    }

    // Start scanning for external sessions (Claude running in user's terminal)
    const cwd = process.cwd();
    const dirs = claudeProvider.getSessionDirs?.(cwd);
    if (dirs && dirs[0]) {
      const projectDir = dirs[0];
      console.log(`[Pixel Agents] Scanning project dir: ${projectDir}`);
      runtime.startProjectScan(projectDir);
      runtime.startExternalScanning(projectDir);
      runtime.startStaleCheck();
    }

    console.log(`\n  Pixel Agents server running at http://${args.host}:${config.port}\n`);

    // ── Graceful shutdown ──
    function shutdown(): void {
      console.log('\nShutting down...');
      runtime.dispose();
      server.stop();
      process.exit(0);
    }

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
