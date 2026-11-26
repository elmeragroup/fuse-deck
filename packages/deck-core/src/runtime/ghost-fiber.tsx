import { useEffect, useRef } from "react";

import { createPortal } from "react-dom";

import { useSlideBackdropHost } from "./slide-backdrop.tsx";

type RGB = readonly [number, number, number];

type Palette = {
  readonly isDark: boolean;
  readonly core: RGB;
  readonly mid: RGB;
  readonly glow: RGB;
  readonly secondary: RGB;
};

type SpriteSet = {
  readonly sharpCore: HTMLCanvasElement;
  readonly sharpMid: HTMLCanvasElement;
  readonly bokehMid: HTMLCanvasElement;
  readonly bokehSecondary: HTMLCanvasElement;
  readonly ridgeGlow: HTMLCanvasElement;
  readonly veilGlow: HTMLCanvasElement;
};

type RibbonSpec = {
  readonly phase: number;
  readonly xShift: number;
  readonly xAspectScale: number;
  readonly yShift: number;
  readonly zOffset: number;
  readonly rotation: number;
  readonly baseSpan: number;
  readonly spanAspectScale: number;
  readonly halfWidth: number;
  readonly twistBase: number;
  readonly twistRate: number;
  readonly waveAmp: number;
  readonly waveFreq: number;
  readonly volume: number;
  readonly speedScale: number;
  readonly flowSpeed: number;
  readonly threads: number;
  readonly dotsPerUnit: number;
  readonly weight: number;
  readonly glowWeight: number;
};

type DustSpeck = {
  readonly u: number;
  readonly y: number;
  readonly z: number;
  readonly speed: number;
  readonly size: number;
  readonly phase: number;
};

type DensityTier = {
  readonly threadStride: number;
  readonly dotStride: number;
};

type RibbonFrame = {
  readonly ribbon: RibbonSpec;
  readonly rt: number;
  readonly cosRot: number;
  readonly sinRot: number;
  readonly span: number;
  readonly xShift: number;
  readonly halfW: number;
  readonly halfH: number;
  readonly scale: number;
  readonly tiltX: number;
  readonly tiltY: number;
};

type SpineSample = {
  spineX: number;
  spineY: number;
  spineZ: number;
  cosT: number;
  sinT: number;
  widthEnv: number;
};

type ProjectedPoint = {
  px: number;
  py: number;
  pz3: number;
  persp: number;
};

const LIGHT_PALETTE: Palette = {
  isDark: false,
  core: [16, 16, 20],
  mid: [63, 63, 72],
  glow: [63, 63, 74],
  secondary: [132, 132, 144],
};

const DARK_PALETTE: Palette = {
  isDark: true,
  core: [255, 255, 255],
  mid: [216, 216, 224],
  glow: [228, 228, 236],
  secondary: [152, 152, 164],
};

// Hero sweeping S-curve silk veil plus a quiet distant lower-right echo.
// Both expand with viewport aspect so ribbons travel past every screen edge without wasted off-screen span.
const RIBBONS: readonly RibbonSpec[] = [
  {
    phase: 0.72,
    xShift: 0.06,
    xAspectScale: 0,
    yShift: -0.22,
    zOffset: 0.1,
    rotation: -0.34,
    baseSpan: 2.8,
    spanAspectScale: 1.75,
    halfWidth: 0.78,
    twistBase: 0.48,
    twistRate: 2.25,
    waveAmp: 0.44,
    waveFreq: 1.9,
    volume: 0.14,
    speedScale: 0.78,
    flowSpeed: 0.042,
    threads: 56,
    dotsPerUnit: 30,
    weight: 1.0,
    glowWeight: 1.0,
  },
  {
    phase: 2.95,
    xShift: 0,
    xAspectScale: 0.64,
    yShift: 0.9,
    zOffset: -0.45,
    rotation: -0.58,
    baseSpan: 1.8,
    spanAspectScale: 0.95,
    halfWidth: 0.52,
    twistBase: 1.25,
    twistRate: 1.6,
    waveAmp: 0.24,
    waveFreq: 1.65,
    volume: 0.1,
    speedScale: 0.56,
    flowSpeed: 0.032,
    threads: 28,
    dotsPerUnit: 29,
    weight: 0.58,
    glowWeight: 0.42,
  },
];

const FULL_DENSITY: DensityTier = { threadStride: 1, dotStride: 1 };

// Animated density tiers: cap animated drawImage calls and step down cleanly when frames exceed budget,
// while reduced-motion stills render at FULL_DENSITY.
const ANIMATED_TIERS: readonly DensityTier[] = [
  { threadStride: 2, dotStride: 1 },
  { threadStride: 2, dotStride: 2 },
  { threadStride: 3, dotStride: 2 },
  { threadStride: 4, dotStride: 2 },
  { threadStride: 4, dotStride: 3 },
];

const GLOW_TRACKS = [
  { v: 0, tight: false },
  { v: -0.78, tight: true },
  { v: 0.78, tight: true },
] as const;

function hashUnit(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

// Deterministic floating dust field so reduced-motion frames and visual tests stay repeatable.
const DUST: readonly DustSpeck[] = Array.from({ length: 38 }, (_, index) => {
  const n = index + 1;
  return {
    u: hashUnit(n * 1.17) * 2 - 1,
    y: (hashUnit(n * 2.31) * 2 - 1) * 0.92,
    z: (hashUnit(n * 3.73) * 2 - 1) * 0.95,
    speed: 0.009 + hashUnit(n * 4.91) * 0.016,
    size: 5 + hashUnit(n * 5.63) * 8,
    phase: hashUnit(n * 6.47) * Math.PI * 2,
  };
});

// Subtle organic depth ripple across threads while keeping longitudinal dots braided in phase.
const MAX_THREADS = 64;
const THREAD_Z_RIPPLE = Float32Array.from(
  { length: MAX_THREADS },
  (_, i) => Math.sin(i * 0.68) * 0.65 + (hashUnit(i * 3.17 + 1) - 0.5) * 0.7
);
const THREAD_FLOW_DRIFT = Float32Array.from(
  { length: MAX_THREADS },
  (_, i) => 0.94 + Math.sin(i * 0.27) * 0.08
);

const BASE_HEIGHT = 720;
const MIN_WIDTH = 480;
const MAX_WIDTH = 2400;
const CAMERA_Z = 4.6;
const FOCUS_Z = 0.28;
const STILL_TIME = 4.9;

function createRadialSprite(
  size: number,
  rgb: RGB,
  stops: readonly (readonly [number, number])[]
): HTMLCanvasElement {
  const sprite = document.createElement("canvas");
  sprite.width = size;
  sprite.height = size;
  const ctx = sprite.getContext("2d");
  if (ctx === null) {
    return sprite;
  }
  const half = size * 0.5;
  const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
  const prefix = `rgba(${String(rgb[0])},${String(rgb[1])},${String(rgb[2])},`;
  for (const [offset, alpha] of stops) {
    grad.addColorStop(offset, `${prefix}${alpha.toFixed(3)})`);
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return sprite;
}

function buildSprites(palette: Palette): SpriteSet {
  return {
    sharpCore: createRadialSprite(24, palette.core, [
      [0, 1],
      [0.36, 0.96],
      [0.64, 0.34],
      [1, 0],
    ]),
    sharpMid: createRadialSprite(24, palette.mid, [
      [0, 0.96],
      [0.38, 0.84],
      [0.68, 0.26],
      [1, 0],
    ]),
    bokehMid: createRadialSprite(48, palette.mid, [
      [0, 0.64],
      [0.44, 0.44],
      [0.74, 0.14],
      [1, 0],
    ]),
    bokehSecondary: createRadialSprite(48, palette.secondary, [
      [0, 0.54],
      [0.46, 0.34],
      [0.78, 0.1],
      [1, 0],
    ]),
    ridgeGlow: createRadialSprite(48, palette.core, [
      [0, 0.68],
      [0.24, 0.42],
      [0.58, 0.12],
      [1, 0],
    ]),
    veilGlow: createRadialSprite(64, palette.glow, [
      [0, 0.34],
      [0.36, 0.18],
      [0.7, 0.05],
      [1, 0],
    ]),
  };
}

function readPalette(): Palette {
  const theme = document.documentElement.getAttribute("data-theme");
  if (theme === "dark") {
    return DARK_PALETTE;
  }
  if (theme === "light") {
    return LIGHT_PALETTE;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? DARK_PALETTE : LIGHT_PALETTE;
}

function computeCanvasSize(container: HTMLElement) {
  const rect = container.getBoundingClientRect();
  const aspect =
    rect.width > 0 && rect.height > 0
      ? rect.width / rect.height
      : Math.max(1, window.innerWidth) / Math.max(1, window.innerHeight);
  const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(BASE_HEIGHT * aspect)));
  return { width, height: BASE_HEIGHT };
}

function intersectAxisInterval(
  minU: number,
  maxU: number,
  origin: number,
  slope: number,
  limit: number
): readonly [number, number] {
  if (Math.abs(slope) < 1e-6) {
    return Math.abs(origin) <= limit ? [minU, maxU] : [1, -1];
  }
  const a = (-limit - origin) / slope;
  const b = (limit - origin) / slope;
  return [Math.max(minU, Math.min(a, b)), Math.min(maxU, Math.max(a, b))];
}

function sampleRibbonSpine(frame: RibbonFrame, u: number, out: SpineSample): void {
  const { ribbon, rt, span } = frame;
  out.spineX = u * span;
  out.spineY =
    ribbon.waveAmp * Math.sin(u * ribbon.waveFreq + rt * 0.26 + ribbon.phase) +
    ribbon.waveAmp * 0.36 * Math.sin(u * 3.15 - rt * 0.17 + ribbon.phase * 1.4);
  out.spineZ =
    ribbon.zOffset +
    0.46 * Math.cos(u * 1.55 + rt * 0.22 + ribbon.phase) +
    0.18 * Math.sin(u * 2.6 + rt * 0.14);

  const twist =
    ribbon.twistBase + u * ribbon.twistRate + rt * 0.15 + 0.42 * Math.sin(u * 1.3 - rt * 0.12 + ribbon.phase);
  out.cosT = Math.cos(twist);
  out.sinT = Math.sin(twist);
  out.widthEnv = 0.66 + 0.34 * Math.cos(u * 1.35 - rt * 0.11);
}

function projectRibbonPoint(
  frame: RibbonFrame,
  spine: SpineSample,
  vNorm: number,
  normalOffset: number,
  out: ProjectedPoint
): void {
  const { ribbon, cosRot, sinRot, xShift, halfW, halfH, scale, tiltX, tiltY } = frame;
  const offset = vNorm * ribbon.halfWidth * spine.widthEnv;
  const lx = spine.spineX + offset * 0.12 * spine.sinT;
  const ly = spine.spineY + offset * spine.cosT + normalOffset * 0.35 * spine.sinT;
  const lz = spine.spineZ + offset * spine.sinT + normalOffset * spine.cosT;

  const rx = xShift + lx * cosRot - ly * sinRot;
  const ry = ribbon.yShift + lx * sinRot + ly * cosRot;
  const px3 = rx + lz * tiltX;
  const py3 = ry + lz * tiltY;
  const pz3 = lz - rx * tiltX * 0.22 - ry * tiltY * 0.22;
  const persp = CAMERA_Z / Math.max(1.5, CAMERA_Z - pz3);

  out.px = halfW + px3 * scale * persp;
  out.py = halfH + py3 * scale * persp;
  out.pz3 = pz3;
  out.persp = persp;
}

function drawFrame(
  ctx: CanvasRenderingContext2D,
  glowCtx: CanvasRenderingContext2D,
  glowCanvas: HTMLCanvasElement,
  sprites: SpriteSet,
  palette: Palette,
  t: number,
  tiltX: number,
  tiltY: number,
  density: DensityTier
): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const glowW = glowCanvas.width;
  const glowH = glowCanvas.height;
  const aspect = w / Math.max(1, h);
  const halfW = w * 0.5;
  const halfH = h * 0.5;
  const scale = h * 0.46;
  const glowScaleX = glowW / w;
  const glowScaleY = glowH / h;

  ctx.clearRect(0, 0, w, h);
  glowCtx.clearRect(0, 0, glowW, glowH);

  const blendMode: GlobalCompositeOperation = palette.isDark ? "lighter" : "source-over";
  ctx.globalCompositeOperation = blendMode;
  glowCtx.globalCompositeOperation = palette.isDark ? "lighter" : "source-over";

  // Conservative world-space viewport bounds at minimum perspective for early off-screen culling.
  const maxWorldX = (halfW + 32) / (scale * 0.68) + 0.25;
  const maxWorldY = (halfH + 32) / (scale * 0.68) + 0.25;

  const spine: SpineSample = { spineX: 0, spineY: 0, spineZ: 0, cosT: 1, sinT: 0, widthEnv: 1 };
  const projected: ProjectedPoint = { px: 0, py: 0, pz3: 0, persp: 1 };

  const { threadStride, dotStride } = density;
  const strideArea = threadStride * dotStride;
  // Compensate dot alpha and size subtly as animated stride steps down so luminous silk weight holds steady.
  const alphaCompensation = strideArea > 1 ? Math.min(1.45, Math.pow(strideArea, 0.26)) : 1;
  const sizeCompensation = strideArea > 1 ? Math.min(1.38, Math.pow(strideArea, 0.16)) : 1;

  for (let r = RIBBONS.length - 1; r >= 0; r -= 1) {
    const ribbon = RIBBONS[r];
    if (ribbon === undefined) {
      continue;
    }

    const rt = t * ribbon.speedScale;
    const cosRot = Math.cos(ribbon.rotation);
    const sinRot = Math.sin(ribbon.rotation);
    const span = Math.max(ribbon.baseSpan, aspect * ribbon.spanAspectScale);
    const xShift = ribbon.xShift + aspect * ribbon.xAspectScale;
    const threadCount = ribbon.threads;
    const dotCount = Math.max(48, Math.min(160, Math.round(span * ribbon.dotsPerUnit)));

    const frame: RibbonFrame = {
      ribbon,
      rt,
      cosRot,
      sinRot,
      span,
      xShift,
      halfW,
      halfH,
      scale,
      tiltX,
      tiltY,
    };

    const margin = ribbon.halfWidth + ribbon.waveAmp * 1.36 + ribbon.volume + 0.15;
    const [uMinX, uMaxX] = intersectAxisInterval(-1, 1, xShift, span * cosRot, maxWorldX + margin);
    const [uMin, uMax] = intersectAxisInterval(
      uMinX,
      uMaxX,
      ribbon.yShift,
      span * sinRot,
      maxWorldY + margin
    );
    if (uMin > uMax) {
      continue;
    }

    // Pass 1: luminous satin fold crest and soft atmospheric veil into the quarter-res buffer.
    const spineSamples = Math.max(72, Math.round(span * 24));
    const iStart = Math.max(0, Math.floor((uMin + 1) * 0.5 * spineSamples));
    const iEnd = Math.min(spineSamples, Math.ceil((uMax + 1) * 0.5 * spineSamples));
    for (let i = iStart; i <= iEnd; i += 1) {
      const frac = i / spineSamples;
      const u = frac * 2 - 1;
      const endFade = Math.min(1, frac * 8, (1 - frac) * 8);
      sampleRibbonSpine(frame, u, spine);
      const fold = Math.pow(Math.abs(spine.sinT), 1.85);

      // Stamp wide atmospheric halo along the ribbon spine plus a tighter satin crest along the fold edge.
      for (const track of GLOW_TRACKS) {
        projectRibbonPoint(frame, spine, track.v, 0, projected);
        const gx = projected.px * glowScaleX;
        const gy = projected.py * glowScaleY;

        if (track.tight) {
          const ridgeStrength = fold * endFade * ribbon.glowWeight;
          if (ridgeStrength < 0.08) {
            continue;
          }
          const radius = (6.8 + (1 - fold) * 4.5) * projected.persp;
          if (gx < -radius || gx > glowW + radius || gy < -radius || gy > glowH + radius) {
            continue;
          }
          glowCtx.globalAlpha = Math.min(
            palette.isDark ? 0.4 : 0.16,
            (palette.isDark ? 0.27 : 0.1) * ridgeStrength
          );
          glowCtx.drawImage(sprites.ridgeGlow, gx - radius, gy - radius, radius * 2, radius * 2);
        } else {
          const radius = (15 + (1 - fold) * 11) * projected.persp;
          if (gx < -radius || gx > glowW + radius || gy < -radius || gy > glowH + radius) {
            continue;
          }
          const alpha = (palette.isDark ? 0.16 : 0.075) * ribbon.glowWeight * endFade * (0.28 + fold * 1.35);
          if (alpha < 0.008) {
            continue;
          }
          glowCtx.globalAlpha = Math.min(palette.isDark ? 0.36 : 0.15, alpha);
          glowCtx.drawImage(sprites.veilGlow, gx - radius, gy - radius, radius * 2, radius * 2);
        }
      }
    }

    // Pass 2: braided stippled silk dot lattice with depth-of-field softening and fold caustics.
    const threadSteps =
      threadCount <= 1
        ? 0
        : threadStride === 1
          ? threadCount - 1
          : Math.max(2, Math.round((threadCount - 1) / threadStride));

    for (let s = 0; s <= threadSteps; s += 1) {
      const j = threadSteps > 0 ? Math.round((s / threadSteps) * (threadCount - 1)) : 0;
      const vNorm = threadCount > 1 ? (j / (threadCount - 1)) * 2 - 1 : 0;
      const absV = Math.abs(vNorm);
      // Slight brightening near the outer selvedge edge echoes light catching a folded silk border.
      const edgeProfile = Math.pow(1 - absV * 0.55, 1.05) * (0.86 + 0.34 * Math.pow(absV, 3));
      const zJitter = (THREAD_Z_RIPPLE[j] ?? 0) * ribbon.volume;
      const speedMul = THREAD_FLOW_DRIFT[j] ?? 1;
      // Smoothly staggered phase across adjacent threads creates the woven moire fabric rhythm.
      const braidedPhase = j * 0.017 + Math.sin(j * 0.35) * 0.012;
      const rawPhase = t * ribbon.flowSpeed * speedMul + braidedPhase;
      const flowShift =
        dotStride === 1 ? ((rawPhase % 1) + 1) % 1 : ((((rawPhase / dotStride) % 1) + 1) % 1) * dotStride;

      const rawStart = Math.max(0, Math.floor((uMin + 1) * 0.5 * dotCount - flowShift));
      const bStart = Math.floor(rawStart / dotStride) * dotStride;
      const bEnd = Math.min(dotCount, Math.ceil((uMax + 1) * 0.5 * dotCount - flowShift) + 1);

      for (let b = bStart; b < bEnd; b += dotStride) {
        const frac = (b + flowShift) / dotCount;
        const u = frac * 2 - 1;
        const endFade = Math.min(1, frac * 8, (1 - frac) * 8);
        if (endFade < 0.03) {
          continue;
        }

        sampleRibbonSpine(frame, u, spine);
        // Subtle weave crimp undulation perpendicular to the ribbon surface.
        const weaveCrimp = 0.03 * Math.sin(u * 18 + j * 0.55);
        projectRibbonPoint(frame, spine, vNorm, zJitter + weaveCrimp, projected);

        const { px, py, pz3, persp } = projected;
        if (px < -32 || px > w + 32 || py < -32 || py > h + 32) {
          continue;
        }

        const dof = Math.min(1.4, Math.abs(pz3 - FOCUS_Z));
        const inFocus = Math.max(0.28, 1 - dof * 0.56);
        const fold = Math.abs(spine.sinT);
        const caustic = Math.pow(fold, 1.75);
        const sparkleWave = 0.7 + 0.3 * Math.sin(b * 2.1 + j * 1.45 + t * 1.25);
        const depthFade = Math.max(0.32, Math.min(1.08, 0.82 + pz3 * 0.26));

        const baseAlpha =
          (palette.isDark ? 0.62 : 0.52) *
          ribbon.weight *
          edgeProfile *
          endFade *
          depthFade *
          inFocus *
          sparkleWave *
          (0.42 + caustic * 0.95) *
          alphaCompensation;

        if (baseAlpha < 0.02) {
          continue;
        }

        const isOutOfFocus = dof > 0.54;
        const isBrightFold = (caustic > 0.52 || absV > 0.82) && dof < 0.48;
        const sprite = isOutOfFocus
          ? pz3 < -0.2
            ? sprites.bokehSecondary
            : sprites.bokehMid
          : isBrightFold
            ? sprites.sharpCore
            : sprites.sharpMid;

        const size =
          (isOutOfFocus ? 6.8 + dof * 7.5 : 4.2 + dof * 3.0 + caustic * 1.35) * persp * sizeCompensation;
        const halfSize = size * 0.5;
        ctx.globalAlpha = Math.min(palette.isDark ? 0.88 : 0.68, baseAlpha);
        ctx.drawImage(sprite, px - halfSize, py - halfSize, size, size);
      }
    }
  }

  // Pass 3: composite the satin fold crest and soft bloom over the stippled silk field.
  // Bilinear smoothing ("low") avoids expensive Lanczos resampling on an already-blurred radial glow buffer.
  ctx.save();
  ctx.globalCompositeOperation = palette.isDark ? "screen" : "source-over";
  ctx.globalAlpha = palette.isDark ? 0.96 : 0.86;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "low";
  ctx.drawImage(glowCanvas, 0, 0, w, h);
  ctx.restore();

  // Pass 4: quiet floating bokeh dust in 3D depth space.
  ctx.globalCompositeOperation = blendMode;
  const dustSpan = Math.max(2.6, aspect * 1.45);
  for (const speck of DUST) {
    const u = (((((speck.u + 1) * 0.5 + t * speck.speed) % 1) + 1) % 1) * 2 - 1;
    const x3 = u * dustSpan + speck.z * tiltX;
    const y3 = speck.y + 0.055 * Math.sin(t * 0.42 + speck.phase) + speck.z * tiltY;
    const persp = CAMERA_Z / Math.max(1.8, CAMERA_Z - speck.z);
    const px = halfW + x3 * scale * persp;
    const py = halfH + y3 * scale * persp;
    const size = speck.size * persp;
    const halfSize = size * 0.5;
    if (px < -halfSize || px > w + halfSize || py < -halfSize || py > h + halfSize) {
      continue;
    }
    const twinkle = 0.48 + 0.52 * Math.sin(t * 0.9 + speck.phase);
    const edge = 1 - Math.abs(u) * 0.85;
    const alpha = (palette.isDark ? 0.4 : 0.26) * twinkle * Math.max(0, edge);
    if (alpha < 0.014) {
      continue;
    }
    ctx.globalAlpha = alpha;
    ctx.drawImage(sprites.bokehSecondary, px - halfSize, py - halfSize, size, size);
  }

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

function GhostFiberCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderedStillRef = useRef<{
    readonly width: number;
    readonly height: number;
    readonly isDark: boolean;
  } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (container === null || canvas === null) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      return;
    }

    const glowCanvas = document.createElement("canvas");
    const glowCtx = glowCanvas.getContext("2d");
    if (glowCtx === null) {
      return;
    }

    const syncSize = () => {
      const next = computeCanvasSize(container);
      const nextGlowWidth = Math.max(120, Math.round(next.width / 4));
      const nextGlowHeight = Math.max(90, Math.round(next.height / 4));
      let changed = false;
      if (canvas.width !== next.width || canvas.height !== next.height) {
        canvas.width = next.width;
        canvas.height = next.height;
        renderedStillRef.current = null;
        changed = true;
      }
      if (glowCanvas.width !== nextGlowWidth || glowCanvas.height !== nextGlowHeight) {
        glowCanvas.width = nextGlowWidth;
        glowCanvas.height = nextGlowHeight;
        changed = true;
      }
      return changed;
    };
    syncSize();

    let palette = readPalette();
    let sprites = buildSprites(palette);
    const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
    const colorQuery = window.matchMedia("(prefers-color-scheme: dark)");

    // Spring-damped pointer tilt so cursor parallax feels physical instead of snapped.
    let targetTiltX = 0;
    let targetTiltY = 0;
    let tiltX = 0;
    let tiltY = 0;
    let velX = 0;
    let velY = 0;

    let frameId: number | null = null;
    let elapsed = STILL_TIME;
    let lastNow = performance.now();
    let hasFrameSample = false;
    let tierIndex = 0;
    let avgFrameMs = 16.7;
    let slowStreak = 0;

    const stop = () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
        frameId = null;
      }
    };

    const startAnimation = () => {
      stop();
      if (reducedQuery.matches || document.hidden) {
        return;
      }
      lastNow = performance.now();
      hasFrameSample = false;
      frameId = requestAnimationFrame(tick);
    };

    const tick = (now: number) => {
      frameId = null;
      const rawFrameMs = Math.max(1, now - lastNow);
      const dt = Math.min(0.05, Math.max(0.001, rawFrameMs / 1000));
      lastNow = now;
      elapsed += dt;

      // Critically damped spring at 6.5 rad/s for zero-overshoot pointer ease.
      const omega = 6.5;
      const ax = (targetTiltX - tiltX) * omega * omega - 2 * omega * velX;
      const ay = (targetTiltY - tiltY) * omega * omega - 2 * omega * velY;
      velX += ax * dt;
      velY += ay * dt;
      tiltX += velX * dt;
      tiltY += velY * dt;

      const tier = ANIMATED_TIERS[tierIndex] ?? FULL_DENSITY;
      renderedStillRef.current = null;
      const drawStart = performance.now();
      drawFrame(ctx, glowCtx, glowCanvas, sprites, palette, elapsed, tiltX, tiltY, tier);
      const drawMs = performance.now() - drawStart;

      // Step animated density down monotonically for the visit when draw duration or frame cadence exceeds budget.
      const clampedFrameMs = Math.min(120, rawFrameMs);
      if (hasFrameSample) {
        avgFrameMs = avgFrameMs * 0.7 + clampedFrameMs * 0.3;
      }
      hasFrameSample = true;

      if (drawMs > 28 && tierIndex < ANIMATED_TIERS.length - 1) {
        tierIndex = Math.min(ANIMATED_TIERS.length - 1, tierIndex + 2);
        avgFrameMs = clampedFrameMs * 0.6;
        slowStreak = 0;
      } else if (drawMs > 14 || avgFrameMs > 27) {
        slowStreak += 1;
        if (slowStreak >= 2 && tierIndex < ANIMATED_TIERS.length - 1) {
          tierIndex += 1;
          avgFrameMs = clampedFrameMs * 0.75;
          slowStreak = 0;
        }
      } else {
        slowStreak = 0;
      }

      if (!reducedQuery.matches && !document.hidden) {
        frameId = requestAnimationFrame(tick);
      }
    };

    const renderStill = () => {
      const rendered = renderedStillRef.current;
      // Skip repainting the exact same reduced-motion still when StrictMode replays the effect on mount.
      if (
        rendered !== null &&
        rendered.width === canvas.width &&
        rendered.height === canvas.height &&
        rendered.isDark === palette.isDark
      ) {
        return;
      }
      drawFrame(ctx, glowCtx, glowCanvas, sprites, palette, STILL_TIME, 0, 0, FULL_DENSITY);
      renderedStillRef.current = { width: canvas.width, height: canvas.height, isDark: palette.isDark };
    };

    const onReducedMotionChange = () => {
      stop();
      if (reducedQuery.matches) {
        renderStill();
        return;
      }
      startAnimation();
    };

    const onVisibilityChange = () => {
      if (reducedQuery.matches) {
        return;
      }
      if (document.hidden) {
        stop();
      } else {
        startAnimation();
      }
    };

    const onThemeChange = () => {
      const next = readPalette();
      if (next.isDark === palette.isDark) {
        return;
      }
      palette = next;
      sprites = buildSprites(palette);
      if (reducedQuery.matches) {
        renderStill();
      }
    };

    const onResize = () => {
      if (!syncSize()) {
        return;
      }
      if (reducedQuery.matches) {
        renderStill();
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!finePointer.matches || reducedQuery.matches) {
        return;
      }
      const nx = (event.clientX / Math.max(1, window.innerWidth)) * 2 - 1;
      const ny = (event.clientY / Math.max(1, window.innerHeight)) * 2 - 1;
      targetTiltX = nx * 0.085;
      targetTiltY = ny * 0.065;
    };

    const onPointerLeave = () => {
      targetTiltX = 0;
      targetTiltY = 0;
    };

    const observer = new MutationObserver(onThemeChange);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(container);
    colorQuery.addEventListener("change", onThemeChange);
    reducedQuery.addEventListener("change", onReducedMotionChange);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onPointerLeave);

    onReducedMotionChange();

    return () => {
      stop();
      observer.disconnect();
      resizeObserver.disconnect();
      colorQuery.removeEventListener("change", onThemeChange);
      reducedQuery.removeEventListener("change", onReducedMotionChange);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
    };
  }, []);

  return (
    <div ref={containerRef} className="deck-elmera-cover-bg" data-background="ghost-fiber" aria-hidden="true">
      <canvas ref={canvasRef} className="deck-elmera-cover-canvas" width={1280} height={BASE_HEIGHT} />
    </div>
  );
}

/**
 * Monochrome atmospheric ghost-fiber canvas rendered behind `<ElmeraCover>` when enabled.
 * Adapts to light and dark themes, matches the viewport aspect ratio edge-to-edge, pauses when
 * the document is hidden, and draws one calm static frame under `prefers-reduced-motion: reduce`.
 */
export function GhostFiberBackground() {
  const host = useSlideBackdropHost();
  switch (host._tag) {
    case "pending":
      return null;
    case "ready":
      return createPortal(<GhostFiberCanvas />, host.element);
    case "unmanaged":
      return <GhostFiberCanvas />;
  }
}
