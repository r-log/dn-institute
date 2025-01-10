/// <reference types="vitest" />
import { beforeAll, afterAll, afterEach, vi } from "vitest"
import { setupServer } from "msw/node"
import { http } from "msw"

// Mock Cloudflare Worker environment
const mockEnv = {
  GITHUB_TOKEN: "test-token",
  ANTHROPIC_API_KEY: "test-key",
  BRAVE_SEARCH_API_KEY: "test-key",
  GITHUB_WEBHOOK_SECRET: "test-secret",
  RATE_LIMIT_KV: {
    get: vi
      .fn()
      .mockImplementation(async (key: string, options?: { type: string }) => {
        if (options?.type === "json") {
          return [] // Default empty array for rate limiting
        }
        return null
      }),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi
      .fn()
      .mockResolvedValue({ keys: [], list_complete: true, cursor: "" }),
    getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null })
  } as unknown as KVNamespace
}

// Create MSW server for API mocking
export const server = setupServer(
  // GitHub API mocks
  http.get(
    "https://api.github.com/repos/:owner/:repo/pulls/:pull_number/files",
    () => {
      return Response.json([
        {
          filename: "test.md",
          status: "added",
          sha: "test-sha"
        }
      ])
    }
  ),

  http.get("https://api.github.com/repos/:owner/:repo/contents/:path", () => {
    return Response.json({
      content: Buffer.from("Test content").toString("base64"),
      encoding: "base64"
    })
  }),

  http.post(
    "https://api.github.com/repos/:owner/:repo/issues/:issue_number/comments",
    () => {
      return Response.json({
        id: 1,
        body: "Test comment"
      })
    }
  ),

  // Claude API mocks
  http.post("https://api.anthropic.com/v1/messages", () => {
    return Response.json({
      content: [{ text: "Test analysis response" }]
    })
  }),

  // Brave Search API mocks
  http.get("https://api.search.brave.com/res/v1/web/search", () => {
    return Response.json({
      web: {
        results: [
          {
            title: "Test Result",
            description: "Test Description",
            url: "https://test.com"
          }
        ]
      }
    })
  })
)

// Setup and teardown
beforeAll(() => server.listen({ onUnhandledRequest: "warn" }))
afterAll(() => server.close())
afterEach(() => server.resetHandlers())

// Export test utilities
export { mockEnv, http }
