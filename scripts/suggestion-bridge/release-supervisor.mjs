import { resolve, join } from 'node:path';
import { readJson, writeJson, createOnce } from './journal.mjs';
import { ReleaseExecutor, ReleaseCheckError } from './release-executor.mjs';
const directory = resolve(process.argv[2]);
const spec = await readJson(join(directory, 'launch.json'));
if (!spec || !(await createOnce(join(directory, 'owner.json'), { pid: process.pid, at: Date.now() })))
  process.exit(1);
try {
  const executor = new ReleaseExecutor(spec.config, spec.job, join(directory, 'commands.log'));
  const manifest = spec.phase === 'prepare' ? await executor.prepare() : await executor.deploy();
  await writeJson(join(directory, 'result.json'), {
    state: spec.phase === 'prepare' ? 'prepared' : 'released',
    summary:
      spec.phase === 'prepare'
        ? 'Integrated and tested. Ready for you to deploy.'
        : 'Deployed to the household server. The updated Android package is available on the install page.',
    ...(spec.phase === 'prepare' ? { manifest } : {}),
  });
} catch (error) {
  await writeJson(join(directory, 'diagnostic.json'), { message: error.message, stack: error.stack });
  await writeJson(join(directory, 'result.json'), {
    state: spec.phase === 'prepare' ? 'failed' : 'uncertain',
    summary:
      spec.phase === 'deploy'
        ? 'Deployment needs host inspection. Some steps may have completed; no automatic retry will run. ' +
          (error instanceof ReleaseCheckError
            ? error.message
            : 'Diagnostic details are saved on the development host.')
        : error instanceof ReleaseCheckError
          ? error.message
          : 'Release checks did not finish. The running app is unchanged. Diagnostic details are saved on the development host.',
  });
}
