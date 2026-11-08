import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { helpText } from '../src/cli.js';
import { parseConfig } from '../src/config.js';

const readmePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../README.md');

describe('README stays accurate', () => {
  it('has a config example that the schema accepts', async () => {
    const readme = await readFile(readmePath, 'utf8');
    const block = /```jsonc\n([\s\S]*?)```/.exec(readme)?.[1];
    expect(block).toBeDefined();
    const json = (block ?? '').replace(/\s+\/\/.*$/gm, '');
    expect(() => parseConfig(JSON.parse(json), '/c/config.json', '/h')).not.toThrow();
  });

  it('documents every serve option that the CLI accepts', async () => {
    const readme = await readFile(readmePath, 'utf8');
    const options = [...(helpText('serve') ?? '').matchAll(/--([a-z-]+)/g)].map((m) => m[1]);
    for (const option of new Set(options)) expect(readme).toContain(`--${option}`);
  });
});
