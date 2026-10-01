import { expect, test } from 'bun:test'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.env.CRAFT_RICH_IMPERATIVE_TEST_CHILD !== '1') {
  test('imperative input updates run against production callbacks in an isolated profile', () => {
    const profile = mkdtempSync(join(tmpdir(), 'stair-rich-imperative-profile-'))
    try {
      const repo = resolve(import.meta.dir, '../../../../../../..')
      copyFileSync(join(repo, 'apps/electron/resources/config-defaults.json'), join(profile, 'config-defaults.json'))
      const child = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
        env: { ...process.env, CRAFT_CONFIG_DIR: profile, CRAFT_RICH_IMPERATIVE_TEST_CHILD: '1' },
        stdout: 'pipe', stderr: 'pipe',
      })
      if (child.exitCode !== 0) throw new Error(`imperative input fixture failed (exit ${child.exitCode})\n${child.stdout.toString()}\n${child.stderr.toString()}`)
      expect(child.exitCode).toBe(0)
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }, 30_000)
} else {
  if (!process.env.CRAFT_CONFIG_DIR?.includes('stair-rich-imperative-profile-')) throw new Error('Disposable input profile required')
  const { findMentionMatches } = await import('../../../lib/mentions')
  const source = readFileSync(join(import.meta.dir, '../rich-text-input.tsx'), 'utf8')
  function part(start: string, end: string) {
    const from = source.indexOf(start)
    const to = source.indexOf(end, from)
    if (from < 0 || to < 0) throw new Error('Production imperative input callback missing')
    return source.slice(from, to)
  }
  // Execute the current imperative handle and prop effects. The small hook
  // context preserves dependency identity across renders, including mount [].
  const factory = new Function('ctx', 'props', 'React', 'findMentionMatches', new Bun.Transpiler({ loader: 'tsx' }).transformSync(`
    const { divRef, lastValueRef, lastMentionSignatureRef, cursorPositionRef, pendingCursorRef, isInternalUpdate, forwardedRef, document, window, Node } = ctx;
    const { safeValue, skills, sources, workspaceId } = props;
    const getSkillIconSync = () => null, getSourceIconSync = () => null;
    ${part('    const skillSlugs = React.useMemo', '    // Preload icons')}
    ${part('// SVG icons as HTML strings', '// RotatingPlaceholder Component')}
    ${part('    React.useImperativeHandle(forwardedRef', '    // Handle input events')}
    ${part('    // Sync value from props', '    // Handle selection changes to highlight badges when selected')}
    return forwardedRef.current;
  `))
  interface HookCell { deps: unknown[]; value?: unknown }
  function sameDeps(before: unknown[] | undefined, next: unknown[]) {
    return before?.length === next.length && before.every((value, index) => Object.is(value, next[index]))
  }
  function setup() {
    let html = '<br>'
    const element = {
      nodeType: 1, tagName: 'DIV', getAttribute: () => null,
      childNodes: [] as Array<{ nodeType: number; textContent: string; parentNode: unknown }>,
      get innerHTML() { return html },
      set innerHTML(value: string) {
        html = value
        // Focused caret cases below use plain single-line content. Mention
        // cases inspect the real rendered markup without simulating selection.
        this.childNodes = [{ nodeType: 3, textContent: value, parentNode: this }]
      },
    }
    const selection = { removed: 0, added: 0, removeAllRanges() { this.removed += 1 }, addRange() { this.added += 1 } }
    const position = { node: undefined as unknown, offset: -1 }
    const document = {
      activeElement: null as unknown,
      createRange: () => ({ setStart(node: unknown, offset: number) { position.node = node; position.offset = offset }, collapse() {}, selectNodeContents() {} }),
    }
    const ctx = {
      divRef: { current: element }, lastValueRef: { current: '' }, lastMentionSignatureRef: { current: '' },
      cursorPositionRef: { current: 0 }, pendingCursorRef: { current: null }, isInternalUpdate: { current: false },
      forwardedRef: { current: null }, document, window: { getSelection: () => selection }, Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    }
    const cells: HookCell[] = []
    let index = 0
    let effects: Array<() => void> = []
    const React = {
      useMemo: (callback: () => unknown, deps: unknown[]) => {
        const at = index++
        if (!sameDeps(cells[at]?.deps, deps)) cells[at] = { deps, value: callback() }
        return cells[at]!.value
      },
      useImperativeHandle: (ref: { current: unknown }, callback: () => unknown, deps: unknown[]) => {
        const at = index++
        if (!sameDeps(cells[at]?.deps, deps)) { ref.current = callback(); cells[at] = { deps } }
      },
      useEffect: (callback: () => void, deps: unknown[]) => {
        const at = index++
        if (!sameDeps(cells[at]?.deps, deps)) { cells[at] = { deps }; effects.push(callback) }
      },
    }
    const render = (props: { safeValue: string; skills: unknown[]; sources: unknown[]; workspaceId?: string }) => {
      index = 0
      effects = []
      const handle = factory(ctx, props, React, findMentionMatches)
      for (const effect of effects) effect()
      return handle
    }
    return { ctx, element, selection, position, document, render }
  }
  const sources = [{ config: { slug: 'github', name: 'GitHub' } }]
  const skills = [{ slug: 'solve', metadata: { name: 'Solve' } }]

  test('sources and skills loaded after mount survive synchronous setValue and the following prop effect', () => {
    const f = setup()
    f.render({ safeValue: '', skills: [], sources: [] })
    const props = { safeValue: '[source:github] [skill:solve]', skills, sources }
    const handle = f.render(props)
    expect(f.element.innerHTML.match(/data-mention="true"/g)).toHaveLength(2)
    const next = props.safeValue + '\nMore context'
    handle.setValue(next)
    const synchronousHtml = f.element.innerHTML
    f.render({ ...props, safeValue: next })
    expect(handle.value).toBe(next)
    expect(f.element.innerHTML).toBe(synchronousHtml)
    expect(f.element.innerHTML.match(/data-mention="true"/g)).toHaveLength(2)
    expect(f.element.innerHTML).toContain('GitHub')
    expect(f.element.innerHTML).toContain('Solve')
    expect(f.element.innerHTML).toContain('<br>More context')
  })

  test('setValue uses the current source and skill removals rather than the mount list', () => {
    const f = setup()
    const value = '[source:github] [skill:solve]'
    f.render({ safeValue: value, skills, sources })
    const props = { safeValue: value, skills: [], sources: [] }
    const handle = f.render(props)
    handle.setValue(value)
    f.render(props)
    expect(handle.value).toBe(value)
    expect(f.element.innerHTML).toBe(value)
  })

  test('a focused synchronous replacement clamps the real caret calculation to the new text', () => {
    const f = setup()
    const handle = f.render({ safeValue: 'abcdefgh', skills: [], sources: [] })
    f.ctx.cursorPositionRef.current = 7
    f.document.activeElement = f.element
    handle.setValue('abc')
    expect(handle.value).toBe('abc')
    expect(handle.selectionStart).toBe(3)
    expect(f.position.node).toBe(f.element.childNodes[0])
    expect(f.position.offset).toBe(3)
    expect(f.selection.added).toBe(1)
  })

  test('restoring an unfocused editor updates DOM without moving the active selection', () => {
    const f = setup()
    const handle = f.render({ safeValue: 'old', skills: [], sources: [] })
    const otherElement = {}
    f.document.activeElement = otherElement
    handle.setValue('restored')
    expect(f.element.innerHTML).toBe('restored')
    expect(handle.value).toBe('restored')
    expect(f.document.activeElement).toBe(otherElement)
    expect(f.selection.added).toBe(0)
  })

  test('synchronous replacement escapes HTML and preserves plain-text newlines', () => {
    const f = setup()
    const handle = f.render({ safeValue: '', skills: [], sources: [] })
    handle.setValue('<unsafe>&\nnext')
    expect(handle.value).toBe('<unsafe>&\nnext')
    expect(f.element.innerHTML).toBe('&lt;unsafe&gt;&amp;<br>next')
  })
}
