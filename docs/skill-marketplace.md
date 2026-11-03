# Skill marketplace

The Skills collection opens a searchable marketplace. EduHub and skills.sh results share a detail and installation flow; the Add menu accepts a public GitHub repository/directory/SKILL.md URL or a local folder/ZIP. Installation targets the current workspace.

The interaction follows the reviewed ChatGPT Plugins directory: compact result rows, a separate detail view, a modal for instructions, explicit selection when a package contains multiple skills, and a Use in chat action that creates a draft without sending it. Installed skills keep their existing detail, editing and deletion controls. Remote installations expose a manual Check updates action using the same preview flow.

## Module boundaries

- `shared/skills/marketplace-types.ts` contains browser-safe contracts. UI and RPC share these types; UI does not interpret provider manifests or archives.
- `server-core/skills/catalogs.ts` owns the two catalog APIs and public GitHub resolution. Search produces references; resolution pins an EduHub version or Git commit and returns package files.
- `server-core/skills/archive.ts` reads ZIPs using the existing yauzl dependency. It checks paths, entry types, expanded sizes and CRC before any filesystem write.
  GitHub repository links are recorded without being read or restored, then rejected if they belong to the selected skill; links elsewhere in the repository do not block installation. Local ZIP and EduHub packages still reject links outright.
- `server-core/skills/marketplace.ts` owns discovery, validation, reviewed snapshots, conflict checks and installation results. Preview tokens are scoped to client and workspace, expire after 15 minutes, and retain at most three packages.
- `shared/skills/installation.ts` owns filesystem replacement and provenance. Both marketplace installation and the existing resource-bundle import call the same writer. A staged directory replaces the target only after restoration succeeds; a failed replacement rename restores the previous directory.
- The three skills RPC handlers only resolve the workspace, delegate, and notify the existing config watcher. Installed skills still use `loadAllSkills`, the existing workspace directory, cache invalidation and `[skill:slug]` mentions.

GitHub identity uses repository plus skill directory, independent of whether discovery came from skills.sh or a pasted link. `stair-install.json` records source, revision, content fingerprint and the update reference; existing resource transfer preserves it. It is not required for hand-written skills. Updates detect local edits and require explicit replacement. A filesystem change after preview requires another preview.

GitHub updates select the exact repository-relative directory with `skillPath`, including an empty path for a root skill. Display-name changes and nested skills do not change the update target. Older installation records recover that selector from their existing `subpath` when loaded. Preview requirements use the same normalization as the installed-skill loader. Resource transfer preserves safe legacy directory names; marketplace imports continue to validate their generated slugs, falling back to the skill name when a folder name cannot produce one. Concurrent previews retain independent tokens within the existing expiry and capacity limits, prioritizing the most recently started requests when capacity is reached.

## Boundaries

- GitHub access is public and unauthenticated. Rate limits and provider outages are surfaced in the UI; one catalog failing does not hide the other's results.
- skills.sh's public CLI endpoint supports keyword search, starting at two characters. This installer lists its public GitHub-backed entries; externally hosted entries are filtered out. An empty search does not invent a catalog feed. Each catalog returns up to 40 results; refine the query to narrow them.
- Local folder/ZIP uploads are limited to 8 MiB. A remote ZIP is limited to 20 MiB compressed and 100 MiB expanded. An individual skill supports up to 600 files, 4 MiB per file, and 40 MiB total. GitHub resolution downloads the repository archive, including when selecting a subdirectory.
- ZIP/GitHub executable mode is preserved on POSIX. Browser folder uploads expose file contents but not executable mode. ZIP is the import route for local executable scripts.
- Installation parses YAML metadata and copies files; it does not execute downloaded scripts, install dependencies, or create MCP connections. Existing skill runtime and permission behavior applies when used.
- Replacement recovery covers write/rename errors. There is no startup recovery journal for a process or machine crash between filesystem operations.

## Verification

`packages/server-core/src/skills/marketplace.test.ts` covers all source adapters, version/checksum pinning, multiple and nested skills, selected installation, conflict snapshots, local edits, client/workspace isolation, unsafe archives and frontmatter, preservation of old contents, executable/binary files, and resource-transfer round trips. Existing protocol, storage and resource-bundle suites cover integration contracts.

`apps/electron/src/renderer/pages/__tests__/skill-marketplace.isolated.ts` exercises pending preview and installation across session-directory changes, plus stale responses after a workspace switch. Imports remain scoped to the workspace; the installed-skill refresh uses the latest session directory.

For UI acceptance, use a dedicated `CRAFT_CONFIG_DIR`, Vite port and deep-link scheme. Worktrees do not isolate the default Stair runtime profile. Verify each source through preview → install → installed list, manual replacement, instruction preview, and Use in chat without sending a message.
