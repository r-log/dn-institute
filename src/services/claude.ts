interface ClaudeResponse {
  completion: string;
  stop_reason: string | null;
}

export class ClaudeService {
  private apiKey: string;
  private baseUrl = 'https://api.anthropic.com/v1';
  private model = 'claude-2.1';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async analyzeArticle(content: string): Promise<string> {
    const prompt = `
      You are a quality assurance bot for a crypto attack wiki. Please analyze the following article content and provide feedback on:
      1. Factual accuracy and completeness
      2. Technical accuracy of descriptions
      3. Writing style and clarity
      4. Compliance with wiki standards
      5. Any missing critical information

      Article content:
      ${content}

      Please provide your analysis in a clear, structured format suitable for a GitHub comment.
    `;

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{
          role: 'user',
          content: prompt
        }],
        max_tokens: 1000,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Claude API error: ${response.statusText} - ${errorText}`);
    }

    const data = await response.json() as { content: Array<{ text: string }> };
    return data.content[0].text;
  }
} 