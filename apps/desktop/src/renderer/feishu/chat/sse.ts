// A frame may span UTF-8 chunks; decoding is done by the caller in streaming mode.
export class SseParser {
  private buffer = '';
  constructor(private readonly onEvent: (name: string, data: string) => void) {}
  push(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > 512 * 1024) throw new Error('事件流缓冲超限');
    while (true) {
      const boundary = /\r?\n\r?\n/.exec(this.buffer);
      if (!boundary || boundary.index == null) break;
      const frame = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      let name = 'message';
      const data: string[] = [];
      for (const line of frame.split(/\r?\n/)) {
        if (!line || line.startsWith(':')) continue;
        const index = line.indexOf(':');
        const key = index < 0 ? line : line.slice(0, index);
        const value = index < 0 ? '' : line.slice(index + 1).replace(/^ /, '');
        if (key === 'event') name = value;
        if (key === 'data') data.push(value);
      }
      if (data.length) this.onEvent(name, data.join('\n'));
    }
  }
}
