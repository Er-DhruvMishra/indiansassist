/**
 * Capture script injection (section 9.2, P7): the capture script exists only while a session is active, never on
 * deny-listed hosts. Scope `all_tabs` registers it globally with `excludeMatches` from the deny list and injects
 * into tabs already open; scope `current_tab` injects per attached tab only. A tab whose injection rejects or that
 * sends no `cs.ready` within 3 s is `unsupported` with `inject_failed`. Teardown unregisters and stops every tab.
 */
import { denyListToMatchPatterns } from '@indiansassist/shared';
import { ext } from '../shared/api';
import { CAPTURE_SCRIPT_ID, INJECT_READY_TIMEOUT_MS } from '../shared/constants';

export type RegistryDeps = {
  onInjectFailed: (tabId: number) => void;
  sendStop: (tabId: number) => Promise<void> | void;
  readyTimeoutMs?: number;
};

export class ContentRegistry {
  private registered = false;
  private waiting = new Map<number, ReturnType<typeof setTimeout>>();
  readonly injected = new Set<number>();

  constructor(private readonly deps: RegistryDeps) {}

  get isRegistered(): boolean {
    return this.registered;
  }

  /** `all_tabs`: global registration at `document_start`, deny-listed hosts excluded. */
  async registerAllTabs(denyList: readonly string[]): Promise<void> {
    if (this.registered) return;
    const excludeMatches = denyListToMatchPatterns(denyList);
    await ext().scripting.registerContentScripts([
      {
        id: CAPTURE_SCRIPT_ID,
        matches: ['http://*/*', 'https://*/*'],
        excludeMatches,
        js: ['content.js'],
        runAt: 'document_start',
        allFrames: false,
        persistAcrossSessions: false,
      },
    ]);
    this.registered = true;
  }

  /** Injects into one tab (the caller checked scheme, deny list and scope) and waits for `cs.ready`. */
  async inject(tabId: number): Promise<boolean> {
    this.expectReady(tabId);
    try {
      await ext().scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      return true;
    } catch {
      this.clearWait(tabId);
      this.deps.onInjectFailed(tabId);
      return false;
    }
  }

  /** A registered script announced itself in a tab that navigated (no explicit inject). */
  expectReady(tabId: number): void {
    this.clearWait(tabId);
    this.waiting.set(
      tabId,
      setTimeout(() => {
        this.waiting.delete(tabId);
        this.injected.delete(tabId);
        this.deps.onInjectFailed(tabId);
      }, this.deps.readyTimeoutMs ?? INJECT_READY_TIMEOUT_MS),
    );
  }

  ready(tabId: number): void {
    this.clearWait(tabId);
    this.injected.add(tabId);
  }

  forget(tabId: number): void {
    this.clearWait(tabId);
    this.injected.delete(tabId);
  }

  private clearWait(tabId: number): void {
    const t = this.waiting.get(tabId);
    if (t) clearTimeout(t);
    this.waiting.delete(tabId);
  }

  /** Teardown: unregister (when registered) and `cs.stop` to every injected tab. */
  async teardown(): Promise<void> {
    for (const t of this.waiting.values()) clearTimeout(t);
    this.waiting.clear();
    if (this.registered) {
      try {
        await ext().scripting.unregisterContentScripts({ ids: [CAPTURE_SCRIPT_ID] });
      } catch {
        /* already gone */
      }
      this.registered = false;
    }
    const tabs = [...this.injected];
    this.injected.clear();
    await Promise.all(tabs.map((id) => this.deps.sendStop(id)));
  }
}
