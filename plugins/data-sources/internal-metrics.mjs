// 自有内容表现：读取 C-media 的 publish-record，按平台拉取每条已发布视频的当前数据。
// 输入记录来源（任选，可组合）：
//   params.records        直接传入 publish-record 对象数组
//   params.recordFiles    publish-record JSON 文件路径（相对 OPC_ROOT 或绝对路径）
//   params.recordsJsonl   publish-record JSONL 文件，默认 data/publish_records.jsonl（存在才读）
// 只处理 status=published 且 platformVideoId 非空的记录（契约保证这三个字段此时非 null）。
import fs from 'node:fs/promises';
import path from 'node:path';
import { DataSourcePlugin, DataSourceError, OPC_ROOT, engagementOf, getJson } from './lib/base.mjs';
import { dropUndefined } from './bilibili-hot.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) OPC-DataBot/1.0';

/** 平台统计拉取器：返回 { views, likes, comments, shares, favorites, title?, durationSec?, tags? } */
const statFetchers = {
  async bilibili(videoId) {
    const body = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(videoId)}`, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
    });
    if (body.code !== 0) {
      const code = [-352, -412, -509].includes(body.code) ? 'API_RATE_LIMIT' : 'NETWORK_ERROR';
      throw new DataSourceError(code, `bilibili view code=${body.code} ${body.message || ''}`.trim());
    }
    const d = body.data || {};
    const s = d.stat || {};
    return {
      views: s.view, likes: s.like, comments: s.reply, shares: s.share, favorites: s.favorite,
      title: d.title, durationSec: d.duration, ownerName: d.owner?.name, ownerId: d.owner?.mid,
    };
  },
};

/** 距发布时长所落区间 */
export function windowOf(hours) {
  if (hours < 24) return '0h';
  if (hours < 72) return '24h';
  if (hours < 168) return '72h';
  if (hours < 336) return '7d';
  return 'latest';
}

export class InternalMetricsPlugin extends DataSourcePlugin {
  constructor(config = {}) {
    // 自有数据变化快，默认缓存 1 小时；限速 2s/次
    super({ id: 'internal-metrics', platform: 'internal', minIntervalMs: 2000, ...config });
    this.statFetchers = { ...statFetchers, ...(config.statFetchers || {}) };
  }

  async loadRecords(params) {
    const records = [...(params.records || [])];
    const resolve = (p) => (path.isAbsolute(p) ? p : path.join(OPC_ROOT, p));
    for (const f of params.recordFiles || []) {
      const json = JSON.parse(await fs.readFile(resolve(f), 'utf8'));
      // 兼容 step-envelope 包装（data 内为 publish-record）与数组
      const unwrapped = json && json.data && json.stepId ? json.data : json;
      records.push(...(Array.isArray(unwrapped) ? unwrapped : [unwrapped]));
    }
    const jsonl = resolve(params.recordsJsonl || 'data/publish_records.jsonl');
    try {
      const text = await fs.readFile(jsonl, 'utf8');
      for (const line of text.split('\n')) if (line.trim()) records.push(JSON.parse(line));
    } catch (e) {
      if (e.code !== 'ENOENT' || params.recordsJsonl) throw e; // 显式指定却不存在 → 报错
    }
    // 同一 publishId 保留最后一条
    return [...new Map(records.map((r) => [r.publishId, r])).values()];
  }

  async fetch(params) {
    const records = await this.loadRecords(params);
    const results = [];
    const skipped = [];
    const snapshotFile = this.snapshotFile(params);
    let first = true;
    for (const r of records) {
      if (r.status !== 'published' || !r.platformVideoId) {
        skipped.push(`${r.publishId}: status=${r.status}`);
        continue;
      }
      const fetcher = this.statFetchers[r.platform];
      if (!fetcher) {
        skipped.push(`${r.publishId}: 暂不支持平台 ${r.platform}`);
        continue;
      }
      if (!first) await this.rateLimit(); // 第一次请求的限速已由 run() 完成
      first = false;
      try {
        const stat = await fetcher(r.platformVideoId);
        const fetchedAt = new Date().toISOString();
        results.push({ record: r, stat, fetchedAt });
        if (params.snapshot !== false) {
          try {
            await appendSnapshot(snapshotFile, r, stat, fetchedAt);
          } catch (e) {
            skipped.push(`${r.publishId}: 快照写入失败 ${e.message}`);
          }
        }
      } catch (e) {
        if (e.code === 'API_RATE_LIMIT') throw e; // 被风控就整体失败，交给调度器退避
        skipped.push(`${r.publishId}: 拉取失败 ${e.message}`);
      }
    }
    return { results, skipped };
  }

  transform(raw) {
    const items = raw.results.map(({ record: r, stat, fetchedAt }) => {
      const counts = {
        views: int(stat.views), likes: int(stat.likes), comments: int(stat.comments),
        shares: int(stat.shares), favorites: int(stat.favorites),
      };
      const hours = Math.max((Date.parse(fetchedAt) - Date.parse(r.publishedAt)) / 3600000, 0);
      return dropUndefined({
        id: r.platformVideoId,
        title: r.metadata?.title || stat.title || '',
        url: r.url || undefined,
        ...counts,
        tags: r.metadata?.tags || [],
        durationSec: Number.isInteger(stat.durationSec) ? stat.durationSec : undefined,
        publishDate: r.publishedAt.slice(0, 10),
        publishedAt: r.publishedAt,
        channel: {
          id: stat.ownerId != null ? String(stat.ownerId) : undefined,
          name: stat.ownerName || 'self',
          subscribers: null,
        },
        metrics: {
          engagement: engagementOf(counts),
          viewsPerHour: hours > 0 ? Math.round((counts.views / Math.max(hours, 1)) * 100) / 100 : 0,
          velocity: 'unknown', // 单次快照无法判断，由 build-dashboard 对比历史得出
        },
        internal: {
          publishId: r.publishId,
          themeId: r.themeId,
          platform: r.platform,
          window: windowOf(hours),
          hoursSincePublish: Math.round(hours * 10) / 10,
        },
      });
    });
    return { items, warnings: raw.skipped };
  }

  snapshotFile(params) {
    const file = params.snapshotsJsonl || this.config.snapshotFile || 'data/internal_metrics_snapshots.jsonl';
    return path.isAbsolute(file) ? file : path.join(OPC_ROOT, file);
  }
}

/** 追加一行快照，供后续按 24h/72h 窗口回看（当前输出仍只取最新一次） */
async function appendSnapshot(file, record, stat, fetchedAt) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const hours = Math.max((Date.parse(fetchedAt) - Date.parse(record.publishedAt)) / 3600000, 0);
  const line = {
    ts: fetchedAt,
    publishId: record.publishId,
    themeId: record.themeId,
    platform: record.platform,
    platformVideoId: record.platformVideoId,
    publishedAt: record.publishedAt,
    window: windowOf(hours),
    hoursSincePublish: Math.round(hours * 10) / 10,
    views: int(stat.views),
    likes: int(stat.likes),
    comments: int(stat.comments),
    shares: int(stat.shares),
    favorites: int(stat.favorites),
  };
  await fs.appendFile(file, `${JSON.stringify(line)}\n`);
}

const int = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

export default InternalMetricsPlugin;
