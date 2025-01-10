import { Octokit } from '@octokit/rest';
import type { RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods';

type PullFile = RestEndpointMethodTypes['pulls']['listFiles']['response']['data'][0];
type RepoContent = RestEndpointMethodTypes['repos']['getContent']['response']['data'];

export class GitHubService {
  private octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  async getPRContent(owner: string, repo: string, pullNumber: number): Promise<string> {
    const { data: files } = await this.octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
    });

    // Get the content of added/modified markdown files
    const markdownFiles = files.filter((file: PullFile) => 
      (file.status === 'added' || file.status === 'modified') &&
      file.filename.endsWith('.md')
    );

    if (markdownFiles.length === 0) {
      throw new Error('No markdown files found in the PR');
    }

    // For each file, get its content
    const contents = await Promise.all(
      markdownFiles.map(async (file: PullFile) => {
        const { data } = await this.octokit.repos.getContent({
          owner,
          repo,
          path: file.filename,
          ref: file.sha, // Get content at this specific commit
        });

        if ('content' in data && typeof data.content === 'string') {
          return Buffer.from(data.content, 'base64').toString('utf-8');
        }
        return '';
      })
    );

    return contents.join('\n\n');
  }

  async createComment(owner: string, repo: string, issueNumber: number, body: string): Promise<void> {
    await this.octokit.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
  }

  static extractPRDetails(prUrl: string): { owner: string; repo: string; number: number } {
    // Expected format: https://api.github.com/repos/owner/repo/pulls/number
    const match = prUrl.match(/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)/);
    if (!match) {
      throw new Error('Invalid PR URL format');
    }

    return {
      owner: match[1],
      repo: match[2],
      number: parseInt(match[3], 10),
    };
  }
} 