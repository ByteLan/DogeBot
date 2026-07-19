const SHARE_ENDPOINT = 'https://www.iesdouyin.com/share/video/';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
// Douyin serves this fallback title on the mobile share page when a video is
// deleted / private / otherwise unavailable. A live video renders its real title.
export const INVALID_TITLE_MARKER = '在抖音记录美好生活';
const CHECK_TIMEOUT_MS = 8000;

export type DouyinValidity = {
  awemeId: string;
  valid: boolean;
  /** Real video title when valid, or the fallback title when invalid. */
  title: string;
  /** true when the check itself failed (network/timeout); treated as inconclusive. */
  errored: boolean;
};

function extractTitle(html: string) {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (!match) return '';
  return match[1].replace(/\s*-\s*抖音\s*$/, '').trim();
}

/**
 * Detect whether a Douyin aweme is still available.
 *
 * The public PC page (www.douyin.com/video/<id>) is an SSR shell that loads the
 * video client-side, so it can't be used to tell valid from invalid. The mobile
 * share endpoint renders real video data server-side: invalid videos fall back to
 * the generic "在抖音记录美好生活<date>" title, valid ones show the real title.
 *
 * On any network/parse failure we return `errored: true` and `valid: true` so the
 * caller never deletes / skips a video just because the probe failed.
 */
export async function checkDouyinAwemeValidity(awemeId: string): Promise<DouyinValidity> {
  const normalizedId = String(awemeId || '').trim();
  if (!/^\d{6,}$/.test(normalizedId)) {
    return { awemeId: normalizedId, valid: true, title: '', errored: true };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(`${SHARE_ENDPOINT}${encodeURIComponent(normalizedId)}`, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': MOBILE_UA },
      signal: controller.signal
    });
    const html = await response.text();
    const title = extractTitle(html);
    const invalid = title.startsWith(INVALID_TITLE_MARKER);
    return { awemeId: normalizedId, valid: !invalid, title, errored: false };
  } catch (error) {
    console.error('[douyin] validity check failed', {
      awemeId: normalizedId,
      error: error instanceof Error ? error.message : String(error)
    });
    return { awemeId: normalizedId, valid: true, title: '', errored: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract the aweme_id from arbitrary text: the last run of 10+ consecutive digits.
 * Handles douyin video URLs as well as bare numbers.
 */
export function extractAwemeIdFromText(text: string) {
  const matches = String(text || '').match(/\d{10,}/g);
  if (!matches || matches.length === 0) return '';
  return matches[matches.length - 1];
}
