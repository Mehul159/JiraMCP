export type ToolResult<T extends Record<string, unknown> = Record<string, unknown>> = {
  success: boolean;
  message: string;
  data: T;
};

export function ok<T extends Record<string, unknown>>(
  message: string,
  data: T,
): ToolResult<T> {
  return { success: true, message, data };
}

export function fail<T extends Record<string, unknown>>(
  message: string,
  data: T,
): ToolResult<T> {
  return { success: false, message, data };
}

export function toMcpContent(result: ToolResult): {
  content: [{ type: "text"; text: string }];
} {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}
