// 服务日志：launchd 的 stdout/stderr 没有时间戳，统一在每条消息前加 ISO UTC。
// 请求记录（四层观测）自带 ts，不经过这里。
function stamp(): string {
  return new Date().toISOString();
}

export const serviceLogger = {
  log(...args: unknown[]): void {
    console.log(stamp(), ...args);
  },
  warn(...args: unknown[]): void {
    console.warn(stamp(), ...args);
  },
  error(...args: unknown[]): void {
    console.error(stamp(), ...args);
  },
};
