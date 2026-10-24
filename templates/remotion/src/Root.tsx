import React from 'react';
import { Composition } from 'remotion';
import { Explainer30s, explainerDefaults, type ExplainerProps } from './Explainer30s';

const FPS = 30;

// 时长由分镜决定：所有 scene.durationSec 之和
const calcMeta = ({ props }: { props: ExplainerProps }) => ({
  durationInFrames: Math.max(
    1,
    Math.round(props.scenes.reduce((s, sc) => s + sc.durationSec, 0) * FPS),
  ),
});

export const Root: React.FC = () => (
  <Composition
    id="explainer-30s"
    component={Explainer30s}
    fps={FPS}
    width={1920}
    height={1080}
    durationInFrames={30 * FPS}
    defaultProps={explainerDefaults}
    calculateMetadata={calcMeta}
  />
);
