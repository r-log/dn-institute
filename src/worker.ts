/// <reference types="@cloudflare/workers-types" />
import { Octokit } from "@octokit/rest"
import { WebhookEvent, IssueCommentEvent } from "@octokit/webhooks-types"
import { verify } from "@octokit/webhooks-methods"
import { ClaudeService } from "./services/claude"
import { BraveSearchService } from "./services/brave-search"
import { GitHubService } from "./services/github"

interface Env {
  GITHUB_TOKEN: string
  ANTHROPIC_API_KEY: string
  BRAVE_SEARCH_API_KEY: string
  GITHUB_WEBHOOK_SECRET: string
  RATE_LIMIT_KV: KVNamespace
}

const RATE_LIMIT = {
  MAX_REQUESTS: 100,
  WINDOW_SIZE: 3600 // 1 hour in seconds
}

async function checkRateLimit(kv: KVNamespace, ip: string): Promise<boolean> {
  try {
    const now = Math.floor(Date.now() / 1000)
    const windowStart = now - RATE_LIMIT.WINDOW_SIZE
    const key = `ratelimit:${ip}`

    // Get current requests with error handling
    let requests: number[] = []
    try {
      const storedRequests = await kv.get(key, { type: "json" })
      requests = Array.isArray(storedRequests) ? storedRequests : []
    } catch {
      requests = []
    }

    // Filter out old requests and add new one
    const validRequests = requests.filter((time) => time > windowStart)
    validRequests.push(now)

    // Update KV store
    try {
      await kv.put(key, JSON.stringify(validRequests), {
        expirationTtl: RATE_LIMIT.WINDOW_SIZE
      })
    } catch {
      // Ignore KV store errors to prevent blocking legitimate traffic
    }

    // Return true if the request should be BLOCKED (over limit)
    return validRequests.length > RATE_LIMIT.MAX_REQUESTS
  } catch {
    return false // Allow request on error to prevent blocking legitimate traffic
  }
}

async function validateRequest(
  request: Request,
  env: Env
): Promise<Response | null> {
  // Validate environment variables
  const requiredEnvVars = [
    "GITHUB_TOKEN",
    "ANTHROPIC_API_KEY",
    "BRAVE_SEARCH_API_KEY",
    "GITHUB_WEBHOOK_SECRET"
  ]
  const missingEnvVars = requiredEnvVars.filter((key) => !env[key as keyof Env])
  if (missingEnvVars.length > 0) {
    console.error("Missing required environment variables:", missingEnvVars)
    return new Response("Missing required environment variables", {
      status: 500
    })
  }

  // Check rate limit
  const clientIP = request.headers.get("cf-connecting-ip") || "unknown"
  const isOverLimit = await checkRateLimit(env.RATE_LIMIT_KV, clientIP)
  if (isOverLimit) {
    return new Response("Rate limit exceeded", {
      status: 429,
      headers: {
        "Retry-After": RATE_LIMIT.WINDOW_SIZE.toString()
      }
    })
  }

  // Verify webhook signature
  const signature = request.headers.get("x-hub-signature-256")
  if (!signature) {
    return new Response("No signature", { status: 401 })
  }

  const rawBody = await request.clone().text()
  const isValid = await verify(env.GITHUB_WEBHOOK_SECRET, rawBody, signature)
  if (!isValid) {
    return new Response("Invalid signature", { status: 401 })
  }

  return null
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    try {
      // Validate request and check rate limits
      const validationError = await validateRequest(request, env)
      if (validationError) return validationError

      const rawBody = await request.clone().text()
      const payload = JSON.parse(rawBody) as WebhookEvent

      // Handle issue_comment events for PR comments
      if (
        "issue" in payload &&
        "comment" in payload &&
        payload.action === "created"
      ) {
        const event = payload as IssueCommentEvent
        if (event.issue.pull_request && event.comment.body) {
          const comment = event.comment.body

          // Check if the comment contains the trigger command
          if (comment.includes("/articlecheck")) {
            const githubService = new GitHubService(env.GITHUB_TOKEN)
            const claudeService = new ClaudeService(env.ANTHROPIC_API_KEY)
            const braveSearchService = new BraveSearchService(
              env.BRAVE_SEARCH_API_KEY
            )

            // Extract PR details
            const prUrl = event.issue.pull_request.url
            if (!prUrl) {
              return new Response("Invalid PR URL", { status: 400 })
            }

            const prDetails = GitHubService.extractPRDetails(prUrl)

            try {
              // Use waitUntil for background tasks
              ctx.waitUntil(
                githubService.createComment(
                  prDetails.owner,
                  prDetails.repo,
                  event.issue.number,
                  "⏳ Processing article check request..."
                )
              )

              // Get PR content with timeout
              const contentPromise = Promise.race([
                githubService.getPRContent(
                  prDetails.owner,
                  prDetails.repo,
                  prDetails.number
                ),
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error("Timeout")), 30000)
                )
              ])
              const content = await contentPromise

              // Analyze with Claude
              const analysis = await claudeService.analyzeArticle(content)

              // Fact check with Brave Search
              const factChecking = await braveSearchService.factCheck(content)

              // Prepare the comment with error handling for markdown
              const comment = `## Article Check Results

### AI Analysis
${analysis || "*Error: Could not generate analysis*"}

### Fact Checking Results
${
  factChecking.length > 0
    ? factChecking
        .map(
          (result) => `
**Claim:** ${result.claim}
**References:**
${result.references.map((ref) => `- [${ref.title}](${ref.url})`).join("\n")}
`
        )
        .join("\n")
    : "*No claims to fact check*"
}

---
*This check was performed automatically by the Article Checker bot.*
*Processing time: ${
                Date.now() - new Date(event.comment.created_at).getTime()
              }ms*`

              // Post the comment
              await githubService.createComment(
                prDetails.owner,
                prDetails.repo,
                event.issue.number,
                comment
              )

              return new Response("Article check completed", {
                status: 200,
                headers: {
                  "Content-Type": "application/json"
                }
              })
            } catch (error) {
              console.error("Error processing article check:", error)
              const errorMessage =
                error instanceof Error ? error.message : "Unknown error"

              // Post error as comment with more details
              await githubService.createComment(
                prDetails.owner,
                prDetails.repo,
                event.issue.number,
                `❌ Error checking article:
\`\`\`
${errorMessage}
\`\`\`
Please try again later or contact support if the issue persists.`
              )

              return new Response(JSON.stringify({ error: errorMessage }), {
                status: 500,
                headers: {
                  "Content-Type": "application/json"
                }
              })
            }
          }
        }
      }

      return new Response("Event processed", { status: 200 })
    } catch (error) {
      console.error("Error processing webhook:", error)
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: {
          "Content-Type": "application/json"
        }
      })
    }
  }
}
