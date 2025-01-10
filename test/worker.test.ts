import { describe, it, expect, beforeEach, vi } from "vitest"
import worker from "../cloudflare-worker/worker"
import { mockEnv } from "./setup"
import { server, http } from "./setup"
import { ExecutionContext } from "@cloudflare/workers-types"
import { verify } from "@octokit/webhooks-methods"

const RATE_LIMIT = {
  MAX_REQUESTS: 100,
  WINDOW_SIZE: 3600 // 1 hour in seconds
}

// Mock webhook verification
vi.mock("@octokit/webhooks-methods", () => ({
  verify: vi
    .fn()
    .mockImplementation(
      (secret: string, payload: string, signature: string) => {
        return Promise.resolve(signature === "sha256=valid")
      }
    )
}))

describe("Worker Handler", () => {
  const env = mockEnv
  const ctx: ExecutionContext = {
    waitUntil: (promise: Promise<any>) => promise,
    passThroughOnException: () => {},
    props: {}
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("Rate Limiting", () => {
    it("should enforce rate limits", async () => {
      const request = new Request("https://example.com", {
        method: "POST",
        headers: {
          "x-hub-signature-256": "sha256=valid",
          "x-github-event": "pull_request",
          "cf-connecting-ip": "1.2.3.4"
        },
        body: "{}"
      })

      // Mock webhook signature verification to pass
      vi.mocked(verify).mockResolvedValueOnce(true)

      // Override the default mock to simulate rate limit exceeded
      const now = Math.floor(Date.now() / 1000)
      const timestamps = Array(RATE_LIMIT.MAX_REQUESTS + 1).fill(now - 100)

      const getMock = vi
        .fn()
        .mockImplementation(
          async (_key: string, options?: KVNamespaceGetOptions<any>) => {
            if (options?.type === "json") {
              return timestamps
            }
            return null
          }
        )

      const putMock = vi.fn()

      const mockKV = {
        get: getMock,
        put: putMock,
        delete: vi.fn(),
        list: vi
          .fn()
          .mockResolvedValue({ keys: [], list_complete: true, cursor: "" }),
        getWithMetadata: vi
          .fn()
          .mockResolvedValue({ value: null, metadata: null })
      } as unknown as KVNamespace

      const testEnv = {
        ...env,
        RATE_LIMIT_KV: mockKV
      }

      const response = await worker.fetch(request, testEnv, ctx)

      expect(response.status).toBe(429)
      expect(response.headers.get("Retry-After")).toBeTruthy()
      expect(getMock).toHaveBeenCalled()
      expect(putMock).toHaveBeenCalled()
    })

    it("should allow requests within rate limit", async () => {
      const request = new Request("https://example.com", {
        method: "POST",
        headers: {
          "x-hub-signature-256": "sha256=valid",
          "x-github-event": "pull_request",
          "cf-connecting-ip": "1.2.3.4"
        },
        body: "{}"
      })

      // Mock webhook signature verification to pass
      vi.mocked(verify).mockResolvedValueOnce(true)

      // Use default mock which returns empty array
      const response = await worker.fetch(request, env, ctx)
      expect(response.status).not.toBe(429)
    })
  })

  describe("Error Handling", () => {
    it("should handle API timeouts", async () => {
      const payload = JSON.stringify({
        action: "created",
        issue: {
          number: 123,
          pull_request: {
            url: "https://api.github.com/repos/owner/repo/pulls/123"
          }
        },
        comment: {
          body: "/articlecheck",
          created_at: new Date().toISOString()
        }
      })

      // Mock API timeout
      server.use(
        http.get(
          "https://api.github.com/repos/:owner/:repo/pulls/:pull_number/files",
          () => {
            return new Promise((_, reject) =>
              setTimeout(() => reject(new Error("Timeout")), 100)
            )
          }
        )
      )

      const request = new Request("https://example.com", {
        method: "POST",
        headers: {
          "x-hub-signature-256": "sha256=valid",
          "x-github-event": "issue_comment"
        },
        body: payload
      })

      const mockKV = {
        get: vi
          .fn()
          .mockImplementation(
            async (_key: string, options?: { type: string }) => {
              if (options?.type === "json") {
                return [] // No rate limit
              }
              return null
            }
          ),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        list: vi
          .fn()
          .mockResolvedValue({ keys: [], list_complete: true, cursor: "" }),
        getWithMetadata: vi
          .fn()
          .mockResolvedValue({ value: null, metadata: null })
      } as unknown as KVNamespace

      const testEnv = {
        ...env,
        RATE_LIMIT_KV: mockKV
      }

      const response = await worker.fetch(request, testEnv, ctx)
      expect(response.status).toBe(500)
      const responseBody = (await response.json()) as { error: string }
      expect(responseBody.error).toBe("Timeout")
    })

    it("should handle malformed webhook payloads", async () => {
      const request = new Request("https://example.com", {
        method: "POST",
        headers: {
          "x-hub-signature-256": "sha256=valid",
          "x-github-event": "issue_comment"
        },
        body: "invalid json"
      })

      const response = await worker.fetch(request, env, ctx)
      expect(response.status).toBe(500)
      const responseBody = (await response.json()) as { error: string }
      expect(responseBody.error).toBe("Internal server error")
    })
  })

  describe("Background Processing", () => {
    it("should send initial processing message", async () => {
      const payload = JSON.stringify({
        action: "created",
        issue: {
          number: 123,
          pull_request: {
            url: "https://api.github.com/repos/owner/repo/pulls/123"
          }
        },
        comment: {
          body: "/articlecheck",
          created_at: new Date().toISOString()
        }
      })

      let processingMessageSent = false
      server.use(
        http.post(
          "https://api.github.com/repos/:owner/:repo/issues/:issue_number/comments",
          async ({ request }) => {
            const requestBody = (await request.json()) as { body: string }
            if (requestBody.body.includes("Processing")) {
              processingMessageSent = true
            }
            return Response.json({ id: 1 })
          }
        )
      )

      const request = new Request("https://example.com", {
        method: "POST",
        headers: {
          "x-hub-signature-256": "sha256=valid",
          "x-github-event": "issue_comment"
        },
        body: payload
      })

      await worker.fetch(request, env, ctx)
      expect(processingMessageSent).toBe(true)
    })
  })

  describe("GitHub Webhook Handler", () => {
    it("should verify webhook signature", async () => {
      const payload = JSON.stringify({
        action: "opened",
        pull_request: {
          url: "https://api.github.com/repos/owner/repo/pulls/123"
        }
      })

      const signature = "sha256=invalid"
      const request = new Request("https://example.com", {
        method: "POST",
        headers: {
          "x-hub-signature-256": signature,
          "x-github-event": "pull_request"
        },
        body: payload
      })

      const response = await worker.fetch(request, env, ctx)
      expect(response.status).toBe(401)
      expect(verify).toHaveBeenCalledWith(
        env.GITHUB_WEBHOOK_SECRET,
        payload,
        signature
      )
    })

    it("should handle missing environment variables", async () => {
      const invalidEnv = {
        ...env,
        GITHUB_TOKEN: ""
      }

      const request = new Request("https://example.com", {
        method: "POST",
        headers: {
          "x-hub-signature-256": "sha256=valid",
          "x-github-event": "pull_request"
        },
        body: "{}"
      })

      const response = await worker.fetch(request, invalidEnv, ctx)
      expect(response.status).toBe(500)
    })

    it("should ignore non-pull request events", async () => {
      const request = new Request("https://example.com", {
        method: "POST",
        headers: {
          "x-hub-signature-256": "sha256=valid",
          "x-github-event": "push"
        },
        body: "{}"
      })

      const response = await worker.fetch(request, env, ctx)
      expect(response.status).toBe(200)
    })
  })
})
