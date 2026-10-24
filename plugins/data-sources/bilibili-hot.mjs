// B 站综合热门：https://api.bilibili.com/x/web-interface/popular
// 公开只读接口（网页端热门页使用），无需登录。插件层限速默认 3s/次 + 1 小时缓存。
import { DataSourcePlugin, DataSourceError, engagementOf, velocityByMedian, getJson } from './lib/base.mjs';

const API = 'https://api.bilibili.com/x/web-interface/popular';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) OPC-DataBot/1.0';

export class BilibiliHotPlugin extends DataSourcePlugin {
  constructor(config = {}) {
    super({ id: 'bilibili-hot', platform: 'bilibili', minIntervalMs: 3000, ...config });
  }

  /** params: { limit=50 (1-100), pages? } 每页最多 50 条 */
  async fetch(params) {
    const limit = clamp(params.limit ?? 50, 1, 100);
    const pageSize = Math.min(limit, 50);
    const pages = Math.ceil(limit / pageSize);
    const list = [];
    for (let pn = 1; pn <= pages; pn++) {
      if (pn > 1) await this.rateLimit();
      const body = await getJson(`${API}?ps=${pageSize}&pn=${pn}`, {
        headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
      });
      if (body.code !== 0) {
        // -352/-412 为风控，按限流处理以便调度器退避重试
        const code = [-352, -412, -509].includes(body.code) ? 'API_RATE_LIMIT' : 'NETWORK_ERROR';
        throw new DataSourceError(code, `bilibili code=${body.code} ${body.message || ''}`.trim());
      }
      list.push(...(body.data?.list || []));
      if (body.data?.no_more) break;
    }
    return { list: list.slice(0, limit) };
  }

  transform(raw, _params, fetchedAt) {
    const now = Date.parse(fetchedAt);
    const warnings = [];
    const rows = (raw.list || []).filter((v) => {
      if (!v.bvid) warnings.push(`跳过无 bvid 条目: ${v.title || '?'}`);
      return Boolean(v.bvid);
    });
    const vph = rows.map((v) => viewsPerHour(v, now));
    const velocity = velocityByMedian(vph);

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
        tags: buildTags(v),
        category: v.tname || undefined,
        durationSec: Number.isInteger(v.duration) ? v.duration : undefined,
        publishDate: pubMs ? new Date(pubMs).toISOString().slice(0, 10) : new Date(now).toISOString().slice(0, 10),
        publishedAt: pubMs ? new Date(pubMs).toISOString().replace(/\.\d{3}Z$/, 'Z') : undefined,
        channel: {
          id: v.owner?.mid != null ? String(v.owner.mid) : undefined,
          name: v.owner?.name || '未知',
          subscribers: null, // 热门接口不返回粉丝数
        },
        metrics: {
          engagement: engagementOf(counts),
          viewsPerHour: Math.round(vph[i] * 100) / 100,
          velocity: velocity(vph[i]),
        },
      };
      return dropUndefined(item);
    });
    return { items, warnings };
  }
}

function viewsPerHour(v, now) {
  if (!v.pubdate || !v.stat?.view) return 0;
  const hours = Math.max((now - v.pubdate * 1000) / 3600000, 1);
  return v.stat.view / hours;
}

/** 热门接口无 tag 列表：用分区名 + 非徽章类推荐理由作为标签 */
function buildTags(v) {
  const tags = [];
  if (v.tname) tags.push(v.tname);
  const reason = v.rcmd_reason?.content;
  // “百万播放”“热门推荐”等是平台徽章，不是内容主题，不能当话题统计
  if (reason && reason.length <= 20 && !/播放|热门|推荐|收藏|点赞|排行/.test(reason)) tags.push(reason);
  return [...new Set(tags)];
}

const int = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
const clamp = (n, lo, hi) => Math.min(Math.max(Math.floor(Number(n) || lo), lo), hi);

export function dropUndefined(obj) {
  for (const k of Object.keys(obj)) {
    if (obj[k] === undefined) delete obj[k];
    else if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])) dropUndefined(obj[k]);
  }
  return obj;
}

export default BilibiliHotPlugin;
