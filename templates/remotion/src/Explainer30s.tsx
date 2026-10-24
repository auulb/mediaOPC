import React from 'react';
import {
  AbsoluteFill,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

// props 即 storyboard.json，结构见 skills/render-remotion/schemas/storyboard.schema.json
export type Scene = {
  kind: 'title' | 'point' | 'outro';
  heading: string;
  body?: string;
  durationSec: number;
};

export type ExplainerProps = {
  theme: { primary: string; background: string; text: string };
  scenes: Scene[];
};

export const explainerDefaults: ExplainerProps = {
  theme: { primary: '#FF4D6D', background: '#0F1020', text: '#FFFFFF' },
  scenes: [
    { kind: 'title', heading: 'OPC 示例', body: '30 秒模板', durationSec: 5 },
    { kind: 'point', heading: '第一点', body: '数据驱动选题', durationSec: 8 },
    { kind: 'point', heading: '第二点', body: 'AI 生成脚本与分镜', durationSec: 9 },
    { kind: 'outro', heading: '关注我们', body: '下期见', durationSec: 8 },
  ],
};

const SceneView: React.FC<{ scene: Scene; index: number; theme: ExplainerProps['theme'] }> = ({
  scene,
  index,
  theme,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  const exit = interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const isTitle = scene.kind !== 'point';

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.background,
        color: theme.text,
        fontFamily: '"PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
        justifyContent: 'center',
        alignItems: isTitle ? 'center' : 'flex-start',
        padding: '0 160px',
        opacity: exit,
      }}
    >
      {!isTitle && (
        <div style={{ fontSize: 64, fontWeight: 800, color: theme.primary, opacity: enter }}>
          {String(index).padStart(2, '0')}
        </div>
      )}
      <div
        style={{
          fontSize: isTitle ? 120 : 96,
          fontWeight: 800,
          lineHeight: 1.2,
          textAlign: isTitle ? 'center' : 'left',
          transform: `translateY(${(1 - enter) * 40}px)`,
          opacity: enter,
        }}
      >
        {scene.heading}
      </div>
      <div
        style={{
          width: interpolate(enter, [0, 1], [0, 240]),
          height: 10,
          background: theme.primary,
          margin: '36px 0',
          borderRadius: 5,
        }}
      />
      {scene.body && (
        <div
          style={{
            fontSize: 56,
            lineHeight: 1.5,
            opacity: interpolate(frame, [10, 25], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
            textAlign: isTitle ? 'center' : 'left',
            maxWidth: 1500,
          }}
        >
          {scene.body}
        </div>
      )}
    </AbsoluteFill>
  );
};

export const Explainer30s: React.FC<ExplainerProps> = ({ theme, scenes }) => {
  const { fps } = useVideoConfig();
  let from = 0;
  let pointNo = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: theme.background }}>
      {scenes.map((scene, i) => {
        const len = Math.max(1, Math.round(scene.durationSec * fps));
        const start = from;
        from += len;
        if (scene.kind === 'point') pointNo += 1;
        return (
          <Sequence key={i} from={start} durationInFrames={len}>
            <SceneView scene={scene} index={pointNo} theme={theme} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
