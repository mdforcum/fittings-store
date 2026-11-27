// Reads one survey photo with Claude's vision API and returns the facts on it.
import { strictSchema } from "./strict-schema";
import type { CaptureKind } from "./match";
import { READING_SCHEMA, cleanReading, readingPrompt, type Reading } from "./reading";
import { env } from "./server";

export const visionReady = (): boolean => !!env.anthropic;

export class VisionError extends Error {}

/** Sends the photo and gets back a filled-in reading. Throws VisionError with a plain message on failure. */
export async function readPhoto(kind: CaptureKind, bytes: Buffer, mediaType: string): Promise<Reading> {
  const input = await askVision({
    system: readingPrompt(kind),
    tool: "record_reading",
    description: "Record what this inventory photo shows.",
    schema: READING_SCHEMA,
    images: [{ bytes, mediaType }],
    text: "Record what this photo shows.",
  });
  return cleanReading(input);
}

/**
 * Asks Claude to fill in one tool call from one or more photos, and returns
 * the tool's input as sent. Throws VisionError with a plain message on failure.
 */
export async function askVision(opts: {
  system: string;
  tool: string;
  description: string;
  schema: Record<string, unknown>;
  images: Array<{ bytes: Buffer; mediaType: string; caption?: string }>;
  text: string;
  maxTokens?: number;
  /** How long to wait for an answer. Many photos and a long reply need more than the usual 45 seconds. */
  timeoutMs?: number;
}): Promise<unknown> {
  if (!env.anthropic) throw new VisionError("Photo reading is not switched on yet.");
  const content: Array<Record<string, unknown>> = [];
  for (const img of opts.images) {
    if (img.caption) content.push({ type: "text", text: img.caption });
    content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.bytes.toString("base64") } });
  }
  content.push({ type: "text", text: opts.text });
  // Current models do not accept a forced tool choice. The tool is offered with
  // tool_choice "auto" and a strict schema, and the prompt says to always call it.
  const system = `${opts.system}\n\nAlways answer by calling the ${opts.tool} tool exactly once. Do not reply in text.`;
  let strict = true;
  for (let attempt = 0; attempt < 3; attempt++) {
    const tool: Record<string, unknown> = {
      name: opts.tool,
      description: opts.description,
      input_schema: strict ? strictSchema(opts.schema) : opts.schema,
    };
    if (strict) tool.strict = true;
    let res: Response;
    try {
      res = await fetch(`${env.anthropicBase}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.anthropic,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: env.anthropicModel,
          max_tokens: opts.maxTokens ?? 1024,
          system,
          tools: [tool],
          tool_choice: { type: "auto" },
          messages: [{ role: "user", content }],
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 45_000),
        cache: "no-store",
      });
    } catch {
      throw new VisionError("The photo reader did not answer in time.");
    }
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      const message = detail?.error?.message ?? "";
      console.error("vision request failed", res.status, message);
      // A schema the strict checker will not take: ask again without strict.
      if (res.status === 400 && strict && /strict|schema/i.test(message)) {
        strict = false;
        continue;
      }
      if (res.status === 401) throw new VisionError("The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in Vercel.");
      if (res.status === 404) throw new VisionError(`The model "${env.anthropicModel}" was not found. Check ANTHROPIC_MODEL in Vercel.`);
      if (res.status === 429 || res.status === 529) throw new VisionError("The photo reader is busy. Try again in a minute.");
      throw new VisionError((message || "The photo could not be read.").slice(0, 200));
    }
    const body = (await res.json()) as { content?: Array<{ type: string; name?: string; input?: unknown }> };
    const call = body.content?.find((block) => block.type === "tool_use" && block.name === opts.tool);
    if (call) return call.input;
    // Answered in words instead of the tool: ask once more.
  }
  throw new VisionError("The photo reader returned nothing usable. Try again.");
}
