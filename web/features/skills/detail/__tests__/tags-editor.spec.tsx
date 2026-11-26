import type { SkillDetailResponse } from '@dify/contracts/api/console/workspaces/types.gen'
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vite-plus/test'
import { consoleQuery } from '@/service/console'
import { createConsoleQueryClient, renderWithConsoleQuery } from '@/test/console/query-data'
import { SkillTagsEditor } from '../tags-editor'

vi.mock('@/features/tag-management/tag-management-dialog', () => ({
  TagManagementDialog: ({ onTagsChange }: { onTagsChange?: () => void }) => (
    <button type="button" onClick={onTagsChange}>
      trigger-tags-change
    </button>
  ),
}))

describe('SkillTagsEditor', () => {
  it('invalidates cached infinite and query skill lists when managed tags change', () => {
    const queryClient = createConsoleQueryClient()
    const skills = consoleQuery.workspaces.current.skills
    const detailKey = skills.bySkillId.get.queryKey({ input: { params: { skill_id: 'skill-1' } } })
    const queryListKey = skills.get.queryKey({ input: { query: { page: 1 } } })
    const infiniteListKey = skills.get.infiniteOptions({
      input: (pageParam: number) => ({ query: { page: pageParam, tag: ['ops'] } }),
      initialPageParam: 1,
      getNextPageParam: () => undefined,
    }).queryKey
    const tagsKey = skills.tags.get.queryKey()

    const detail = {
      id: 'skill-1',
      name: 'triage',
      display_name: 'Triage',
      tags: ['ops'],
      updated_at: 1,
    } as SkillDetailResponse

    queryClient.setQueryData(detailKey, detail as never)
    queryClient.setQueryData(queryListKey, {
      data: [],
      has_more: false,
      limit: 20,
      page: 1,
      total: 0,
    } as never)
    queryClient.setQueryData(infiniteListKey, { pages: [], pageParams: [1] } as never)
    queryClient.setQueryData(tagsKey, { data: [{ tag: 'ops', skill_count: 1 }] } as never)

    renderWithConsoleQuery(
      <SkillTagsEditor
        detail={detail}
        draftMutationCoordinator={{
          latestDetail: detail,
          queue: Promise.resolve(),
          skillId: 'skill-1',
        }}
        readonly={false}
        skillId="skill-1"
      />,
      { queryClient },
    )

    fireEvent.click(screen.getByRole('button', { name: 'trigger-tags-change' }))

    expect(queryClient.getQueryState(detailKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(tagsKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(queryListKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(infiniteListKey)?.isInvalidated).toBe(true)
  })
})
