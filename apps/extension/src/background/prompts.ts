/**
 * Prompt cards for level, attach and unmask requests (sections 3.2, 5.3, 8.4): at most one open prompt per kind
 * per session (a second one answers `rate_limited`, section 12.4), answered from the side panel or the tab bar,
 * timing out after 60 s.
 */
import { LIMITS } from '@indiansassist/shared';
import type { PromptKind, UiPrompt } from '../shared/ui-state';

export type PromptDecision = 'allow' | 'refuse' | 'permission_refused' | 'timeout' | 'cancelled';

type Open = { prompt: UiPrompt; resolve: (d: PromptDecision) => void; timer: ReturnType<typeof setTimeout> };

export class PromptManager {
  private open = new Map<string, Open>();

  constructor(
    private readonly onChange: (prompts: UiPrompt[]) => void,
    private readonly timeoutMs: number = LIMITS.promptTimeoutMs,
    private readonly now: () => number = Date.now,
  ) {}

  list(): UiPrompt[] {
    return [...this.open.values()].map((o) => o.prompt);
  }

  hasKind(kind: PromptKind): boolean {
    return [...this.open.values()].some((o) => o.prompt.promptKind === kind);
  }

  /** Opens a prompt; null when one of the same kind is already open (the caller answers `rate_limited`). */
  ask(p: Omit<UiPrompt, 'expiresAt'>): Promise<PromptDecision> | null {
    if (this.hasKind(p.promptKind) || this.open.has(p.id)) return null;
    return new Promise((resolve) => {
      const prompt: UiPrompt = { ...p, expiresAt: this.now() + this.timeoutMs };
      const timer = setTimeout(() => this.finish(p.id, 'timeout'), this.timeoutMs);
      this.open.set(p.id, { prompt, resolve, timer });
      this.onChange(this.list());
    });
  }

  /** The Desk answered (side panel or bar); false when no such prompt is open. */
  answer(id: string, decision: 'allow' | 'refuse' | 'permission_refused'): boolean {
    return this.finish(id, decision);
  }

  cancelAll(): void {
    for (const id of [...this.open.keys()]) this.finish(id, 'cancelled');
  }

  private finish(id: string, decision: PromptDecision): boolean {
    const o = this.open.get(id);
    if (!o) return false;
    clearTimeout(o.timer);
    this.open.delete(id);
    this.onChange(this.list());
    o.resolve(decision);
    return true;
  }
}
