interface BraveSearchResponse {
  web: {
    results: Array<{
      title: string;
      description: string;
      url: string;
    }>;
  };
}

export class BraveSearchService {
  private apiKey: string;
  private baseUrl = 'https://api.search.brave.com/res/v1';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async searchReferences(query: string): Promise<Array<{ title: string; url: string }>> {
    const response = await fetch(`${this.baseUrl}/web/search?q=${encodeURIComponent(query)}`, {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': this.apiKey
      }
    });

    if (!response.ok) {
      throw new Error(`Brave Search API error: ${response.statusText}`);
    }

    const data = await response.json() as BraveSearchResponse;
    return data.web.results.map(result => ({
      title: result.title,
      url: result.url
    }));
  }

  async factCheck(content: string): Promise<Array<{ claim: string; references: Array<{ title: string; url: string }> }>> {
    // Extract key claims from content (simplified version)
    const claims = content
      .split('.')
      .filter(sentence => sentence.trim().length > 20)
      .slice(0, 3); // Limit to first 3 substantial sentences for main claims

    const results = await Promise.all(
      claims.map(async claim => ({
        claim: claim.trim(),
        references: await this.searchReferences(claim)
      }))
    );

    return results;
  }
} 