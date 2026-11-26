// 服务日志：launchd 的 stdout/stderr 没有时间戳，统一在每条消息前加 ISO UTC。
// 请求记录（四层观测）自带 ts，不经过这里。
function emit(write: (...args: unknown[]) => void, args: unknown[]): void {
  const stamp = new Date().toISOString();
  const lines: unknown[][] = [[]];
  let cursor = 0;

  for (const arg of args) {
    if (typeof arg === "string") {
      const segments = arg.split(/\r\n|\n|\r/);
      segments.forEach((segment, index) => {
        while (lines.length <= cursor + index) lines.push([]);
        lines[cursor + index].push(segment);
      });
      cursor += segments.length - 1;
    } else {
      lines[cursor].push(arg);
    }
  }

  for (const line of lines) write(stamp, ...line);
}

export const serviceLogger = {
  log(...args: unknown[]): void {
    emit(console.log, args);
  },
  warn(...args: unknown[]): void {
    emit(console.warn, args);
  },
  error(...args: unknown[]): void {
    emit(console.error, args);
  },
};
