import type { CheckDependenciesResult } from '@dify/contracts/api/console/apps/types.gen'
import { act } from '@testing-library/react'
import { createErrorToastCaches } from '@/app/query-error-toast'
import { createHttpError } from '@/service/http-error'
import { createConsoleQueryClient, renderHookWithConsoleQuery } from '@/test/console/query-data'
import { usePluginDependencies } from '../hooks'
import { useStore } from '../store'

const mocks = vi.hoisted(() => ({
  request: vi.fn<(...args: unknown[]) => Promise<Response>>(),
  error: vi.fn(),
}))

vi.mock('@/service/base', () => ({ request: mocks.request }))
vi.mock('@/app/notifications', () => ({ toast: { error: mocks.error } }))

describe('usePluginDependencies', () => {
  beforeEach(() => {
    mocks.request.mockReset()
    mocks.error.mockReset()
    useStore.getState().setDependencies([])
  })

  it.each([
    { resource: 'app', isPipeline: false, path: '/apps/imports/resource-1/check-dependencies' },
    {
      resource: 'pipeline',
      isPipeline: true,
      path: '/rag/pipelines/imports/resource-1/check-dependencies',
    },
  ])(
    'stores $resource dependencies with nullable versions and clears an omitted list',
    async ({ isPipeline, path }) => {
      const dependency = {
        type: 'marketplace',
        value: { marketplace_plugin_unique_identifier: 'plugin-1', version: null },
      } satisfies NonNullable<CheckDependenciesResult['leaked_dependencies']>[number]
      mocks.request
        .mockResolvedValueOnce(Response.json({ leaked_dependencies: [dependency] }))
        .mockResolvedValueOnce(Response.json({}))
      const { result } = renderHookWithConsoleQuery(usePluginDependencies)
      await act(async () =>
        expect(await result.current.handleCheckPluginDependencies('resource-1', isPipeline)).toBe(
          true,
        ),
      )
      expect(useStore.getState().dependencies).toEqual([
        { ...dependency, value: { ...dependency.value, version: undefined } },
      ])
      expect(mocks.request).toHaveBeenCalledWith(
        expect.stringContaining(path),
        expect.any(Object),
        expect.objectContaining({ fetchCompat: true }),
      )
      await act(async () => result.current.handleCheckPluginDependencies('resource-1', isPipeline))
      expect(useStore.getState().dependencies).toEqual([])
    },
  )

  it.each([
    {
      resource: 'app',
      isPipeline: false,
      error: new TypeError('Network unavailable'),
      description: 'Network unavailable',
    },
    {
      resource: 'app',
      isPipeline: false,
      error: createHttpError(new Response(null, { status: 503 }), {
        message: 'Dependency check unavailable',
      }),
      description: 'Dependency check unavailable',
    },
    {
      resource: 'pipeline',
      isPipeline: true,
      error: new TypeError('Network unavailable'),
      description: 'Network unavailable',
    },
    {
      resource: 'pipeline',
      isPipeline: true,
      error: createHttpError(new Response(null, { status: 503 }), {
        message: 'Dependency check unavailable',
      }),
      description: 'Dependency check unavailable',
    },
  ])(
    'reports $resource dependency errors once and clears stale dependencies ($description)',
    async ({ isPipeline, error, description }) => {
      useStore.getState().setDependencies([
        {
          type: 'marketplace',
          value: { marketplace_plugin_unique_identifier: 'previous-app-plugin' },
        },
      ])
      mocks.request.mockRejectedValue(error)
      const queryClient = createConsoleQueryClient({ caches: createErrorToastCaches() })
      const { result } = renderHookWithConsoleQuery(usePluginDependencies, { queryClient })
      await act(async () =>
        expect(await result.current.handleCheckPluginDependencies('resource-1', isPipeline)).toBe(
          false,
        ),
      )
      expect(mocks.error).toHaveBeenCalledExactlyOnceWith('common.error', { description })
      expect(useStore.getState().dependencies).toEqual([])
    },
  )
})
