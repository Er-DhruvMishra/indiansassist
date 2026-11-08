/**
 * The public /downloads page: grouped by tier then platform, one download button per published file with its version,
 * size and sha256, "Not available yet" for a slot with no build (never a dead link), and the honest instructions: a
 * generic portable agent needs a code, an installer needs the Tokens page, the extension is loaded unpacked.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { PublicDownloadFile } from '@indiansassist/shared';
import { DownloadsPage, NOT_AVAILABLE_TEXT } from '../src/pages/DownloadsPage';
import { ApiRequestError } from '../src/lib/api';

const SHA = 'ab'.repeat(32);
function file(over: Partial<PublicDownloadFile>): PublicDownloadFile {
  return {
    tier: 'p3_portable',
    platform: 'windows',
    arch: 'x64',
    format: 'exe',
    version: '0.3.1',
    size: 13_213_696,
    sha256: SHA,
    signed: true,
    minOs: '10.0.17763',
    filename: 'IndiansAssist-windows-x64-0.3.1.exe',
    url: 'https://api.indiansassist.com/api/v1/downloads/IndiansAssist-windows-x64-0.3.1.exe',
    ...over,
  };
}

function page(files: PublicDownloadFile[]) {
  render(
    <MemoryRouter>
      <DownloadsPage load={async () => ({ v: 1, files })} />
    </MemoryRouter>,
  );
}

describe('DownloadsPage', () => {
  it('shows a download link, version, size and sha256 for a published file, under its tier and platform', async () => {
    page([file({})]);
    const row = await screen.findByTestId('dl-p3_portable-windows-x64-exe');
    const link = within(row).getByRole('link', { name: /Download/ });
    expect(link.getAttribute('href')).toBe('https://api.indiansassist.com/api/v1/downloads/IndiansAssist-windows-x64-0.3.1.exe');
    expect(link.getAttribute('download')).toBe('IndiansAssist-windows-x64-0.3.1.exe');
    expect(row.textContent).toMatch(/Version 0\.3\.1, 12\.6 MB/);
    expect(row.textContent).toContain('Signed.');
    expect(within(row).getByTestId('dl-sha256').textContent).toContain(SHA);
    expect(screen.getByRole('heading', { level: 2, name: /Support client/ })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 3, name: 'Windows' }).length).toBeGreaterThan(0);
  });

  it('a platform with no build on the server says so and has no link', async () => {
    page([file({})]);
    await screen.findByTestId('dl-p3_portable-windows-x64-exe');
    const arm = screen.getByTestId('dl-p3_portable-windows-arm64-exe');
    expect(within(arm).queryByRole('link')).toBeNull();
    expect(within(arm).getByText(NOT_AVAILABLE_TEXT)).toBeTruthy();
    const mac = screen.getByTestId('dl-p3_portable-macos-arm64-app.zip');
    expect(within(mac).getByText(NOT_AVAILABLE_TEXT)).toBeTruthy();
    const msi = screen.getByTestId('dl-p4_installed-windows-x64-msi');
    expect(within(msi).getByText(NOT_AVAILABLE_TEXT)).toBeTruthy();
  });

  it('with an empty server every slot is not available and the page does not error', async () => {
    page([]);
    await screen.findByTestId('dl-p2_extension-browser-universal-zip');
    expect(screen.queryAllByRole('link', { name: /^Download/ })).toHaveLength(0);
    expect(screen.getAllByText(NOT_AVAILABLE_TEXT).length).toBeGreaterThan(4);
  });

  it('marks an unsigned file as not signed', async () => {
    page([file({ tier: 'p3_portable', platform: 'linux', arch: 'x64', format: 'tar.gz', signed: false, filename: 'IndiansAssist-linux-x64-0.3.1.tar.gz', url: 'https://x/y.tar.gz' })]);
    const row = await screen.findByTestId('dl-p3_portable-linux-x64-tar.gz');
    expect(row.textContent).toContain('Not signed.');
  });

  it('tells the truth about each generic file: the portable agent needs a code, the installer needs the Tokens page, the extension is loaded unpacked', async () => {
    page([]);
    await screen.findByTestId('dl-p2_extension-browser-universal-zip');
    expect(document.body.textContent).toContain('This generic file has no session code');
    expect(document.body.textContent).toContain('--code <12-digit code>');
    expect(document.body.textContent).toContain('Double-clicked, it shows a message and closes');
    expect(document.body.textContent).toContain('enroll.iaconfig');
    expect(screen.getAllByRole('link', { name: 'Tokens page' }).length).toBeGreaterThanOrEqual(3);
    expect(document.body.textContent).toContain('chrome://extensions');
    expect(document.body.textContent).toContain('edge://extensions');
    expect(document.body.textContent).toContain('Load unpacked');
    expect(document.body.textContent).toMatch(/iPhone and iPad/);
  });

  it('shows the error with a retry when the list cannot be loaded', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const load = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new ApiRequestError(429, 'rate_limited', 'too many', { retryAfterSec: 3 });
      return { v: 1 as const, files: [file({})] };
    });
    render(
      <MemoryRouter>
        <DownloadsPage load={load} />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Too many attempts/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('dl-p3_portable-windows-x64-exe')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
