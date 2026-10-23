/**
 * /app/branding (PRD 12.15 white label, contracts sections 6.6 and 12; org_admin only): display name,
 * support email, accent colour and logo shown to the Desk on the join, consent and room pages. The logo is
 * uploaded as a PNG / JPEG `data:` URL (max 200 KiB) because Desk pages never load a cross-origin resource.
 */
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { LIMITS, isValidLogoData, type BrandingPatchRequest } from '@indiansassist/shared';
import { useAuth } from '../auth/AuthContext';
import { Alert, Button, Card, Field, Input, PageHeader } from '../components/ui';
import { usePageTitle } from '../hooks/usePageTitle';
import { errorMessage } from '../lib/api';
import { DEFAULT_ACCENT, contrastRatio, safeAccent } from '../lib/contrast';
import { orgApi } from '../lib/endpoints';

const HEX = /^#[0-9a-fA-F]{6}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === 'string' ? r.result : '');
    r.onerror = () => reject(r.error ?? new Error('Could not read the file.'));
    r.readAsDataURL(file);
  });
}

type Form = { displayName: string; supportEmail: string; accentColor: string; logoData: string | null };

/** Only the fields that changed; an emptied field is sent as `null` (clears it, section 6.6). */
export function brandingPatch(before: Partial<Record<keyof Form, string | undefined>>, form: Form): BrandingPatchRequest {
  const patch: BrandingPatchRequest = {};
  const text = (k: 'displayName' | 'supportEmail' | 'accentColor') => {
    const next = form[k].trim();
    if (next === (before[k] ?? '')) return;
    patch[k] = next === '' ? null : next;
  };
  text('displayName');
  text('supportEmail');
  text('accentColor');
  if ((form.logoData ?? '') !== (before.logoData ?? '')) patch.logoData = form.logoData;
  return patch;
}

export function BrandingPage() {
  usePageTitle('Branding');
  const { me, setMe } = useAuth();
  const branding = me?.org.branding ?? {};
  const [form, setForm] = useState<Form>({
    displayName: branding.displayName ?? '',
    supportEmail: branding.supportEmail ?? '',
    accentColor: branding.accentColor ?? '',
    logoData: branding.logoData ?? null,
  });
  const [logoError, setLogoError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!me) return null;

  const accentInvalid = form.accentColor.trim() !== '' && !HEX.test(form.accentColor.trim());
  const emailInvalid = form.supportEmail.trim() !== '' && !EMAIL.test(form.supportEmail.trim());
  const accent = HEX.test(form.accentColor) ? form.accentColor : null;
  const shown = safeAccent(accent);
  const fallsBack = accent !== null && shown !== accent;
  const name = form.displayName.trim() || me.org.name;

  const onLogo = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    setLogoError(null);
    if (!file) return;
    if (file.type !== 'image/png' && file.type !== 'image/jpeg') return setLogoError('Use a PNG or JPEG image.');
    if (file.size > LIMITS.logoMaxBytes) return setLogoError(`The logo must be at most ${Math.round(LIMITS.logoMaxBytes / 1024)} KiB.`);
    try {
      const data = await readAsDataUrl(file);
      if (!isValidLogoData(data)) return setLogoError('This file is not a valid PNG or JPEG image.');
      setForm((f) => ({ ...f, logoData: data }));
    } catch (err) {
      setLogoError(errorMessage(err));
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (accentInvalid || emailInvalid) return setMsg({ ok: false, text: 'Fix the highlighted fields first.' });
    const patch = brandingPatch(branding, form);
    if (Object.keys(patch).length === 0) return setMsg({ ok: true, text: 'Nothing to save.' });
    setBusy(true);
    try {
      const org = await orgApi.updateBranding(patch);
      setMe({ ...me, org });
      setMsg({ ok: true, text: 'Branding saved. New Desk sessions show it from now on.' });
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Branding" />
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="What the Desk sees">
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3" aria-label="Branding">
            {msg && <Alert tone={msg.ok ? 'green' : 'red'}>{msg.text}</Alert>}
            <Field label="Display name" hint={`Shown to the person you help. Empty uses "${me.org.name}".`}>
              {(p) => <Input id={p.id} aria-describedby={p.describedBy} maxLength={100} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />}
            </Field>
            <Field label="Support email" hint="Optional." error={emailInvalid ? 'Enter a valid email address.' : null}>
              {(p) => (
                <Input id={p.id} type="email" aria-describedby={p.describedBy} aria-invalid={p.invalid} value={form.supportEmail} onChange={(e) => setForm({ ...form, supportEmail: e.target.value })} />
              )}
            </Field>
            <Field
              label="Accent colour"
              hint="Hex, for example #0f766e. It must reach 4.5:1 contrast with white text."
              error={accentInvalid ? 'Use the form #rrggbb.' : fallsBack ? `Contrast with white is ${contrastRatio(accent!, '#ffffff').toFixed(1)}:1, so Desk pages will use the default colour.` : null}
            >
              {(p) => (
                <div className="flex items-center gap-2">
                  <input type="color" aria-label="Pick accent colour" className="h-10 w-12 rounded border border-slate-400" value={accent ?? DEFAULT_ACCENT} onChange={(e) => setForm({ ...form, accentColor: e.target.value })} />
                  <Input id={p.id} aria-describedby={p.describedBy} aria-invalid={p.invalid} placeholder={DEFAULT_ACCENT} value={form.accentColor} onChange={(e) => setForm({ ...form, accentColor: e.target.value })} />
                </div>
              )}
            </Field>
            <Field label="Logo (PNG or JPEG)" hint={`At most ${Math.round(LIMITS.logoMaxBytes / 1024)} KiB.`} error={logoError}>
              {(p) => <input id={p.id} aria-describedby={p.describedBy} type="file" accept="image/png,image/jpeg" className="text-sm" onChange={(e) => void onLogo(e)} />}
            </Field>
            {form.logoData && (
              <Button variant="secondary" size="sm" className="self-start" onClick={() => setForm({ ...form, logoData: null })}>
                Remove logo
              </Button>
            )}
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving...' : 'Save branding'}
            </Button>
          </form>
        </Card>
        <Card title="Preview">
          <div className="rounded-lg border-t-4 bg-white p-4 shadow-sm dark:bg-slate-950" style={{ borderTopColor: shown }} data-testid="branding-preview">
            <div className="mb-3 flex items-center gap-3">
              {form.logoData && <img src={form.logoData} alt="" className="h-10 w-10 rounded object-contain" />}
              <p className="text-lg font-semibold">{name}</p>
            </div>
            <p className="mb-3 text-sm">Your technician from {name} is asking to see your screen.</p>
            <span className="inline-flex min-h-10 items-center rounded-md px-4 text-sm font-medium text-white" style={{ backgroundColor: shown }}>
              Share my screen
            </span>
          </div>
        </Card>
      </div>
    </>
  );
}
