import fs from 'node:fs/promises';
import path from 'node:path';

export async function loadWordFixerConfig() {
  const home = process.env.HOME;
  const configDir = path.join(home, '.config', 'word-fixer');
  const configPath = path.join(configDir, 'config.json');
  const raw = await fs.readFile(configPath, 'utf8');
  const config = JSON.parse(raw);
  const piDir = path.join(configDir, '.pi');
  return { configDir, configPath, piDir, ...config };
}

export async function resolvePiSdkModuleUrl(piBinaryPath) {
  const realPiPath = await fs.realpath(piBinaryPath);
  const packageRoot = path.dirname(path.dirname(realPiPath));
  return new URL(`file://${path.join(packageRoot, 'dist', 'index.js')}`);
}

export function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

export function parseArgs(argv) {
  const args = [...argv];
  const positional = [];
  const options = {};

  while (args.length > 0) {
    const arg = args.shift();
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = args[0];
    if (!next || next.startsWith('--')) {
      options[key] = true;
      continue;
    }
    options[key] = args.shift();
  }

  return { positional, options };
}
