import { describe, it, expect } from "vitest"
import { GitHubService } from "../../cloudflare-worker/services/github"
import { mockEnv } from "../setup"
import { server, http } from "../setup"

describe("GitHubService", () => {
  const service = new GitHubService(mockEnv.GITHUB_TOKEN)

  describe("extractPRDetails", () => {
    it("should correctly parse PR URL", () => {
      const url = "https://api.github.com/repos/owner/repo/pulls/123"
      const result = GitHubService.extractPRDetails(url)

      expect(result).toEqual({
        owner: "owner",
        repo: "repo",
        number: 123
      })
    })

    it("should throw error for invalid URL", () => {
      const url = "https://invalid-url"
      expect(() => GitHubService.extractPRDetails(url)).toThrow(
        "Invalid PR URL format"
      )
    })
  })

  describe("getPRContent", () => {
    it("should fetch and parse PR content", async () => {
      const content = await service.getPRContent("owner", "repo", 123)
      expect(content).toBeTruthy()
    })

    it("should handle empty PR content", async () => {
      // Override mock for this test
      server.use(
        http.get(
          "https://api.github.com/repos/:owner/:repo/pulls/:pull_number/files",
          () => {
            return Response.json([])
          }
        )
      )

      await expect(service.getPRContent("owner", "repo", 123)).rejects.toThrow(
        "No markdown files found"
      )
    })
  })

  describe("createComment", () => {
    it("should create comment successfully", async () => {
      await expect(
        service.createComment("owner", "repo", 123, "test comment")
      ).resolves.not.toThrow()
    })
  })
})
