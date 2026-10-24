#!/usr/bin/env node
// 把 dashboard 压缩成选题上下文，减少 pi 的阅读量。用法: node scripts/context.mjs --input ./input.json
import fs from 'node:fs';
import path from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const file = path.resolve(arg('input', './input.json'));
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const dash = raw?.data?.externalTrends ? raw.data : raw;

if (!dash?.externalTrends || !dash?.internalPerformance) {
  console.error('input 不是 dashboard v1（缺 externalTrends / internalPerformance）');
  process.exit(1);
}

const now = new Date();
const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;

const out = {
  generatedAt: dash.generatedAt,
  themeIdPrefix: `theme_${stamp}`,
  externalTopics: dash.externalTrends.topTopics.map((t, i) => ({
    pointer: `/externalTrends/topTopics/${i}`,
    topic: t.topic,
    heat: t.heat,
    growth: t.growth,
    itemCount: t.itemCount,
    platforms: t.platforms || [],
  })),
  externalItems: dash.externalTrends.topItems.slice(0, 10).map((it, i) => ({
    pointer: `/externalTrends/topItems/${i}`,
    id: it.id,
    title: it.title,
    platform: it.platform,
    views: it.views,
    engagement: it.engagement,
    velocity: it.velocity,
    tags: it.tags || [],
  })),
  internalEpisodes: dash.internalPerformance.episodes.map((e, i) => ({
    pointer: `/internalPerformance/episodes/${i}`,
    publishId: e.id,
    themeId: e.themeId,
    title: e.title,
    platform: e.platform,
    window: e.window,
    views: e.views,
    engagement: e.engagement,
    roi: e.roi,
  })),
  internalSummary: {
    pointer: '/internalPerformance',
    avgEngagement: dash.internalPerformance.avgEngagement.value,
    topPerformers: dash.internalPerformance.topPerformers,
  },
  tokenUsage: {
    pointer: '/tokenUsage',
    today: dash.tokenUsage.today,
    thisWeek: dash.tokenUsage.thisWeek,
    budget: dash.tokenUsage.budget,
    utilizationRate: dash.tokenUsage.utilizationRate,
  },
  taskSummary: {
    pointer: '/taskStatus',
    ...dash.taskStatus.summary,
  },
};

console.log(JSON.stringify(out, null, 2));
