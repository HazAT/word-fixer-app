const HYPRLAND_ADDRESS_PATTERN = /^0x[0-9a-f]+$/i;

function targetError(message) {
  return new TypeError(`Invalid Hyprland target: ${message}.`);
}

function requireTargetRecord(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw targetError('expected an object');
  }

  if (typeof target.address !== 'string' || !HYPRLAND_ADDRESS_PATTERN.test(target.address)) {
    throw targetError('address');
  }
  if (!Number.isSafeInteger(target.pid) || target.pid <= 0) {
    throw targetError('pid');
  }
  if (typeof target.initialClass !== 'string' || target.initialClass.length === 0) {
    throw targetError('initialClass');
  }
}

export function captureTarget(window) {
  requireTargetRecord(window);
  return Object.freeze({
    address: window.address.toLowerCase(),
    pid: window.pid,
    initialClass: window.initialClass,
  });
}

export function targetMatches(capturedTarget, activeWindow) {
  requireTargetRecord(capturedTarget);

  let candidate;
  try {
    candidate = captureTarget(activeWindow);
  } catch {
    return false;
  }

  return capturedTarget.address.toLowerCase() === candidate.address
    && capturedTarget.pid === candidate.pid
    && capturedTarget.initialClass === candidate.initialClass;
}

export function isTerminalWindow(window) {
  if (!window || typeof window !== 'object' || Array.isArray(window)) return false;
  if (!Array.isArray(window.tags)) return false;

  return window.tags.some((tag) => (
    typeof tag === 'string' && tag.replace(/\*$/, '') === 'terminal'
  ));
}
