import type { HookProvider } from '../../core/src/provider.js';

/**
 * In-memory registry of HookProviders, indexed by provider.id.
 *
 * Each provider (Claude, Opencode, etc.) registers itself on startup.
 * The HookEventHandler looks up the correct provider by `providerId`
 * (from the URL path `/api/hooks/:providerId`) before normalizing.
 *
 * Module-level setters in fileWatcher.ts / transcriptParser.ts still use
 * the *primary* provider (the first registered) for file-fallback mode.
 * Providers without file fallback (Opencode) simply skip those paths.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, HookProvider>();

  register(provider: HookProvider): void {
    if (this.providers.has(provider.id)) {
      console.warn(
        `[Pixel Agents] Provider "${provider.id}" already registered — overwriting`,
      );
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): HookProvider | undefined {
    return this.providers.get(id);
  }

  getAll(): HookProvider[] {
    return [...this.providers.values()];
  }

  get ids(): string[] {
    return [...this.providers.keys()];
  }

  get size(): number {
    return this.providers.size;
  }
}
