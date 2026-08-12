import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { globSync } from 'glob'
import { RPC_CHANNELS } from '../packages/shared/src/protocol/channels'
import {
  createStairEnvironment,
  STAIR_DEFAULT_VITE_PORT,
} from './stair-profile'

const REPO_ROOT = join(import.meta.dir, '..')
const CENTRAL_CONFIG_PATH = 'packages/shared/src/config/paths.ts'
const DYNAMIC_PERMISSIONS_PATH = 'packages/shared/src/agent/permissions-config.ts'

function moduleUrl(path: string): string {
  return pathToFileURL(join(REPO_ROOT, path)).href
}

describe('Stair 脚本环境', () => {
  it('提供固定产品身份和独立默认值', () => {
    const env = createStairEnvironment(
      { PATH: '/usr/bin' },
      REPO_ROOT,
      '/Users/test',
    )

    expect(env.CRAFT_APP_NAME).toBe('Stair')
    expect(env.VITE_APP_NAME).toBe('Stair')
    expect(env.CRAFT_CONFIG_DIR).toBe('/Users/test/.stair')
    expect(env.CRAFT_VITE_PORT).toBe(STAIR_DEFAULT_VITE_PORT)
    expect(env.CRAFT_DEEPLINK_SCHEME).toBe('stair')
    expect(env.CRAFT_DISABLE_AUTO_UPDATE).toBe('1')
    expect(env.CRAFT_APP_ICON).toBe(
      join(REPO_ROOT, 'apps/electron/resources/stair/icon.png'),
    )
  })

  it('允许验收覆盖配置目录和端口，但不覆盖产品身份', () => {
    const env = createStairEnvironment(
      {
        CRAFT_APP_NAME: 'Craft Agents',
        CRAFT_CONFIG_DIR: '/tmp/stair-acceptance',
        CRAFT_VITE_PORT: '6193',
        CRAFT_DEEPLINK_SCHEME: 'craftagents',
      },
      REPO_ROOT,
      '/Users/test',
    )

    expect(env.CRAFT_APP_NAME).toBe('Stair')
    expect(env.CRAFT_CONFIG_DIR).toBe('/tmp/stair-acceptance')
    expect(env.CRAFT_VITE_PORT).toBe('6193')
    expect(env.CRAFT_DEEPLINK_SCHEME).toBe('stair')
  })
})

describe('Stair 构建入口', () => {
  it('提供开发、构建和打包入口以及独立资源', () => {
    const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
    expect(packageJson.scripts['stair:dev']).toBe('bun run scripts/stair-dev.ts')
    expect(packageJson.scripts['stair:build']).toBe('bun run scripts/stair-build.ts --dir')
    expect(packageJson.scripts['stair:dist']).toBe('bun run scripts/stair-build.ts')

    for (const path of [
      'apps/electron/electron-builder.stair.yml',
      'apps/electron/stair-main.cjs',
      'apps/electron/resources/stair/icon.svg',
      'apps/electron/resources/stair/icon.png',
      'apps/electron/resources/stair/icon.icns',
      'apps/electron/resources/stair/icon.ico',
      'apps/electron/resources/stair/dmg-background.tiff',
    ]) {
      expect(existsSync(join(REPO_ROOT, path)), path).toBe(true)
    }

    const builderConfig = readFileSync(
      join(REPO_ROOT, 'apps/electron/electron-builder.stair.yml'),
      'utf8',
    )
    expect(builderConfig).toContain('appId: io.github.build-my-work.stair')
    expect(builderConfig).toContain('productName: Stair')
    expect(builderConfig).toContain('publish: null')
    expect(builderConfig).toContain('protocols:')
    expect(builderConfig).toContain('- stair')

    const packagedEntry = readFileSync(
      join(REPO_ROOT, 'apps/electron/stair-main.cjs'),
      'utf8',
    )
    expect(packagedEntry).toContain('CRAFT_APP_ICON')
    expect(packagedEntry).toContain("dist', 'resources', 'stair'")
  })

  it('把独立深链协议注入 Renderer 构建', () => {
    const viteConfig = readFileSync(
      join(REPO_ROOT, 'apps/electron/vite.config.ts'),
      'utf8',
    )

    expect(viteConfig).toContain('__APP_DEEP_LINK_SCHEME__')
    expect(viteConfig).toContain('CRAFT_DEEPLINK_SCHEME')
  })
})

describe('产品数据目录边界', () => {
  it('Renderer 通过本地主进程读取产品配置目录', () => {
    expect((RPC_CHANNELS.system as Record<string, string>).CONFIG_DIR).toBe(
      'system:configDir',
    )
  })

  it('产品路径消费者不再写死 Craft 数据目录', () => {
    const runtimeConsumers = [
      'apps/electron/src/renderer/components/ui/EditPopover.tsx',
      'apps/electron/src/renderer/components/workspace/AddWorkspaceStep_ConnectRemote.tsx',
      'apps/electron/src/renderer/components/workspace/AddWorkspaceStep_CreateNew.tsx',
      'apps/electron/src/renderer/pages/settings/AppearanceSettingsPage.tsx',
      'apps/electron/src/renderer/pages/settings/PermissionsSettingsPage.tsx',
      'packages/shared/src/agent/core/config-validator.ts',
      'packages/shared/src/agent/core/path-processor.ts',
      'packages/shared/src/agent/mode-manager.ts',
      'packages/shared/src/config/validators.ts',
      'packages/shared/src/docs/doc-links.ts',
      'packages/shared/src/docs/index.ts',
      ...globSync('packages/shared/src/i18n/locales/*.json', { cwd: REPO_ROOT }),
    ]

    const offenders = runtimeConsumers.filter((path) =>
      readFileSync(join(REPO_ROOT, path), 'utf8').includes('.craft-agent'),
    )

    expect(offenders).toEqual([])
  })

  it('生产代码只能通过集中配置定义默认 .craft-agent 路径', () => {
    const sourceFiles = globSync(
      [
        'apps/electron/src/**/*.{ts,tsx,cjs}',
        'packages/server-core/src/**/*.{ts,tsx,cjs}',
        'packages/shared/src/**/*.{ts,tsx,cjs}',
        'scripts/**/*.{ts,tsx,cjs}',
      ],
      {
        cwd: REPO_ROOT,
        ignore: ['**/__tests__/**', '**/*.test.ts', '**/dist/**'],
      },
    )
    const allowedFiles = new Set([
      CENTRAL_CONFIG_PATH,
      // This function intentionally reads the env dynamically for tests that
      // switch CRAFT_CONFIG_DIR after importing the module.
      DYNAMIC_PERMISSIONS_PATH,
    ])
    const hardcodedDefault = /(?:join|resolve)\([\s\S]{0,80}?homedir\(\)[\s\S]{0,80}?['"]\.craft-agent['"]/u

    const offenders = sourceFiles
      .filter((path) => !allowedFiles.has(path))
      .filter((path) => hardcodedDefault.test(readFileSync(join(REPO_ROOT, path), 'utf8')))
      .sort()

    expect(offenders).toEqual([])
  })

  it('显式配置目录承载全部关键用户状态', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'stair-data-boundary-'))

    try {
      const script = `
        import { existsSync } from 'node:fs';
        import { join } from 'node:path';
        import { CONFIG_DIR } from '${moduleUrl(CENTRAL_CONFIG_PATH)}';
        import { getDefaultWorkspacesDir } from '${moduleUrl('packages/shared/src/workspaces/storage.ts')}';
        import { APP_ROOT, getDocsDir, initializeDocs } from '${moduleUrl('packages/shared/src/docs/index.ts')}';
        import { initializeReleaseNotes } from '${moduleUrl('packages/shared/src/release-notes/index.ts')}';
        import { CONFIG_FILE, LOG_DIR } from '${moduleUrl('packages/shared/src/interceptor-common.ts')}';
        import { SecureStorageBackend } from '${moduleUrl('packages/shared/src/credentials/backends/secure-storage.ts')}';
        import { PrivilegedExecutionBroker } from '${moduleUrl('packages/server-core/src/services/privileged-execution-broker.ts')}';
        import {
          autoUpdateLogPath,
          getLogFilePath,
          messagingGatewayLogPath,
        } from '${moduleUrl('apps/electron/src/main/logger.ts')}';
        import {
          saveWindowState,
          WINDOW_STATE_FILE,
        } from '${moduleUrl('apps/electron/src/main/window-state.ts')}';

        initializeDocs();
        initializeReleaseNotes();
        saveWindowState({ windows: [] });

        const credentials = new SecureStorageBackend();
        await credentials.set(
          { type: 'llm_api_key', connectionSlug: 'stair-isolation-test' },
          { value: 'test-secret' },
        );

        const audit = new PrivilegedExecutionBroker({ warn() {} });
        audit.auditEvent('stair_isolation_test', {});
        await Bun.sleep(100);

        console.log('STAIR_DATA_BOUNDARY:' + JSON.stringify({
          configDir: CONFIG_DIR,
          appRoot: APP_ROOT,
          workspaceDir: getDefaultWorkspacesDir(),
          docsDir: getDocsDir(),
          configFile: CONFIG_FILE,
          interceptorLogDir: LOG_DIR,
          mainLogPath: getLogFilePath(),
          messagingLogPath: messagingGatewayLogPath,
          autoUpdateLogPath,
          windowStatePath: WINDOW_STATE_FILE,
          credentialFileExists: existsSync(join(CONFIG_DIR, 'credentials.enc')),
          windowStateFileExists: existsSync(WINDOW_STATE_FILE),
          releaseNotesDirExists: existsSync(join(CONFIG_DIR, 'release-notes')),
          auditLogExists: existsSync(join(CONFIG_DIR, 'logs', 'privileged-actions.jsonl')),
        }));
      `
      const run = Bun.spawnSync([process.execPath, '--eval', script], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          CRAFT_CONFIG_DIR: configDir,
          CRAFT_IS_PACKAGED: 'false',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })

      expect(run.exitCode, run.stderr.toString()).toBe(0)
      const output = run.stdout.toString()
      const marker = 'STAIR_DATA_BOUNDARY:'
      const resultLine = output.split(/\r?\n/u).find((line) => line.startsWith(marker))
      expect(resultLine, output).toBeDefined()
      expect(JSON.parse(resultLine!.slice(marker.length))).toEqual({
        configDir,
        appRoot: configDir,
        workspaceDir: join(configDir, 'workspaces'),
        docsDir: join(configDir, 'docs'),
        configFile: join(configDir, 'config.json'),
        interceptorLogDir: join(configDir, 'logs'),
        mainLogPath: join(configDir, 'logs', 'main.log'),
        messagingLogPath: join(configDir, 'logs', 'messaging-gateway.log'),
        autoUpdateLogPath: join(configDir, 'logs', 'auto-update.log'),
        windowStatePath: join(configDir, 'window-state.json'),
        credentialFileExists: true,
        windowStateFileExists: true,
        releaseNotesDirExists: true,
        auditLogExists: true,
      })
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})

describe('产品深链边界', () => {
  it('用户入口不再写死 Craft 协议', () => {
    const runtimeConsumers = [
      'apps/electron/src/main/handlers/workspace.ts',
      'apps/electron/src/renderer/components/app-shell/SidebarMenu.tsx',
      'apps/electron/src/renderer/components/app-shell/SkillsListPanel.tsx',
      'apps/electron/src/renderer/components/app-shell/SourcesListPanel.tsx',
      'apps/electron/src/renderer/components/ui/EditPopover.tsx',
      'apps/electron/src/renderer/components/ui/HeaderMenu.tsx',
      'apps/electron/src/renderer/pages/ChatPage.tsx',
      'apps/electron/src/renderer/pages/settings/SettingsNavigator.tsx',
      'apps/electron/src/renderer/pages/SkillInfoPage.tsx',
      'apps/electron/src/renderer/pages/SourceInfoPage.tsx',
    ]

    const offenders = runtimeConsumers.filter((path) =>
      readFileSync(join(REPO_ROOT, path), 'utf8').includes('craftagents://'),
    )

    expect(offenders).toEqual([])
  })
})
