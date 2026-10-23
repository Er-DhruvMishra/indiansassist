import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CDP_ALLOWED_METHODS, DebuggerControl, cdpModifiers, cdpMouseEvents, sendCommand } from '../src/background/debugger-control';
import { installChromeMock, type ChromeMock } from './chrome-mock';

let chrome: ChromeMock;
beforeEach(() => {
  chrome = installChromeMock();
});

describe('CDP allow-list (section 5.4)', () => {
  it('only the three Input methods exist in the allow-list', () => {
    expect([...CDP_ALLOWED_METHODS]).toEqual(['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText']);
  });

  it('every other method throws before reaching chrome.debugger.sendCommand', async () => {
    for (const m of ['Runtime.evaluate', 'Network.getCookies', 'Page.navigate', 'Target.attachToTarget', 'Page.captureScreenshot', 'Input.dispatchTouchEvent']) {
      await expect(sendCommand(1, m, {})).rejects.toThrow('cdp_method_not_allowed');
    }
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalled();
    await sendCommand(1, 'Input.insertText', { text: 'a' });
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Input.insertText', { text: 'a' });
  });
});

describe('DebuggerControl', () => {
  it('attaches only with the optional permission, reports attach / detach and removes the permission', async () => {
    const changes = vi.fn();
    const d = new DebuggerControl(changes);
    expect(await d.attach(5)).toBe(false);
    expect(chrome.debugger.attach).not.toHaveBeenCalled();
    chrome.permissionsSet.add('debugger');
    expect(await d.attach(5)).toBe(true);
    expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 5 }, '1.3');
    expect(changes).toHaveBeenLastCalledWith(5, true, 'request');
    await d.detachAll('level');
    expect(changes).toHaveBeenLastCalledWith(5, false, 'level');
    expect(d.attached.size).toBe(0);
    await d.removePermission();
    expect(chrome.permissionsSet.has('debugger')).toBe(false);
  });

  it('a user-cancelled infobar (onDetach) is reported with cause user', async () => {
    chrome.permissionsSet.add('debugger');
    const changes = vi.fn();
    const d = new DebuggerControl(changes);
    await d.attach(7);
    d.handleDetached(7, 'canceled_by_user');
    expect(changes).toHaveBeenLastCalledWith(7, false, 'user');
  });

  it('maps pointer kinds onto CDP mouse events', () => {
    expect(cdpModifiers({ alt: true, ctrl: true, meta: false, shift: true })).toBe(11);
    expect(cdpMouseEvents('click', 10, 20, 0, 0).map((e) => e.type)).toEqual(['mousePressed', 'mouseReleased']);
    expect(cdpMouseEvents('dblclick', 1, 1, 0, 0).map((e) => e.clickCount)).toEqual([1, 1, 2, 2]);
    expect(cdpMouseEvents('contextmenu', 1, 1, 0, 0)[0]).toMatchObject({ button: 'right' });
    expect(cdpMouseEvents('wheel', 1, 1, 0, 0, 0, 120)[0]).toMatchObject({ type: 'mouseWheel', deltaY: 120 });
  });
});
