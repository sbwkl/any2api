// 服务日志：launchd 的 stdout/stderr 没有时间戳，统一在每条消息前加 ISO UTC。
// 请求记录（四层观测）自带 ts，不经过这里。
function emit(write: (...args: unknown[]) => void, args: unknown[]): void {
  write(new Date().toISOString(), ...args);
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
