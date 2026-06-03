type AdfNode = {
  type?: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
};

export function adfToPlainText(node: unknown, depth = 0): string {
  if (!node || typeof node !== "object") return "";
  const n = node as AdfNode;

  switch (n.type) {
    case "text":
      return typeof n.text === "string" ? n.text : "";
    case "hardBreak":
    case "rule":
      return "\n";
    case "paragraph":
    case "heading":
      return (n.content?.map((c) => adfToPlainText(c, depth)).join("") ?? "") + "\n";
    case "bulletList":
    case "orderedList":
      return (n.content?.map((c) => adfToPlainText(c, depth + 1)).join("") ?? "") + "\n";
    case "listItem":
      return (
        "  ".repeat(depth) +
        "- " +
        (n.content?.map((c) => adfToPlainText(c, depth)).join("").trim() ?? "") +
        "\n"
      );
    case "blockquote":
      return (
        (n.content?.map((c) => adfToPlainText(c, depth)).join("") ?? "")
          .split("\n")
          .map((l) => "> " + l)
          .join("\n") + "\n"
      );
    case "codeBlock": {
      const lang = n.attrs?.language ? `(${n.attrs.language}) ` : "";
      return `[CODE ${lang}${n.content?.map((c) => adfToPlainText(c)).join("") ?? ""}]\n`;
    }
    case "panel": {
      const ptype = String(n.attrs?.panelType ?? "info").toUpperCase();
      return `[${ptype}] ` + (n.content?.map((c) => adfToPlainText(c, depth)).join("") ?? "");
    }
    case "table":
      return (n.content?.map((c) => adfToPlainText(c, depth)).join("") ?? "") + "\n";
    case "tableRow":
      return (n.content?.map((c) => adfToPlainText(c, depth)).join(" | ") ?? "") + "\n";
    case "tableCell":
    case "tableHeader":
      return n.content?.map((c) => adfToPlainText(c, depth)).join("").trim() ?? "";
    case "mention":
      return `@${String(n.attrs?.text ?? n.attrs?.id ?? "user")}`;
    case "emoji":
      return String(n.attrs?.text ?? "");
    case "inlineCard":
    case "blockCard":
      return String(n.attrs?.url ?? "");
    case "mediaGroup":
    case "mediaSingle":
      return "[attachment]\n";
    default:
      if (Array.isArray(n.content)) {
        return n.content.map((c) => adfToPlainText(c, depth)).join("");
      }
      return "";
  }
}

export type AdfMediaRef = {
  id?: string;
  collection?: string;
  mediaType?: string;
  alt?: string;
};

/**
 * Walk an ADF tree and collect inline media node references (images/files
 * pasted into the description or a comment). These carry a media-services id;
 * we resolve the actual bytes via the issue's attachment list in media-context.
 */
export function extractMediaRefs(node: unknown, acc: AdfMediaRef[] = []): AdfMediaRef[] {
  if (!node || typeof node !== "object") return acc;
  const n = node as AdfNode;
  if (n.type === "media") {
    acc.push({
      id: typeof n.attrs?.id === "string" ? n.attrs.id : undefined,
      collection:
        typeof n.attrs?.collection === "string" ? n.attrs.collection : undefined,
      mediaType: typeof n.attrs?.type === "string" ? n.attrs.type : undefined,
      alt: typeof n.attrs?.alt === "string" ? n.attrs.alt : undefined,
    });
  }
  if (Array.isArray(n.content)) {
    for (const c of n.content) extractMediaRefs(c, acc);
  }
  return acc;
}

export function extractAcceptanceLines(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const ac: string[] = [];
  let inAcSection = false;

  for (const line of lines) {
    // Section header detection
    if (
      /^(acceptance criteria|ac|definition of done|dod|done when|done criteria)\s*:?\s*$/i.test(
        line,
      )
    ) {
      inAcSection = true;
      continue;
    }
    // Exit AC section on next markdown header
    if (inAcSection && /^#+\s/.test(line)) {
      inAcSection = false;
    }
    if (inAcSection && line.length > 0) {
      ac.push(line.replace(/^[-*•\d.]+\s*/, "").trim());
      continue;
    }
    // Inline AC patterns
    if (/^(given|when|then)\b/i.test(line)) ac.push(line);
    if (/\b(must|should|shall)\b.{5,}/i.test(line) && ac.length < 20) ac.push(line);
  }
  return ac.slice(0, 20);
}

/** Extract a "Steps to Reproduce" / "Steps" section from a ticket description. */
export function extractStepsToReproduce(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const steps: string[] = [];
  let inSection = false;

  for (const line of lines) {
    if (
      /^(steps to reproduce|steps to repro|reproduction steps|repro steps|steps)\s*:?\s*$/i.test(
        line,
      )
    ) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (line.length === 0) {
      // Allow a single blank line inside the list; stop on a header.
      continue;
    }
    // Stop when we hit another section header.
    if (/^#+\s/.test(line) || /^(acceptance criteria|expected|actual result|expected result)\b/i.test(line)) {
      break;
    }
    const cleaned = line.replace(/^[-*•]\s*/, "").replace(/^\d+[.)]\s*/, "").trim();
    if (cleaned) steps.push(cleaned);
  }
  return steps.slice(0, 30);
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "for", "of", "in", "on", "is", "are", "was", "be",
  "with", "this", "that", "from", "as", "at", "by", "it", "we", "should", "will", "can",
  "not", "get", "set", "new", "use", "has", "have", "had", "do", "did", "does", "been",
  "but", "if", "so", "up", "out", "no", "its", "my", "our", "your", "their", "they",
  "also", "when", "which", "than", "then", "all", "any", "more", "would", "could",
  "into", "over", "after", "before", "about", "each", "such", "just", "make", "like",
]);

export function keywordsFromText(...parts: string[]): string[] {
  const words = parts
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return [...new Set(words)].slice(0, 15);
}
