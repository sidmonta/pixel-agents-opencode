/**
 * Opencode HookProvider.
 *
 * Normalizes raw hook payloads from the pixel-agents.opencode plugin into
 * AgentEvent discriminated unions, exactly as the Claude provider does.
 *
 * Opencode event schema (plugin-payload shape):
 *   - type: string (e.g. 'session.created', 'tool.execute.before')
 *   - sessionId: string
 *   - toolName?: string
 *   - toolInput?: Record<string, unknown>
 *   - data?: Record<string, unknown> (contextual payload, e.g. { status, reason, source, cwd })
 *
 * The plugin forwards the raw Opencode event object as-is. The shape above is
 * our internal contract; the plugin is maintained alongside this provider.
 */

import * as path from 'path';

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
} from '../../../constants.js';
import { OPENCODE_TERMINAL_NAME_PREFIX } from './constants.js';
import {
  areHooksInstalled as installerAreHooksInstalled,
  installHooks,
  uninstallHooks,
} from './opencodeHookInstaller.js';

// ── Tool status formatting ──

function formatToolStatus(toolName: string, input?: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  const base = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '');
  switch (toolName) {
    case 'Read':
      return `Reading ${base(inp.file_path)}`;
    case 'Edit':
      return `Editing ${base(inp.file_path)}`;
    case 'Write':
      return `Writing ${base(inp.file_path)}`;
    case 'Bash': {
      const cmd = (inp.command as string) || '';
      return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : cmd}`;
    }
    case 'Glob':
      return 'Searching files';
    case 'Grep':
      return 'Searching code';
    case 'WebFetch':
      return 'Fetching web content';
    case 'WebSearch':
      return 'Searching the web';
    case 'Task':
    case 'Agent': {
      const desc = typeof inp.description === 'string' ? inp.description : '';
      return desc
        ? `Subtask: ${desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + '\u2026' : desc}`
        : 'Running subtask';
    }
    case 'AskUserQuestion':
      return 'Waiting for your answer';
    default:
      return `Using ${toolName}`;
  }
}

// ── Hook event normalization ──

/** Extract the nested properties object from an Opencode event. */
function getProperties(raw: Record<string, unknown>): Record<string, unknown> {
  return typeof raw.properties === 'object' && raw.properties !== null
    ? (raw.properties as Record<string, unknown>)
    : {};
}

/** Extract a string field nested in properties (e.g. properties.sessionID). */
function propStr(properties: Record<string, unknown>, key: string): string | undefined {
  const v = properties[key];
  return typeof v === 'string' ? v : undefined;
}

/** Extract an object nested inside properties. */
function propObj(properties: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = properties[key];
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

/** Extract agent name from an Opencode event's nested properties.info.agent */
function extractAgentName(raw: Record<string, unknown>): string | undefined {
  const properties = getProperties(raw);
  const info = propObj(properties, 'info');
  const agent = info.agent;
  if (typeof agent === 'string' && agent.length > 0) {
    console.log(`[Opencode] agent=${agent}`);
    return agent;
  }
  return undefined;
}

/** Helper: return the agent name plus the normalized event. */
function normalizeWithAgent(
  raw: Record<string, unknown>,
  sessionId: string,
  event: AgentEvent,
): { sessionId: string; agentName?: string; event: AgentEvent } {
  return { sessionId, agentName: extractAgentName(raw), event };
}

function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; agentName?: string; event: AgentEvent } | null {
  const eventType = raw.type;
  if (typeof eventType !== 'string') return null;

  const properties = getProperties(raw);
  // Opencode nests the session ID inside properties.sessionID.
  // Fall back to top-level sessionId / session_id for future compat.
  const sessionId = propStr(properties, 'sessionID') ?? (raw.sessionId as string | undefined) ?? (raw.session_id as string | undefined);
  if (!sessionId) return null; // system event (plugin.added, catalog.updated, etc.)

  const data = (typeof raw.data === 'object' && raw.data !== null
    ? (raw.data as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  switch (eventType) {
    // ── Session lifecycle ──

    case 'session.created': {
      const info = propObj(properties, 'info');
      const cwd = (info.directory as string) || (data.cwd as string) || (raw.cwd as string) || undefined;
      return normalizeWithAgent(raw, sessionId, {
        kind: 'sessionStart',
        source: (data.source as string) || (raw.source as string) || undefined,
        cwd,
        parentID: (info.parentID as string) || undefined,
      });
    }

    case 'session.status': {
      const statusObj = propObj(properties, 'status');
      const statusType = (statusObj.type as string) || (data.status as string) || '';
      if (statusType === 'ended' || statusType === 'stopped') {
        return normalizeWithAgent(raw, sessionId, {
          kind: 'sessionEnd',
          reason: (data.reason as string) || statusType,
        });
      }
      // Busy → model is working (treat as a tool execution step)
      if (statusType === 'busy') {
        return normalizeWithAgent(raw, sessionId, {
          kind: 'toolStart',
          toolId: `hook-${Date.now()}`,
          toolName: 'Thinking',
          input: {},
        });
      }
      // Idle → model finished the current turn
      if (statusType === 'idle') {
        return normalizeWithAgent(raw, sessionId, { kind: 'toolEnd', toolId: 'current' });
      }
      return null; // unknown status
    }

    case 'session.idle':
      return normalizeWithAgent(raw, sessionId, { kind: 'turnEnd', awaitingInput: true });

    case 'session.deleted':
      return normalizeWithAgent(raw, sessionId, {
        kind: 'sessionEnd',
        reason: (data.reason as string) || 'deleted',
      });

    // ── Tool lifecycle (emitted by some models/plugins) ──

    case 'tool.execute.before': {
      const toolName = (raw.toolName as string) || (raw.tool_name as string) || '';
      const toolInput =
        (raw.toolInput as Record<string, unknown>) ||
        (raw.tool_input as Record<string, unknown>) ||
        {};
      return normalizeWithAgent(raw, sessionId, {
        kind: 'toolStart',
        toolId: `hook-${Date.now()}`,
        toolName,
        input: toolInput,
        runInBackground: (toolInput.run_in_background as boolean) === true,
      });
    }

    case 'tool.execute.after':
      return normalizeWithAgent(raw, sessionId, { kind: 'toolEnd', toolId: 'current' });

    // ── Permission ──

    case 'permission.asked':
      return normalizeWithAgent(raw, sessionId, { kind: 'permissionRequest' });

    case 'permission.replied':
      return null;

    default:
      return null;
  }
}

// ── Installer wrappers ──

function installHooksWrapper(_serverUrl: string, _authToken: string): Promise<void> {
  installHooks();
  return Promise.resolve();
}

function uninstallHooksWrapper(): Promise<void> {
  uninstallHooks();
  return Promise.resolve();
}

function areHooksInstalledWrapper(): Promise<boolean> {
  return Promise.resolve(installerAreHooksInstalled());
}

// ── The provider ──

export const opencodeProvider: HookProvider = {
  kind: 'hook',
  id: 'opencode',
  displayName: 'Opencode',
  protocolVersion: 1,

  normalizeHookEvent,

  installHooks: installHooksWrapper,
  uninstallHooks: uninstallHooksWrapper,
  areHooksInstalled: areHooksInstalledWrapper,

  formatToolStatus,
  permissionExemptTools: new Set(['Task', 'Agent', 'AskUserQuestion']),
  subagentToolNames: new Set(['Task', 'Agent']),
  readingTools: new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']),
  terminalNamePrefix: OPENCODE_TERMINAL_NAME_PREFIX,
};
