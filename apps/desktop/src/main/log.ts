export function logDouyin(message: string, data?: unknown) {
  if (data === undefined) {
    console.log(`[douyin] ${message}`);
    return;
  }
  console.log(`[douyin] ${message}`, data);
}
