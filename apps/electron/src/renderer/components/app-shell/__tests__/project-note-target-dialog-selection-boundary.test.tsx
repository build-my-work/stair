import { describe, expect, it, mock } from 'bun:test'
import type { HTMLAttributes, PropsWithChildren } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

function Passthrough({ children }: PropsWithChildren) {
  return <>{children}</>
}

function DialogContent({ children, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return <div {...props}>{children}</div>
}

mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

mock.module('@/context/ModalContext', () => ({
  useRegisterModal: () => {},
}))

let projectFilesTreeSearchExtensions: readonly string[] | undefined
mock.module('@/components/project-files/ProjectFilesTree', () => ({
  ProjectFilesTree: ({ searchExtensions }: { searchExtensions?: readonly string[] }) => {
    projectFilesTreeSearchExtensions = searchExtensions
    return null
  },
}))

mock.module('@/components/ui/button', () => ({
  Button: ({ children, ...props }: PropsWithChildren<HTMLAttributes<HTMLButtonElement>>) => (
    <button {...props}>{children}</button>
  ),
}))

mock.module('@/components/ui/dialog', () => ({
  Dialog: Passthrough,
  DialogContent,
  DialogFooter: Passthrough,
  DialogHeader: Passthrough,
  DialogTitle: Passthrough,
}))

const { ProjectNoteTargetDialog } = await import('../ProjectNoteTargetDialog')

describe('ProjectNoteTargetDialog chat selection boundary', () => {
  it('marks the portaled dialog as both assistant-island and user-message selection safe', () => {
    const html = renderToStaticMarkup(
      <ProjectNoteTargetDialog
        open
        recentPaths={[]}
        busy={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )

    expect(html).toContain('data-ca-island-blocker="true"')
    expect(html).toContain('data-ca-user-reference-menu="true"')
  })

  it('filters Note search by supported extensions before the server result limit', () => {
    renderToStaticMarkup(
      <ProjectNoteTargetDialog
        open
        recentPaths={[]}
        busy={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )

    expect(projectFilesTreeSearchExtensions).toEqual(['md', 'markdown', 'txt'])
  })
})
