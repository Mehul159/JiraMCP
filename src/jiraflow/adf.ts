type AdfNode = {
  type?: string;
  text?: string;
  content?: AdfNode[];
};

export function adfToPlainText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as AdfNode;
  if (n.type === "text" && typeof n.text === "string") return n.text;
  if (!Array.isArray(n.content)) return "";
  return n.content.map((c) => adfToPlainText(c)).join("");
}

export function extractAcceptanceLines(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const ac: string[] = [];
  for (const line of lines) {
    if (/^(ac|acceptance criteria|given|when|then)\b/i.test(line)) ac.push(line);
    else if (/^[-*•]\s+/.test(line) && ac.length > 0) ac.push(line);
    else if (/^\d+\.\s+/.test(line) && text.toLowerCase().includes("acceptance")) ac.push(line);
  }
  return ac.slice(0, 20);
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "for", "of", "in", "on", "is", "are", "was", "be",
  "with", "this", "that", "from", "as", "at", "by", "it", "we", "should", "will", "can",
]);

export function keywordsFromText(...parts: string[]): string[] {
  const words = parts
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return [...new Set(words)].slice(0, 12);
}
