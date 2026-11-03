/**
 * Skills Atom
 *
 * Simple atom for storing workspace skills.
 * Used by NavigationContext for auto-selection when navigating to skills view.
 */

import { atom } from 'jotai'
import type { LoadedSkill } from '../../shared/types'

/**
 * Atom to store the current workspace's skills.
 * AppShell populates this when skills are loaded.
 * NavigationContext reads from it for auto-selection.
 */
export const skillsAtom = atom<LoadedSkill[]>([])

/** Hand off an explicit update request from an installed skill to the shared preview flow. */
export const skillImportSourceAtom = atom<{ workspaceId: string; source: import('@craft-agent/shared/skills/marketplace').SkillImportSource } | null>(null)
