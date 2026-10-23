/**
 * Commands from the UI pages (section 9.3 `ui.*`) and pushes from the capture scripts (`cs.*`), validated with
 * the bus schemas before anything acts on them.
 */
import { CONSENT_LEVEL_ORDER, levelAtLeast, minLevel, type ConsentLevel } from '@indiansassist/shared';
import { ext } from '../shared/api';
import { contentToWorkerSchema, uiCommandSchema, type UiCommand } from '../shared/bus-schemas';
import { EXTENSION_VERSION } from '../shared/constants';
import { patchDiagnostics } from '../shared/storage';
import { levelAllowed } from './policy';
import { cancel, decline, revokeConsent, stopSharing } from './session-end';
import type { SessionMachine } from './session-machine';
import { classifyUrl } from './tab-registry';

/** `ui.consent` share (section 3.1): the level sent is always one the extension can honour. */
async function consent(m: SessionMachine, c: Extract<UiCommand, { t: 'ui.consent' }>): Promise<void> {
  if (m.phase !== 'consent_pending' || !m.s?.sessionId || !m.eff) return;
  if (c.decision === 'decline') return decline(m);
  const eff = m.eff;
  let level: ConsentLevel = levelAllowed(eff, c.level) ? c.level : minLevel(c.level, eff.maxLevel);
  if (level === 'deep_control' && !(await ext().permissions.contains({ permissions: ['debugger'] }).catch(() => false))) level = 'in_page';
  const scope = c.scope === 'all_tabs' && eff.allowAllTabs ? 'all_tabs' : 'current_tab';
  const backstage = c.backstage && eff.backstageAllowed;
  let tabId: number | null = null;
  if (c.tabId !== null) {
    const tab = await ext().tabs.get(c.tabId).catch(() => null);
    if (tab && classifyUrl(tab.url, eff.denyList) === 'ok') tabId = c.tabId;
  }
  m.s.consent = { level, scope, backstage };
  m.s.consentTabId = tabId;
  m.persist();
  m.send({ t: 'desk.consent', state: 'granted', surface: 'browser', extension: { level, scope, backstage } });
}

/** The Desk changes the level from the side panel (section 3.2 "Desk lowers" and raises within the cap). */
async function deskLevel(m: SessionMachine, level: ConsentLevel): Promise<void> {
  const live = m.live;
  if (!live || !m.eff || !m.s?.sessionId || !levelAllowed(m.eff, level)) return;
  const from = live.level();
  if (from === level) return;
  if (level === 'deep_control' && !(await live.debuggerControl.hasPermission()))
    return m.ui.set({ lastError: { code: 'refused', message: 'debugger permission refused' } });
  if (CONSENT_LEVEL_ORDER[level] < CONSENT_LEVEL_ORDER[from]) {
    // Lower locally first: the debugger detaches and input stops before the WS frame is sent.
    m.s.log.levelChanges.push({ from, to: level, at: new Date().toISOString(), requestedBy: 'desk' });
    await live.applyLevel(level);
  }
  live.pendingDeskLevel = level;
  m.send({ t: 'desk.consent_level', sessionId: m.s.sessionId, level });
  m.persist();
}

export async function handleUiCommand(m: SessionMachine, raw: unknown): Promise<unknown> {
  const parsed = uiCommandSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'bad_payload' };
  const c = parsed.data;
  const live = m.live;
  switch (c.t) {
    case 'ui.getState':
      return m.ui.current;
    case 'ui.connect':
      await m.connect(c.code, c.via, c.deskLabel);
      break;
    case 'ui.consent':
      await consent(m, c);
      break;
    case 'ui.level':
      await deskLevel(m, c.level);
      break;
    case 'ui.backstage':
      if (live && m.s?.consent && m.s.sessionId && m.eff) {
        const allowed = c.allowed && m.eff.backstageAllowed && levelAtLeast(live.level(), 'tab_control');
        m.s.consent.backstage = allowed;
        m.send({ t: 'desk.consent_backstage', sessionId: m.s.sessionId, backstage: allowed });
        live.sendLevelEvent();
        m.persist();
      }
      break;
    case 'ui.prompt':
      m.prompts.answer(c.id, c.decision);
      break;
    case 'ui.stop':
      await stopSharing(m, c.closeBackstage);
      break;
    case 'ui.revoke':
      await revokeConsent(m);
      break;
    case 'ui.pauseTab':
      await live?.tabs.pause(c.tabId, c.paused);
      break;
    case 'ui.hideTab':
      live?.tabs.endRevealLocally(c.tabId, 'desk');
      break;
    case 'ui.attachTab':
      if (live?.scope() === 'current_tab') await live.tabs.attach(c.tabId);
      break;
    case 'ui.closeBackstage':
      await live?.tabs.closeBackstage(c.tabId);
      break;
    case 'ui.chat':
      await live?.sendChat(c.text);
      break;
    case 'ui.sendFile':
      if (live) await m.offscreen.send({ t: 'file.send', blobUrl: c.blobUrl, name: c.name, size: c.size, mime: c.mime });
      break;
    case 'ui.fileDecision':
      if (live) await m.offscreen.send({ t: 'file.decision', key: c.key, accept: c.accept });
      break;
    case 'ui.voice':
      m.ui.set({ voice: { ...m.ui.current.voice, muted: c.muted } });
      if (live) {
        await m.offscreen.send({ t: 'voice.mute', muted: c.muted });
        await m.offscreen.send({ t: 'dc.send', label: 'ia.ctrl', msg: { t: 'voice.state', from: 'desk', muted: c.muted, ts: Date.now() } });
      }
      break;
    case 'ui.voiceAvailable':
      m.ui.set({ voice: { ...m.ui.current.voice, available: c.available } });
      break;
    case 'ui.dismissEnded':
      m.dismissEnded();
      break;
    case 'ui.cancel':
      await cancel(m);
      break;
  }
  return { ok: true };
}

export async function handleContentMessage(m: SessionMachine, raw: unknown, tabId: number | undefined): Promise<unknown> {
  const parsed = contentToWorkerSchema.safeParse(raw);
  if (!parsed.success || tabId === undefined) return undefined;
  const c = parsed.data;
  const live = m.live;
  if (!live) return c.t === 'cs.ready' ? { ok: false } : undefined;
  switch (c.t) {
    case 'cs.ready':
      await live.tabs.onReady(tabId, c.skippedSelectors);
      if (c.skippedSelectors?.length) await patchDiagnostics({ skippedSelectors: c.skippedSelectors }, EXTENSION_VERSION);
      return { ok: true };
    case 'cs.pauseClicked':
      return live.tabs.pause(tabId, true);
    case 'cs.resumeClicked':
      return live.tabs.pause(tabId, false);
    case 'cs.stopClicked':
      return stopSharing(m, true);
    case 'cs.hideClicked':
      return live.tabs.endRevealLocally(tabId, 'desk');
    case 'cs.closeBackstageClicked':
      return live.tabs.closeBackstage('all');
    case 'cs.promptAnswer': {
      const p = m.prompts.list().find((x) => x.id === c.id);
      // A deep-control grant needs the permission prompt, which only the side panel can show.
      if (p && !(p.promptKind === 'level' && p.level === 'deep_control' && c.decision === 'allow')) m.prompts.answer(c.id, c.decision);
      return undefined;
    }
    case 'cs.revealEnded':
      return live.tabs.revealEnded(tabId, c.scope, c.by, c.durationMs);
    case 'cs.barHidden':
      return live.tabs.pause(tabId, true, 'bar_hidden');
    case 'cs.error':
      return patchDiagnostics({ lastError: c.message }, EXTENSION_VERSION);
    default:
      return undefined;
  }
}
