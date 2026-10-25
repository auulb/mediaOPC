// B 站知识区（tid=36）最新视频 / 分区排行。
//   latest  : x/web-interface/newlist（按发布时间倒序，无需登录）
//   ranking : x/web-interface/ranking/v2（易 -352，需要手动 Cookie）
// 确定性数据采集：不调用任何大模型，Cookie 只从 data/secrets 手动配置读取。
import { DataSourcePlugin, DataSourceError, engagementOf, velocityByMedian, getJson } from './lib/base.mjs';
import { cookieHeaders, readCookie } from './lib/cookie.mjs';

const NEWLIST = 'https://api.bilibili.com/x/web-interface/newlist';
const RANKING = 'https://api.bilibili.com/x/web-interface/ranking/v2';
const VIEW = 'https://api.bilibili.com/x/web-interface/view';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** 知识区（pid=1010）常用分区；默认 36 = 知识区全部 */
export const KNOWLEDGE_ZONES = [
  { tid: 36, name: '知识（全部）' },
  { tid: 201, name: '科学科普' },
  { tid: 124, name: '社科·法律·心理' },
  { tid: 228, name: '人文历史' },
  { tid: 207, name: '财经商业' },
  { tid: 208, name: '校园学习' },
  { tid: 209, name: '职业职场' },
  { tid: 229, name: '设计·创意' },
  { tid: 230, name: '野生技能' },
];
const ZONE_NAMES = new Map(KNOWLEDGE_ZONES.map((z) => [z.tid, z.name]));

export class BilibiliKnowledgePlugin extends DataSourcePlugin {
  constructor(config = {}) {
    // 最新视频要"新"：缓存 5 分钟；跨进程限速 800ms（补抓播放数据时逐条请求）
    super({ id: 'bilibili-knowledge', platform: 'bilibili', minIntervalMs: 800, cacheTtlSec: 300, ...config });
  }

  /** params: { tid=36, limit=20(1-50), mode='latest'|'ranking', enrich=true, enrichLimit=8, keywords=[], cookie?, cookieFile? } */
  async fetch(params) {    const tid = clamp(params.tid ?? 36, 1, 9999, 36);
    const limit = clamp(params.limit ?? 20, 1, 50, 20);
    const mode = params.mode === 'ranking' ? 'ranking' : 'latest';
    const keywords = (Array.isArray(params.keywords) ? params.keywords : [])
      .map((k) => String(k).trim().toLowerCase()).filter(Boolean).slice(0, 5);
    // 有关键词时多抓一些再筛（纯字符串匹配，不做语义判断）
    const fetchLimit = keywords.length ? Math.min(50, limit * 3) : limit;
    const headers = this.headers(params);

    if (mode === 'ranking') {
      const body = await this.getJson(`${RANKING}?rid=${tid}&type=all`, headers);
      const list = filterByKeywords((body.data?.list || []).slice(0, fetchLimit), keywords);
      return { mode, tid, keywords, list: list.slice(0, limit), enriched: 0, warnings: [] };
    }

    const ps = Math.min(fetchLimit, 20);
    const pages = Math.ceil(fetchLimit / ps);
    const list = [];
    for (let pn = 1; pn <= pages; pn++) {
      if (pn > 1) await this.rateLimit();
      const body = await this.getJson(`${NEWLIST}?rid=${tid}&type=0&pn=${pn}&ps=${ps}`, headers);
      const archives = body.data?.archives || [];
      if (!archives.length) break;
      list.push(...archives);
      if (archives.length < ps) break;
    }
    // 接口按发布时倒序，但分页边界/置顶可能乱序、翻页时新视频会把旧条目顶重；
    // 统一按 pubdate 重排 + 按 bvid 去重（保留最新的一条）
    list.sort((a, b) => (b.pubdate || 0) - (a.pubdate || 0));
    const deduped = dedupeByBvid(list);
    const warnings = [];
    if (deduped.length !== list.length) warnings.push(`翻页重复 ${list.length - deduped.length} 条已按 bvid 去重`);
    let picked = deduped;
    if (keywords.length) {
      const filtered = filterByKeywords(deduped, keywords);
      warnings.push(`关键词筛选 [${keywords.join(', ')}]：${deduped.length} → ${filtered.length} 条`);
      picked = filtered;
    }
    picked = picked.slice(0, limit);

    // newlist 的 stat 恒为 0，逐条查 view 才有播放/点赞；失败不影响主流程
    let enriched = 0;
    if (params.enrich !== false) {
      const cap = Math.min(picked.length, clamp(params.enrichLimit ?? 8, 1, 20, 8));
      let fails = 0;
      for (let i = 0; i < cap; i++) {
        const v = picked[i];
        if (!v.bvid) continue;
        try {
          await this.rateLimit();
          const body = await this.getJson(`${VIEW}?bvid=${encodeURIComponent(v.bvid)}`, headers);
          const d = body.data;
          if (d?.stat) {
            v.stat = d.stat;
            v.duration = d.duration ?? v.duration;
            if (d.owner?.name) v.owner = { ...v.owner, name: d.owner.name, mid: d.owner.mid };
            if (d.tname) v.tname = d.tname;
            if (d.tnamev2) v.tnamev2 = d.tnamev2;
            enriched += 1;
          }
          fails = 0;
        } catch (e) {
          fails += 1;
          warnings.push(`补抓播放数据失败 ${v.bvid}: ${e.code || ''} ${e.message}`);
          if (fails >= 2) {
            warnings.push('连续 2 条补抓失败，停止补抓（其余条目播放数按接口原值）');
            break;
          }
        }
      }
    }
    return { mode, tid, keywords, list: picked, enriched, warnings };
  }

  headers(params) {
    const cookie = params.cookie ?? readCookie();
    return {
      'User-Agent': UA,
      Referer: 'https://www.bilibili.com/',
      Accept: 'application/json, text/plain, */*',
      ...cookieHeaders(cookie),
    };
  }

  async getJson(url, headers) {
    const body = await getJson(url, { headers, timeoutMs: 15000 });
    if (body.code !== 0) {
      const code = [-352, -412, -509, -799].includes(body.code) ? 'API_RATE_LIMIT' : 'NETWORK_ERROR';
      const hint = code === 'API_RATE_LIMIT' && body.code === -352
        ? '（B 站风控：到「数据接口」页手动粘贴 Cookie 后重试）'
        : '';
      throw new DataSourceError(code, `bilibili code=${body.code} ${body.message || ''}${hint}`.trim());
    }
    return body;
  }

  transform(raw, params, fetchedAt) {
    const now = Date.parse(fetchedAt);
    const warnings = [...(raw.warnings || [])];
    const rows = dedupeByBvid((raw.list || []).filter((v) => {
      if (!v.bvid) warnings.push(`跳过无 bvid 条目: ${v.title || '?'}`);
      return Boolean(v.bvid);
    }));
    const vph = rows.map((v) => viewsPerHour(v, now));
    const velocity = velocityByMedian(vph);
    const zoneName = ZONE_NAMES.get(Number(params.tid ?? raw.tid)) || '知识';

    const items = rows.map((v, i) => {
      const s = v.stat || {};
      const counts = {
        views: int(s.view),
        likes: int(s.like),
        comments: int(s.reply),
        shares: int(s.share),
        favorites: int(s.favorite),
      };
      const pubMs = v.pubdate ? v.pubdate * 1000 : null;
      const item = {
        id: v.bvid,
        title: v.title || '',
        url: `https://www.bilibili.com/video/${v.bvid}`,
        ...counts,
        tags: buildTags(v, zoneName),
        category: v.tname || v.tnamev2 || undefined,
        durationSec: Number.isInteger(v.duration) ? v.duration : undefined,
        publishDate: pubMs ? new Date(pubMs).toISOString().slice(0, 10) : new Date(now).toISOString().slice(0, 10),
        publishedAt: pubMs ? new Date(pubMs).toISOString().replace(/\.\d{3}Z$/, 'Z') : undefined,
        channel: {
          id: v.owner?.mid != null ? String(v.owner.mid) : undefined,
          name: v.owner?.name || '未知',
          subscribers: null, // 该接口不返回粉丝数
        },
        metrics: {
          engagement: engagementOf(counts),
          viewsPerHour: Math.round(vph[i] * 100) / 100,
          velocity: velocity(vph[i]),
        },
      };
      return dropUndefined(item);
    });
    // 最新视频通常刚发布：按发布时间从新到旧保证可读顺序
    items.sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));
    return { items, warnings };
  }
}

/** 按 bvid 去重（保留先出现的，即最新） */
function dedupeByBvid(list) {
  const seen = new Set();
  return list.filter((v) => {
    const id = v.bvid || (v.aid != null ? `av${v.aid}` : null);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** 纯字符串匹配：标题/分区包含关键词（不调用任何模型）
 *  - 中文关键词：substring
 *  - ASCII 关键词：词边界匹配，避免 "AI" 命中 "email"/"trailer"
 *  只匹配标题与分区，不看简介（避免"含 AI 生成标识"之类的元信息污染） */
function filterByKeywords(list, keywords) {
  if (!keywords.length) return list;
  const matchers = keywords.map((k) => (/^[\x20-\x7e]+$/.test(k)
    ? new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i')
    : k));
  return list.filter((v) => {
    const text = [v.title, v.tname, v.tnamev2].filter(Boolean).join(' ').toLowerCase();
    return matchers.some((m) => (typeof m === 'string' ? text.includes(m) : m.test(text)));
  });
}

function viewsPerHour(v, now) {
  if (!v.pubdate || !v.stat?.view) return 0;
  const hours = Math.max((now - v.pubdate * 1000) / 3600000, 1);
  return v.stat.view / hours;
}

/** 分区名 + 二级分区；AI 博主可直接拿来做话题标签 */
function buildTags(v, zoneName) {
  const tags = [zoneName];
  for (const t of [v.tname, v.tnamev2]) {
    if (t && t !== zoneName && t.length <= 12) tags.push(t);
  }
  const reason = v.rcmd_reason?.content;
  if (reason && reason.length <= 20 && !/播放|热门|推荐|收藏|点赞|排行/.test(reason)) tags.push(reason);
  return [...new Set(tags)];
}

const int = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
const clamp = (n, lo, hi, fallback) => {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.min(Math.max(v, lo), hi);
};

export function dropUndefined(obj) {
  for (const k of Object.keys(obj)) {
    if (obj[k] === undefined) delete obj[k];
    else if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])) dropUndefined(obj[k]);
  }
  return obj;
}

export default BilibiliKnowledgePlugin;
