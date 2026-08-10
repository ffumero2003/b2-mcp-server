#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { listBuckets } from './b2/buckets.js'
import { getClient } from './b2/client.js'
import { loadConfig } from './config.js'
import { loadDotEnv } from './env-file.js'

/** Server identity reported to MCP clients during initialization. */
const SERVER_NAME = 'b2-mcp-server'
const SERVER_VERSION = '0.1.0'

/**
 * Reduces any thrown value to a message safe to hand back to the client.
 *
 * The B2 SDK's error classes (BadAuthTokenError and the rest of the B2Error
 * family) carry an EMPTY message and put the diagnosis in name/code/status, so
 * reading .message alone yields a blank error the caller cannot act on. Change
 * this if the SDK starts populating .message, or if another error family with
 * its own shape has to be reported.
 */
export function toMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }
  if (error.message) {
    return error.message
  }

  const { code, status } = error as { code?: string; status?: number }
  const parts = [error.name]
  if (code) {
    parts.push(`(${code})`)
  }
  if (status) {
    parts.push(`HTTP ${status}`)
  }
  return parts.join(' ')
}

/**
 * Builds the MCP server and registers every tool it exposes.
 *
 * Separated from startup so a future test can drive the server through an
 * in-memory transport without spawning a process. Change this when a tool is
 * added or removed.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })

  server.registerTool(
    'b2_list_buckets',
    {
      title: 'List B2 buckets',
      description:
        'Lists every bucket in the configured Backblaze B2 account, as JSON objects with bucketId, bucketName, and bucketType.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      // Failures are returned as an error result rather than thrown: a throw
      // would tear down the stdio session, while a result lets the client read
      // and explain what went wrong.
      try {
        const client = await getClient(loadConfig())
        const buckets = await listBuckets(client)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(buckets, null, 2) }],
        }
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: toMessage(error) }],
        }
      }
    },
  )

  return server
}

/**
 * Starts the server on stdio. Change this when a second transport is added.
 *
 * Nothing may be written to stdout here or below it: stdout is the MCP
 * transport, and stray output corrupts the protocol stream. Diagnostics go to
 * stderr.
 */
async function main(): Promise<void> {
  // Before anything reads credentials. Only the status is reported, never which
  // variables were set -- naming them is one step from leaking them.
  process.stderr.write(`.env ${loadDotEnv()}\n`)

  const server = createServer()
  await server.connect(new StdioServerTransport())
  process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION} listening on stdio\n`)
}

// Only start when run as the entry point. Without this guard, a test importing
// anything from this module would spawn a stdio server as a side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`fatal: ${toMessage(error)}\n`)
    process.exit(1)
  })
}
