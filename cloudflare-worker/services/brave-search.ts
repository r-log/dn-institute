export interface SearchResult {
  claim: string
  references: Array<{ title: string; url: string }>
}

interface BraveSearchResult {
  title: string
  url: string
  description: string
}

interface BraveAPIResponse {
  web?: {
    results: Array<{
      title: string
      url: string
      description: string
    }>
  }
  news?: {
    results: Array<{
      title: string
      url: string
      description: string
      age: string
      meta_url: {
        hostname: string
      }
    }>
  }
  faq?: {
    results: Array<{
      title: string
      url: string
      question: string
      answer: string
    }>
  }
  mixed?: {
    main: Array<{
      type: "web" | "news" | "faq"
    }>
  }
}

export class BraveSearchService {
  private readonly apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  private async searchBrave(query: string): Promise<BraveAPIResponse> {
    const headers = {
      Accept: "application/json",
      "X-Subscription-Token": this.apiKey
    }

    const response = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(
        query
      )}&count=20`,
      { headers }
    )

    if (!response.ok) {
      console.error("Brave search failed:", await response.text())
      throw new Error(`Brave search failed: ${response.statusText}`)
    }

    return response.json()
  }

  private removeStrong(text: string): string {
    return text
      .replace(/<strong>/g, "")
      .replace(/<\/strong>/g, "")
      .replace(/&#x27;/g, "'")
  }

  private async processSearchResults(
    query: string
  ): Promise<BraveSearchResult[]> {
    const response = await this.searchBrave(query)
    const results: BraveSearchResult[] = []

    const ordering = response.mixed?.main || []
    const webResults = response.web?.results || []
    const newsResults = response.news?.results || []
    const faqResults = response.faq?.results || []

    let webIndex = 0
    let newsIndex = 0
    let faqIndex = 0

    for (const item of ordering) {
      if (results.length >= 5) break // Limit to 5 most relevant results

      switch (item.type) {
        case "web":
          if (webIndex < webResults.length) {
            const result = webResults[webIndex++]
            results.push({
              title: result.title,
              url: result.url,
              description: this.removeStrong(result.description)
            })
          }
          break

        case "news":
          if (newsIndex < newsResults.length) {
            const result = newsResults[newsIndex++]
            if (result.description.length >= 5) {
              results.push({
                title: `${result.title} (${result.age} - ${result.meta_url.hostname})`,
                url: result.url,
                description: this.removeStrong(result.description)
              })
            }
          }
          break

        case "faq":
          if (faqIndex < faqResults.length) {
            const result = faqResults[faqIndex++]
            results.push({
              title: result.title,
              url: result.url,
              description: `Q: ${result.question}\nA: ${result.answer}`
            })
          }
          break
      }
    }

    return results
  }

  async factCheck(content: string): Promise<SearchResult[]> {
    // Extract key claims (sentences that are substantial)
    const claims = content
      .split(".")
      .map((s) => s.trim())
      .filter((s) => s.length >= 20 && s.split(" ").length >= 5)
      .slice(0, 3) // Limit to first 3 substantial claims

    const results = await Promise.all(
      claims.map(async (claim) => {
        const searchResults = await this.processSearchResults(claim)
        return {
          claim,
          references: searchResults.map((result) => ({
            title: result.title,
            url: result.url
          }))
        }
      })
    )

    return results.filter((result) => result.references.length > 0)
  }
}
