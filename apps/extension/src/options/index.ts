/**
 * Options page (section 9.2): the API origin (a drop-down over the compiled region origins only, free text is
 * not accepted), the built-in deny list (read only), the live session's policy while a session runs (never
 * outside one), diagnostics, and Reset extension.
 */
import '../ui/styles.css';
import { BUILTIN_DENY_LIST } from '@indiansassist/shared';
import { append, button, clear, el } from '../shared/dom';
import { DEFAULT_API_ORIGIN, EXTENSION_VERSION, REGION_ORIGINS, isRegionOrigin } from '../shared/constants';
import { LOCAL_KEYS, SESSION_KEYS, readLocal, readManaged, readSession, removeLocal, writeLocal, type Diagnostics, type PolicyCache } from '../shared/storage';
import { command } from '../ui/client';

const main = document.getElementById('app')!;

async function render(): Promise<void> {
  clear(main);
  main.appendChild(el('h1', 'IndiansAssist options'));

  const origin = el('section', null, { class: 'card' });
  origin.appendChild(el('h2', 'Server'));
  const managed = await readManaged();
  const current = (await readLocal<string>(LOCAL_KEYS.apiOrigin)) ?? DEFAULT_API_ORIGIN;
  const select = el('select', null, { 'aria-label': 'IndiansAssist server', disabled: isRegionOrigin(managed.apiOrigin) });
  for (const o of REGION_ORIGINS) {
    const opt = el('option', o, { value: o });
    opt.selected = o === (isRegionOrigin(managed.apiOrigin) ? managed.apiOrigin : current);
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    if (isRegionOrigin(select.value)) void writeLocal(LOCAL_KEYS.apiOrigin, select.value);
  });
  origin.appendChild(select);
  if (isRegionOrigin(managed.apiOrigin)) origin.appendChild(el('p', 'Set by your organisation.', { class: 'muted' }));

  const deny = el('section', null, { class: 'card' });
  deny.appendChild(el('h2', 'Sites that are never shared'));
  const list = el('ul', null, { class: 'list' });
  for (const h of BUILTIN_DENY_LIST) list.appendChild(el('li', h));
  for (const h of managed.extraDenyList ?? []) list.appendChild(el('li', `${h} (your organisation)`));
  deny.appendChild(list);
  deny.appendChild(el('p', "The organisation's list is shown during a session.", { class: 'muted' }));

  const live = el('section', null, { class: 'card' });
  live.appendChild(el('h2', 'Current session policy'));
  const cache = await readSession<PolicyCache>(SESSION_KEYS.policyCache).catch(() => undefined);
  if (cache) {
    const p = cache.policy;
    live.appendChild(el('p', `Highest level: ${p.maxConsentLevel}; deep control ${p.allowDeepControl ? 'allowed' : 'off'}; all tabs ${p.allowAllTabs ? 'allowed' : 'off'}; background tabs ${p.backstageAllowed ? 'allowed' : 'off'}; reveal on request ${p.allowUnmask ? 'allowed' : 'off'}; server relay ${p.allowRelayFallback ? 'allowed' : 'off'}.`));
    if (p.denyList.length > 0) live.appendChild(el('p', `Organisation protected sites: ${p.denyList.join(', ')}`, { class: 'muted' }));
    if (p.maskSelectors.length + p.blockSelectors.length > 0) live.appendChild(el('p', `Extra hidden elements: ${[...p.maskSelectors, ...p.blockSelectors].join(', ')}`, { class: 'muted' }));
  } else live.appendChild(el('p', 'No session is running.', { class: 'muted' }));

  const diag = el('section', null, { class: 'card' });
  diag.appendChild(el('h2', 'Diagnostics'));
  const d = await readLocal<Diagnostics>(LOCAL_KEYS.diagnostics);
  diag.appendChild(el('p', `Version ${EXTENSION_VERSION}`));
  diag.appendChild(el('p', `Last error: ${d?.lastError ?? 'none'}`, { class: 'muted' }));
  diag.appendChild(el('p', `Skipped selectors: ${d?.skippedSelectors?.length ? d.skippedSelectors.join(', ') : 'none'}`, { class: 'muted' }));
  diag.appendChild(el('p', `Refused join attempts from other sites: ${d?.originRefusals ?? 0}`, { class: 'muted' }));
  diag.appendChild(
    button('Reset extension', async () => {
      await command({ t: 'ui.cancel' });
      await removeLocal(LOCAL_KEYS.apiOrigin, LOCAL_KEYS.lastDeskLabel, LOCAL_KEYS.pubkeys, LOCAL_KEYS.diagnostics);
      await render();
    }),
  );
  append(main, origin, deny, live, diag);
}

void render();
