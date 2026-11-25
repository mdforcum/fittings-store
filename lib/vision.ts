// Reads one survey photo with Claude's vision API and returns the facts on it.
import type { CaptureKind } from "./match";
import { READING_SCHEMA, cleanReading, readingPrompt, type Reading } from "./reading";
import { env } from "./server";

export const visionReady = (): boolean => !!env.anthropic;

export class VisionError extends Error {}

/** Sends the photo and gets back a filled-in reading. Throws VisionError with a plain message on failure. */
export async function readPhoto(kind: CaptureKind, bytes: Buffer, mediaType: string): Promise<Reading> {
  if (!env.anthropic) throw new VisionError("Photo reading is not switched on yet.");
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
        max_tokens: 1024,
        system: readingPrompt(kind),
        tools: [
          {
            name: "record_reading",
            description: "Record what this inventory photo shows.",
            input_schema: READING_SCHEMA,
          },
        ],
        tool_choice: { type: "tool", name: "record_reading" },
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") } },
              { type: "text", text: "Record what this photo shows." },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
      cache: "no-store",
    });
  } catch {
    throw new VisionError("The photo reader did not answer in time.");
  }
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    console.error("vision request failed", res.status, detail?.error?.message);
    if (res.status === 401) throw new VisionError("The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in Vercel.");
    if (res.status === 404) throw new VisionError(`The model "${env.anthropicModel}" was not found. Check ANTHROPIC_MODEL in Vercel.`);
    if (res.status === 429 || res.status === 529) throw new VisionError("The photo reader is busy. Try again in a minute.");
    throw new VisionError((detail?.error?.message ?? "The photo could not be read.").slice(0, 200));
  }
  const body = (await res.json()) as { content?: Array<{ type: string; name?: string; input?: unknown }> };
  const call = body.content?.find((block) => block.type === "tool_use" && block.name === "record_reading");
  if (!call) throw new VisionError("The photo reader returned nothing usable.");
  return cleanReading(call.input);
}
