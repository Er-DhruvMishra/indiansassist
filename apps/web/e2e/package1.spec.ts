/**
 * Package 1 two-browser end-to-end test: one Chromium, two contexts. Assist signs up an in-mum org, creates a
 * p1_browser one_time token and copies the join link; the Desk opens it, copies the token, joins, consents and
 * shares (fake screen); then video, chat both ways, a voice call (both sides turn voice on, the remote audio track
 * is live and RTP audio bytes keep arriving on each side), a Desk -> Assist and an Assist -> Desk file, an
 * annotation, the network widget, a recording upload, Stop sharing, the consent receipt and the audit chain are
 * all checked through the real UI.
 */
import { createHash, randomBytes } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  canvasHasContent,
  captureConsole,
  inkPixels,
  probeRemoteAudio,
  probeRemoteVideo,
  recordPeerConnections,
  shot,
  shots,
} from './helpers';

const WEB = `http://localhost:${process.env.E2E_WEB_PORT || '5173'}`;
const DESK_NAME = 'E2E Desk';
const FILE_NAME = 'e2e-desk-note.txt';
const FILE_BYTES = randomBytes(2048).toString('hex'); // 4096 ASCII bytes
const FILE_SHA = createHash('sha256').update(FILE_BYTES).digest('hex');
const BACK_NAME = 'e2e-assist-reply.txt';
const BACK_BYTES = randomBytes(1024).toString('hex'); // 2048 ASCII bytes
const BACK_SHA = createHash('sha256').update(BACK_BYTES).digest('hex');

async function newSide(ctx: BrowserContext, side: string): Promise<Page> {
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write', 'camera', 'microphone'], { origin: WEB });
  await ctx.addInitScript(recordPeerConnections);
  const page = await ctx.newPage();
  captureConsole(page, side);
  return page;
}

test('Package 1: Assist and Desk complete a real browser session', async ({ browser }) => {
  const assistCtx = await browser.newContext();
  const deskCtx = await browser.newContext();
  const assist = await newSide(assistCtx, 'assist');
  const desk = await newSide(deskCtx, 'desk');
  let joinUrl = '';
  let sessionId = '';

  try {
    await test.step('Assist signs up an org in in-mum', async () => {
      await assist.goto('/signup');
      await assist.getByLabel('Organisation name').fill('E2E Clinic');
      await expect(assist.getByLabel('Data region')).toHaveValue('in-mum');
      await assist.getByLabel('Your name').fill('Asha Tech');
      await assist.getByLabel('Work email').fill(`asha+${Date.now()}@e2e.example.com`);
      await assist.getByLabel('Password').fill('correct horse battery staple');
      await assist.getByRole('button', { name: 'Create organisation' }).click();
      await expect(assist).toHaveURL(/\/app$/);
      await expect(assist.getByRole('banner').getByText('Signaling: Online')).toBeVisible();
      await shot(assist, 'assist-dashboard');
    });

    await test.step('Assist creates a p1_browser one_time token and copies the join link', async () => {
      const card = assist
        .locator('section')
        .filter({ has: assist.getByRole('heading', { name: 'Quick create token' }) });
      await expect(card.getByLabel('Package tier')).toHaveValue('p1_browser');
      await expect(card.getByRole('radio', { name: /One time/ })).toBeChecked();
      await card.getByLabel('Label (optional)').fill('E2E ticket');
      await card.getByRole('button', { name: 'Create token' }).click();
      const link = assist.locator('#join-link');
      await expect(link).toHaveValue(/\/join#t=/);
      await assist.getByRole('button', { name: 'Copy link' }).first().click();
      await expect(assist.getByText('Copied', { exact: true }).first()).toBeVisible();
      joinUrl = await assist.evaluate(() => navigator.clipboard.readText());
      expect(joinUrl).toBe(await link.inputValue());
      expect(joinUrl.startsWith(`${WEB}/join`)).toBe(true);
      await shot(assist, 'assist-token-created');
    });

    await test.step('Desk opens the link, copies the token and joins', async () => {
      await desk.goto(joinUrl);
      await expect(desk).toHaveURL(`${WEB}/join`); // the bearer leaves the URL bar at once
      await expect(desk.getByText('Asha Tech wants to help you')).toBeVisible();
      await desk.getByRole('button', { name: 'Copy token' }).click();
      await expect(desk.getByRole('button', { name: 'Copy token again' })).toBeVisible();
      const copied = await desk.evaluate(() => navigator.clipboard.readText());
      expect(joinUrl.endsWith(encodeURIComponent(copied)) || joinUrl.endsWith(copied)).toBe(true);
      await desk.getByLabel('Your name (optional, shown to the technician)').fill(DESK_NAME);
      await shot(desk, 'desk-join');
      await desk.getByRole('button', { name: 'Join support session' }).click();
      await expect(desk.getByRole('heading', { name: 'Waiting for Asha Tech to accept' })).toBeVisible();
      await shot(desk, 'desk-waiting');
    });

    await test.step('Assist sees the knock and accepts', async () => {
      const knock = assist.getByRole('article', { name: `Support request from ${DESK_NAME}` }).first();
      await expect(knock).toBeVisible();
      await expect(knock).toContainText('E2E ticket');
      await shot(assist, 'assist-knock');
      await knock.getByRole('button', { name: 'Accept', exact: true }).click();
      await expect(assist).toHaveURL(/\/app\/sessions\/[0-9a-f-]{36}$/);
      sessionId = /\/app\/sessions\/([0-9a-f-]{36})$/.exec(assist.url())![1]!;
      await expect(assist.getByRole('status').filter({ hasText: 'Waiting for consent' })).toBeVisible();
    });

    await test.step('Desk consents and shares the entire screen', async () => {
      await expect(desk.getByRole('heading', { name: /Asha Tech from .* is asking to see your screen/ })).toBeVisible();
      await expect(desk.getByRole('button', { name: 'Share my screen' })).toBeDisabled();
      await desk.getByLabel('Share a single window instead of my whole screen').uncheck();
      await desk.getByLabel('I have closed or hidden anything private').check();
      await shot(desk, 'desk-consent');
      await desk.getByRole('button', { name: 'Share my screen' }).click();
      const banner = desk.getByRole('region', { name: 'Screen sharing status' });
      await expect(banner).toBeVisible();
      await expect(banner).toContainText('You are sharing your screen with Asha Tech');
      await expect(desk).toHaveTitle(/^\(Sharing\)/);
      await shot(desk, 'desk-sharing');
    });

    await test.step('Assist console receives video frames', async () => {
      await expect
        .poll(async () => (await probeRemoteVideo(assist))?.width ?? 0, { timeout: 20_000 })
        .toBeGreaterThan(0);
      const t0 = (await probeRemoteVideo(assist))!.time;
      await expect.poll(async () => (await probeRemoteVideo(assist))?.time ?? 0).toBeGreaterThan(t0 + 0.3);
      await expect(assist.getByText('Live', { exact: true }).first()).toBeVisible();
      await expect.poll(() => canvasHasContent(assist.locator('canvas[role="img"]').first())).toBe(true);
      await shot(assist, 'assist-live');
    });

    await test.step('Chat both ways over the data channel', async () => {
      await assist.locator('#chat-input').fill('Hello from Assist');
      await assist.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(desk.getByRole('log', { name: 'Chat messages' })).toContainText('Hello from Assist');
      await desk.locator('#chat-input').fill('Hi Assist, Desk here');
      await desk.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(assist.getByRole('log', { name: 'Chat messages' })).toContainText('Hi Assist, Desk here');
      await shot(assist, 'chat');
    });

    await test.step('Voice call: both sides turn voice on and hear each other', async () => {
      const assistVoice = assist.getByRole('region', { name: 'Voice' });
      const deskVoice = desk.getByRole('region', { name: 'Voice' });
      await assistVoice.getByRole('button', { name: 'Turn voice on' }).click();
      await expect(assistVoice.getByRole('button', { name: 'Turn voice off' })).toBeVisible();
      await expect(deskVoice).toContainText("Asha Tech's microphone is on");
      await deskVoice.getByRole('button', { name: 'Turn voice on' }).click();
      await expect(deskVoice.getByRole('button', { name: 'Turn voice off' })).toBeVisible();
      await expect(assistVoice).toContainText(`${DESK_NAME}'s microphone is on`);
      for (const [side, page] of [
        ['assist', assist],
        ['desk', desk],
      ] as const) {
        await expect
          .poll(async () => {
            const a = await probeRemoteAudio(page);
            return a.live && a.unmuted && a.bytesReceived > 0;
          }, { message: `${side} receives remote audio`, timeout: 20_000 })
          .toBe(true);
        const b0 = (await probeRemoteAudio(page)).bytesReceived;
        await expect
          .poll(async () => (await probeRemoteAudio(page)).bytesReceived, { message: `${side} audio bytes grow` })
          .toBeGreaterThan(b0);
      }
      // The mute state reaches the other side over ia.ctrl (voice.state).
      await deskVoice.getByRole('button', { name: 'Mute microphone' }).click();
      await expect(assistVoice).toContainText(`${DESK_NAME} is muted`);
      await deskVoice.getByRole('button', { name: 'Unmute microphone' }).click();
      await expect(assistVoice).toContainText(`${DESK_NAME}'s microphone is on`);
      await shot(assist, 'voice-on');
    });

    await test.step('Desk sends a file and Assist receives it intact', async () => {
      await desk
        .locator('#file-send')
        .setInputFiles({ name: FILE_NAME, mimeType: 'text/plain', buffer: Buffer.from(FILE_BYTES) });
      const dialog = assist.getByRole('dialog', { name: 'Incoming file' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(FILE_NAME);
      await expect(dialog).toContainText('4.0 KiB');
      await dialog.getByRole('button', { name: 'Accept', exact: true }).click();
      const row = assist.getByRole('region', { name: 'Files' }).getByRole('listitem').filter({ hasText: FILE_NAME });
      await expect(row).toContainText(`From ${DESK_NAME}: ${FILE_NAME}`);
      await expect(row).toContainText('done');
      await expect(row).toContainText('4.0 KiB / 4.0 KiB');
      await expect(row).toContainText(`sha256 ${FILE_SHA}`);
      await expect(
        desk.getByRole('region', { name: 'Files' }).getByRole('listitem').filter({ hasText: FILE_NAME }),
      ).toContainText('done');
      await shot(assist, 'file-received');
    });

    await test.step('Assist sends a file and the Desk accepts it intact', async () => {
      await assist
        .locator('#file-send')
        .setInputFiles({ name: BACK_NAME, mimeType: 'text/plain', buffer: Buffer.from(BACK_BYTES) });
      const dialog = desk.getByRole('dialog', { name: 'Incoming file' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(BACK_NAME);
      await expect(dialog).toContainText('2.0 KiB');
      await expect(dialog).toContainText('Asha Tech');
      await shot(desk, 'desk-incoming-file');
      await dialog.getByRole('button', { name: 'Accept', exact: true }).click();
      const row = desk.getByRole('region', { name: 'Files' }).getByRole('listitem').filter({ hasText: BACK_NAME });
      await expect(row).toContainText(`From Asha Tech: ${BACK_NAME}`);
      await expect(row).toContainText('done');
      await expect(row).toContainText('2.0 KiB / 2.0 KiB');
      await expect(row).toContainText(`sha256 ${BACK_SHA}`);
      await expect(row).toContainText('reported to the server');
      const sent = assist.getByRole('region', { name: 'Files' }).getByRole('listitem').filter({ hasText: BACK_NAME });
      await expect(sent).toContainText(`To ${DESK_NAME}: ${BACK_NAME}`);
      await expect(sent).toContainText('done');
    });

    await test.step('Annotation drawn on Assist appears on the Desk overlay', async () => {
      await assist.getByRole('button', { name: 'Rectangle', exact: true }).click();
      const overlay = assist.locator('canvas.cursor-crosshair');
      await expect(overlay).toBeVisible();
      const box = (await overlay.boundingBox())!;
      await assist.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
      await assist.mouse.down();
      await assist.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
      await assist.mouse.up();
      const deskOverlay = desk.getByRole('img', { name: 'Technician annotations on your shared screen' });
      await expect(deskOverlay).toBeVisible();
      await expect.poll(() => inkPixels(deskOverlay)).toBeGreaterThan(50);
      await shot(desk, 'desk-annotation');
    });

    await test.step('Network widget shows the path and a numeric RTT', async () => {
      const net = assist.getByRole('region', { name: 'Network path' });
      await expect(net.getByText(/^(P2P|Relay)$/)).toBeVisible();
      await expect(net.locator('dt:text-is("RTT") + dd')).toHaveText(/^\d+ ms$/, { timeout: 20_000 });
    });

    await test.step('Recording starts, stops and uploads with a sha256', async () => {
      await assist.getByRole('button', { name: 'Record', exact: true }).click();
      await expect(assist.getByText('Recording', { exact: true }).first()).toBeVisible();
      await expect(desk.getByRole('region', { name: 'Screen sharing status' }).getByRole('status')).toContainText(
        'Recording',
      );
      await shot(desk, 'desk-recording-indicator');
      await assist.waitForTimeout(2000); // a couple of seconds of real frames in the recording
      await assist.getByRole('button', { name: 'Stop recording' }).click();
      await expect(assist.getByTestId('recording-sha256')).toHaveText(/^[0-9a-f]{64}$/, { timeout: 30_000 });
      await shot(assist, 'assist-recording-stored');
    });

    await test.step('Desk stops sharing; both sides show the end', async () => {
      await desk
        .getByRole('region', { name: 'Screen sharing status' })
        .getByRole('button', { name: 'Stop sharing' })
        .click();
      await expect(desk.getByRole('heading', { name: 'Session ended: your consent receipt' })).toBeVisible();
      await expect(assist.getByText(/^Session ended/).first()).toBeVisible();
      await expect(assist.getByRole('heading', { name: 'Session summary' })).toBeVisible();
      await shot(assist, 'assist-ended');
    });

    await test.step('Desk consent receipt lists the file and the recording', async () => {
      const files = desk.locator('dt:text-is("Files") + dd');
      await expect(files).toContainText(`Sent ${FILE_NAME} (4.0 KiB)`);
      await expect(files).toContainText(FILE_SHA);
      await expect(desk.locator('dt:text-is("Recorded") + dd')).toHaveText('Yes, the technician recorded this session');
      await expect(desk.locator('dt:text-is("Session id") + dd')).toHaveText(sessionId);
      await shot(desk, 'desk-receipt');
    });

    await test.step('Audit shows the session entries and the chain verifies', async () => {
      await assist.goto('/app/audit');
      await assist.locator('#f-session').fill(sessionId);
      await assist.getByRole('button', { name: 'Apply filters' }).click();
      const table = assist.getByRole('table', { name: 'Audit entries' });
      for (const action of [
        'session.knock',
        'session.accepted',
        'session.consent_granted',
        'session.started',
        'recording.started',
        'recording.stored',
        'session.ended',
      ]) {
        await expect(table.getByRole('cell', { name: action, exact: true }).first()).toBeVisible();
      }
      await expect(table.getByRole('cell', { name: 'file.sent', exact: true }).first()).toBeVisible();
      // The Desk attests what it received from the Assist (actor desk).
      const received = table.getByRole('row').filter({ has: assist.getByRole('cell', { name: 'file.received', exact: true }) });
      await expect(received.filter({ hasText: '(desk)' }).first()).toBeVisible();
      await assist.getByRole('button', { name: 'Verify chain' }).click();
      const badge = assist.getByText(/^Verified /);
      await expect(badge).toBeVisible();
      await expect(badge).toHaveAttribute('data-tone', 'green');
      await shot(assist, 'assist-audit-verified');
    });
  } finally {
    console.log(`screenshots:\n${shots.join('\n')}`);
    await assistCtx.close();
    await deskCtx.close();
  }
});
