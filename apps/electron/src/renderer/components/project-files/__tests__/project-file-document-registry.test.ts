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
      await flushOpenProjectFile('project-a', 'a.md')
      expect(calls).toEqual(['a'])
      calls.length = 0
      await flushOpenProjectFilesForProject('project-b')
      expect(calls).toEqual(['b'])
      calls.length = 0
      await flushOpenProjectFiles()
      expect(calls.sort()).toEqual(['a', 'b'])
    } finally {
      unregisterA()
      unregisterB()
    }
  })
})
