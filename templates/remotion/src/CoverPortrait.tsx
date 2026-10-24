import React from 'react';
import { AbsoluteFill } from 'remotion';

// 竖版封面（1080×1920）：用于抖音/视频号/小红书等 9:16 场景。
// props 与横版封面解耦，只取标题/副标题/配色，保证竖屏排版不溢出。
export type CoverPortraitProps = {
  theme: { primary: string; background: string; text: string };
  kicker?: string;
  title: string;
  subtitle?: string;
  footer?: string;
};

export const coverPortraitDefaults: CoverPortraitProps = {
  theme: { primary: '#FF4D6D', background: '#0F1020', text: '#FFFFFF' },
  kicker: 'OPC · 拆解',
  title: '先导片为什么这么燃',
  subtitle: '3 个镜头套路',
  footer: 'AI 动画 · 45 秒看懂',
};

export const CoverPortrait: React.FC<CoverPortraitProps> = ({ theme, kicker, title, subtitle, footer }) => {
  const titleSize = title.length > 20 ? 84 : title.length > 12 ? 100 : 116;
  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.background,
        color: theme.text,
        fontFamily: '"PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
        padding: '150px 96px',
        justifyContent: 'flex-start',
      }}
    >
      {/* 顶部色块 + 栏目名 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <div style={{ width: 76, height: 76, borderRadius: 20, background: theme.primary }} />
        <div style={{ fontSize: 46, fontWeight: 700, letterSpacing: 2, opacity: 0.92 }}>{kicker}</div>
      </div>

      {/* 主标题 */}
      <div
        style={{
          marginTop: 120,
          fontSize: titleSize,
          fontWeight: 900,
          lineHeight: 1.18,
          letterSpacing: 1,
          textShadow: `0 12px 60px ${theme.primary}55`,
        }}
      >
        {title}
      </div>

      <div style={{ width: 220, height: 14, borderRadius: 7, background: theme.primary, margin: '56px 0 44px' }} />

      {/* 副标题 */}
      {subtitle ? (
        <div style={{ fontSize: 52, lineHeight: 1.5, fontWeight: 500, opacity: 0.9 }}>{subtitle}</div>
      ) : null}

      {/* 底部 */}
      <div style={{ position: 'absolute', left: 96, right: 96, bottom: 130 }}>
        <div style={{ fontSize: 40, opacity: 0.62, letterSpacing: 1 }}>{footer}</div>
        <div style={{ marginTop: 28, height: 8, width: '100%', borderRadius: 4, background: `${theme.primary}33` }} />
      </div>
    </AbsoluteFill>
  );
};
