#!/usr/bin/env node
/**
 * Rebuild the vendored KiCanvas bundle in `assets/`.
 *
 * The viewer ships inside the plugin, so upgrading it is a maintainer step, not a runtime action:
 * this script clones the pinned commit into a temp directory, builds it, and copies the bundle,
 * its license, and a VERSION file into `assets/`.
 *
 *   node scripts/vendor-kicanvas.mjs            # use the pinned commit
 *   node scripts/vendor-kicanvas.mjs <commit>   # try another commit
 *
 * Requires `git`, `node`, and `npm` on PATH.
 */
import { execFile } from 'node:child_process'
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const REPO = 'https://github.com/theacodes/kicanvas.git'
const PINNED = 'b031159eb74aaa7eef2b026fd85d35bc05ff2095'
const commit = process.argv[2] ?? PINNED
const here = dirname(fileURLToPath(import.meta.url))
const assets = join(here, '..', 'assets')

async function main() {
  const work = await mkdtemp(join(tmpdir(), 'kicanvas-vendor-'))
  try {
    console.log(`cloning ${REPO} @ ${commit}`)
    await run('git', ['clone', '--filter=blob:none', REPO, work], { maxBuffer: 16 * 1024 * 1024 })
    await run('git', ['-C', work, 'checkout', '--detach', commit], { maxBuffer: 16 * 1024 * 1024 })

    console.log('npm ci')
    await run('npm', ['ci'], { cwd: work, maxBuffer: 64 * 1024 * 1024 })
    console.log('npm run build')
    await run('npm', ['run', 'build'], { cwd: work, maxBuffer: 64 * 1024 * 1024 })

    const { stdout: head } = await run('git', ['-C', work, 'rev-parse', 'HEAD'])
    const { stdout: date } = await run('git', ['-C', work, 'log', '-1', '--format=%cs'])

    await mkdir(assets, { recursive: true })
    await cp(join(work, 'build', 'kicanvas.js'), join(assets, 'kicanvas.js'))
    await cp(join(work, 'LICENSE.md'), join(assets, 'LICENSE-kicanvas.md'))
    await writeFile(
      join(assets, 'KICANVAS-VERSION'),
      [
        `upstream: ${REPO}`,
        `commit: ${head.trim()}`,
        `commit_date: ${date.trim()}`,
        'bundle: assets/kicanvas.js',
        'built_with: npm ci && npm run build (esbuild, minified)',
        'note: rebuilt by scripts/vendor-kicanvas.mjs',
        '',
      ].join('\n'),
      'utf8',
    )
    console.log(`vendored ${head.trim()} → assets/kicanvas.js`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(String(error?.stderr ?? error?.message ?? error))
  process.exit(1)
})
