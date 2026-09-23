import { describe, expect, it } from 'bun:test'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { globSync } from 'glob'
import { RPC_CHANNELS } from '../packages/shared/src/protocol/channels'
import {
  copyPiAgentServer,
  copyRipgrep,
  copySDK,
  type Arch,
  type BuildConfig,
  type Platform,
} from './build/common'
import {
  createStairEnvironment,
  STAIR_DEFAULT_VITE_PORT,
} from './stair-profile'

const REPO_ROOT = join(import.meta.dir, '..')
const CENTRAL_CONFIG_PATH = 'packages/shared/src/config/paths.ts'
const DYNAMIC_PERMISSIONS_PATH = 'packages/shared/src/agent/permissions-config.ts'

function writeExecutableHeader(
  filePath: string,
  platform: Platform,
  arch: Arch,
): void {
  if (platform === 'darwin') {
    const header = Buffer.alloc(32)
    header.writeUInt32LE(0xfeedfacf, 0)
    header.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4)
    writeFileSync(filePath, header)
    return
  }

  if (platform === 'win32') {
    const header = Buffer.alloc(128)
    header.write('MZ', 0)
    header.writeUInt32LE(0x40, 0x3c)
    header.write('PE\0\0', 0x40)
    header.writeUInt16LE(arch === 'arm64' ? 0xaa64 : 0x8664, 0x44)
    writeFileSync(filePath, header)
    return
  }

  const header = Buffer.alloc(64)
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
  header.writeUInt16LE(arch === 'arm64' ? 183 : 62, 18)
  writeFileSync(filePath, header)
}

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

  it('packaged 入口覆盖继承的 Craft 身份但保留验收配置目录', () => {
    const packagedRoot = mkdtempSync(join(tmpdir(), 'stair-packaged-entry-'))
    const entryPath = join(packagedRoot, 'stair-main.cjs')
    try {
      copyFileSync(join(REPO_ROOT, 'apps/electron/stair-main.cjs'), entryPath)
      mkdirSync(join(packagedRoot, 'dist'), { recursive: true })
      writeFileSync(
        join(packagedRoot, 'dist/main.cjs'),
        `const keys = [
          'CRAFT_APP_NAME',
          'CRAFT_CONFIG_DIR',
          'CRAFT_DEEPLINK_SCHEME',
          'CRAFT_APP_ICON',
          'CRAFT_DISABLE_AUTO_UPDATE',
        ];
        console.log('STAIR_PACKAGED_ENV:' + JSON.stringify(
          Object.fromEntries(keys.map(key => [key, process.env[key]])),
        ));`,
      )
      const run = Bun.spawnSync([process.execPath, entryPath], {
        env: {
          ...process.env,
          CRAFT_APP_NAME: 'Craft Agents',
          CRAFT_CONFIG_DIR: '/tmp/stair-acceptance',
          CRAFT_DEEPLINK_SCHEME: 'craftagents',
          CRAFT_APP_ICON: '/tmp/craft.png',
          CRAFT_DISABLE_AUTO_UPDATE: '0',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })

      expect(run.exitCode, run.stderr.toString()).toBe(0)
      const marker = 'STAIR_PACKAGED_ENV:'
      const line = run.stdout.toString().split(/\r?\n/u)
        .find(candidate => candidate.startsWith(marker))
      const env = JSON.parse(line!.slice(marker.length)) as Record<string, string>
      expect(env).toMatchObject({
        CRAFT_APP_NAME: 'Stair',
        CRAFT_CONFIG_DIR: '/tmp/stair-acceptance',
        CRAFT_DEEPLINK_SCHEME: 'stair',
        CRAFT_APP_ICON: join(realpathSync(packagedRoot), 'dist/resources/stair/icon.png'),
        CRAFT_DISABLE_AUTO_UPDATE: '1',
      })
    } finally {
      rmSync(packagedRoot, { recursive: true, force: true })
    }
  })
})

describe('Stair 开发构建监听', () => {
  it('初始构建并监听全部 Browser preload 入口', () => {
    const source = readFileSync(join(REPO_ROOT, 'scripts/electron-dev.ts'), 'utf8')
    for (const preload of [
      'apps/electron/src/preload/browser-toolbar.ts',
      'apps/electron/src/preload/browser-page.ts',
      'apps/electron/src/preload/browser-overlay.ts',
    ]) {
      expect(source).toContain(`entry: "${preload}"`)
    }
    expect(source).toContain('...PRELOAD_OUTPUTS.map(output => runEsbuild(output.entry, output.outfile))')
    expect(source).toContain('for (const output of PRELOAD_OUTPUTS)')
    expect(source).toContain('await context.watch()')
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
    expect(packagedEntry).toContain(
      "'dist', 'resources', 'stair', 'icon.png'",
    )
    expect(packagedEntry).toContain("process.env.CRAFT_APP_NAME = 'Stair'")
    expect(packagedEntry).toContain("process.env.CRAFT_DEEPLINK_SCHEME = 'stair'")
    expect(packagedEntry).toContain("process.env.CRAFT_DISABLE_AUTO_UPDATE = '1'")
    expect(packagedEntry).not.toContain('||=')

    const baseBuilderConfig = readFileSync(
      join(REPO_ROOT, 'apps/electron/electron-builder.yml'),
      'utf8',
    )
    expect(baseBuilderConfig).toContain('resources/bin/win32-arm64/**/*')
    expect(baseBuilderConfig).toContain('resources/bin/linux-arm64/**/*')
    expect(baseBuilderConfig).toContain('build/koffi/win32_${arch}/**/*')
    expect(baseBuilderConfig).toContain('from: resources/bin/win32-${arch}')
    expect(baseBuilderConfig).toContain('to: app/resources/bin/win32-${arch}')
  })

  it('把独立深链协议注入 Renderer 构建', () => {
    const viteConfig = readFileSync(
      join(REPO_ROOT, 'apps/electron/vite.config.ts'),
      'utf8',
    )

    expect(viteConfig).toContain('__APP_DEEP_LINK_SCHEME__')
    expect(viteConfig).toContain('CRAFT_DEEPLINK_SCHEME')
  })

  it('暂存并验证 packaged runtime 依赖', () => {
    const buildEntry = readFileSync(join(REPO_ROOT, 'scripts/stair-build.ts'), 'utf8')
    const commonBuild = readFileSync(join(REPO_ROOT, 'scripts/build/common.ts'), 'utf8')
    const downloadBun = commonBuild.slice(
      commonBuild.indexOf('export async function downloadBun'),
      commonBuild.indexOf('function findFileRecursive'),
    )
    expect(buildEntry).toContain('await downloadBun(buildConfig)')
    expect(buildEntry).toContain('await downloadUv(buildConfig)')
    expect(buildEntry).toContain('copySessionServer(buildConfig)')
    expect(buildEntry).toContain('copyPiAgentServer(buildConfig)')
    expect(buildEntry).toContain('copySDK(buildConfig)')
    expect(buildEntry).toContain('copyRipgrep(buildConfig)')
    expect(buildEntry).toContain('verifyMcpServersExist(buildConfig)')
    expect(buildEntry).toContain('verifySDKCopy(buildConfig)')
    expect(buildEntry).toContain('const archFlag = `--${arch}`')
    expect(buildEntry).toContain('...(hasExplicitArch ? [] : [archFlag])')
    expect(buildEntry).toContain('if (hasX64 && hasArm64)')
    expect(downloadBun).toContain('Expand-Archive')
    expect(downloadBun).toContain('$env:STAIR_BUN_ARCHIVE')
    expect(downloadBun).not.toContain("-LiteralPath '${zipPath}'")
    expect(downloadBun.match(/--http1\.1/g)).toHaveLength(2)
    expect(downloadBun.match(/--retry-all-errors/g)).toHaveLength(2)
    expect(downloadBun).toContain('gh release download')
    expect(downloadBun).toContain('--clobber')
    expect(commonBuild).toContain("'pack',")
    expect(commonBuild).toContain('`@anthropic-ai/${pkg}@${sdkVersion}`')
    expect(commonBuild).toContain("'--pack-destination'")

    const afterPack = require(join(
      REPO_ROOT,
      'apps/electron/scripts/afterPack.stair.cjs',
    )) as {
      verifyPackagedRuntimeDependencies: (
        resourcesPath: string,
        platform?: NodeJS.Platform,
        arch?: 'arm64' | 'x64',
      ) => void
    }
    expect(afterPack.verifyPackagedRuntimeDependencies).toBeFunction()

    const resourcesPath = mkdtempSync(join(tmpdir(), 'stair-packaged-runtime-'))
    try {
      expect(() => {
        afterPack.verifyPackagedRuntimeDependencies(resourcesPath, 'darwin', 'arm64')
      }).toThrow('claude-agent-sdk')

      const appModules = join(resourcesPath, 'app/node_modules')
      const sdkDir = join(appModules, '@anthropic-ai/claude-agent-sdk')
      const binaryDir = join(appModules, '@anthropic-ai/claude-agent-sdk-binary')
      const ripgrepDir = join(appModules, '@vscode/ripgrep/bin')
      mkdirSync(sdkDir, { recursive: true })
      mkdirSync(binaryDir, { recursive: true })
      mkdirSync(ripgrepDir, { recursive: true })
      writeFileSync(join(sdkDir, 'package.json'), '{}')
      expect(() => {
        afterPack.verifyPackagedRuntimeDependencies(resourcesPath, 'darwin', 'arm64')
      }).toThrow('sdk.mjs')
      writeFileSync(join(sdkDir, 'sdk.mjs'), '')
      writeFileSync(
        join(binaryDir, 'package.json'),
        JSON.stringify({ os: ['darwin'], cpu: ['x64'] }),
      )
      const claudeBinary = join(binaryDir, 'claude')
      writeFileSync(claudeBinary, '')
      writeExecutableHeader(join(ripgrepDir, 'rg'), 'darwin', 'arm64')

      expect(() => {
        afterPack.verifyPackagedRuntimeDependencies(resourcesPath, 'darwin', 'arm64')
      }).toThrow('icon.png')

      const iconDir = join(resourcesPath, 'app/dist/resources/stair')
      mkdirSync(iconDir, { recursive: true })
      writeFileSync(join(iconDir, 'icon.png'), 'png')

      expect(() => {
        afterPack.verifyPackagedRuntimeDependencies(resourcesPath, 'darwin', 'arm64')
      }).toThrow('does not match darwin-arm64')
      writeFileSync(
        join(binaryDir, 'package.json'),
        JSON.stringify({ os: ['darwin'], cpu: ['arm64'] }),
      )
      expect(() => {
        afterPack.verifyPackagedRuntimeDependencies(resourcesPath, 'darwin', 'arm64')
      }).toThrow('too small')
      truncateSync(claudeBinary, 50_000_000)

      expect(() => {
        afterPack.verifyPackagedRuntimeDependencies(resourcesPath, 'darwin', 'arm64')
      }).toThrow('session-mcp-server')
      const sessionServer = join(resourcesPath, 'app/resources/session-mcp-server/index.js')
      mkdirSync(join(sessionServer, '..'), { recursive: true })
      writeFileSync(sessionServer, 'session')
      expect(() => {
        afterPack.verifyPackagedRuntimeDependencies(resourcesPath, 'darwin', 'arm64')
      }).toThrow('pi-agent-server')

      const piServer = join(resourcesPath, 'app/resources/pi-agent-server/index.js')
      const koffiDir = join(resourcesPath, 'app/resources/pi-agent-server/node_modules/koffi')
      mkdirSync(koffiDir, { recursive: true })
      writeFileSync(piServer, 'pi')
      writeFileSync(join(koffiDir, 'package.json'), '{}')
      const darwinKoffi = join(koffiDir, 'build/koffi/darwin_arm64/koffi.node')
      mkdirSync(join(darwinKoffi, '..'), { recursive: true })
      writeFileSync(darwinKoffi, 'koffi')

      expect(() => {
        afterPack.verifyPackagedRuntimeDependencies(resourcesPath, 'darwin', 'arm64')
      }).toThrow('vendor/bun/bun')
      const bunBinary = join(resourcesPath, 'app/vendor/bun/bun')
      mkdirSync(join(bunBinary, '..'), { recursive: true })
      writeFileSync(bunBinary, 'bun')
      expect(() => {
        afterPack.verifyPackagedRuntimeDependencies(resourcesPath, 'darwin', 'arm64')
      }).toThrow('resources/bin/darwin-arm64/uv')

      const darwinUv = join(resourcesPath, 'app/resources/bin/darwin-arm64/uv')
      mkdirSync(join(darwinUv, '..'), { recursive: true })
      writeFileSync(darwinUv, 'uv')
      expect(() => {
        afterPack.verifyPackagedRuntimeDependencies(resourcesPath, 'darwin', 'arm64')
      }).toThrow('app/node_modules/koffi')

      const rootKoffi = join(resourcesPath, 'app/node_modules/koffi')
      mkdirSync(rootKoffi, { recursive: true })
      writeFileSync(join(rootKoffi, 'package.json'), '{}')
      const rootDarwinKoffi = join(rootKoffi, 'build/koffi/darwin_arm64/koffi.node')
      mkdirSync(join(rootDarwinKoffi, '..'), { recursive: true })
      writeFileSync(rootDarwinKoffi, 'koffi')
      expect(() => {
        afterPack.verifyPackagedRuntimeDependencies(resourcesPath, 'darwin', 'arm64')
      }).not.toThrow()

      writeExecutableHeader(join(ripgrepDir, 'rg'), 'darwin', 'x64')
      expect(() => {
        afterPack.verifyPackagedRuntimeDependencies(resourcesPath, 'darwin', 'arm64')
      }).toThrow('ripgrep binary does not match darwin-arm64')
      writeExecutableHeader(join(ripgrepDir, 'rg'), 'darwin', 'arm64')

      const claudeExe = join(binaryDir, 'claude.exe')
      writeFileSync(claudeExe, '')
      truncateSync(claudeExe, 50_000_000)
      writeExecutableHeader(join(ripgrepDir, 'rg.exe'), 'win32', 'x64')
      writeFileSync(
        join(binaryDir, 'package.json'),
        JSON.stringify({ os: ['win32'], cpu: ['x64'] }),
      )
      const winKoffi = join(koffiDir, 'build/koffi/win32_x64/koffi.node')
      mkdirSync(join(winKoffi, '..'), { recursive: true })
      writeFileSync(winKoffi, 'koffi')
      rmSync(bunBinary)
      const winBun = join(resourcesPath, 'vendor/bun/bun.exe')
      mkdirSync(join(winBun, '..'), { recursive: true })
      writeFileSync(winBun, 'bun')
      expect(() => {
        afterPack.verifyPackagedRuntimeDependencies(resourcesPath, 'win32', 'x64')
      }).toThrow('resources/bin/win32-x64/uv.exe')
      const winUv = join(resourcesPath, 'app/resources/bin/win32-x64/uv.exe')
      mkdirSync(join(winUv, '..'), { recursive: true })
      writeFileSync(winUv, 'uv')
      expect(() => {
        afterPack.verifyPackagedRuntimeDependencies(resourcesPath, 'win32', 'x64')
      }).toThrow('win32_x64')
      const rootWinKoffi = join(rootKoffi, 'build/koffi/win32_x64/koffi.node')
      mkdirSync(join(rootWinKoffi, '..'), { recursive: true })
      writeFileSync(rootWinKoffi, 'koffi')
      expect(() => {
        afterPack.verifyPackagedRuntimeDependencies(resourcesPath, 'win32', 'x64')
      }).not.toThrow()

      writeExecutableHeader(join(ripgrepDir, 'rg.exe'), 'win32', 'arm64')
      writeFileSync(
        join(binaryDir, 'package.json'),
        JSON.stringify({ os: ['win32'], cpu: ['arm64'] }),
      )
      const winArmKoffi = join(koffiDir, 'build/koffi/win32_arm64/koffi.node')
      mkdirSync(join(winArmKoffi, '..'), { recursive: true })
      writeFileSync(winArmKoffi, 'koffi')
      const rootWinArmKoffi = join(rootKoffi, 'build/koffi/win32_arm64/koffi.node')
      mkdirSync(join(rootWinArmKoffi, '..'), { recursive: true })
      writeFileSync(rootWinArmKoffi, 'koffi')
      const winArmUv = join(resourcesPath, 'app/resources/bin/win32-arm64/uv.exe')
      mkdirSync(join(winArmUv, '..'), { recursive: true })
      writeFileSync(winArmUv, 'uv')
      expect(() => {
        afterPack.verifyPackagedRuntimeDependencies(resourcesPath, 'win32', 'arm64')
      }).not.toThrow()

      writeExecutableHeader(join(ripgrepDir, 'rg'), 'linux', 'x64')
      writeFileSync(
        join(binaryDir, 'package.json'),
        JSON.stringify({ os: ['linux'], cpu: ['x64'] }),
      )
      const linuxKoffi = join(koffiDir, 'build/koffi/linux_x64/koffi.node')
      mkdirSync(join(linuxKoffi, '..'), { recursive: true })
      writeFileSync(linuxKoffi, 'koffi')
      const rootLinuxKoffi = join(rootKoffi, 'build/koffi/linux_x64/koffi.node')
      mkdirSync(join(rootLinuxKoffi, '..'), { recursive: true })
      writeFileSync(rootLinuxKoffi, 'koffi')
      writeFileSync(bunBinary, 'bun')
      const linuxUv = join(resourcesPath, 'app/resources/bin/linux-x64/uv')
      mkdirSync(join(linuxUv, '..'), { recursive: true })
      writeFileSync(linuxUv, 'uv')
      expect(() => {
        afterPack.verifyPackagedRuntimeDependencies(resourcesPath, 'linux', 'x64')
      }).not.toThrow()

      writeExecutableHeader(join(ripgrepDir, 'rg'), 'linux', 'arm64')
      writeFileSync(
        join(binaryDir, 'package.json'),
        JSON.stringify({ os: ['linux'], cpu: ['arm64'] }),
      )
      const linuxArmKoffi = join(koffiDir, 'build/koffi/linux_arm64/koffi.node')
      mkdirSync(join(linuxArmKoffi, '..'), { recursive: true })
      writeFileSync(linuxArmKoffi, 'koffi')
      const rootLinuxArmKoffi = join(rootKoffi, 'build/koffi/linux_arm64/koffi.node')
      mkdirSync(join(rootLinuxArmKoffi, '..'), { recursive: true })
      writeFileSync(rootLinuxArmKoffi, 'koffi')
      const linuxArmUv = join(resourcesPath, 'app/resources/bin/linux-arm64/uv')
      mkdirSync(join(linuxArmUv, '..'), { recursive: true })
      writeFileSync(linuxArmUv, 'uv')
      expect(() => {
        afterPack.verifyPackagedRuntimeDependencies(resourcesPath, 'linux', 'arm64')
      }).not.toThrow()
    } finally {
      rmSync(resourcesPath, { recursive: true, force: true })
    }
  })

  it('跨架构构建会重新暂存目标架构的 ripgrep', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'stair-ripgrep-source-'))
    const electronDir = mkdtempSync(join(tmpdir(), 'stair-ripgrep-electron-'))
    const platform = process.platform as Platform
    const targetArch: Arch = process.arch === 'arm64' ? 'x64' : 'arm64'
    const binaryName = platform === 'win32' ? 'rg.exe' : 'rg'
    const source = join(rootDir, 'node_modules/@vscode/ripgrep')

    try {
      mkdirSync(join(source, 'bin'), { recursive: true })
      mkdirSync(join(source, 'lib'), { recursive: true })
      writeFileSync(join(source, 'package.json'), '{}')
      writeFileSync(join(source, 'bin', binaryName), process.arch)
      writeFileSync(
        join(source, 'lib/postinstall.js'),
        `require('node:fs').writeFileSync(require('node:path').join(__dirname, '../bin/${binaryName}'), process.env.npm_config_arch)`,
      )

      copyRipgrep({
        platform,
        arch: targetArch,
        upload: false,
        uploadLatest: false,
        uploadScript: false,
        rootDir,
        electronDir,
      } satisfies BuildConfig)

      expect(
        readFileSync(
          join(electronDir, 'node_modules/@vscode/ripgrep/bin', binaryName),
          'utf8',
        ),
      ).toBe(targetArch)
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
      rmSync(electronDir, { recursive: true, force: true })
    }
  })

  it('跨架构构建只暂存与核心 SDK 同版本的目标 Claude runtime', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'stair-sdk-source-'))
    const electronDir = mkdtempSync(join(tmpdir(), 'stair-sdk-electron-'))
    const platform = process.platform as Platform
    const targetArch: Arch = process.arch === 'arm64' ? 'x64' : 'arm64'
    const packageName = `claude-agent-sdk-${platform}-${targetArch}`
    const sdkSource = join(rootDir, 'node_modules/@anthropic-ai/claude-agent-sdk')
    const binarySource = join(rootDir, 'node_modules/@anthropic-ai', packageName)
    const binaryName = platform === 'win32' ? 'claude.exe' : 'claude'

    try {
      mkdirSync(sdkSource, { recursive: true })
      mkdirSync(binarySource, { recursive: true })
      writeFileSync(join(sdkSource, 'package.json'), JSON.stringify({ version: '1.2.3' }))
      writeFileSync(join(sdkSource, 'sdk.mjs'), 'sdk')
      writeFileSync(
        join(binarySource, 'package.json'),
        JSON.stringify({ version: '1.2.2', os: [platform], cpu: [targetArch] }),
      )
      writeFileSync(join(binarySource, binaryName), targetArch)

      const config = {
        platform,
        arch: targetArch,
        upload: false,
        uploadLatest: false,
        uploadScript: false,
        rootDir,
        electronDir,
      } satisfies BuildConfig

      expect(() => copySDK(config)).toThrow('does not match')
      writeFileSync(
        join(binarySource, 'package.json'),
        JSON.stringify({ version: '1.2.3', os: [platform], cpu: [targetArch] }),
      )
      copySDK(config)

      const staged = join(
        electronDir,
        'node_modules/@anthropic-ai/claude-agent-sdk-binary',
      )
      expect(JSON.parse(readFileSync(join(staged, 'package.json'), 'utf8'))).toMatchObject({
        version: '1.2.3',
        os: [platform],
        cpu: [targetArch],
      })
      expect(readFileSync(join(staged, binaryName), 'utf8')).toBe(targetArch)
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
      rmSync(electronDir, { recursive: true, force: true })
    }
  })

  it('连续构建只保留目标架构的 Pi native runtime', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'stair-pi-source-'))
    const electronDir = mkdtempSync(join(tmpdir(), 'stair-pi-electron-'))
    const piDist = join(rootDir, 'packages/pi-agent-server/dist')
    const koffi = join(rootDir, 'node_modules/koffi')

    try {
      mkdirSync(piDist, { recursive: true })
      mkdirSync(koffi, { recursive: true })
      writeFileSync(join(piDist, 'index.js'), 'pi')
      writeFileSync(join(koffi, 'package.json'), '{}')
      for (const arch of ['arm64', 'x64'] as const) {
        const nativeDir = join(koffi, `build/koffi/darwin_${arch}`)
        mkdirSync(nativeDir, { recursive: true })
        writeFileSync(join(nativeDir, 'koffi.node'), arch)
      }

      const config = {
        platform: 'darwin',
        upload: false,
        uploadLatest: false,
        uploadScript: false,
        rootDir,
        electronDir,
      } as const
      copyPiAgentServer({ ...config, arch: 'arm64' })
      copyPiAgentServer({ ...config, arch: 'x64' })

      const packagedKoffi = join(
        electronDir,
        'resources/pi-agent-server/node_modules/koffi/build/koffi',
      )
      expect(existsSync(join(packagedKoffi, 'darwin_arm64'))).toBe(false)
      expect(existsSync(join(packagedKoffi, 'darwin_x64/koffi.node'))).toBe(true)

      rmSync(join(piDist, 'index.js'))
      copyPiAgentServer({ ...config, arch: 'arm64' })
      expect(
        existsSync(join(electronDir, 'resources/pi-agent-server')),
      ).toBe(false)
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
      rmSync(electronDir, { recursive: true, force: true })
    }
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
