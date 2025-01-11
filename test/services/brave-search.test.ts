import { describe, it, expect } from "vitest"
import { BraveSearchService } from "../../cloudflare-worker/services/brave-search"
import { mockEnv } from "../setup"
import { server, http } from "../setup"

describe("BraveSearchService", () => {
  const service = new BraveSearchService(mockEnv.BRAVE_SEARCH_API_KEY)

  describe("searchBrave", () => {
    it("should fetch search results successfully", async () => {
      server.use(
        http.get("https://api.search.brave.com/res/v1/web/search", () => {
          return Response.json({
            web: {
              results: [
                {
                  title: "Web Result",
                  url: "https://test.com",
                  description: "A web result"
                }
              ]
            },
            news: {
              results: [
                {
                  title: "News Result",
                  url: "https://news.com",
                  description: "A news result",
                  age: "2d",
                  meta_url: { hostname: "news.com" }
                }
              ]
            },
            faq: {
              results: [
                {
                  title: "FAQ Result",
                  url: "https://faq.com",
                  question: "Test question?",
                  answer: "Test answer"
                }
              ]
            },
            mixed: {
              main: [{ type: "web" }, { type: "news" }, { type: "faq" }]
            }
          })
        })
      )

      const results = await service["processSearchResults"]("test query")
      expect(results).toHaveLength(3)
      expect(results[0]).toMatchObject({
        title: "Web Result",
        url: "https://test.com",
        description: "A web result"
      })
      expect(results[1]).toMatchObject({
        title: "News Result (2d - news.com)",
        url: "https://news.com",
        description: "A news result"
      })
      expect(results[2]).toMatchObject({
        title: "FAQ Result",
        url: "https://faq.com",
        description: "Q: Test question?\nA: Test answer"
      })
    })

    it("should handle API errors", async () => {
      server.use(
        http.get("https://api.search.brave.com/res/v1/web/search", () => {
          return new Response("API Error", { status: 500 })
        })
      )

      await expect(service["searchBrave"]("test query")).rejects.toThrow(
        "Brave search failed"
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

      await service["searchBrave"]("test & query")
      expect(requestUrl).toContain(encodeURIComponent("test & query"))
    })

    it("should limit results to 5", async () => {
      server.use(
        http.get("https://api.search.brave.com/res/v1/web/search", () => {
          return Response.json({
            web: {
              results: Array(10).fill({
                title: "Web Result",
                url: "https://test.com",
                description: "A web result"
              })
            },
            mixed: {
              main: Array(10).fill({ type: "web" })
            }
          })
        })
      )

      const results = await service["processSearchResults"]("test query")
      expect(results).toHaveLength(5)
    })
  })

  describe("factCheck", () => {
    it("should process multiple claims", async () => {
      const content =
        "This is a substantial claim about testing. Another significant claim about verification. A third important claim about validation."
      const results = await service.factCheck(content)

      expect(results.length).toBeGreaterThan(0)
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
      const content =
        "Short. This is a longer and more substantial claim that should be included."
      const results = await service.factCheck(content)

      expect(results).toHaveLength(1)
      expect(results[0].claim).toBe(
        "This is a longer and more substantial claim that should be included"
      )
    })

    it("should limit to first 3 substantial claims", async () => {
      const content = Array(5)
        .fill("This is a substantial claim that should be processed")
        .join(". ")
      const results = await service.factCheck(content)

      expect(results.length).toBeLessThanOrEqual(3)
    })

    it("should filter out claims with no references", async () => {
      server.use(
        http.get("https://api.search.brave.com/res/v1/web/search", () => {
          return Response.json({ web: { results: [] } })
        })
      )

      const content = "This is a substantial claim that should be processed"
      const results = await service.factCheck(content)

      expect(results).toHaveLength(0)
    })
  })
})
