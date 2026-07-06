import * as path from 'path';

import type { AgentEvent, HookProvider } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import { SESSION_END_GRACE_MS } from './constants.js';
import type { ProviderRegistry } from './providerRegistry.js';
import type { SessionRouter } from './sessionRouter.js';
import { getInlineTeammates, hasInlineTeammates } from './teamUtils.js';
import { cancelPermissionTimer, cancelWaitingTimer } from './timerManager.js';
import type { AgentState } from './types.js';

const debug = process.env.PIXEL_AGENTS_DEBUG !== '0';

/** Normalized hook event received from any provider's hook script via the HTTP server. */
export interface HookEvent {
  /** Hook event name (e.g., 'Stop', 'PermissionRequest', 'Notification') */
  hook_event_name: string;
  /** Claude Code session ID, maps to JSONL filename */
  session_id: string;
  /** Additional provider-specific fields (notification_type, tool_name, etc.) */
  [key: string]: unknown;
}

/**
 * Dispatches normalized AgentEvents to agents based on session_id.
 * Session routing (session→agent mapping, pending sessions, event buffering)
 * is delegated to an injected SessionRouter instance.
 *
 * When an event is successfully delivered, sets `agent.hookDelivered = true` which
 * suppresses heuristic timers (permission 7s, text-idle 5s) for that agent.
 *
 * Multi-provider: uses the injected ProviderRegistry to look up the correct
 * HookProvider by `providerId` on every event dispatch.
 */
/** Callback for session lifecycle events detected via hooks. */
interface SessionLifecycleCallbacks {
  /** Called when an external session is detected (unknown session_id in SessionStart).
   *  transcriptPath is undefined for providers without transcripts (Opencode, Copilot). */
  onExternalSessionDetected?: (
    sessionId: string,
    transcriptPath: string | undefined,
    cwd: string,
  ) => void;
  /** Called when /clear is detected via hooks (SessionEnd reason=clear + SessionStart source=clear). */
  onSessionClear?: (
    agentId: number,
    newSessionId: string,
    newTranscriptPath: string | undefined,
  ) => void;
  /** Called when a session is resumed (--resume). Clears dismissals so the file can be re-adopted. */
  onSessionResume?: (transcriptPath: string) => void;
  /** Called when a session ends (exit/logout). */
  onSessionEnd?: (agentId: number, reason: string) => void;
  /** Called when the active agent changes within a session (Opencode agent switch).
   *  The callback must synchronously update the session router so subsequent events
   *  reach the correct agent. */
  onAgentSwitch?: (sessionId: string, newAgentName: string) => void;
  /** Called when an Agent Teams teammate is detected via SubagentStart hook.
   *  Triggers scanning of the session's subagents/ directory for the teammate's JSONL. */
  onTeammateDetected?: (parentAgentId: number, sessionId: string, agentType: string) => void;
  /** Called when a teammate should be removed (e.g. no longer in team config members).
   *  Removes the teammate agent from the office. */
  onTeammateRemoved?: (teammateAgentId: number) => void;
}

export class HookEventHandler {
  private lifecycleCallbacks: SessionLifecycleCallbacks = {};

  /** Highest HookProvider.protocolVersion this handler understands. */
  private static readonly SUPPORTED_PROTOCOL_VERSION = 1;

  /**
   * The provider for the currently dispatching event. Set at method entry in
   * handleEvent(), read by all sub-handlers. This avoids threading a provider
   * parameter through every private method while remaining safe because
   * handleEvent() is the only public entry point for event dispatch.
   */
  private currentProvider: HookProvider | null = null;

  /** Tracks the currently active agent name per session (e.g. "explore", "general").
   *  Used to detect Opencode agent switches within the same session. */
  private agentNamesBySession = new Map<string, string>();

  constructor(
    private agents: AgentStateStore,
    private waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
    private permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
    private providerRegistry: ProviderRegistry,
    private sessionRouter: SessionRouter,
    private watchAllSessionsRef?: { current: boolean },
  ) {
    for (const provider of providerRegistry.getAll()) {
      if (provider.protocolVersion !== HookEventHandler.SUPPORTED_PROTOCOL_VERSION) {
        console.warn(
          `[Pixel Agents] HookProvider "${provider.id}" reports protocolVersion=${provider.protocolVersion}, ` +
            `but handler understands ${HookEventHandler.SUPPORTED_PROTOCOL_VERSION}. ` +
            `Events from this provider will be dropped.`,
        );
      }
    }
  }

  /** Merged set of tool names that spawn subagents (teammates + within-turn subagents
   *  when a team provider is attached, or the base HookProvider set otherwise). */
  private getSubagentToolSet(): ReadonlySet<string> {
    const provider = this.currentProvider;
    if (!provider) return new Set();
    if (provider.team) {
      return new Set<string>([
        ...provider.team.teammateSpawnTools,
        ...provider.team.withinTurnSubagentTools,
      ]);
    }
    return provider.subagentToolNames;
  }

  /** Check if a session is tracked (in workspace project dir, or Watch All Sessions ON). */
  private isTrackedSession(transcriptPath?: string, cwd?: string): boolean {
    if (this.watchAllSessionsRef?.current) return true;
    const projectDir = transcriptPath ? path.dirname(transcriptPath) : cwd;
    if (!projectDir) return false;
    return [...this.agents.values()].some(
      (a) => path.resolve(a.projectDir).toLowerCase() === path.resolve(projectDir).toLowerCase(),
    );
  }

  /** Set callbacks for session lifecycle events (SessionStart/SessionEnd). */
  setLifecycleCallbacks(callbacks: SessionLifecycleCallbacks): void {
    this.lifecycleCallbacks = callbacks;
  }

  /** Register an agent for hook event routing. Flushes any buffered events for this session. */
  registerAgent(sessionId: string, agentId: number): void {
    const flushed = this.sessionRouter.register(sessionId, agentId);
    if (debug && flushed.length > 0)
      console.log(
        `[Pixel Agents] Hook: flushing ${flushed.length} buffered event(s) for session ${sessionId.slice(0, 8)}...`,
      );
    for (const { providerId, event } of flushed) {
      this.handleEvent(providerId, event as HookEvent);
    }
  }

  /** Remove an agent's session mapping (called on agent removal/terminal close). */
  unregisterAgent(sessionId: string): void {
    this.sessionRouter.unregister(sessionId);
  }

  /**
   * Process an incoming hook event. Looks up the agent by session_id,
   * falls back to auto-discovery scan, or buffers if agent not yet registered.
   * @param providerId - Provider that sent the event ('claude', 'opencode', etc.)
   * @param event - The hook event payload from the CLI tool
   */
  handleEvent(providerId: string, event: HookEvent): void {
    // ── Resolve provider from registry ──────────────────────────────────────
    const provider = this.providerRegistry.get(providerId);
    if (!provider) {
      if (debug)
        console.warn(`[Pixel Agents] Hook: unknown provider "${providerId}" — dropping event`);
      return;
    }
    if (provider.protocolVersion !== HookEventHandler.SUPPORTED_PROTOCOL_VERSION) {
      return; // version mismatch already logged in constructor
    }
    this.currentProvider = provider;

    // ── Provider normalization boundary ───────────────────────────────────────
    // All raw provider-specific fields are extracted by provider.normalizeHookEvent.
    // Downstream dispatch uses the normalized AgentEvent.kind.
    const normalized = provider.normalizeHookEvent(event);
    if (!normalized) return; // unknown / uninteresting event -- silently drop
    const normEvent = normalized.event;
    // Provider-agnostic event name for logging: claude uses hook_event_name,
// opencode uses type. Both are always valid strings if we got this far.
const eventName = String(event.hook_event_name ?? event.type ?? '?');
    // CI / e2e diagnostic: see agentStateStore.ts debugLogBroadcast comment.
    if (process.env['PIXEL_AGENTS_DEBUG_LOG']) {
      try {
        const fs = require('fs') as typeof import('fs');
          const sid = normalized.sessionId.slice(0, 8);
        const extras =
          normEvent.kind === 'toolStart'
            ? ` toolName=${(normEvent as { toolName?: string }).toolName}`
            : '';
        fs.appendFileSync(
          process.env['PIXEL_AGENTS_DEBUG_LOG']!,
          `${new Date().toISOString()} HOOK kind=${normEvent.kind} sid=${sid} src=${(normEvent as { source?: string }).source ?? ''}${extras}\n`,
        );
      } catch {
        /* never crash on diagnostic failure */
      }
    }

    // ── Agent switch detection ──────────────────────────────────────────
    // Opencode reuses the same session across agent switches. The raw event
    // carries properties.info.agent which tells us which agent is currently
    // active. When it changes, we swap the sessionRouter mapping and mark
    // the old agent idle.
    if (normalized.agentName) {
      const prev = this.agentNamesBySession.get(normalized.sessionId);
      if (prev !== normalized.agentName) {
        if (debug)
          console.log(
            `[Pixel Agents] Hook: Agent switch detected: ${prev ?? '(none)'} -> ${normalized.agentName}`,
          );
        this.agentNamesBySession.set(normalized.sessionId, normalized.agentName);
        this.lifecycleCallbacks.onAgentSwitch?.(normalized.sessionId, normalized.agentName);
      }
    }

    // --- SessionStart: handle /clear for known agents, ignore unknown sessions ---
    // External session detection via SessionStart is deferred to Phase C.
    // For now, only use SessionStart for:
    //   1. Confirming known agents (set hookDelivered)
    //   2. /clear reassignment (source=clear + pendingClear agent)
    if (normEvent.kind === 'sessionStart') {
      const sid = normalized.sessionId.slice(0, 8);
      const source = normEvent.source ?? 'unknown';
      const transcriptPath = normEvent.transcriptPath;
      const cwd = normEvent.cwd;
      const tracked = this.isTrackedSession(transcriptPath, cwd);
      if (debug && tracked)
        console.log(`[Pixel Agents] Hook: SessionStart(source=${source}, session=${sid}...)`);

      // Check registered mapping
      const existingAgentId = this.sessionRouter.resolve(normalized.sessionId);
      if (existingAgentId !== undefined) {
        const agent = this.agents.get(existingAgentId);
        if (agent) {
          agent.hookDelivered = true;
        }
        if (debug)
          console.log(
            `[Pixel Agents] Hook: Agent ${existingAgentId} - SessionStart(source=${source}) known`,
          );
        return;
      }
      // Check auto-discovery (agent exists but not yet registered for hooks)
      for (const [id, agent] of this.agents) {
        if (agent.sessionId === normalized.sessionId) {
          this.registerAgent(agent.sessionId, id);
          agent.hookDelivered = true;
          if (debug)
            console.log(
              `[Pixel Agents] Hook: Agent ${id} - SessionStart(source=${source}) auto-discovered`,
            );
          return;
        }
      }
      // /clear or /resume: reassign existing agent to new session
      if (normEvent.source === 'clear' || normEvent.source === 'resume') {
        const projectDir = transcriptPath ? path.dirname(transcriptPath) : cwd;
        if (projectDir) {
          for (const [id, agent] of this.agents) {
            const isMatch =
              agent.pendingClear &&
              path.resolve(agent.projectDir).toLowerCase() ===
                path.resolve(projectDir).toLowerCase();
            if (isMatch) {
              agent.pendingClear = false;
              console.log(
                `[Pixel Agents] Hook: Agent ${id} - /${normEvent.source} detected, reassigning to ${normalized.sessionId}`,
              );
              this.sessionRouter.unregister(agent.sessionId);
              this.registerAgent(normalized.sessionId, id);
              this.lifecycleCallbacks.onSessionClear?.(id, normalized.sessionId, transcriptPath);
              return;
            }
          }
        }
      }
      // Unknown session:
      //   file-based provider (transcriptPath set) → store pending, create on next event
      //   hook-only provider (transcriptPath unset) → create immediately
      if (transcriptPath) {
        if (normEvent.source === 'resume') {
          this.lifecycleCallbacks.onSessionResume?.(transcriptPath);
        }
        if (debug && tracked)
          console.log(
            `[Pixel Agents] Hook: SessionStart(source=${source}) -> pending external session ${sid}..., awaiting confirmation`,
          );
        this.sessionRouter.storePending(normalized.sessionId, {
          sessionId: normalized.sessionId,
          transcriptPath,
          cwd: cwd ?? '',
        });
      } else if (cwd) {
        // Hook-only provider (no transcript file) — create agent immediately
        if (debug && tracked)
          console.log(
            `[Pixel Agents] Hook: SessionStart(source=${source}) -> creating hooks-only agent for session ${sid}...`,
          );
        this.lifecycleCallbacks.onExternalSessionDetected?.(
          normalized.sessionId,
          undefined,
          cwd,
        );
      } else {
        if (debug && tracked)
          console.log(
            `[Pixel Agents] Hook: SessionStart -> unknown session ${sid}..., no transcript_path or cwd`,
          );
      }
      return;
    }

    // --- All other events: standard agent lookup ---
    if (normEvent.kind === 'sessionEnd' && this.sessionRouter.hasPending(normalized.sessionId)) {
      this.sessionRouter.discardPending(normalized.sessionId);
      if (debug)
        console.log(
          `[Pixel Agents] Hook: SessionEnd discarded pending external session ${normalized.sessionId.slice(0, 8)}...`,
        );
      return;
    }

    const pending = this.sessionRouter.confirmPending(normalized.sessionId);
    if (pending) {
      if (debug)
        console.log(
          `[Pixel Agents] Hook: ${eventName} confirmed external session ${normalized.sessionId.slice(0, 8)}..., creating agent`,
        );
      this.lifecycleCallbacks.onExternalSessionDetected?.(
        pending.sessionId,
        pending.transcriptPath,
        pending.cwd,
      );
      this.handleEvent(providerId, event);
      return;
    }

    let agentId = this.sessionRouter.resolve(normalized.sessionId);
    if (agentId === undefined) {
      for (const [id, agent] of this.agents) {
        if (agent.sessionId === normalized.sessionId) {
          this.registerAgent(agent.sessionId, id);
          agentId = id;
          break;
        }
      }
    }
    if (agentId === undefined) {
      const isPending = this.sessionRouter.hasPending(normalized.sessionId);
      const hasBuffered = this.sessionRouter.hasBuffered(normalized.sessionId);
      const hasUnregisteredAgents = [...this.agents.values()].some(
        (a) => a.sessionId && !this.sessionRouter.hasSession(a.sessionId),
      );
      if (isPending || hasBuffered || hasUnregisteredAgents) {
        if (debug)
          console.log(
            `[Pixel Agents] Hook: ${eventName} - unknown session ${normalized.sessionId.slice(0, 8)}..., buffering`,
          );
        this.sessionRouter.bufferEvent(providerId, event);
      }
      return;
    }

    const agent = this.agents.get(agentId);
    if (!agent) return;

    agent.hookDelivered = true;
    if (debug)
      console.log(
        `[Pixel Agents] Hook: Agent ${agentId} - ${eventName} (session=${normalized.sessionId.slice(0, 8)}...)`,
      );

    switch (normEvent.kind) {
      case 'sessionEnd':
        return this.handleSessionEnd(normEvent, agent, agentId);
      case 'toolStart':
        return this.handlePreToolUse(normEvent, agent, agentId);
      case 'toolEnd':
        return this.handlePostToolUse(agent, agentId);
      case 'subagentStart':
        return provider.team ? this.handleSubagentStart(event, agent, agentId) : undefined;
      case 'subagentEnd':
        return provider.team ? this.handleSubagentStop(agent, agentId) : undefined;
      case 'permissionRequest':
        return this.handlePermissionRequest(agent, agentId);
      case 'turnEnd':
        return this.handleStop(agent, agentId, normEvent.awaitingInput === true);
      case 'subagentTurnEnd':
        if (!provider.team) return;
        if (normEvent.reason === 'completed') {
          return this.handleTaskCompleted(event, agentId);
        }
        return this.handleTeammateIdle(event, agent, agentId);
      case 'progress':
        return;
    }
  }

  private handleSessionEnd(
    normEvent: Extract<AgentEvent, { kind: 'sessionEnd' }>,
    agent: AgentState,
    agentId: number,
  ): void {
    const reason = normEvent.reason;
    if (debug)
      console.log(
        `[Pixel Agents] Hook: Agent ${agentId} - SessionEnd(reason=${reason ?? 'unknown'})`,
      );

    const expectsFollowUp = reason === 'clear' || reason === 'resume';

    if (expectsFollowUp) {
      agent.pendingClear = true;
      this.markAgentWaiting(agent, agentId);
      if (debug)
        console.log(
          `[Pixel Agents] Hook: Agent ${agentId} - SessionEnd(reason=${reason}), awaiting possible SessionStart`,
        );
      setTimeout(() => {
        if (agent.pendingClear) {
          agent.pendingClear = false;
          this.lifecycleCallbacks.onSessionEnd?.(agentId, reason);
        }
      }, SESSION_END_GRACE_MS);
    } else {
      this.markAgentWaiting(agent, agentId);
      this.lifecycleCallbacks.onSessionEnd?.(agentId, reason ?? 'unknown');
    }
  }

  private handlePreToolUse(
    normEvent: Extract<AgentEvent, { kind: 'toolStart' }>,
    agent: AgentState,
    agentId: number,
  ): void {
    const provider = this.currentProvider;
    if (!provider) return;
    const toolName = normEvent.toolName;
    const toolInput = (normEvent.input as Record<string, unknown> | undefined) ?? {};
    const status = provider.formatToolStatus(toolName, toolInput);
    const hookToolId = `hook-${Date.now()}`;

    agent.currentHookToolId = hookToolId;
    agent.currentHookToolName = toolName;
    agent.currentHookIsTeammateSpawn =
      provider.team?.isTeammateSpawnCall(toolName, toolInput) ?? false;

    if (hasInlineTeammates(agentId, this.agents)) return;

    cancelWaitingTimer(agentId, this.waitingTimers);
    agent.isWaiting = false;
    agent.permissionSent = false;
    agent.hadToolsInTurn = true;

    if (toolName !== 'Task' && toolName !== 'Agent') {
      this.agents.broadcast({
        type: 'agentToolStart',
        id: agentId,
        toolId: hookToolId,
        status,
        toolName,
      });
    }
    this.agents.broadcast({
      type: 'agentStatus',
      id: agentId,
      status: 'active',
    });
  }

  private handlePostToolUse(agent: AgentState, agentId: number): void {
    if (agent.currentHookToolId) {
      if (!hasInlineTeammates(agentId, this.agents)) {
        this.agents.broadcast({
          type: 'agentToolDone',
          id: agentId,
          toolId: agent.currentHookToolId,
        });
      }
      agent.currentHookToolId = undefined;
      agent.currentHookToolName = undefined;
    }
  }

  private handleSubagentStart(event: HookEvent, agent: AgentState, agentId: number): void {
    const provider = this.currentProvider;
    if (!provider) return;
    const agentType = provider.team?.extractTeammateNameFromEvent(event) ?? 'unknown';

    if (provider.team && agent.currentHookIsTeammateSpawn === true && agent.teamName) {
      if (debug)
        console.log(
          `[Pixel Agents] Hook: Agent ${agentId} - SubagentStart: teammate "${agentType}" detected, triggering discovery`,
        );
      this.lifecycleCallbacks.onTeammateDetected?.(agentId, String(event.session_id ?? (event as Record<string, unknown>).sessionId ?? ''), agentType);
      return;
    }

    const parentTools = this.getSubagentToolSet();
    let parentToolId: string | undefined;
    for (const [toolId, toolName] of agent.activeToolNames) {
      if (parentTools.has(toolName)) {
        parentToolId = toolId;
        break;
      }
    }
    if (!parentToolId) return;

    const subToolId = `hook-sub-${agentType}-${Date.now()}`;
    const status = `Subtask: ${agentType}`;

    let subTools = agent.activeSubagentToolIds.get(parentToolId);
    if (!subTools) {
      subTools = new Set();
      agent.activeSubagentToolIds.set(parentToolId, subTools);
    }
    subTools.add(subToolId);

    let subNames = agent.activeSubagentToolNames.get(parentToolId);
    if (!subNames) {
      subNames = new Map();
      agent.activeSubagentToolNames.set(parentToolId, subNames);
    }
    subNames.set(subToolId, agentType);

    this.agents.broadcast({
      type: 'subagentToolStart',
      id: agentId,
      parentToolId,
      toolId: subToolId,
      status,
    });
  }

  private handleSubagentStop(agent: AgentState, agentId: number): void {
    const inlineTeammates = getInlineTeammates(agentId, this.agents);
    if (inlineTeammates.length > 0) {
      if (debug)
        console.log(
          `[Pixel Agents] Hook: Agent ${agentId} - SubagentStop: marking inline teammates as waiting`,
        );
      for (const [id, a] of inlineTeammates) {
        this.markAgentWaiting(a, id);
      }
      return;
    }

    const subagentParentTools = this.getSubagentToolSet();
    let parentToolId: string | undefined;
    for (const [toolId, toolName] of agent.activeToolNames) {
      if (subagentParentTools.has(toolName) && agent.activeSubagentToolIds.has(toolId)) {
        parentToolId = toolId;
        break;
      }
    }
    if (!parentToolId) return;

    agent.activeSubagentToolIds.delete(parentToolId);
    agent.activeSubagentToolNames.delete(parentToolId);
    this.agents.broadcast({
      type: 'subagentClear',
      id: agentId,
      parentToolId,
    });
  }

  private handlePermissionRequest(agent: AgentState, agentId: number): void {
    const inlineTeammates = getInlineTeammates(agentId, this.agents);
    if (inlineTeammates.length > 0) {
      for (const [id, a] of inlineTeammates) {
        cancelPermissionTimer(id, this.permissionTimers);
        a.permissionSent = true;
        this.agents.broadcast({ type: 'agentToolPermission', id });
      }
      return;
    }

    cancelPermissionTimer(agentId, this.permissionTimers);
    agent.permissionSent = true;
    this.agents.broadcast({
      type: 'agentToolPermission',
      id: agentId,
    });
    for (const parentToolId of agent.activeSubagentToolNames.keys()) {
      this.agents.broadcast({
        type: 'subagentToolPermission',
        id: agentId,
        parentToolId,
      });
    }
  }

  private handleStop(agent: AgentState, agentId: number, awaitingInput = false): void {
    this.markAgentWaiting(agent, agentId, awaitingInput);
  }

  private handleTeammateIdle(event: HookEvent, agent: AgentState, agentId: number): void {
    const provider = this.currentProvider;
    const agentType = provider?.team?.extractTeammateNameFromEvent(event);
    const inlineTeammates = getInlineTeammates(agentId, this.agents);

    if (inlineTeammates.length === 0) {
      this.markAgentWaiting(agent, agentId, true);
      return;
    }

    if (agentType) {
      const match = inlineTeammates.find(([, a]) => a.agentName === agentType);
      if (match) {
        const [id, a] = match;
        if (debug)
          console.log(`[Pixel Agents] Hook: TeammateIdle "${agentType}" -> teammate Agent ${id}`);
        this.markAgentWaiting(a, id, true);
        return;
      }
    }

    if (debug)
      console.log(
        `[Pixel Agents] Hook: TeammateIdle (no agent_type match) -> marking ${inlineTeammates.length} teammate(s) waiting`,
      );
    for (const [id, a] of inlineTeammates) {
      this.markAgentWaiting(a, id, true);
    }
  }

  private handleTaskCompleted(event: HookEvent, agentId: number): void {
    const provider = this.currentProvider;
    const subject = (event.subject as string) ?? '';
    const agentType = provider?.team?.extractTeammateNameFromEvent(event);
    if (debug)
      console.log(
        `[Pixel Agents] Hook: Agent ${agentId} - TaskCompleted: ${subject}${agentType ? ` (agent_type=${agentType})` : ''}`,
      );

    const inlineTeammates = getInlineTeammates(agentId, this.agents);
    if (inlineTeammates.length === 0) return;

    if (agentType) {
      const match = inlineTeammates.find(([, a]) => a.agentName === agentType);
      if (match) {
        const [id, a] = match;
        this.markAgentWaiting(a, id);
        return;
      }
    }
    for (const [id, a] of inlineTeammates) {
      this.markAgentWaiting(a, id);
    }
  }

  private markAgentWaiting(agent: AgentState, agentId: number, awaitingInput = false): void {
    cancelWaitingTimer(agentId, this.waitingTimers);
    cancelPermissionTimer(agentId, this.permissionTimers);

    const parentTools = this.getSubagentToolSet();
    for (const toolId of [...agent.activeToolIds]) {
      if (agent.backgroundAgentToolIds.has(toolId)) continue;
      agent.activeToolIds.delete(toolId);
      agent.activeToolStatuses.delete(toolId);
      const toolName = agent.activeToolNames.get(toolId);
      agent.activeToolNames.delete(toolId);
      if (toolName && parentTools.has(toolName)) {
        agent.activeSubagentToolIds.delete(toolId);
        agent.activeSubagentToolNames.delete(toolId);
      }
    }
    this.agents.broadcast({ type: 'agentToolsClear', id: agentId });
    for (const toolId of agent.backgroundAgentToolIds) {
      const status = agent.activeToolStatuses.get(toolId);
      if (status) {
        this.agents.broadcast({
          type: 'agentToolStart',
          id: agentId,
          toolId,
          status,
        });
      }
    }

    agent.isWaiting = true;
    agent.permissionSent = false;
    agent.hadToolsInTurn = false;
    agent.currentHookToolId = undefined;
    this.agents.broadcast({
      type: 'agentStatus',
      id: agentId,
      status: 'waiting',
      awaitingInput,
    });
  }

  /** Clean up timers and maps. Called when the extension disposes. */
  dispose(): void {
    this.sessionRouter.dispose();
  }
}
