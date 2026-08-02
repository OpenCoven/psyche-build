export const BRAND_PALETTE = {
  black: '#050507',
  graphite: '#111117',
  smoke: '#8e879f',
  violet: '#6d28d9',
  purple: '#8b5cf6',
  lilac: '#efe7ff',
};

export const BRAND_OUTPUTS = {
  wordmark: { width: 1134, height: 300 },
  favicon: { width: 1024, height: 1024 },
  og: { width: 1424, height: 752 },
  video: { width: 1920, height: 1080, fps: 30, seconds: 6 },
};

export const BRAND_PATHS = {
  wordmarkSource: 'docs/brand/source/psyche-wordmark.svg',
  markSource: 'docs/brand/source/psyche-mark.svg',
  heroSource: 'docs/brand/source/psyche-hero.svg',
  ogSource: 'docs/brand/source/psyche-og.svg',
  motionSceneSource: 'docs/brand/source/psyche-motion-scene.mjs',
  publicWordmark: 'docs/public/psyche.svg',
  publicMark: 'docs/public/favicon.svg',
  publicHero: 'docs/public/psyche.svg',
  publicFaviconRaster: 'docs/public/favicon.svg',
  publicOgRaster: 'docs/public/og.svg',
  publicVideo: '',
  repoWordmarkVector: 'psyche.svg',
  repoWordmarkRaster: '',
  nativeHelperIcon: '',
};

export const BRAND_VECTOR_ASSETS = [
  {
    asset: 'wordmark',
    sourcePath: BRAND_PATHS.wordmarkSource,
    publicPath: BRAND_PATHS.publicWordmark,
    mirrorPaths: [BRAND_PATHS.repoWordmarkVector],
  },
  {
    asset: 'mark',
    sourcePath: BRAND_PATHS.markSource,
    publicPath: BRAND_PATHS.publicMark,
    mirrorPaths: [],
  },
];

export const BRAND_STILL_ASSETS = [
  {
    asset: 'hero',
    sourcePath: BRAND_PATHS.heroSource,
    publicPath: BRAND_PATHS.publicHero,
    format: 'png',
    renderOptions: BRAND_OUTPUTS.wordmark,
    mirrorPaths: [BRAND_PATHS.repoWordmarkRaster],
  },
  {
    asset: 'favicon',
    sourcePath: BRAND_PATHS.markSource,
    publicPath: BRAND_PATHS.publicFaviconRaster,
    format: 'png',
    renderOptions: BRAND_OUTPUTS.favicon,
    mirrorPaths: [BRAND_PATHS.nativeHelperIcon],
  },
  {
    asset: 'og',
    sourcePath: BRAND_PATHS.ogSource,
    publicPath: BRAND_PATHS.publicOgRaster,
    format: 'jpeg',
    renderOptions: BRAND_OUTPUTS.og,
    mirrorPaths: [],
  },
];

export const BRAND_MOTION_ASSET = {
  asset: 'motion',
  sourcePath: BRAND_PATHS.motionSceneSource,
  publicPath: BRAND_PATHS.publicVideo,
  renderOptions: BRAND_OUTPUTS.video,
};
