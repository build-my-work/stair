/**
 * Skills Module
 *
 * Workspace skills are specialized instructions that extend Claude's capabilities.
 */

export * from './types.ts';
export {
  GLOBAL_AGENT_SKILLS_DIR,
  PROJECT_AGENT_SKILLS_DIR,
  normalizeRequiredSources,
  loadSkill,
  loadAllSkills,
  invalidateSkillsCache,
  loadSkillBySlug,
  getSkillIconPath,
  deleteSkill,
  skillExists,
  listSkillSlugs,
  skillNeedsIconDownload,
  downloadSkillIcon,
} from './storage.ts';

export * from './marketplace-types'
export { writeSkillDirectory, hashSkillFiles, fingerprintSkillDirectory, readSkillInstallation, SKILL_INSTALLATION_FILE } from './installation'
