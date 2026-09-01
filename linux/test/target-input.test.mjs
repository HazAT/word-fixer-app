import assert from 'node:assert/strict';
import test from 'node:test';
import { clipboardKeyEvents, selectClipboardCommand } from '../lib/input-command.mjs';
import { captureTarget, isTerminalWindow, targetMatches } from '../lib/target.mjs';

const normalWindow = {
  address: '0xA1B2',
  pid: 4242,
  class: 'org.gnome.TextEditor',
  initialClass: 'org.gnome.TextEditor',
  title: 'Draft 1',
  tags: ['editor'],
};

const terminalWindow = {
  address: '0xC3D4',
  pid: 5252,
  class: 'Alacritty',
  initialClass: 'Alacritty',
  title: 'shell',
  tags: ['terminal*'],
};

test('captures stable Hyprland identity and matches the exact active target', () => {
  const captured = captureTarget(normalWindow);

  assert.deepEqual(captured, {
    address: '0xa1b2',
    pid: 4242,
    initialClass: 'org.gnome.TextEditor',
  });
  assert.equal(targetMatches(captured, { ...normalWindow, title: 'Draft 2' }), true);
  assert.equal(targetMatches(captured, { ...normalWindow, address: '0xFFFF' }), false);
  assert.equal(targetMatches(captured, { ...normalWindow, pid: 9999 }), false);
  assert.equal(targetMatches(captured, { ...normalWindow, initialClass: 'imposter' }), false);
  assert.equal(targetMatches(captured, null), false);
});

test('rejects incomplete captured targets instead of weakening identity checks', () => {
  assert.throws(
    () => captureTarget({ address: '0x123', pid: 1 }),
    /initialClass/,
  );
  assert.throws(
    () => captureTarget({ address: '../../window', pid: 1, initialClass: 'app' }),
    /address/,
  );
  assert.throws(
    () => targetMatches({ address: '0x123', pid: 0, initialClass: 'app' }, normalWindow),
    /pid/,
  );
});

test('recognizes only Omarchy terminal tags, including dynamic trailing stars', () => {
  assert.equal(isTerminalWindow(normalWindow), false);
  assert.equal(isTerminalWindow(terminalWindow), true);
  assert.equal(isTerminalWindow({ tags: ['terminal'] }), true);
  assert.equal(isTerminalWindow({ tags: ['terminal**'] }), false);
  assert.equal(isTerminalWindow({ tags: ['Terminal'] }), false);
  assert.equal(isTerminalWindow({ tags: null }), false);
});

test('selects Omarchy normal-window copy and paste chords', () => {
  assert.deepEqual(selectClipboardCommand('copy', normalWindow), { mods: 'CTRL', key: 'C' });
  assert.deepEqual(selectClipboardCommand('paste', normalWindow), { mods: 'CTRL', key: 'V' });
});

test('selects Omarchy terminal-specific copy and paste chords', () => {
  assert.deepEqual(selectClipboardCommand('copy', terminalWindow), {
    mods: 'CTRL',
    key: 'Insert',
  });
  assert.deepEqual(selectClipboardCommand('paste', terminalWindow), {
    mods: 'SHIFT',
    key: 'Insert',
  });
});

test('builds explicit down/up key-state events without a shell command', () => {
  assert.deepEqual(clipboardKeyEvents('paste', terminalWindow), [
    { mods: 'SHIFT', key: 'Insert', state: 'down' },
    { mods: 'SHIFT', key: 'Insert', state: 'up' },
  ]);
  assert.throws(() => selectClipboardCommand('cut', normalWindow), /Unsupported/);
});
