# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits. The in-app loader only reads `X.Y.Z.md` files, so this file is never shown to users.

## Features

- **Video notes from captions** — Paste a YouTube or Bilibili video link in chat to create source-linked notes and a native mind map. Stair preserves the existing captions and timestamps, processes long videos in chunks, and reports login, access and missing-caption failures without running speech recognition.

- **Sign in to MCP servers that reject the OAuth relay** — Some MCP servers only accept a local (loopback) redirect address when signing in, and refuse the Craft Agents relay with an error like "only HTTP loopback callbacks". Add `"oauthRelay": false` to the source's `mcp` block to send the sign-in straight back to the app on `localhost` instead. Leave it unset to keep using the relay. See **Sources → MCP servers → Authentication** in the docs.
- Added the rebuilt Stair desktop experience with Project-scoped sessions, files and readers, native Browser panels, Drawnix boards, references, and persistent multi-panel Workbench layouts.

## Improvements

- Stair now ships with its own app identity, URL scheme, data directory, icons, update policy, and fresh-install packaging checks.
- Packaged builds now stage and validate the Session MCP server, Pi agent server, target-architecture Koffi runtime, Bun, and ripgrep alongside the Claude runtime.

## Bug Fixes

- Fixed packaged Stair builds omitting the Claude Agent SDK, native Claude binary, and ripgrep, and switched the macOS runtime dock icon from an ICNS that Electron rejected to the bundled PNG.
- Fixed restored Browser panels showing a blank toolbar URL by requesting the current native Browser state after the toolbar preload subscribes.

## Breaking Changes
