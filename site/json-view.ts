/** Highlight serialized JSON without changing its text or interpreting it as HTML. */
export function highlightedJson(value: unknown): string {
  const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return JSON.stringify(value, null, 2).replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/gu,
    (token: string, string: string | undefined, key: string | undefined, literal: string | undefined) => {
      const kind = key ? "key" : string ? "string" : literal ? "literal" : "number";
      return `<span class="json-${kind}">${escape(token)}</span>`;
    },
  );
}
