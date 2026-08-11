import { parseBooleanFlag } from './config.js';

const SHARE_ENDPOINT = 'https://www.iesdouyin.com/share/video/';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) larkUrl AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
// Douyin serves this fallback title on the mobile share page when a video is
// deleted / private / otherwise unavailable. A live video renders its real title.
export const INVALID_TITLE_MARKER = '在抖音记录美好生活';
const CHECK_TIMEOUT_MS = 8000;

// Secondary path: the web aweme-detail API (same one yt-dlp's DouyinIE uses).
// Since Douyin stopped inlining video data into the mobile share page's SSR
// (every id now renders the generic fallback title), the share page alone can
// no longer tell valid from invalid — so we confirm ambiguous cases here.
const DETAIL_ENDPOINT = 'https://www.douyin.com/aweme/v1/web/aweme/detail/';
const DOUYIN_HOME = 'https://www.douyin.com/';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// The detail API rejects anonymous requests but accepts a plain `ttwid` cookie
// (no a_bogus/msToken signing needed). Obtain it from the bytedance ttwid
// registration endpoint (works without JS/browser, unlike the douyin.com home
// page which only sets the cookie client-side via JS). Cache and reuse it.
const TTWID_REGISTER_URL = 'https://ttwid.bytedance.com/ttwid/union/register/';
const TTWID_TTL_MS = 30 * 60 * 1000;
let cachedTtwid = '';
let cachedTtwidAt = 0;

// Per-stage on/off switches. Stage 1 = mobile share page, stage 2 = detail API.
// Both default on; disabling stage 2 reverts to the legacy "share-page fallback
// title == invalid" behavior. Disabling both leaves every probe inconclusive.
export const douyinCheckStageConfig = {
  stage1Enabled: parseBooleanFlag(process.env.DOGEBOT_DOUYIN_CHECK_STAGE1_ENABLED, true),
  stage2Enabled: parseBooleanFlag(process.env.DOGEBOT_DOUYIN_CHECK_STAGE2_ENABLED, true)
};

export type DouyinCheckStageName = 'share' | 'detail';
/** valid/invalid: conclusive; errored: probe failed; skipped: stage disabled. */
export type DouyinCheckStageOutcome = 'valid' | 'invalid' | 'errored' | 'skipped';

export type DouyinCheckStageResult = {
  stage: DouyinCheckStageName;
  outcome: DouyinCheckStageOutcome;
  /** title observed at this stage, when any (real desc, share <title>, or ''). */
  title?: string;
  /** short human-readable detail: http status, marker hit, error message, etc. */
  info?: string;
};

export type DouyinValidity = {
  awemeId: string;
  valid: boolean;
  /** Real video title when valid, or the fallback title when invalid. */
  title: string;
  /** true when the check itself failed (network/timeout); treated as inconclusive. */
  errored: boolean;
  /** Ordered per-stage diagnostics for every stage that ran / was skipped. */
  stages: DouyinCheckStageResult[];
  /** Which stage produced the final verdict: a probe stage, the DB cache, or none. */
  decidedBy: DouyinCheckStageName | 'cache' | 'none';
};

function extractTitle(html: string) {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (!match) return '';
  return match[1].replace(/\s*-\s*抖音\s*$/, '').trim();
}

/**
 * A share-page <title> that carries no real video title: empty, the generic
 * "在抖音记录美好生活…" fallback, or the bare site name "抖音" (rendered when the
 * SSR didn't hydrate video data). All of these are inconclusive and must defer
 * to the detail API rather than count as a real (valid) title.
 */
function isFallbackShareTitle(title: string): boolean {
  return !title || title === '抖音' || title.startsWith(INVALID_TITLE_MARKER);
}

async function fetchWithTimeout(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    return await fetch(url, { redirect: 'follow', ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

type ShareProbe =
  | { ok: true; title: string; status: number }
  | { ok: false; error: string };

/**
 * Probe the mobile share page. A valid video renders its real <title>; an
 * invalid one (and, since Douyin stopped inlining SSR data, an unknown share of
 * valid ones too) renders the generic "在抖音记录美好生活<date>" fallback — which
 * is why a fallback title only means "ambiguous, confirm via the detail API".
 */
async function fetchShareProbe(awemeId: string): Promise<ShareProbe> {
  try {
    const response = await fetchWithTimeout(`${SHARE_ENDPOINT}${encodeURIComponent(awemeId)}`, {
      headers: { 'user-agent': MOBILE_UA }
    });
    return { ok: true, title: extractTitle(await response.text()), status: response.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[douyin] share page probe failed', { awemeId, error: message });
    return { ok: false, error: message };
  }
}

/** Obtain a fresh `ttwid` cookie from ByteDance's ttwid registration service. */
async function getTtwid(): Promise<string> {
  if (cachedTtwid && Date.now() - cachedTtwidAt < TTWID_TTL_MS) return cachedTtwid;
  try {
    const response = await fetchWithTimeout(TTWID_REGISTER_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': DESKTOP_UA },
      body: JSON.stringify({
        region: 'cn',
        aid: 1768,
        needFid: false,
        service: 'www.ixigua.com',
        migrate_info: { ticket: '', source: 'node' },
        cbUrlProtocol: 'https',
        union: true
      })
    });
    // The ttwid is returned as a set-cookie header.
    const cookies = response.headers.getSetCookie?.() ?? [];
    for (const cookie of cookies) {
      const match = cookie.match(/ttwid=([^;]+)/);
      if (match) {
        cachedTtwid = `ttwid=${match[1]}`;
        cachedTtwidAt = Date.now();
        return cachedTtwid;
      }
    }
    // Fallback: combined header (older Node versions)
    const rawSetCookie = response.headers.get('set-cookie') || '';
    const fallbackMatch = rawSetCookie.match(/ttwid=([^;]+)/);
    if (fallbackMatch) {
      cachedTtwid = `ttwid=${fallbackMatch[1]}`;
      cachedTtwidAt = Date.now();
      return cachedTtwid;
    }
    console.warn('[douyin] ttwid register: cookie not found in response', {
      status: response.status,
      cookieCount: cookies.length,
      hasSetCookieHeader: !!rawSetCookie
    });
  } catch (error) {
    console.error('[douyin] ttwid register failed', {
      error: error instanceof Error ? error.message : String(error)
    });
  }
  cachedTtwid = '';
  return '';
}

type DetailProbe =
  | { ok: true; valid: boolean; title: string; status: number }
  | { ok: false; error: string; status?: number };

/**
 * Confirm validity via the web aweme-detail API (yt-dlp's DouyinIE approach).
 * `aweme_detail` is a non-empty object for a live video (we read its `desc` as
 * the real title) and `null` for deleted/private/nonexistent ones. `ok: false`
 * means the probe itself failed (blocked / network / non-JSON), which the caller
 * treats as inconclusive rather than a confirmed state.
 */
async function fetchDetailProbe(awemeId: string): Promise<DetailProbe> {
  try {
    let ttwid = await getTtwid();
    const call = async () => {
      const url =
        `${DETAIL_ENDPOINT}?aweme_id=${encodeURIComponent(awemeId)}` +
        '&device_platform=webapp&aid=6383&channel=channel_pc_web';
      return fetchWithTimeout(url, {
        headers: {
          'user-agent': DESKTOP_UA,
          referer: DOUYIN_HOME,
          ...(ttwid ? { cookie: ttwid } : {})
        }
      });
    };
    let response = await call();
    // A stale/absent ttwid tends to surface as a 4xx: re-prime once and retry.
    if (!response.ok) {
      cachedTtwid = '';
      cachedTtwidAt = 0;
      ttwid = await getTtwid();
      if (ttwid) response = await call();
    }
    if (!response.ok) {
      console.error('[douyin] detail api non-ok', { awemeId, status: response.status, hasTtwid: !!ttwid });
      return { ok: false, error: `http ${response.status}`, status: response.status };
    }
    const text = await response.text();
    let data: { aweme_detail?: { desc?: string } | null };
    try {
      data = JSON.parse(text);
    } catch {
      console.error('[douyin] detail api json parse failed', {
        awemeId,
        status: response.status,
        hasTtwid: !!ttwid,
        bodyPreview: text.slice(0, 200)
      });
      return { ok: false, error: `json parse failed (status ${response.status}, body ${text.length}b)`, status: response.status };
    }
    if (data.aweme_detail && typeof data.aweme_detail === 'object') {
      return { ok: true, valid: true, title: String(data.aweme_detail.desc || '').trim(), status: response.status };
    }
    // Explicit null aweme_detail == the video is gone.
    if ('aweme_detail' in data) return { ok: true, valid: false, title: '', status: response.status };
    return { ok: false, error: 'unexpected response shape', status: response.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[douyin] detail api probe failed', { awemeId, error: message });
    return { ok: false, error: message };
  }
}

function invalidId(awemeId: string): DouyinValidity {
  return {
    awemeId,
    valid: true,
    title: '',
    errored: true,
    stages: [{ stage: 'share', outcome: 'errored', info: 'invalid aweme_id format' }],
    decidedBy: 'none'
  };
}

/**
 * Detect whether a Douyin aweme is still available, and surface its title.
 *
 * Two-stage strategy (each independently switchable via env):
 *  1. Mobile share page. A real (non-fallback) title means the video is
 *     definitely live — fast path, no extra request.
 *  2. When the share page returns the generic fallback title (ambiguous under
 *     Douyin's current SSR) or fails, confirm via the web detail API. When
 *     stage 2 is disabled, a fallback title from stage 1 is treated as invalid
 *     (the legacy behavior).
 *
 * Every stage that runs (or is skipped) is recorded in `stages`, and `decidedBy`
 * names the stage that produced the verdict — surfaced on the admin card.
 *
 * The returned `title` upholds the cache contract in douyin.ts: a valid result
 * carries the real title (never starting with INVALID_TITLE_MARKER), a
 * confirmed-invalid result carries a marker-prefixed title. On any inconclusive
 * outcome we return `errored: true` and `valid: true` so the caller never
 * deletes / skips a video just because the probe failed.
 */
export async function checkDouyinAwemeValidity(awemeId: string): Promise<DouyinValidity> {
  const normalizedId = String(awemeId || '').trim();
  if (!/^\d{6,}$/.test(normalizedId)) return invalidId(normalizedId);

  const stages: DouyinCheckStageResult[] = [];
  let shareTitle = '';

  // Stage 1: mobile share page.
  if (douyinCheckStageConfig.stage1Enabled) {
    const probe = await fetchShareProbe(normalizedId);
    if (probe.ok) {
      shareTitle = probe.title;
      if (!isFallbackShareTitle(probe.title)) {
        stages.push({ stage: 'share', outcome: 'valid', title: probe.title, info: `http ${probe.status}` });
        return { awemeId: normalizedId, valid: true, title: probe.title, errored: false, stages, decidedBy: 'share' };
      }
      // Fallback title: conclusive only when stage 2 is off.
      if (!douyinCheckStageConfig.stage2Enabled) {
        stages.push({
          stage: 'share',
          outcome: 'invalid',
          title: probe.title,
          info: `fallback title, http ${probe.status}`
        });
        return {
          awemeId: normalizedId,
          valid: false,
          title: probe.title.startsWith(INVALID_TITLE_MARKER) ? probe.title : INVALID_TITLE_MARKER,
          errored: false,
          stages,
          decidedBy: 'share'
        };
      }
      stages.push({ stage: 'share', outcome: 'errored', title: probe.title, info: `fallback title, http ${probe.status}` });
    } else {
      stages.push({ stage: 'share', outcome: 'errored', info: probe.error });
    }
  } else {
    stages.push({ stage: 'share', outcome: 'skipped', info: 'stage disabled' });
  }

  // Stage 2: web detail API.
  if (douyinCheckStageConfig.stage2Enabled) {
    const probe = await fetchDetailProbe(normalizedId);
    if (probe.ok) {
      if (probe.valid) {
        const title = probe.title || (isFallbackShareTitle(shareTitle) ? '' : shareTitle);
        stages.push({ stage: 'detail', outcome: 'valid', title, info: `http ${probe.status}` });
        return { awemeId: normalizedId, valid: true, title, errored: false, stages, decidedBy: 'detail' };
      }
      // Confirmed invalid: keep a marker-prefixed title so the DB cache reads back invalid.
      const title = shareTitle.startsWith(INVALID_TITLE_MARKER) ? shareTitle : INVALID_TITLE_MARKER;
      stages.push({ stage: 'detail', outcome: 'invalid', title, info: `aweme_detail=null, http ${probe.status}` });
      return { awemeId: normalizedId, valid: false, title, errored: false, stages, decidedBy: 'detail' };
    }
    stages.push({ stage: 'detail', outcome: 'errored', info: probe.error });
  } else {
    stages.push({ stage: 'detail', outcome: 'skipped', info: 'stage disabled' });
  }

  // All enabled stages inconclusive: never let this delete/skip a video.
  return {
    awemeId: normalizedId,
    valid: true,
    title: isFallbackShareTitle(shareTitle) ? '' : shareTitle,
    errored: true,
    stages,
    decidedBy: 'none'
  };
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

const STAGE_LABEL: Record<DouyinCheckStageName, string> = { share: '阶段1·分享页', detail: '阶段2·详情API' };
const OUTCOME_LABEL: Record<DouyinCheckStageOutcome, string> = {
  valid: '✅ 有效',
  invalid: '❌ 失效',
  errored: '⚠️ 失败',
  skipped: '⏭️ 跳过'
};

/**
 * Render the per-stage diagnostics as markdown lines for the admin card, e.g.
 *   - 阶段1·分享页：⚠️ 失败（fallback title, http 200）
 *   - 阶段2·详情API：✅ 有效（http 200）｜标题：这套到底拍了多少遍…
 * `decidedBy` is appended as a final "判定依据" line.
 */
export function formatDouyinCheckStages(result: Pick<DouyinValidity, 'stages' | 'decidedBy'>): string {
  const lines = result.stages.map((s) => {
    const parts = [`- **${STAGE_LABEL[s.stage]}**：${OUTCOME_LABEL[s.outcome]}`];
    if (s.info) parts.push(`（${s.info}）`);
    if (s.title) parts.push(`｜标题：${s.title.length > 40 ? `${s.title.slice(0, 40)}…` : s.title}`);
    return parts.join('');
  });
  const decidedLabel =
    result.decidedBy === 'cache' ? '数据库缓存' :
    result.decidedBy === 'share' ? STAGE_LABEL.share :
    result.decidedBy === 'detail' ? STAGE_LABEL.detail :
    '无（均未得出结论）';
  lines.push(`- **判定依据**：${decidedLabel}`);
  return lines.join('\n');
}
