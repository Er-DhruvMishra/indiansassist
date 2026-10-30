// The Phase C starter catalogue (scripts/playbooks, section 8.6): every entry names a body file, the bodies pass the
// shared section 8.1 lint, and the metadata respects the playbook schema (checked with the built shared package).
import { describe, expect, it } from 'vitest';
import { loadStarterCatalogue } from '../seed-playbooks.mjs';
import { loadShared } from '../smoke/shared.mjs';

describe('starter playbooks', () => {
  it('four entries, valid create bodies, lint-clean, the elevation-only one is the spooler', async () => {
    const shared = await loadShared();
    const cat = loadStarterCatalogue();
    expect(cat.map((p) => p.name)).toEqual(['Clear temp files', 'Flush DNS cache', 'Restart Print Spooler', 'Collect logs (zip)']);
    for (const p of cat) {
      const { file: _f, ...create } = p;
      expect(shared.playbookCreateSchema.safeParse(create).success, p.name).toBe(true);
      expect(shared.lintPlaybookBody(p.interpreter, p.body).errors, p.name).toEqual([]);
      expect(p.body.includes('\r'), p.name).toBe(false);
    }
    expect(cat.filter((p) => p.requiresElevation).map((p) => p.name)).toEqual(['Restart Print Spooler']);
    expect(cat.find((p) => p.name === 'Collect logs (zip)').body).toMatch(/IA_FILE_OFFER \$zip/);
  });
});
