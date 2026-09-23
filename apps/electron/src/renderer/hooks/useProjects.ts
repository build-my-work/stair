/**
 * useProjects
 *
 * Loads workspace-scoped projects and keeps them in sync via the
 * `projects:changed` broadcast. Mirrors the lightweight half of `useAutomations`.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useSetAtom } from 'jotai'
import { projectsAtom } from '@/atoms/projects'
import type { LoadedProject } from '@craft-agent/shared/projects/types'

export interface UseProjectsResult {
  projects: LoadedProject[]
  loaded: boolean
  refresh: () => Promise<void>
}

export function useProjects(activeWorkspaceId: string | null | undefined): UseProjectsResult {
  const [projects, setProjects] = useState<LoadedProject[]>([])
  const [loadedWorkspaceId, setLoadedWorkspaceId] = useState<string | null>()
  const setProjectsAtom = useSetAtom(projectsAtom)
  const requestGenerationRef = useRef(0)
  const activeWorkspaceIdRef = useRef(activeWorkspaceId)
  activeWorkspaceIdRef.current = activeWorkspaceId

  const refresh = useCallback(async () => {
    const generation = ++requestGenerationRef.current
    setLoadedWorkspaceId(undefined)
    if (!activeWorkspaceId) {
      setProjects([])
      setProjectsAtom([])
      setLoadedWorkspaceId(null)
      return
    }
    const workspaceId = activeWorkspaceId
    try {
      const result = await window.electronAPI.getProjects(workspaceId)
      if (
        requestGenerationRef.current !== generation
        || activeWorkspaceIdRef.current !== workspaceId
      ) return
      const list = Array.isArray(result) ? (result as LoadedProject[]) : []
      setProjects(list)
      setProjectsAtom(list)
      setLoadedWorkspaceId(workspaceId)
      await window.electronAPI.browserPane.reconcile({
        workspaceId,
        projectIds: list.map(project => project.config.id),
      }).catch(error => console.error('[useProjects] Failed to reconcile Browser Projects:', error))
    } catch (err) {
      if (
        requestGenerationRef.current !== generation
        || activeWorkspaceIdRef.current !== workspaceId
      ) return
      console.error('[useProjects] Failed to load projects:', err)
      setProjects([])
      setProjectsAtom([])
      throw err
    }
  }, [activeWorkspaceId, setProjectsAtom])

  useEffect(() => {
    let cancelled = false
    let retryTimeout: ReturnType<typeof setTimeout> | null = null
    const load = () => {
      void refresh().catch(() => {
        if (!cancelled) retryTimeout = setTimeout(load, 500)
      })
    }
    load()
    return () => {
      cancelled = true
      if (retryTimeout) clearTimeout(retryTimeout)
    }
  }, [refresh])

  useEffect(() => {
    if (!activeWorkspaceId) return
    const off = window.electronAPI.onProjectsChanged((wsId: string, list: unknown) => {
      if (wsId !== activeWorkspaceId || activeWorkspaceIdRef.current !== wsId) return
      requestGenerationRef.current += 1
      const projects = Array.isArray(list) ? (list as LoadedProject[]) : []
      setProjects(projects)
      setProjectsAtom(projects)
      setLoadedWorkspaceId(wsId)
      void window.electronAPI.browserPane.reconcile({
        workspaceId: wsId,
        projectIds: projects.map(project => project.config.id),
      }).catch(error => console.error('[useProjects] Failed to reconcile Browser Projects:', error))
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [activeWorkspaceId, setProjectsAtom])

  useEffect(() => window.electronAPI.onReconnected(() => {
    void refresh().catch(() => {})
  }), [refresh])

  return {
    projects,
    loaded: loadedWorkspaceId === (activeWorkspaceId ?? null),
    refresh,
  }
}
