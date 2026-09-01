import { isTerminalWindow } from './target.mjs';

const COMMANDS = Object.freeze({
  copy: Object.freeze({
    normal: Object.freeze({ mods: 'CTRL', key: 'C' }),
    terminal: Object.freeze({ mods: 'CTRL', key: 'Insert' }),
  }),
  paste: Object.freeze({
    normal: Object.freeze({ mods: 'CTRL', key: 'V' }),
    terminal: Object.freeze({ mods: 'SHIFT', key: 'Insert' }),
  }),
});

export function selectClipboardCommand(action, window) {
  if (!Object.hasOwn(COMMANDS, action)) {
    throw new TypeError(`Unsupported clipboard action: ${String(action)}.`);
  }

  return isTerminalWindow(window) ? COMMANDS[action].terminal : COMMANDS[action].normal;
}

export function clipboardKeyEvents(action, window) {
  const command = selectClipboardCommand(action, window);
  return [
    Object.freeze({ ...command, state: 'down' }),
    Object.freeze({ ...command, state: 'up' }),
  ];
}
