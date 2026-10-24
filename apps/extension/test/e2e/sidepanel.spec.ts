/**
 * Package 2 side panel e2e (PRD 3 P2 "Side panel: chat, voice call, file share"; contract section 7): after the
 * join-page handshake and consent (session.ts), chat goes both ways between the extension side panel and the
 * console, a file picked in the side panel reaches the console intact (F6 dialog, sha256), and voice reaches a
 * connected audio state with fake media: the Desk's Unmute (permission obtained by the panel itself) produces a
 * live, receiving audio track on the Assist with growing RTP bytes, and the Assist's voice is acknowledged by the
 * Desk's RTCP receiver reports (the offscreen document that plays it is not a Playwright page, so the Desk side is
 * proven from the Assist's `remote-inbound-rtp` stats).
 */
import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { assistStats, shot, shots } from './helpers';
import { DESK_NAME, openAudit, startP2Session, type P2Session } from './session';

const FILE_NAME = 'e2e-panel-note.txt';
const FILE_BYTES = randomBytes(1536).toString('hex'); // 3072 ASCII bytes
const FILE_SHA = createHash('sha256').update(FILE_BYTES).digest('hex');

test('Package 2: side panel chat, file and voice with the console', async () => {
  let s: P2Session | null = null;
  try {
    s = await startP2Session({ org: 'E2E Panel Clinic', label: 'E2E panel ticket', consent: { level: 'view' } });
    const { assist, panel } = s;

    await test.step('Chat both ways between the side panel and the console', async () => {
      await assist.locator('#chat-input').fill('Hello from the console');
      await assist.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(panel.getByRole('log')).toContainText('Hello from the console');
      await panel.getByLabel('Message to your technician').fill('Hi, the Desk side panel here');
      await panel.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(assist.getByRole('log', { name: 'Chat messages' })).toContainText('Hi, the Desk side panel here');
      await shot(panel, 'desk-panel-chat');
    });

    await test.step('A file picked in the side panel reaches the console intact', async () => {
      await panel
        .getByLabel('Send a file to your technician')
        .setInputFiles({ name: FILE_NAME, mimeType: 'text/plain', buffer: Buffer.from(FILE_BYTES) });
      const dialog = assist.getByRole('dialog', { name: 'Incoming file' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(FILE_NAME);
      await expect(dialog).toContainText('3.0 KiB');
      await dialog.getByRole('button', { name: 'Accept', exact: true }).click();
      const row = assist.getByRole('region', { name: 'Files' }).getByRole('listitem').filter({ hasText: FILE_NAME });
      await expect(row).toContainText(`From ${DESK_NAME}: ${FILE_NAME}`);
      await expect(row).toContainText('done');
      await expect(row).toContainText(`sha256 ${FILE_SHA}`);
      await expect(panel.getByRole('listitem').filter({ hasText: `Sent: ${FILE_NAME}` })).toContainText('done');
      await shot(assist, 'assist-panel-file');
    });

    await test.step('Voice: Desk unmutes in the side panel, Assist turns voice on, audio flows both ways', async () => {
      const voice = assist.getByRole('region', { name: 'Voice' });
      await panel.getByRole('button', { name: 'Unmute', exact: true }).click();
      await expect(panel.getByText('Your technician can hear you')).toBeVisible();
      await expect(voice).toContainText(`${DESK_NAME}'s microphone is on`);
      await voice.getByRole('button', { name: 'Turn voice on' }).click();
      await expect(voice.getByRole('button', { name: 'Turn voice off' })).toBeVisible();
      await expect
        .poll(
          async () => {
            const a = (await assistStats(assist)).audioIn;
            return a.live && a.unmuted && a.bytes > 0;
          },
          { message: 'Assist receives the Desk microphone', timeout: 20_000 },
        )
        .toBe(true);
      const b0 = (await assistStats(assist)).audioIn.bytes;
      await expect.poll(async () => (await assistStats(assist)).audioIn.bytes).toBeGreaterThan(b0);
      await expect
        .poll(async () => (await assistStats(assist)).audioOutReports, {
          message: 'the Desk reports receiving the Assist voice (RTCP)',
          timeout: 20_000,
        })
        .toBeGreaterThan(0);
      await panel.getByRole('button', { name: 'Mute', exact: true }).click();
      await expect(voice).toContainText(`${DESK_NAME} is muted`);
      await shot(panel, 'desk-panel-voice');
    });

    await test.step('Stop sharing; the audit holds the file attestation and the chain verifies', async () => {
      await panel.getByRole('button', { name: 'Stop sharing' }).click();
      await expect(panel.getByRole('heading', { name: 'Session ended' })).toBeVisible();
      const table = await openAudit(s!);
      for (const action of ['session.consent_granted', 'mirror.started', 'file.sent', 'session.ended'])
        await expect(table.getByRole('cell', { name: action, exact: true }).first(), action).toBeVisible();
      await assist.getByRole('button', { name: 'Verify chain' }).click();
      await expect(assist.getByText(/^Verified /)).toHaveAttribute('data-tone', 'green');
    });
  } finally {
    console.log(`screenshots:\n${shots.join('\n')}`);
    await s?.close();
  }
});
