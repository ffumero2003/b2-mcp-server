#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { listBuckets } from './b2/buckets.js'
import { getClient } from './b2/client.js'
import { DEFAULT_LIMIT, MAX_LIMIT, listFiles } from './b2/files.js'
import { uploadFile } from './b2/upload.js'
import { downloadFile } from './b2/download.js'
import { deleteFileVersion, hideFile, unhideFile } from './b2/delete.js'
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

  server.registerTool(
    'b2_list_files',
    {
      title: 'List files in a B2 bucket',
      description:
        'Lists one page of current files in a bucket, as JSON objects with fileName, fileId, contentLength, contentType, and uploadedAt. Optionally filtered by name prefix. The result reports truncated and nextFileName when more files exist beyond the page.',
      inputSchema: {
        bucketName: z.string().min(1).describe('Name of the bucket to list.'),
        prefix: z
          .string()
          .optional()
          .describe('Only list files whose name starts with this prefix.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .describe(`Maximum files to return. Defaults to ${DEFAULT_LIMIT}.`),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ bucketName, prefix, limit }) => {
      try {
        const client = await getClient(loadConfig())
        const listing = await listFiles(client, { bucketName, prefix, limit })
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(listing, null, 2) }],
        }
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: toMessage(error) }],
        }
      }
    },
  )

  server.registerTool(
    'b2_upload_file',
    {
      title: 'Upload a local file to a B2 bucket',
      description:
        'Uploads a file from the local filesystem into a bucket and returns the stored file id, name, size, and type. The local path must sit inside the directory named by B2_UPLOAD_ROOT; uploads are refused otherwise. Uploading an existing name adds a new version rather than replacing the old one.',
      inputSchema: {
        bucketName: z.string().min(1).describe('Name of the destination bucket.'),
        localPath: z
          .string()
          .min(1)
          .describe('Path to the local file. Must be inside B2_UPLOAD_ROOT.'),
        fileName: z
          .string()
          .min(1)
          .optional()
          .describe('Name to store in the bucket. Defaults to the local file name.'),
        contentType: z
          .string()
          .min(1)
          .optional()
          .describe('MIME type. Omit to let B2 detect it.'),
      },
      annotations: {
        readOnlyHint: false,
        // B2 keeps versions, so an existing file is added to, not destroyed.
        destructiveHint: false,
        // Two calls produce two versions.
        idempotentHint: false,
      },
    },
    async ({ bucketName, localPath, fileName, contentType }) => {
      try {
        const client = await getClient(loadConfig())
        const receipt = await uploadFile(client, {
          bucketName,
          localPath,
          fileName,
          contentType,
        })
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(receipt, null, 2) }],
        }
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: toMessage(error) }],
        }
      }
    },
  )

  server.registerTool(
    'b2_download_file',
    {
      title: 'Download a B2 file to local disk',
      description:
        'Downloads a file from a bucket to the local filesystem and returns where it landed, its size, type, and SHA-1. The destination must sit inside the directory named by B2_DOWNLOAD_ROOT. An existing file is not replaced unless overwrite is true. File content is never returned, only the path it was written to.',
      inputSchema: {
        bucketName: z.string().min(1).describe('Name of the bucket to read from.'),
        fileName: z.string().min(1).describe('Name of the file in the bucket.'),
        localPath: z
          .string()
          .min(1)
          .optional()
          .describe('Destination inside B2_DOWNLOAD_ROOT. Defaults to the file base name.'),
        overwrite: z
          .boolean()
          .optional()
          .describe('Replace an existing destination file. Defaults to false.'),
      },
      annotations: {
        readOnlyHint: false,
        // Unlike upload, this CAN destroy data: a replaced local file has no
        // version history to recover from.
        destructiveHint: true,
        // The same version downloaded twice yields the same bytes.
        idempotentHint: true,
      },
    },
    async ({ bucketName, fileName, localPath, overwrite }) => {
      try {
        const client = await getClient(loadConfig())
        const receipt = await downloadFile(client, {
          bucketName,
          fileName,
          localPath,
          overwrite,
        })
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(receipt, null, 2) }],
        }
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: toMessage(error) }],
        }
      }
    },
  )

  server.registerTool(
    'b2_hide_file',
    {
      title: 'Hide a B2 file',
      description:
        'Hides a file so it stops appearing in b2_list_files. Reversible: the data stays in version history and b2_unhide_file restores it. Prefer this over deleting when the goal is to remove something from view.',
      inputSchema: {
        bucketName: z.string().min(1).describe('Bucket containing the file.'),
        fileName: z.string().min(1).describe('Name of the file to hide.'),
      },
      annotations: {
        readOnlyHint: false,
        // The data survives in version history, so nothing is destroyed.
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ bucketName, fileName }) => {
      try {
        const client = await getClient(loadConfig())
        const receipt = await hideFile(client, { bucketName, fileName })
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(receipt, null, 2) }],
        }
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: toMessage(error) }],
        }
      }
    },
  )

  server.registerTool(
    'b2_unhide_file',
    {
      title: 'Unhide a B2 file',
      description:
        'Removes the latest hide marker, making a hidden file visible again. If the file was not hidden, this reports restored false rather than failing.',
      inputSchema: {
        bucketName: z.string().min(1).describe('Bucket containing the file.'),
        fileName: z.string().min(1).describe('Name of the file to restore.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ bucketName, fileName }) => {
      try {
        const client = await getClient(loadConfig())
        const receipt = await unhideFile(client, { bucketName, fileName })
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(receipt, null, 2) }],
        }
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: toMessage(error) }],
        }
      }
    },
  )

  server.registerTool(
    'b2_delete_file_version',
    {
      title: 'Permanently delete one version of a B2 file',
      description:
        'PERMANENTLY destroys ONE version of a file. B2 cannot undo this, and older versions of the same name are left in place. Requires the exact fileId, which you must get from b2_list_files first: this tool will not look one up from a file name. Refused unless B2_AUDIT_LOG is configured, since every deletion is recorded. When B2_ARCHIVE_ROOT is set, a copy of the version is saved locally before it is destroyed. To remove a file from view reversibly, use b2_hide_file instead.',
      inputSchema: {
        bucketName: z.string().min(1).describe('Bucket containing the file.'),
        fileName: z.string().min(1).describe('Name of the file version to delete.'),
        fileId: z
          .string()
          .min(1)
          .describe('Exact version id to destroy. Get it from b2_list_files.'),
      },
      annotations: {
        readOnlyHint: false,
        // The one tool in this server that destroys data B2 cannot return.
        destructiveHint: true,
        // Deleting an already-deleted version is a no-op.
        idempotentHint: true,
      },
    },
    async ({ bucketName, fileName, fileId }) => {
      try {
        const client = await getClient(loadConfig())
        const receipt = await deleteFileVersion(client, { bucketName, fileName, fileId })
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(receipt, null, 2) }],
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
