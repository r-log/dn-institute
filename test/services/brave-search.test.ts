import { describe, it, expect } from "vitest"
import { BraveSearchService } from "../../cloudflare-worker/services/brave-search"
import { mockEnv } from "../setup"
import { server, http } from "../setup"

describe("BraveSearchService", () => {
  const service = new BraveSearchService(mockEnv.BRAVE_SEARCH_API_KEY)

  describe("searchReferences", () => {
    it("should fetch search results successfully", async () => {
      const results = await service.searchReferences("test query")
      expect(results).toHaveLength(1)
      expect(results[0]).toMatchObject({
        title: "Test Result",
        url: "https://test.com"
      })
    })

    it("should handle API errors", async () => {
      server.use(
        http.get("https://api.search.brave.com/res/v1/web/search", () => {
          return new Response("API Error", { status: 500 })
        })
      )

      await expect(service.searchReferences("test query")).rejects.toThrow(
        "Brave Search API error"
      )
    })

    it("should properly encode query parameters", async () => {
      let requestUrl: string | undefined
      server.use(
        http.get(
          "https://api.search.brave.com/res/v1/web/search",
          ({ request }) => {
            requestUrl = request.url
            return Response.json({ web: { results: [] } })
          }
        )
      )

      await service.searchReferences("test & query")
      expect(requestUrl).toContain(encodeURIComponent("test & query"))
    })
  })

  describe("factCheck", () => {
    it("should process multiple claims", async () => {
      const content =
        "First claim. Second claim. Third claim that is long enough."
      const results = await service.factCheck(content)

      expect(results).toHaveLength(1)
      expect(results[0]).toMatchObject({
        claim: expect.any(String),
        references: expect.arrayContaining([
          expect.objectContaining({
            title: expect.any(String),
            url: expect.any(String)
          })
        ])
      })
    })

    it("should filter out short claims", async () => {
      const content = "Short. This is a longer claim that should be included."
      const results = await service.factCheck(content)

      expect(results).toHaveLength(1)
      expect(results[0].claim).toBe(
        "This is a longer claim that should be included"
      )
    })
  })
})
