const assert = require('node:assert/strict')
const { access } = require('node:fs/promises')
const { test } = require('node:test')
const downloadWebBuild = require('./download.cjs')

function fixture({ downloadFailures = 0, producerFails = false, listFailure } = {}) {
  const calls = []
  const sleeps = []
  const listLookups = { jobs: 0, artifacts: 0 }
  const env = {
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '4',
    GH_TOKEN: 'test-token',
  }
  const execute = async (command, args) => {
    calls.push({ command, args })
    if (command === 'tar') return { stdout: '' }
    if (args[0] === 'run') {
      if (downloadFailures > 0) {
        downloadFailures--
        throw new Error('artifact download failed')
      }
      return { stdout: '' }
    }
    const kind = args[1].includes('/jobs?')
      ? 'jobs'
      : args[1].includes('/artifacts?')
        ? 'artifacts'
        : undefined
    if (kind) {
      listLookups[kind]++
      if (listFailure?.kind === kind && listLookups[kind] <= listFailure.attempts) {
        if (listFailure.mode === 'json') return { stdout: `[{"${kind}":` }
        // Match the CI failure: gh pagination exits 1 with partial stdout,
        // before our own JSON.parse or the archive download.
        throw Object.assign(new Error('unexpected end of JSON input'), {
          code: 1,
          stdout: '[]',
          stderr: 'unexpected end of JSON input',
        })
      }
    }
    if (args[1].includes('/jobs?')) {
      return {
        stdout: JSON.stringify([
          {
            jobs: [
              {
                name: 'Run Web Full-Stack E2E / Prepare Core E2E Web Build',
                status: 'completed',
                conclusion: producerFails ? 'failure' : 'success',
                steps: [
                  {
                    name: 'Upload Web build',
                    conclusion: 'success',
                    started_at: '2026-09-22T04:08:08Z',
                    completed_at: '2026-09-22T04:08:12Z',
                  },
                ],
              },
            ],
          },
        ]),
      }
    }
    if (args[1].includes('/artifacts?')) {
      return {
        stdout: JSON.stringify([
          { artifacts: [] },
          {
            artifacts: [
              {
                id: 42,
                name: 'core-e2e-web-build-2',
                created_at: '2026-09-22T04:08:11Z',
                expired: false,
              },
            ],
          },
        ]),
      }
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`)
  }
  const sleep = async (ms) => {
    sleeps.push(ms)
  }
  return { calls, sleeps, options: { env, execute, webDir: '/test/web', sleep } }
}

test('downloads the producer-selected artifact on consumer-only reruns without a second metadata lookup', async () => {
  const { calls, options } = fixture()
  await downloadWebBuild({
    ...options,
    async execute(command, args) {
      if (args[0] === 'api' && args[1].endsWith('/artifacts/42')) {
        throw new Error('gh: Not Found (HTTP 404)')
      }
      return options.execute(command, args)
    },
  })
  assert.match(calls[0].args[1], /runs\/123\/attempts\/4\/jobs/)
  const download = calls.find(({ args }) => args[0] === 'run')
  assert.deepEqual(download.args.slice(0, 7), [
    'run',
    'download',
    '123',
    '--repo',
    'owner/repo',
    '--name',
    'core-e2e-web-build-2',
  ])
  const extract = calls.at(-1)
  assert.equal(extract.command, 'tar')
  assert.deepEqual(extract.args.slice(-2), ['-C', '/test/web'])
  await assert.rejects(access(download.args.at(-1)), { code: 'ENOENT' })
})

test('retries a listed artifact whose archive is temporarily unreadable', async () => {
  const { calls, sleeps, options } = fixture({ downloadFailures: 1 })
  await downloadWebBuild(options)
  assert.deepEqual(sleeps, [5_000])
  assert.equal(calls.filter(({ args }) => args[0] === 'run').length, 2)
  assert.equal(calls.at(-1).command, 'tar')
})

for (const kind of ['jobs', 'artifacts']) {
  for (const mode of ['process', 'json']) {
    test(`recovers a truncated ${kind} list ${mode} response before downloading`, async () => {
      const { calls, sleeps, options } = fixture({ listFailure: { kind, mode, attempts: 1 } })
      await downloadWebBuild(options)
      assert.deepEqual(sleeps, [5_000])
      const reads = calls.filter(({ args }) => args[0] === 'api' && args[1].includes(`/${kind}?`))
      assert.equal(reads.length, 2)
      assert.equal(calls.filter(({ args }) => args[0] === 'run').length, 1)
      assert.equal(calls.at(-1).command, 'tar')
    })

    test(`bounds persistent ${kind} list ${mode} failures without downloading or extracting`, async () => {
      const { calls, sleeps, options } = fixture({ listFailure: { kind, mode, attempts: 99 } })
      await assert.rejects(downloadWebBuild(options), /JSON/)
      assert.deepEqual(sleeps, [5_000, 10_000])
      const reads = calls.filter(({ args }) => args[0] === 'api' && args[1].includes(`/${kind}?`))
      assert.equal(reads.length, 3)
      assert.equal(
        calls.some(({ args }) => args[0] === 'run'),
        false,
      )
      assert.equal(
        calls.some(({ command }) => command === 'tar'),
        false,
      )
      assert.equal(
        calls.some(({ args }) => args[1] === 'repos/owner/repo/actions/artifacts/42'),
        false,
      )
    })
  }
}

test('does not extract a failed download and removes its temporary directory', async () => {
  const { calls, sleeps, options } = fixture({ downloadFailures: 3 })
  await assert.rejects(downloadWebBuild(options), /artifact download failed/)
  assert.deepEqual(sleeps, [5_000, 10_000])
  assert.equal(calls.filter(({ args }) => args[0] === 'run').length, 3)
  assert.equal(
    calls.some(({ command }) => command === 'tar'),
    false,
  )
  await assert.rejects(access(calls.at(-1).args.at(-1)), { code: 'ENOENT' })
})

test('does not download or extract when the producer fails', async () => {
  const { calls, sleeps, options } = fixture({ producerFails: true })
  await assert.rejects(downloadWebBuild(options), /Web build finished with failure/)
  assert.equal(calls.length, 1)
  assert.deepEqual(sleeps, [])
})

test('requires CI metadata and credentials before starting preparation', async () => {
  const { calls, options } = fixture()
  for (const key of Object.keys(options.env)) {
    await assert.rejects(
      downloadWebBuild({ ...options, env: { ...options.env, [key]: '' } }),
      /requires GITHUB/,
    )
  }
  assert.equal(calls.length, 0)
})
