import type { JiraConfig } from "../jira-client.js";
import { jiraFetchBinary } from "../jira-client.js";
import type { IssueResponse } from "../jira/issue-types.js";
import type { AdfMediaRef } from "./adf.js";

export type MediaCategory =
  | "image"
  | "pdf"
  | "video"
  | "text"
  | "office"
  | "archive"
  | "unknown";

export type MediaAnalysisItem = {
  filename: string;
  mimeType: string;
  size: number;
  category: MediaCategory;
  analysis?: string;
  skipped: boolean;
  skip_reason?: string;
};

export type MediaContext = {
  attachment_count: number;
  analyzed_count: number;
  skipped_count: number;
  combined_summary: string;
  items: MediaAnalysisItem[];
  warning?: string;
};

export type MediaAnalysisConfig = {
  enabled: boolean;
  mode: "full" | "images_only" | "off";
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  vision: {
    apiKey?: string;
    baseUrl: string;
    model: string;
  };
};

type JiraAttachment = {
  id?: string;
  filename?: string;
  mimeType?: string;
  content?: string;
  size?: number;
};

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const TEXT_EXT = /\.(txt|log|csv|md|json|xml|ya?ml|html?|tsx?|jsx?|java|py|rb|cs|sql)$/i;
const OFFICE_EXT = /\.(docx?|xlsx?|pptx?|odt|ods)$/i;
const ARCHIVE_EXT = /\.(zip|tar|gz|tgz|rar|7z)$/i;
const VIDEO_EXT = /\.(mp4|mov|avi|mkv|webm)$/i;
const MAX_TEXT_CHARS = 4000;

/** Resolve media-analysis settings from env + optional repo `.jiraflow.yaml` block. */
export function resolveMediaConfig(repoOverride?: {
  enabled?: boolean;
  mode?: "full" | "images_only" | "off";
  max_files?: number;
}): MediaAnalysisConfig {
  const envEnabled = process.env.MEDIA_ANALYSIS_ENABLED;
  const apiKey =
    process.env.VISION_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
  // Opt-in by default: media analysis only runs when the developer explicitly
  // asks for it (analyze_media=true at the tool layer), or when a team turns it
  // on via repo `.jiraflow.yaml` or MEDIA_ANALYSIS_ENABLED. The mere presence of
  // a vision API key does NOT auto-enable it — this keeps per-ticket token cost
  // predictable (base Jira context only) unless media is requested.
  const enabled =
    repoOverride?.enabled ??
    (envEnabled ? /^(1|true|yes|on)$/i.test(envEnabled) : false);
  return {
    enabled,
    mode: repoOverride?.mode ?? "full",
    maxFiles: repoOverride?.max_files ?? numFromEnv("MEDIA_MAX_FILES", 6),
    maxFileBytes: numFromEnv("MEDIA_MAX_FILE_BYTES", 8 * 1024 * 1024),
    maxTotalBytes: numFromEnv("MEDIA_MAX_TOTAL_BYTES", 24 * 1024 * 1024),
    vision: {
      apiKey,
      baseUrl: (
        process.env.VISION_BASE_URL?.trim() || "https://api.openai.com/v1"
      ).replace(/\/+$/, ""),
      model: process.env.VISION_MODEL?.trim() || "gpt-4o-mini",
    },
  };
}

function numFromEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export async function analyzeTicketMedia(opts: {
  cfg: JiraConfig;
  issue: IssueResponse;
  config: MediaAnalysisConfig;
  mediaRefs?: AdfMediaRef[];
  focusHint?: string;
}): Promise<MediaContext> {
  const { cfg, issue, config } = opts;
  const attachments = (issue.fields?.attachment as JiraAttachment[] | undefined) ?? [];
  const items: MediaAnalysisItem[] = [];

  const base: MediaContext = {
    attachment_count: attachments.length,
    analyzed_count: 0,
    skipped_count: 0,
    combined_summary: "",
    items,
  };

  if (config.mode === "off" || !config.enabled) {
    base.warning = "Media analysis is disabled.";
    return base;
  }
  if (attachments.length === 0) {
    base.combined_summary = "_No attachments on this ticket._";
    return base;
  }

  let totalBytes = 0;
  let analyzed = 0;

  for (const att of attachments) {
    if (analyzed >= config.maxFiles) {
      items.push(skip(att, classify(att), "max_files budget reached"));
      continue;
    }
    const category = classify(att);
    const size = Number(att.size ?? 0);

    if (config.mode === "images_only" && category !== "image") {
      items.push(skip(att, category, "images_only mode"));
      continue;
    }
    if (size && size > config.maxFileBytes) {
      items.push(skip(att, category, `exceeds per-file cap (${size} bytes)`));
      continue;
    }
    if (!att.content) {
      items.push(skip(att, category, "no download URL"));
      continue;
    }
    if (category === "image" && !config.vision.apiKey) {
      items.push(skip(att, category, "no vision API key configured"));
      continue;
    }
    if (category !== "image" && category !== "text") {
      items.push(skip(att, category, `unsupported for analysis (${category})`));
      continue;
    }

    try {
      const bin = await jiraFetchBinary(cfg, att.content, {
        maxBytes: config.maxFileBytes,
      });
      totalBytes += bin.bytes;
      if (totalBytes > config.maxTotalBytes) {
        items.push(skip(att, category, "total download budget reached"));
        break;
      }

      let analysis: string | undefined;
      if (category === "image") {
        analysis = await analyzeImage(
          bin.buffer,
          bin.contentType || att.mimeType || "image/png",
          config.vision,
          opts.focusHint,
        );
      } else {
        analysis = decodeText(bin.buffer);
      }

      items.push({
        filename: att.filename ?? "attachment",
        mimeType: att.mimeType ?? bin.contentType,
        size: bin.bytes,
        category,
        analysis,
        skipped: false,
      });
      analyzed++;
    } catch (e) {
      items.push(
        skip(att, category, e instanceof Error ? e.message : String(e)),
      );
    }
  }

  base.analyzed_count = items.filter((i) => !i.skipped).length;
  base.skipped_count = items.filter((i) => i.skipped).length;
  base.combined_summary = renderCombined(items);
  if (base.analyzed_count === 0 && attachments.length > 0) {
    base.warning =
      "Attachments present but none could be analyzed (see per-item skip reasons).";
  }
  return base;
}

function classify(att: JiraAttachment): MediaCategory {
  const mime = (att.mimeType ?? "").toLowerCase();
  const name = (att.filename ?? "").toLowerCase();
  if (mime.startsWith("image/") || IMAGE_EXT.test(name)) return "image";
  if (mime === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (mime.startsWith("video/") || VIDEO_EXT.test(name)) return "video";
  if (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    TEXT_EXT.test(name)
  ) {
    return "text";
  }
  if (OFFICE_EXT.test(name) || mime.includes("officedocument") || mime.includes("msword")) {
    return "office";
  }
  if (ARCHIVE_EXT.test(name) || mime.includes("zip") || mime.includes("compressed")) {
    return "archive";
  }
  return "unknown";
}

function skip(
  att: JiraAttachment,
  category: MediaCategory,
  reason: string,
): MediaAnalysisItem {
  return {
    filename: att.filename ?? "attachment",
    mimeType: att.mimeType ?? "application/octet-stream",
    size: Number(att.size ?? 0),
    category,
    skipped: true,
    skip_reason: reason,
  };
}

function decodeText(buf: Buffer): string {
  const text = buf.toString("utf8").replace(/\u0000/g, "").trim();
  if (text.length <= MAX_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_TEXT_CHARS)}\n…[truncated]`;
}

async function analyzeImage(
  buffer: Buffer,
  mime: string,
  vision: MediaAnalysisConfig["vision"],
  focusHint?: string,
): Promise<string> {
  const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
  const prompt =
    "You are analyzing an image attached to a software ticket. In 4-8 concise " +
    "bullet points describe: the screen/page shown, key UI elements and their " +
    "labels, any error or validation messages (quote them verbatim), the user " +
    "state, and anything an engineer needs to reproduce or implement this. Do " +
    "not speculate beyond what is visible." +
    (focusHint ? `\nTicket context: ${focusHint}` : "");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const res = await fetch(`${vision.baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${vision.apiKey}`,
      },
      body: JSON.stringify({
        model: vision.model,
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`vision API ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("vision API returned no content");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

function renderCombined(items: MediaAnalysisItem[]): string {
  const analyzed = items.filter((i) => !i.skipped && i.analysis);
  if (analyzed.length === 0) return "_No media could be analyzed._";
  const md: string[] = [];
  for (const item of analyzed) {
    md.push(`### ${item.filename} (${item.category})`);
    md.push(item.analysis ?? "");
    md.push("");
  }
  const skipped = items.filter((i) => i.skipped);
  if (skipped.length) {
    md.push("#### Not analyzed");
    for (const s of skipped) {
      md.push(`- \`${s.filename}\` (${s.category}) — ${s.skip_reason}`);
    }
  }
  return md.join("\n").trim();
}
