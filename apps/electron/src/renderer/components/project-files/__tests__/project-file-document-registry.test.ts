import { describe, expect, it } from 'bun:test'
import {
  flushOpenProjectFile,
  flushOpenProjectFiles,
  flushOpenProjectFilesForProject,
  registerOpenProjectFileDocument,
} from '../project-file-document-registry'

describe('Project 文档注册表', () => {
  it('可以按文件、Project 和窗口范围 flush', async () => {
    const calls: string[] = []
    const unregisterA = registerOpenProjectFileDocument('project-a', 'a.md', {
      flush: async () => { calls.push('a') },
    })
    const unregisterB = registerOpenProjectFileDocument('project-b', 'b.md', {
      flush: async () => { calls.push('b') },
    })

    try {
      await expect(flushOpenProjectFile('project-a', 'a.md')).resolves.toBe('idle')
      expect(calls).toEqual(['a'])
      calls.length = 0
      await expect(flushOpenProjectFilesForProject('project-b')).resolves.toBe('idle')
      expect(calls).toEqual(['b'])
      calls.length = 0
      await expect(flushOpenProjectFiles()).resolves.toBe('idle')
      expect(calls.sort()).toEqual(['a', 'b'])
    } finally {
      unregisterA()
      unregisterB()
    }
  })

  it('propagates Drawnix image-wait timeout from any open document', async () => {
    const unregister = registerOpenProjectFileDocument('project-a', 'map.drawnix', {
      flush: async () => 'timeout',
    })
    try {
      await expect(flushOpenProjectFiles()).resolves.toBe('timeout')
      await expect(flushOpenProjectFilesForProject('project-a')).resolves.toBe('timeout')
      await expect(flushOpenProjectFile('project-a', 'map.drawnix')).resolves.toBe('timeout')
    } finally {
      unregister()
    }
  })
})

