#!/usr/bin/env node
import {
  fixText,
  loadPiServices,
  loadWordFixerConfig,
} from '../helper/helper-lib.mjs';

const prompt = process.argv[2] ?? 'helo wrld';
const config = await loadWordFixerConfig();
const log = {
  async log(message, extra = undefined) {
    console.log(new Date().toISOString(), message, extra ?? '');
  },
};

console.log(new Date().toISOString(), 'starting direct SDK test');
console.log(new Date().toISOString(), 'dataDir', config.dataDir);
console.log(new Date().toISOString(), 'piDir', config.piDir);
console.log(new Date().toISOString(), 'prompt', JSON.stringify(prompt));

const services = await loadPiServices({
  piDir: config.piDir,
  dataDir: config.dataDir,
  cwd: process.cwd(),
  log,
});
const result = await fixText({ services, text: prompt, cwd: process.cwd(), log });
console.log(new Date().toISOString(), 'result', JSON.stringify(result.text));
console.log(new Date().toISOString(), 'cost', result.cost ?? null);
