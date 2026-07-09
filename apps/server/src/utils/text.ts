export function escapeXmlText(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeXmlAttribute(value: string) {
  return escapeXmlText(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function unquoteCommand(value: string) {
  const text = value.trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1).trim();
  }
  return text;
}

export function readQuotedToken(value: string) {
  const text = value.trimStart();
  if (!text) return { token: '', rest: '' };
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    let escaped = false;
    for (let index = 1; index < text.length; index += 1) {
      const char = text[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) {
        return {
          token: text.slice(1, index).replace(/\\(["'\\])/g, '$1').trim(),
          rest: text.slice(index + 1).trim()
        };
      }
    }
  }
  const [token = '', ...rest] = text.split(/\s+/);
  return { token, rest: rest.join(' ').trim() };
}
