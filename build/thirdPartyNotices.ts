import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'

export function deploymentNotices(root: string): string {
  const base = readFileSync(join(root, 'THIRD_PARTY_NOTICES'), 'utf8')
  const directory = join(root, 'node_modules/lz-string')
  const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { version?: unknown }
  if (metadata.version !== '1.5.0') throw new Error('The approved legacy clipboard decoder must be lz-string 1.5.0')
  const license = readFileSync(join(directory, 'LICENSE'), 'utf8')
  if (!license.includes('Copyright (c) 2013 pieroxy')) throw new Error('Missing lz-string MIT copyright notice')
  return `${base.trimEnd()}\n\nlz-string 1.5.0 — https://github.com/pieroxy/lz-string — MIT License — Copyright (c) 2013 pieroxy\n\n${license}`
}

export function thirdPartyNotices(root: string): Plugin {
  return {
    name: 'deployment-third-party-notices',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES', source: deploymentNotices(root) })
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== '/THIRD_PARTY_NOTICES') { next(); return }
        try {
          response.setHeader('Content-Type', 'text/plain; charset=utf-8')
          response.end(deploymentNotices(root))
        } catch (error) { next(error) }
      })
    },
  }
}
