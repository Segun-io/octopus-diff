import type { ConfigFlags } from '../args.js';
import { configJsonSchema } from '../config.js';
import type { CliDeps } from '../deps.js';
import { EXIT_OK } from '../errors.js';
import { loadContext } from '../settings.js';

/**
 * `octopus-diff config`: prints the config file path and its validated contents (paths resolved).
 * `--path` prints only the path; `--schema` prints the JSON Schema of the file.
 */
export async function runConfig(flags: ConfigFlags, deps: CliDeps): Promise<number> {
  if (flags.schema) {
    deps.stdout.write(`${JSON.stringify(configJsonSchema(), null, 2)}\n`);
    return EXIT_OK;
  }
  const { paths, loaded } = await loadContext(flags, { env: deps.env, cwd: deps.cwd });
  if (flags.path) {
    deps.stdout.write(`${loaded.path}\n`);
    return EXIT_OK;
  }
  const summary = {
    configFile: loaded.path,
    exists: loaded.exists,
    configDir: paths.configDir,
    stateDir: paths.stateDir,
    config: loaded.config,
  };
  deps.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return EXIT_OK;
}
