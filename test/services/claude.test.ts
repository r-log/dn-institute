import { describe, it, expect } from "vitest"
import { ClaudeService } from "../../src/services/claude"
import { mockEnv } from "../setup"
import { server, http } from "../setup"

describe("ClaudeService", () => {
  const service = new ClaudeService(mockEnv.ANTHROPIC_API_KEY)

  describe("analyzeArticle", () => {
    it("should analyze article content successfully", async () => {
      const content = "Test article content"
      const analysis = await service.analyzeArticle(content)
      expect(analysis).toBe("Test analysis response")
    })

    it("should handle API errors", async () => {
      // Override mock for this test
      server.use(
        http.post("https://api.anthropic.com/v1/messages", () => {
          return new Response("API Error", { status: 500 })
        })
      )

      await expect(service.analyzeArticle("test content")).rejects.toThrow(
        "Claude API error"
      )
    })

    it("should send correct request format", async () => {
      let requestBody: any
      server.use(
        http.post(
          "https://api.anthropic.com/v1/messages",
          async ({ request }) => {
            requestBody = await request.json()
            return Response.json({ content: [{ text: "Test response" }] })
          }
        )
      )

      await service.analyzeArticle("test content")

      expect(requestBody).toMatchObject({
        model: "claude-2.1",
        messages: [
          {
            role: "user",
            content: expect.stringContaining("test content")
          }
        ]
      })
    })
  })
})
