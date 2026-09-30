import assert from 'node:assert/strict';

type Call = (phase: string, tool: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }> }>;
type Window = { hidden: boolean; alpha: number; userInteractionEnabled: boolean; frame: { x: number; y: number; width: number; height: number } };

export async function runSweatcoinUi(call: Call, udid: string) {
  const target = { udid, bundleId: 'swc' };
  const screens: string[] = [];
  async function json(phase: string, tool: string, args: Record<string, unknown>) {
    const result = await call(phase, tool, args);
    const block = result.content.find(block => block.type === 'text' && block.text?.trimStart().startsWith('{'));
    assert(block?.text, `${phase}: missing JSON response`);
    return JSON.parse(block.text);
  }
  async function screen(name: string, identifier: string) {
    const visible = await json(`${name}-visible`, 'await-ui-element', { ...target, condition: 'visible', selector: { identifier }, timeoutMs: 60000 });
    assert.equal(visible.success, true, `${name}: ${JSON.stringify(visible)}`);
    const idle = await json(`${name}-idle`, 'await-screen-idle', { udid, timeoutMs: 10000, minStableMs: 500 });
    assert.equal(idle.settled, true, `${name}: UI did not settle`);
    await call(`${name}-screenshot`, 'screenshot', { udid, scale: 0.5 });
    screens.push(name);
  }
  async function tap(name: string, identifier: string, offsetX?: number) {
    const found = await json(`${name}-target`, 'native-find-views', { ...target, identifier, fields: ['identifier', 'windowFrame', 'hidden', 'alpha', 'userInteractionEnabled'], includeAncestors: false, includeChildren: false });
    assert.equal(found.status, 'ok', `${name}: ${JSON.stringify(found)}`);
    assert.equal(found.matches.length, 1, `${name}: expected one native target`);
    const view = found.matches[0];
    assert(!view.hidden && view.alpha > 0.01 && view.userInteractionEnabled, `${name}: target is not interactive`);
    const frame = view.windowFrame;
    assert(frame.width > 0 && frame.height > 0, `${name}: target has no area`);
    const x = frame.x + (offsetX ?? frame.width / 2);
    const y = frame.y + frame.height / 2;
    assert(x > frame.x && x < frame.x + frame.width && x > 0 && x < size.width && y > 0 && y < size.height, `${name}: tap falls outside the target or screen`);
    const result = await json(name, 'gesture-tap', { udid, x: x / size.width, y: y / size.height });
    assert.equal(result.tapped, true, `${name}: tap failed`);
  }

  const launched = await json('launch', 'restart-app', target);
  assert.equal(launched.restarted, true, 'App did not restart');
  await screen('welcome', 'signUpButton');
  const hierarchy = await json('window', 'native-full-hierarchy', { ...target, fields: ['frame', 'hidden', 'alpha', 'userInteractionEnabled'], maxDepth: 1 });
  assert.equal(hierarchy.status, 'ok', 'Native hierarchy unavailable');
  const windows: Window[] = hierarchy.windows.filter((window: Window) => window.userInteractionEnabled && !window.hidden && window.alpha > 0.01 && window.frame.width > 0 && window.frame.height > 0);
  assert.equal(windows.length, 1, 'Expected one app window');
  const size = windows[0].frame;
  assert(size.x === 0 && size.y === 0 && size.width < size.height, 'Expected a full-screen portrait app window');
  // The nested link has no native node; this is the mobile repo's existing test offset.
  await tap('open-login', 'logInButton', 215);
  await screen('login', 'signInWithPhoneNumberButton');
  await tap('open-phone', 'signInWithPhoneNumberButton');
  await screen('phone', 'buttonConfirm');
  const input = await json('phone-input', 'native-find-views', { ...target, identifier: 'PhoneInput', fields: ['identifier'], includeAncestors: false, includeChildren: false });
  assert.equal(input.status, 'ok', 'Native phone input unavailable');
  assert.equal(input.matches.length, 1, 'Expected one native phone input');
  await tap('cancel-phone', 'CancelButton');
  await screen('welcome-again', 'signUpButton');
  return { screens, taps: 3 };
}
