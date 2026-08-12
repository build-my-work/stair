import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PATH_PROCESSOR_MODULE = pathToFileURL(join(import.meta.dir, '..', 'path-processor.ts')).href;
const CONFIG_VALIDATOR_MODULE = pathToFileURL(join(import.meta.dir, '..', 'config-validator.ts')).href;

describe('产品配置路径识别', () => {
  it('识别显式配置目录内的应用配置文件', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'stair-config-recognition-'));

    try {
      const script = `
        import { PathProcessor } from '${PATH_PROCESSOR_MODULE}';
        import { ConfigValidator } from '${CONFIG_VALIDATOR_MODULE}';

        const processor = new PathProcessor();
        const validator = new ConfigValidator();
        const paths = {
          config: ${JSON.stringify(join(configDir, 'config.json'))},
          source: ${JSON.stringify(join(configDir, 'workspaces', 'workspace-a', 'sources', 'github', 'config.json'))},
          toolIcons: ${JSON.stringify(join(configDir, 'tool-icons', 'tool-icons.json'))},
        };

        console.log(JSON.stringify({
          processor: Object.values(paths).map((path) => processor.isConfigFile(path)),
          validator: Object.values(paths).map((path) => validator.isCraftAgentConfig(path)),
        }));
      `;
      const run = Bun.spawnSync([process.execPath, '--eval', script], {
        env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      expect(run.exitCode, run.stderr.toString()).toBe(0);
      expect(JSON.parse(run.stdout.toString())).toEqual({
        processor: [true, true, false],
        validator: [true, true, true],
      });
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
