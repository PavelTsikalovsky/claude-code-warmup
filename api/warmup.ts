import type { VercelRequest, VercelResponse } from "@vercel/node";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

class AnthropicApiError extends Error {
    constructor(
        public readonly status: number,
        public readonly statusText: string,
        public readonly responseBody: string
    ) {
        super(
            `Anthropic API error: ${status} ${statusText} — ${responseBody}`
        );
        this.name = "AnthropicApiError";
    }
}

const DEFAULT_WARMUP_MESSAGE =
    "Hello! This is an automated warm-up message to reset my Claude Code rate limit window. Please just say 'Warmed up!' in response.";

/**
 * Send a single warm-up message to the Claude API using a long-lived OAuth token.
 */
async function sendWarmupMessage(
    oauthToken: string,
    message: string
): Promise<string> {
    const response = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${oauthToken}`,
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
        },
        body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 64,
            messages: [{ role: "user", content: message }],
        }),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new AnthropicApiError(response.status, response.statusText, text);
    }

    const data = (await response.json()) as {
        content: Array<{ type: string; text: string }>;
    };

    return data.content.find((b) => b.type === "text")?.text ?? "(no text)";
}

export default async function handler(
    req: VercelRequest,
    res: VercelResponse
) {
    // Only allow authorized cron invocations.
    // Expected header: Authorization: Bearer <CRON_SECRET>
    const cronSecret = process.env.CRON_SECRET;
    console.log(
        `[warmup] debug: CRON_SECRET set=${!!cronSecret}, auth present=${!!req.headers.authorization}`
    );
    if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
        console.error(`[warmup] ✗ Error at ${new Date().toISOString()}: Unauthorized request. Missing or invalid CRON_SECRET.`);
        return res.status(401).json({ error: "Unauthorized" });
    }

    const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!oauthToken) {
        return res.status(500).json({
            error: "CLAUDE_CODE_OAUTH_TOKEN env var is not set. Run `claude setup-token` to generate a long-lived token.",
        });
    }

    const warmupMessage = process.env.WARMUP_MESSAGE || DEFAULT_WARMUP_MESSAGE;
    const timestamp = new Date().toISOString();

    try {
        const reply = await sendWarmupMessage(oauthToken, warmupMessage);

        console.log(`[warmup] ✓ Success at ${timestamp}. Claude replied: "${reply}"`);

        return res.status(200).json({
            success: true,
            message: "Warmup sent successfully!",
            claudeReply: reply,
            timestamp,
        });
    } catch (err) {
        if (err instanceof AnthropicApiError) {
            // Endpoint depends on Anthropic API, so report upstream failures explicitly.
            const status = err.status === 429 ? 429 : 502;
            console.error(
                `[warmup] ✗ Error at ${timestamp}: upstream=${err.status} ${err.statusText}`
            );
            return res.status(status).json({
                success: false,
                error: "Anthropic upstream request failed",
                upstreamStatus: err.status,
                timestamp,
            });
        }

        const error = err instanceof Error ? err.message : String(err);
        console.error(`[warmup] ✗ Error at ${timestamp}: ${error}`);
        return res.status(500).json({ success: false, error, timestamp });
    }
}
