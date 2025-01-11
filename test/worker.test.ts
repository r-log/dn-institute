import { describe, it, expect, vi, beforeEach } from "vitest"
import { GitHubService } from "../cloudflare-worker/services/github"
import { ClaudeService } from "../cloudflare-worker/services/claude"
import { BraveSearchService } from "../cloudflare-worker/services/brave-search"
import { verify } from "@octokit/webhooks-methods"
import { server, http } from "./setup"
import worker from "../cloudflare-worker/worker"
import { ExecutionContext } from "@cloudflare/workers-types"

// Mock services
vi.mock("../cloudflare-worker/services/github", () => {
  const MockGitHubService = vi.fn().mockImplementation(() => ({
    getPRContent: vi.fn().mockResolvedValue("Test content"),
    createComment: vi.fn().mockResolvedValue({})
  })) as unknown as typeof GitHubService
  MockGitHubService.extractPRDetails = vi.fn().mockReturnValue({
    owner: "owner",
    repo: "repo",
    number: 123
  })
  return { GitHubService: MockGitHubService }
})

vi.mock("../cloudflare-worker/services/claude", () => ({
  ClaudeService: vi.fn().mockImplementation(() => ({
    analyzeArticle: vi.fn().mockResolvedValue("Test analysis")
  }))
}))

vi.mock("../cloudflare-worker/services/brave-search", () => ({
  BraveSearchService: vi.fn().mockImplementation(() => ({
    factCheck: vi.fn().mockResolvedValue([
      {
        claim: "Test claim",
        references: [{ title: "Test ref", url: "https://test.com" }]
      }
    ])
  }))
}))

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
  const env = {
    GITHUB_TOKEN: "test-token",
    GITHUB_WEBHOOK_SECRET: "test-secret",
    ANTHROPIC_API_KEY: "test-key",
    BRAVE_SEARCH_API_KEY: "test-key",
    RATE_LIMIT_KV: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn(),
      list: vi.fn(),
      getWithMetadata: vi.fn()
    }
  }

  const ctx: ExecutionContext = {
    waitUntil: vi.fn(),
    passThroughOnException: () => {},
    props: {}
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("Request Validation", () => {
    it("should validate webhook signature", async () => {
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

      const request = new Request("https://example.com", {
        method: "POST",
        headers: {
          "x-hub-signature-256": "sha256=invalid",
          "x-github-event": "issue_comment",
          "cf-connecting-ip": "1.2.3.4"
        },
        body: payload
      })

      const response = await worker.fetch(request, env, ctx)
      expect(response.status).toBe(401)
      expect(verify).toHaveBeenCalledWith(
        env.GITHUB_WEBHOOK_SECRET,
        payload,
        "sha256=invalid"
      )
    })

    it("should handle missing environment variables", async () => {
      const invalidEnv = { ...env, GITHUB_TOKEN: "" }
      const request = new Request("https://example.com", {
        method: "POST",
        headers: {
          "x-hub-signature-256": "sha256=valid",
          "x-github-event": "issue_comment"
        },
        body: "{}"
      })

      const response = await worker.fetch(request, invalidEnv, ctx)
      expect(response.status).toBe(500)
    })
  })

  describe("Rate Limiting", () => {
    it("should enforce rate limits", async () => {
      const now = Math.floor(Date.now() / 1000)
      const timestamps = Array(101).fill(now - 100)

      const mockKV = {
        ...env.RATE_LIMIT_KV,
        get: vi
          .fn()
          .mockImplementation(
            async (_key: string, options?: { type: string }) => {
              if (options?.type === "json") {
                return timestamps
              }
              return null
            }
          )
      }

      const request = new Request("https://example.com", {
        method: "POST",
        headers: {
          "x-hub-signature-256": "sha256=valid",
          "x-github-event": "issue_comment",
          "cf-connecting-ip": "1.2.3.4"
        },
        body: "{}"
      })

      const response = await worker.fetch(
        request,
        { ...env, RATE_LIMIT_KV: mockKV },
        ctx
      )
      expect(response.status).toBe(429)
      expect(response.headers.get("Retry-After")).toBe("3600")
    })
  })

  describe("Article Check Processing", () => {
    it("should process article check requests", async () => {
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

      const request = new Request("https://example.com", {
        method: "POST",
        headers: {
          "x-hub-signature-256": "sha256=valid",
          "x-github-event": "issue_comment"
        },
        body: payload
      })

      const response = await worker.fetch(request, env, ctx)
      expect(response.status).toBe(200)
      expect(GitHubService).toHaveBeenCalled()
      expect(ClaudeService).toHaveBeenCalled()
      expect(BraveSearchService).toHaveBeenCalled()
    })

    it("should handle API timeouts", async () => {
      const mockGetPRContent = vi
        .fn()
        .mockRejectedValueOnce(new Error("Timeout"))
      vi.mocked(GitHubService).mockImplementationOnce(
        () =>
          ({
            getPRContent: mockGetPRContent,
            createComment: vi.fn().mockResolvedValue({})
          } as unknown as GitHubService)
      )

      const request = new Request("https://example.com", {
        method: "POST",
        headers: {
          "x-hub-signature-256": "sha256=valid",
          "x-github-event": "issue_comment",
          "cf-connecting-ip": "1.2.3.4"
        },
        body: JSON.stringify({
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
      })

      const response = await worker.fetch(request, env, ctx)
      expect(response.status).toBe(500)
      const responseBody = (await response.json()) as { error: string }
      expect(responseBody.error).toBe("Timeout")
      expect(mockGetPRContent).toHaveBeenCalled()
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
})
