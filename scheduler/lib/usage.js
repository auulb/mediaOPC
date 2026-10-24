// 从 pi --mode json 的 events.jsonl 汇总 token 与成本。
// 以 assistant 的 message_end 为准（文档：message_end 是权威最终消息）。
import fs from 'node:fs';

export function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0, messages: 0, provider: null, model: null };
}

export function sumUsageText(text) {
  const u = emptyUsage();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; } // 被截断的末行等
    if (ev?.type !== 'message_end' || ev.message?.role !== 'assistant') continue;
    const mu = ev.message.usage;
    if (!mu) continue;
    const int = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
    u.input += int(mu.input);
    u.output += int(mu.output);
    u.cacheRead += int(mu.cacheRead);
    u.cacheWrite += int(mu.cacheWrite);
    const sum = int(mu.input) + int(mu.output) + int(mu.cacheRead) + int(mu.cacheWrite);
    u.totalTokens += int(mu.totalTokens ?? sum);
    const cost = mu.cost?.total;
    if (Number.isFinite(cost) && cost > 0) u.costUsd += cost;
    u.messages += 1;
    u.provider = ev.message.provider ?? u.provider;
    u.model = ev.message.model ?? u.model;
  }
  u.costUsd = Math.round(u.costUsd * 1e6) / 1e6;
  return u;
}

export function sumUsageFile(file) {
  if (!fs.existsSync(file)) return emptyUsage();
  return sumUsageText(fs.readFileSync(file, 'utf8'));
}
