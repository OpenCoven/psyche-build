import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import sharp from 'sharp';
import { BRAND_MOTION_ASSET, BRAND_PALETTE, BRAND_PATHS } from './brandConfig.mjs';

const execFileAsync = promisify(execFile);
const motionSceneSourcePath = fileURLToPath(import.meta.url);
const brandConfigSourcePath = fileURLToPath(new URL('./brandConfig.mjs', import.meta.url));

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function formatNumber(value) {
  return Number.parseFloat(value.toFixed(3)).toString();
}

function easeInOutSine(value) {
  return -(Math.cos(Math.PI * value) - 1) / 2;
}

function extractSvgParts(svgText) {
  const match = svgText.match(/<svg[^>]*viewBox\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*)<\/svg>/i);
  if (!match) {
    throw new Error('comux-wordmark.svg missing a parseable root <svg> with viewBox');
  }

  return {
    viewBox: match[1],
    innerMarkup: match[2].trim(),
  };
}

const cachedWordmarksByRoot = new Map();

async function loadWordmark(root) {
  const cachedWordmark = cachedWordmarksByRoot.get(root);
  if (cachedWordmark) {
    return cachedWordmark;
  }

  const svgText = await fs.readFile(path.join(root, BRAND_PATHS.wordmarkSource), 'utf8');
  const parsedWordmark = extractSvgParts(svgText);
  cachedWordmarksByRoot.set(root, parsedWordmark);
  return parsedWordmark;
}

export async function createMotionFingerprint({ root, renderOptions = BRAND_MOTION_ASSET.renderOptions }) {
  const [motionSceneSource, brandConfigSource, wordmarkSource] = await Promise.all([
    fs.readFile(motionSceneSourcePath, 'utf8'),
    fs.readFile(brandConfigSourcePath, 'utf8'),
    fs.readFile(path.join(root, BRAND_PATHS.wordmarkSource), 'utf8'),
  ]);

  return createHash('sha256')
    .update('comux-motion-fingerprint-v1')
    .update(motionSceneSource)
    .update(brandConfigSource)
    .update(wordmarkSource)
    .update(JSON.stringify(renderOptions))
    .digest('hex');
}

export async function renderMotionFrame({ root, frameIndex, frameCount, width, height }) {
  const { viewBox, innerMarkup } = await loadWordmark(root);
  const progress = frameCount <= 1 ? 0 : frameIndex / (frameCount - 1);
  const sweep = -width * 0.42 + progress * width * 1.78;
  const orbit = Math.sin(progress * Math.PI * 2);
  const orbitCos = Math.cos(progress * Math.PI * 2);
  const settle = easeInOutSine(clamp(progress * 1.15, 0, 1));
  const glowShift = 40 * orbit;
  const wordmarkDrift = orbitCos * 10;
  const hazeDrift = orbit * 24;
  const gridShift = orbitCos * 14;
  const beaconScale = 1 + settle * 0.05;
  const beamOpacity = 0.16 + settle * 0.1;
  const signalOpacity = 0.1 + (orbitCos + 1) * 0.05;
  const panelOffset = orbit * 18;
  const wordmarkWidth = 1260;
  const wordmarkHeight = 333.333;
  const wordmarkX = (width - wordmarkWidth) / 2;
  const wordmarkY = 262 + wordmarkDrift;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#111117"/>
      <stop offset="58%" stop-color="#0d0d12"/>
      <stop offset="100%" stop-color="#050507"/>
    </linearGradient>
    <radialGradient id="upper-glow" cx="50%" cy="0%" r="68%">
      <stop offset="0%" stop-color="${BRAND_PALETTE.purple}" stop-opacity="${formatNumber(0.2 + settle * 0.04)}"/>
      <stop offset="100%" stop-color="${BRAND_PALETTE.purple}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="sweep" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="${BRAND_PALETTE.lilac}" stop-opacity="0"/>
      <stop offset="45%" stop-color="${BRAND_PALETTE.lilac}" stop-opacity="${formatNumber(beamOpacity)}"/>
      <stop offset="52%" stop-color="${BRAND_PALETTE.purple}" stop-opacity="${formatNumber(beamOpacity + 0.06)}"/>
      <stop offset="100%" stop-color="${BRAND_PALETTE.lilac}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="panel" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${BRAND_PALETTE.lilac}" stop-opacity="0.13"/>
      <stop offset="100%" stop-color="${BRAND_PALETTE.lilac}" stop-opacity="0.02"/>
    </linearGradient>
    <linearGradient id="signal" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="${BRAND_PALETTE.purple}" stop-opacity="${formatNumber(signalOpacity)}"/>
      <stop offset="100%" stop-color="${BRAND_PALETTE.purple}" stop-opacity="0"/>
    </linearGradient>
    <filter id="soft-glow" x="-30%" y="-40%" width="160%" height="180%">
      <feGaussianBlur stdDeviation="18"/>
    </filter>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <rect width="${width}" height="${height}" fill="url(#upper-glow)"/>

  <g stroke="${BRAND_PALETTE.smoke}" stroke-opacity="0.09">
    <path d="M0 118h${width}M0 250h${width}M0 382h${width}M0 514h${width}M0 646h${width}M0 778h${width}M0 910h${width}"/>
    <path d="M160 0v${height}M432 0v${height}M704 0v${height}M976 0v${height}M1248 0v${height}M1520 0v${height}M1792 0v${height}"/>
  </g>

  <g transform="translate(${formatNumber(gridShift)},0)">
    <rect x="210" y="${formatNumber(150 + panelOffset)}" width="540" height="272" rx="28" fill="url(#panel)" stroke="${BRAND_PALETTE.lilac}" stroke-opacity="0.06"/>
    <rect x="1170" y="${formatNumber(594 - panelOffset)}" width="430" height="218" rx="26" fill="url(#panel)" stroke="${BRAND_PALETTE.lilac}" stroke-opacity="0.05"/>
  </g>

  <g filter="url(#soft-glow)">
    <ellipse cx="${formatNumber(width * 0.5 + glowShift)}" cy="334" rx="${formatNumber(376 * beaconScale)}" ry="${formatNumber(124 * beaconScale)}" fill="${BRAND_PALETTE.purple}" fill-opacity="0.18"/>
  </g>

  <path fill="url(#sweep)" d="M${formatNumber(sweep)} 0h260l420 ${height}h-260z"/>
  <path fill="url(#signal)" d="M${formatNumber(332 + hazeDrift)} 0h3v${height}h-3z"/>
  <path fill="url(#signal)" d="M${formatNumber(1585 - hazeDrift)} 0h3v${height}h-3z"/>

  <path fill="${BRAND_PALETTE.lilac}" opacity="0.08" d="M346 232h1228v5H346z"/>

  <g transform="translate(${formatNumber(wordmarkX)} ${formatNumber(wordmarkY)}) scale(1.111111)">
    <svg x="0" y="0" width="${wordmarkWidth}" height="${wordmarkHeight}" viewBox="${viewBox}" overflow="visible">
      ${innerMarkup}
    </svg>
  </g>

  <g opacity="0.5">
    <rect x="0" y="0" width="${width}" height="120" fill="url(#upper-glow)" transform="translate(0 ${formatNumber(16 + settle * 12)})"/>
  </g>
</svg>`;
}

export async function renderMotionVideo({ root, outputPath, renderOptions = BRAND_MOTION_ASSET.renderOptions }) {
  const resolvedOutputPath = path.isAbsolute(outputPath) ? outputPath : path.join(root, outputPath);
  await fs.mkdir(path.dirname(resolvedOutputPath), { recursive: true });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'comux-brand-motion-'));
  const frameTotal = renderOptions.fps * renderOptions.seconds;
  const fingerprint = await createMotionFingerprint({ root, renderOptions });

  try {
    for (let frameIndex = 0; frameIndex < frameTotal; frameIndex += 1) {
      const frameSvg = await renderMotionFrame({
        root,
        frameIndex,
        frameCount: frameTotal,
        width: renderOptions.width,
        height: renderOptions.height,
      });
      const framePath = path.join(tempDir, `frame-${String(frameIndex).padStart(4, '0')}.png`);
      await sharp(Buffer.from(frameSvg))
        .png()
        .toFile(framePath);
    }

    await execFileAsync(
      ffmpegPath,
      [
        '-y',
        '-framerate',
        String(renderOptions.fps),
        '-i',
        path.join(tempDir, 'frame-%04d.png'),
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        '-fflags',
        '+bitexact',
        '-flags:v',
        '+bitexact',
        '-metadata',
        'creation_time=1970-01-01T00:00:00Z',
        '-metadata',
        'encoder=comux-brand-pipeline',
        '-metadata',
        `comment=comux-motion-fingerprint:${fingerprint}`,
        '-threads',
        '1',
        '-r',
        String(renderOptions.fps),
        resolvedOutputPath,
      ],
      { timeout: 120000 },
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
