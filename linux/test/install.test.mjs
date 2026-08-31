import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const installer = path.join(repositoryRoot, 'linux', 'install');

async function writeExecutable(filePath, content) {
  await fs.writeFile(filePath, content, { mode: 0o755 });
}

async function snapshotTree(root) {
  const entries = [];
  async function visit(current, relative = '') {
    const names = await fs.readdir(current).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const name of names.sort()) {
      const child = path.join(current, name);
      const childRelative = path.join(relative, name);
      const stat = await fs.lstat(child);
      if (stat.isSymbolicLink()) {
        entries.push([childRelative, 'link', await fs.readlink(child)]);
      } else if (stat.isDirectory()) {
        entries.push([childRelative, 'directory', stat.mode & 0o777]);
        await visit(child, childRelative);
      } else {
        entries.push([childRelative, 'file', stat.mode & 0o777, (await fs.readFile(child)).toString('base64')]);
      }
    }
  }
  await visit(root);
  return entries;
}

async function createHarness(t, { modelAvailable = true } = {}) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'word-fixer-install-test-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));

  const home = path.join(temporaryRoot, 'home');
  const stubBin = path.join(temporaryRoot, 'stubs');
  const sdkRoot = path.join(temporaryRoot, 'pi-sdk');
  const sdkBin = path.join(sdkRoot, 'bin');
  const binHome = path.join(home, '.local', 'bin');
  const stateFile = path.join(temporaryRoot, 'plugin-state.json');
  const commandLog = path.join(temporaryRoot, 'commands.log');
  await fs.mkdir(path.join(home, '.pi', 'agent'), { recursive: true });
  await fs.mkdir(stubBin, { recursive: true });
  await fs.mkdir(path.join(sdkRoot, 'dist'), { recursive: true });
  await fs.mkdir(sdkBin, { recursive: true });
  await fs.writeFile(path.join(home, '.pi', 'agent', 'auth.json'), '{"openai-codex":"canonical-test-auth"}\n');
  await fs.writeFile(path.join(sdkRoot, 'package.json'), JSON.stringify({
    name: '@earendil-works/pi-coding-agent',
    version: '0.84.4-test',
  }));
  await fs.writeFile(path.join(sdkRoot, 'dist', 'index.js'), 'export const testSdk = true;\n');
  await fs.writeFile(stateFile, JSON.stringify({ discovered: false, enabled: false }));

  await writeExecutable(path.join(sdkBin, 'pi'), `#!/usr/bin/env bash
set -euo pipefail
printf 'pi %s\\n' "$*" >>"$WF_STUB_LOG"
if [[ \${1:-} == --list-models ]]; then
  printf 'provider      model         context  max-out  thinking  images\\n'
  ${modelAvailable ? "printf 'openai-codex  gpt-5.4-mini  272K     128K     yes       yes\\n'" : ':'}
  exit 0
fi
if [[ \${1:-} == auth && \${2:-} == check ]]; then
  printf '{"status":"ready","provider":"openai-codex","authType":"oauth"}\\n'
  exit 0
fi
if [[ \${1:-} == --version ]]; then
  printf '0.84.4-test\\n'
  exit 0
fi
exit 2
`);
  await fs.symlink(path.join(sdkBin, 'pi'), path.join(stubBin, 'pi'));

  await writeExecutable(path.join(stubBin, 'omarchy-shell'), `#!/usr/bin/env bash
set -euo pipefail
printf 'omarchy-shell %s\\n' "$*" >>"$WF_STUB_LOG"
if [[ \${1:-} == shell && \${2:-} == ping ]]; then
  echo ok
elif [[ \${1:-} == shell && \${2:-} == rescanPlugins ]]; then
  node -e 'const fs=require("fs");const p=process.env.WF_STUB_STATE;const s=JSON.parse(fs.readFileSync(p));s.discovered=true;fs.writeFileSync(p,JSON.stringify(s))'
  echo ok
elif [[ \${1:-} == shell && \${2:-} == summon ]]; then
  node -e 'const fs=require("fs");const s=JSON.parse(fs.readFileSync(process.env.WF_STUB_STATE));process.exit(s.discovered&&s.enabled?0:1)'
  echo ok
else
  exit 2
fi
`);

  await writeExecutable(path.join(stubBin, 'omarchy'), `#!/usr/bin/env bash
set -euo pipefail
printf 'omarchy %s\\n' "$*" >>"$WF_STUB_LOG"
[[ \${1:-} == plugin ]] || exit 2
case \${2:-} in
  validate)
    [[ -f \${3:-}/manifest.json ]]
    ;;
  list)
    node - <<'NODE'
const fs = require('fs');
const state = JSON.parse(fs.readFileSync(process.env.WF_STUB_STATE));
process.stdout.write(JSON.stringify(state.discovered ? [{
  id: 'hazat.word-fixer',
  name: 'Word Fixer',
  kinds: ['overlay'],
  enabled: state.enabled,
  active: false,
  canDisable: true,
  firstParty: false,
  clonedFrom: '',
}] : []));
NODE
    ;;
  enable)
    [[ \${3:-} == hazat.word-fixer ]]
    node -e 'const fs=require("fs");const p=process.env.WF_STUB_STATE;const s=JSON.parse(fs.readFileSync(p));if(!s.discovered)process.exit(1);s.enabled=true;fs.writeFileSync(p,JSON.stringify(s))'
    echo 'Enabled hazat.word-fixer'
    ;;
  *) exit 2 ;;
esac
`);

  for (const command of ['wl-copy', 'wl-paste', 'hyprctl', 'notify-send']) {
    await writeExecutable(path.join(stubBin, command), '#!/usr/bin/env bash\nexit 0\n');
  }

  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_BIN_HOME: binHome,
    PATH: [binHome, stubBin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
    WF_STUB_STATE: stateFile,
    WF_STUB_LOG: commandLog,
  };

  return { temporaryRoot, home, binHome, stateFile, commandLog, env };
}

function runInstaller(harness, args = []) {
  return spawnSync(installer, args, {
    cwd: repositoryRoot,
    env: harness.env,
    encoding: 'utf8',
  });
}

test('check mode is clear and non-destructive before and after installation', async (t) => {
  const harness = await createHarness(t);
  const before = await snapshotTree(harness.home);
  const missingCheck = runInstaller(harness, ['--check']);
  assert.notEqual(missingCheck.status, 0);
  assert.match(`${missingCheck.stdout}${missingCheck.stderr}`, /\[missing\] app config/);
  assert.match(missingCheck.stderr, /installation check\(s\) failed/);
  assert.deepEqual(await snapshotTree(harness.home), before);

  const customPrompt = Buffer.from('Custom prompt bytes: naïve 😀\nNo final replacement.', 'utf8');
  const piDirectory = path.join(harness.home, '.config', 'word-fixer', '.pi');
  await fs.mkdir(piDirectory, { recursive: true });
  await fs.writeFile(path.join(piDirectory, 'SYSTEM.md'), customPrompt);

  const install = runInstaller(harness);
  assert.equal(install.status, 0, install.stderr);
  assert.match(install.stdout, /Word Fixer installation check passed/);
  const installedSnapshot = await snapshotTree(harness.home);

  const check = runInstaller(harness, ['--check']);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /summonable plugin enablement: hazat\.word-fixer \(enabled overlay\)/);
  assert.match(check.stdout, /auth remains canonical only/);
  assert.deepEqual(await snapshotTree(harness.home), installedSnapshot);
});

test('two installs preserve custom prompt bytes and produce dedicated config plus source links', async (t) => {
  const harness = await createHarness(t);
  const piDirectory = path.join(harness.home, '.config', 'word-fixer', '.pi');
  const customPrompt = Buffer.from('Keep $(literal) <markup> 😀 exactly\r\nsecond line', 'utf8');
  await fs.mkdir(piDirectory, { recursive: true });
  await fs.writeFile(path.join(piDirectory, 'NATURAL.md'), customPrompt);

  const firstInstall = runInstaller(harness);
  assert.equal(firstInstall.status, 0, firstInstall.stderr);
  assert.deepEqual(await fs.readFile(path.join(piDirectory, 'NATURAL.md')), customPrompt);

  const customSettings = Buffer.from(`{
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-5.4-mini",
  "defaultThinkingLevel": "off",
  "modelThinkingLevels": {"openai-codex/gpt-5.4-mini": "off"},
  "customMarker": "preserve these bytes"
}\n`);
  await fs.writeFile(path.join(piDirectory, 'settings.json'), customSettings);
  const secondInstall = runInstaller(harness);
  assert.equal(secondInstall.status, 0, secondInstall.stderr);
  assert.deepEqual(await fs.readFile(path.join(piDirectory, 'NATURAL.md')), customPrompt);
  assert.deepEqual(await fs.readFile(path.join(piDirectory, 'settings.json')), customSettings);

  const configDirectory = path.join(harness.home, '.config', 'word-fixer');
  const config = JSON.parse(await fs.readFile(path.join(configDirectory, 'config.json'), 'utf8'));
  assert.equal(config.piBinaryPath, path.join(configDirectory, 'bin', 'pi'));
  const settings = JSON.parse(customSettings);
  assert.equal(settings.defaultProvider, 'openai-codex');
  assert.equal(settings.defaultModel, 'gpt-5.4-mini');
  assert.equal(settings.defaultThinkingLevel, 'off');
  assert.equal(await fs.readlink(path.join(harness.home, '.config', 'omarchy', 'plugins', 'hazat.word-fixer')), repositoryRoot);
  assert.equal(await fs.readlink(path.join(harness.binHome, 'word-fixer')), path.join(repositoryRoot, 'linux', 'bin', 'word-fixer'));
  assert.equal(await fs.access(path.join(piDirectory, 'auth.json')).then(() => true, () => false), false);
  assert.deepEqual(JSON.parse(await fs.readFile(harness.stateFile, 'utf8')), { discovered: true, enabled: true });

  const commandLog = await fs.readFile(harness.commandLog, 'utf8');
  assert.match(commandLog, /omarchy plugin validate/);
  assert.match(commandLog, /omarchy-shell shell rescanPlugins/);
  assert.equal((commandLog.match(/omarchy plugin enable hazat\.word-fixer/g) || []).length, 1);
});

test('missing command and unavailable dedicated model fail before installation mutations', async (t) => {
  const emptyHome = await fs.mkdtemp(path.join(os.tmpdir(), 'word-fixer-missing-prerequisite-'));
  t.after(() => fs.rm(emptyHome, { recursive: true, force: true }));
  const missingCommand = spawnSync(installer, [], {
    cwd: repositoryRoot,
    env: { HOME: emptyHome, PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
  });
  assert.notEqual(missingCommand.status, 0);
  assert.match(missingCommand.stderr, /required command 'pi' was not found on PATH/);
  assert.equal(await fs.access(path.join(emptyHome, '.config', 'word-fixer')).then(() => true, () => false), false);

  const harness = await createHarness(t, { modelAvailable: false });
  const before = await snapshotTree(harness.home);
  const missingModel = runInstaller(harness);
  assert.notEqual(missingModel.status, 0);
  assert.match(missingModel.stderr, /required model openai-codex\/gpt-5\.4-mini is unavailable; no fallback model will be used/);
  assert.deepEqual(await snapshotTree(harness.home), before);
});
