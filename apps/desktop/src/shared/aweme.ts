// 从 collect list 接口响应中提取 aweme_id。
// 两种入参形态在 main 与 renderer 各自沿用，逻辑与原实现逐字一致，故并列保留。

// main 进程侧：入参为原始 JSON 字符串。
export function extractAwemeIdsFromBody(body: string) {
  try {
    const parsed = JSON.parse(body) as { aweme_list?: Array<{ aweme_id?: unknown }> };
    if (!Array.isArray(parsed.aweme_list)) return [];
    return parsed.aweme_list.flatMap((item) => {
      const awemeId = String(item?.aweme_id || '').trim();
      return awemeId ? [awemeId] : [];
    });
  } catch {
    return [];
  }
}

// renderer 侧：入参为已解析的对象。
export function extractAwemeIds(body: unknown) {
  if (!body || typeof body !== 'object') return [];
  const awemeList = (body as { aweme_list?: unknown }).aweme_list;
  if (!Array.isArray(awemeList)) return [];
  return awemeList.flatMap((item) => {
    const awemeId = item && typeof item === 'object' ? String((item as { aweme_id?: unknown }).aweme_id || '').trim() : '';
    return awemeId ? [awemeId] : [];
  });
}
