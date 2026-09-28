import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { boundedInput, choiceKeys, runBoundedProcess } from './filing-codex-provider.js';

/** Runs ONLY inside the separately provisioned isolation boundary. No household mounts. */
export async function runFilingCodex(
  request: unknown,
  options: {
    executable: string;
    home: string;
    temporaryRoot: string;
    signal: AbortSignal;
  },
  execute = runBoundedProcess,
) {
  const r = request as { version: number; input: unknown; model: string; effort: string };
  if (
    !r ||
    r.version !== 1 ||
    typeof r.model !== 'string' ||
    !/^[a-zA-Z0-9._-]{1,100}$/.test(r.model) ||
    !['low', 'medium', 'high'].includes(r.effort) ||
    ![options.executable, options.home, options.temporaryRoot].every(isAbsolute)
  )
    throw new Error('Invalid worker request');
  const input = boundedInput(r.input);
  const directory = await mkdtemp(join(options.temporaryRoot, 'filing-'));
  try {
    const schema = join(directory, 'response.schema.json');
    await writeFile(
      schema,
      JSON.stringify({
        type: 'object',
        additionalProperties: false,
        required: ['keys'],
        properties: {
          keys: {
            type: 'array',
            maxItems: 3,
            items: { type: 'string', enum: input.choices.map((c) => c.key) },
          },
        },
      }),
      { mode: 0o600 },
    );
    const args = [
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--color',
      'never',
      '--model',
      r.model,
      '--output-schema',
      schema,
      '-c',
      'approval_policy="never"',
      '-c',
      `model_reasoning_effort="${r.effort}"`,
      '-c',
      'web_search="disabled"',
    ];
    for (const feature of [
      'shell_tool',
      'unified_exec',
      'apps',
      'plugins',
      'browser_use',
      'computer_use',
      'in_app_browser',
      'multi_agent',
      'memories',
      'codex_hooks',
      'image_generation',
      'tool_search',
      'tool_suggest',
    ]) {
      args.push('--disable', feature);
    }
    args.push('-');
    const env: NodeJS.ProcessEnv = {
      CODEX_HOME: options.home,
      HOME: options.home,
      USERPROFILE: options.home,
      TMPDIR: directory,
      TEMP: directory,
      TMP: directory,
      ...(process.env['SystemRoot'] ? { SystemRoot: process.env['SystemRoot'] } : {}),
    };
    const output = await execute(
      options.executable,
      args,
      JSON.stringify(input),
      directory,
      env,
      options.signal,
    );
    return { keys: choiceKeys(JSON.parse(output), input) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
