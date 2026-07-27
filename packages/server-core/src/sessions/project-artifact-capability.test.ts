import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { createProject, getProjectArtifact, saveProjectArtifact } from '@craft-agent/shared/projects'
import { saveSession } from '@craft-agent/shared/sessions'

import { saveSessionProjectArtifact } from './project-artifact-capability'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('session project artifact capability', () => {
  it('injects the trusted Project and source Session and replaces model reference fields with persisted user data', async () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'session-artifact-'))
    roots.push(workspaceRootPath)
    const project = createProject(workspaceRootPath, { name: 'Operating Systems' })
    const trustedReference = {
      projectId: project.id,
      path: '操作系统导论（异步图书） .epub',
      quote: '进程就是运行中的程序。',
      locator: { type: 'epub-cfi' as const, cfiRange: 'epubcfi(/6/4!/4/2:0,/4/2:8)' },
    }
    await saveSession({
      id: 'session-main',
      workspaceRootPath,
      createdAt: 1,
      lastUsedAt: 1,
      projectId: project.id,
      messages: [{
        id: 'message-user',
        type: 'user',
        content: '请整理这段内容',
        references: [{
          kind: 'web-selection',
          url: 'https://example.com/processes',
          title: 'Processes on the web',
          quote: 'A process is a running program.',
          locator: {
            type: 'text-quote',
            exact: 'A process is a running program.',
          },
        }, trustedReference],
      }],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
    })

    const result = await saveSessionProjectArtifact({
      workspaceRootPath,
      sessionId: 'session-main',
      projectId: project.id,
    }, {
      title: '进程学习笔记',
      markdown: '# 进程',
      references: [{
        path: trustedReference.path,
        quote: '模型伪造的引文',
        locator: trustedReference.locator,
      }],
    })

    expect(result.projectId).toBe(project.id)
    const stored = getProjectArtifact(workspaceRootPath, project.slug, result.artifactId)
    expect(stored?.sourceSessionId).toBe('session-main')
    expect(stored?.references[0]).toEqual(trustedReference)
  })

  it('rejects references that do not exactly match a persisted user-message path and locator', async () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'session-artifact-'))
    roots.push(workspaceRootPath)
    const project = createProject(workspaceRootPath, { name: 'Operating Systems' })
    await saveSession({
      id: 'session-main',
      workspaceRootPath,
      createdAt: 1,
      lastUsedAt: 1,
      projectId: project.id,
      messages: [{
        id: 'message-user',
        type: 'user',
        content: '请整理这段内容',
        references: [{
          projectId: project.id,
          path: 'books/os.epub',
          quote: '可信引文',
          locator: { type: 'epub-cfi', cfiRange: 'epubcfi(/6/4!/4/2:0)' },
        }],
      }, {
        id: 'message-assistant',
        type: 'assistant',
        content: '非用户引用不应被信任',
        references: [{
          projectId: project.id,
          path: 'books/assistant.epub',
          quote: '不可信',
          locator: { type: 'epub-cfi', cfiRange: 'epubcfi(/6/8!/4/2:0)' },
        }],
      }],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
    })

    const baseInput = {
      title: '进程学习笔记',
      markdown: '# 进程',
    }
    await expect(saveSessionProjectArtifact({
      workspaceRootPath,
      sessionId: 'session-main',
      projectId: project.id,
    }, {
      ...baseInput,
      references: [{
        path: 'books/os.epub',
        locator: { type: 'epub-cfi', cfiRange: 'epubcfi(/6/4!/4/2:1)' },
      }],
    })).rejects.toThrow(/not backed by a trusted/i)

    await expect(saveSessionProjectArtifact({
      workspaceRootPath,
      sessionId: 'session-main',
      projectId: project.id,
    }, {
      ...baseInput,
      references: [{
        path: 'books/renamed-os.epub',
        locator: { type: 'epub-cfi', cfiRange: 'epubcfi(/6/4!/4/2:0)' },
      }],
    })).rejects.toThrow(/not backed by a trusted/i)

    await expect(saveSessionProjectArtifact({
      workspaceRootPath,
      sessionId: 'session-main',
      projectId: project.id,
    }, {
      ...baseInput,
      references: [{
        path: 'books/assistant.epub',
        locator: { type: 'epub-cfi', cfiRange: 'epubcfi(/6/8!/4/2:0)' },
      }],
    })).rejects.toThrow(/not backed by a trusted/i)
  })

  it('refuses to save without a live Project binding', async () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'session-artifact-'))
    roots.push(workspaceRootPath)
    await expect(saveSessionProjectArtifact({
      workspaceRootPath,
      sessionId: 'session-main',
      projectId: 'missing-project',
    }, {
      title: 'No target',
      markdown: '',
      references: [],
    })).rejects.toThrow('Project missing-project not found')
  })

  it('keeps the creating Session as the source when another Session updates it', async () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'session-artifact-'))
    roots.push(workspaceRootPath)
    const project = createProject(workspaceRootPath, { name: 'Operating Systems' })

    const created = await saveSessionProjectArtifact({
      workspaceRootPath,
      sessionId: 'side-chat',
      projectId: project.id,
    }, {
      title: 'Original note',
      markdown: '# Original',
      references: [],
    })
    await saveSessionProjectArtifact({
      workspaceRootPath,
      sessionId: 'main-chat',
      projectId: project.id,
    }, {
      artifactId: created.artifactId,
      title: 'Revised note',
      markdown: '# Revised',
      references: [],
    })

    expect(getProjectArtifact(workspaceRootPath, project.slug, created.artifactId))
      .toMatchObject({ sourceSessionId: 'side-chat', title: 'Revised note' })
  })

  it('records the creating Session when the first save supplies an explicit Artifact id', async () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'session-artifact-'))
    roots.push(workspaceRootPath)
    const project = createProject(workspaceRootPath, { name: 'Operating Systems' })
    const artifactId = 'artifact_explicit-note'

    await saveSessionProjectArtifact({
      workspaceRootPath,
      sessionId: 'creator-session',
      projectId: project.id,
    }, {
      artifactId,
      title: 'Original note',
      markdown: '# Original',
      references: [],
    })
    await saveSessionProjectArtifact({
      workspaceRootPath,
      sessionId: 'updater-session',
      projectId: project.id,
    }, {
      artifactId,
      title: 'Revised note',
      markdown: '# Revised',
      references: [],
    })

    expect(getProjectArtifact(workspaceRootPath, project.slug, artifactId))
      .toMatchObject({ sourceSessionId: 'creator-session', title: 'Revised note' })
  })

  it('allows an update to retain an existing trusted Artifact reference', async () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'session-artifact-'))
    roots.push(workspaceRootPath)
    const project = createProject(workspaceRootPath, { name: 'Operating Systems' })
    const trustedReference = {
      projectId: project.id,
      path: 'books/os.epub',
      quote: '已保存的可信引文',
      locator: { type: 'epub-cfi' as const, cfiRange: 'epubcfi(/6/4!/4/2:0)' },
    }
    const created = await saveSessionProjectArtifact({
      workspaceRootPath,
      sessionId: 'creator-session',
      projectId: project.id,
    }, {
      title: 'Original note',
      markdown: '# Original',
      references: [],
    })
    // Seed the trusted reference through the regular Project storage API to model
    // an Artifact that was created from an earlier, now-unavailable Session.
    saveProjectArtifact(workspaceRootPath, project.slug, {
      id: created.artifactId,
      title: 'Original note',
      markdown: '# Original',
      references: [trustedReference],
    })

    await saveSessionProjectArtifact({
      workspaceRootPath,
      sessionId: 'updater-session',
      projectId: project.id,
    }, {
      artifactId: created.artifactId,
      title: 'Revised note',
      markdown: '# Revised',
      references: [{
        path: trustedReference.path,
        quote: '模型伪造的更新引文',
        locator: trustedReference.locator,
      }],
    })

    expect(getProjectArtifact(workspaceRootPath, project.slug, created.artifactId)?.references)
      .toEqual([trustedReference])
  })
})
