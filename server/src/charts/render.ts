import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Resvg, initWasm } from '@resvg/resvg-wasm';
import type { PreparedChart } from './chart-def.js';

/**
 * Server-side chart rendering for Excel exports and scheduled emails. Charts are drawn
 * as SVG here and rasterised with resvg compiled to WebAssembly, so there are no native
 * dependencies (no canvas / cairo / headless browser). Text uses the bundled DejaVu Sans
 * font; system fonts are never loaded.
 */
export const PALETTE = [
  '#6929c4',
  '#1192e8',
  '#005d5d',
  '#9f1853',
  '#fa4d56',
  '#570408',
  '#198038',
  '#002d9c',
  '#ee538b',
  '#b28600',
  '#009d9a',
  '#012749',
  '#8a3800',
  '#a56eff',
];
const FONT = 'DejaVu Sans';
const W = 960;
const H = 540;

type Ok = Extract<PreparedChart, { ok: true }>;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`).replace(/[\p{Cc}]/gu, '');
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const fmt = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${+(n / 1e3).toFixed(1)}K`;
  return String(+n.toFixed(2));
};
const text = (x: number, y: number, s: string, extra = '') =>
  `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${FONT}" font-size="12" fill="#393939" ${extra}>${esc(s)}</text>`;

function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) max = min + 1;
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= max + step * 1e-9; v += step)
    out.push(+v.toPrecision(12));
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

function legend(groups: string[], y: number): string {
  let x = 24;
  return groups
    .map((g, i) => {
      const s = clip(g, 28);
      const part = `<rect x="${x}" y="${y - 10}" width="12" height="12" fill="${PALETTE[i % PALETTE.length]}"/>${text(x + 18, y, s)}`;
      x += 30 + s.length * 7;
      return part;
    })
    .join('');
}

/** Build the SVG for a prepared chart. Exported for tests. */
export function chartSvg(c: Ok, title?: string): string {
  const def = c.def;
  const head = title ?? def.title ?? '';
  const parts: string[] = [`<rect width="${W}" height="${H}" fill="#ffffff"/>`];
  if (head)
    parts.push(
      `<text x="24" y="32" font-family="${FONT}" font-size="18" font-weight="bold" fill="#161616">${esc(clip(head, 80))}</text>`,
    );
  const pie = def.type === 'pie' || def.type === 'donut';
  if (!c.points.length) {
    parts.push(text(W / 2, H / 2, 'No numeric values to plot', 'text-anchor="middle"'));
  } else if (pie) {
    parts.push(pieSvg(c));
  } else {
    if (c.groups.length > 1) parts.push(legend(c.groups, 58));
    parts.push(axesSvg(c));
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`;
}

function pieSvg(c: Ok): string {
  const vals = c.keys.map((k) => Math.max(0, c.points.find((p) => p.key === k)?.value ?? 0));
  const sum = vals.reduce((a, b) => a + b, 0) || 1;
  const cx = 300;
  const cy = 300;
  const r = 200;
  const inner = c.def.type === 'donut' ? 120 : 0;
  let a0 = -Math.PI / 2;
  const out: string[] = [];
  vals.forEach((v, i) => {
    const frac = v / sum;
    const a1 = a0 + frac * Math.PI * 2;
    const color = PALETTE[i % PALETTE.length];
    if (frac >= 0.9999) {
      out.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>`);
    } else if (frac > 0) {
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = (a: number, rr: number) =>
        `${(cx + rr * Math.cos(a)).toFixed(2)} ${(cy + rr * Math.sin(a)).toFixed(2)}`;
      out.push(
        `<path d="M ${p(a0, r)} A ${r} ${r} 0 ${large} 1 ${p(a1, r)} L ${inner ? p(a1, inner) : `${cx} ${cy}`}${inner ? ` A ${inner} ${inner} 0 ${large} 0 ${p(a0, inner)}` : ''} Z" fill="${color}" stroke="#fff" stroke-width="1"/>`,
      );
    }
    a0 = a1;
  });
  if (inner) out.push(`<circle cx="${cx}" cy="${cy}" r="${inner}" fill="#fff"/>`);
  const shown = c.keys.slice(0, 16);
  shown.forEach((k, i) => {
    const y = 110 + i * 24;
    out.push(
      `<rect x="560" y="${y - 10}" width="12" height="12" fill="${PALETTE[i % PALETTE.length]}"/>`,
      text(580, y, `${clip(k, 30)} — ${fmt(vals[i])} (${((vals[i] / sum) * 100).toFixed(1)}%)`),
    );
  });
  if (c.keys.length > shown.length)
    out.push(text(580, 110 + shown.length * 24, `+${c.keys.length - shown.length} more`));
  return out.join('');
}

function axesSvg(c: Ok): string {
  const def = c.def;
  const horizontal = def.type === 'barHorizontal';
  const stacked = def.type === 'stackedBar';
  const line = def.type === 'line' || def.type === 'area';
  const L = horizontal ? 160 : 80;
  const R = 24;
  const T = 76;
  const B = horizontal ? 48 : 96;
  const pw = W - L - R;
  const ph = H - T - B;
  const val = (k: string, g: string) => c.points.find((p) => p.key === k && p.group === g)?.value;
  let lo = 0;
  let hi = 0;
  for (const k of c.keys) {
    let pos = 0;
    let neg = 0;
    for (const g of c.groups) {
      const v = val(k, g) ?? 0;
      if (stacked) {
        if (v >= 0) pos += v;
        else neg += v;
      } else {
        hi = Math.max(hi, v);
        lo = Math.min(lo, v);
      }
    }
    if (stacked) {
      hi = Math.max(hi, pos);
      lo = Math.min(lo, neg);
    }
  }
  const ticks = niceTicks(lo, hi);
  const tMin = ticks[0];
  const tMax = ticks[ticks.length - 1];
  const span = tMax - tMin || 1;
  // value -> pixel along the value axis
  const vp = (v: number) =>
    horizontal ? L + ((v - tMin) / span) * pw : T + ph - ((v - tMin) / span) * ph;
  const out: string[] = [];
  for (const t of ticks) {
    const p = vp(t);
    out.push(
      horizontal
        ? `<line x1="${p}" y1="${T}" x2="${p}" y2="${T + ph}" stroke="#e0e0e0"/>${text(p, T + ph + 18, fmt(t), 'text-anchor="middle"')}`
        : `<line x1="${L}" y1="${p}" x2="${L + pw}" y2="${p}" stroke="#e0e0e0"/>${text(L - 8, p + 4, fmt(t), 'text-anchor="end"')}`,
    );
  }
  const n = c.keys.length;
  const band = (horizontal ? ph : pw) / n;
  const labelEvery = Math.max(1, Math.ceil(n / (horizontal ? 24 : 30)));
  c.keys.forEach((k, i) => {
    if (i % labelEvery) return;
    const mid = (horizontal ? T : L) + band * (i + 0.5);
    out.push(
      horizontal
        ? text(L - 8, mid + 4, clip(k, 20), 'text-anchor="end"')
        : n > 8
          ? text(
              mid,
              T + ph + 14,
              clip(k, 14),
              `text-anchor="end" transform="rotate(-40 ${mid.toFixed(1)} ${(T + ph + 14).toFixed(1)})"`,
            )
          : text(mid, T + ph + 20, clip(k, 18), 'text-anchor="middle"'),
    );
  });
  const zero = vp(Math.max(tMin, Math.min(0, tMax)));
  if (line) {
    c.groups.forEach((g, gi) => {
      const color = PALETTE[gi % PALETTE.length];
      const pts = c.keys
        .map((k, i) => {
          const v = val(k, g);
          return v === undefined ? null : [L + band * (i + 0.5), vp(v)];
        })
        .filter((p): p is number[] => p !== null);
      if (!pts.length) return;
      const d = pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
      if (def.type === 'area')
        out.push(
          `<polygon points="${pts[0][0].toFixed(1)},${zero} ${d} ${pts[pts.length - 1][0].toFixed(1)},${zero}" fill="${color}" fill-opacity="0.25"/>`,
        );
      out.push(`<polyline points="${d}" fill="none" stroke="${color}" stroke-width="2"/>`);
      if (pts.length <= 60)
        for (const p of pts)
          out.push(
            `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3" fill="${color}"/>`,
          );
    });
  } else {
    const inner = band * 0.7;
    const gw = stacked ? inner : inner / c.groups.length;
    c.keys.forEach((k, i) => {
      let pos = 0;
      let neg = 0;
      c.groups.forEach((g, gi) => {
        const v = val(k, g);
        if (v === undefined) return;
        let a: number;
        let b: number;
        if (stacked) {
          a = v >= 0 ? pos : neg;
          b = a + v;
          if (v >= 0) pos = b;
          else neg = b;
        } else {
          a = 0;
          b = v;
        }
        const off = (horizontal ? T : L) + band * i + (band - inner) / 2 + (stacked ? 0 : gi * gw);
        const p1 = vp(a);
        const p2 = vp(b);
        const color = PALETTE[gi % PALETTE.length];
        out.push(
          horizontal
            ? `<rect x="${Math.min(p1, p2).toFixed(1)}" y="${off.toFixed(1)}" width="${Math.abs(p2 - p1).toFixed(1)}" height="${gw.toFixed(1)}" fill="${color}"/>`
            : `<rect x="${off.toFixed(1)}" y="${Math.min(p1, p2).toFixed(1)}" width="${gw.toFixed(1)}" height="${Math.abs(p2 - p1).toFixed(1)}" fill="${color}"/>`,
        );
      });
    });
  }
  out.push(
    horizontal
      ? `<line x1="${zero}" y1="${T}" x2="${zero}" y2="${T + ph}" stroke="#8d8d8d"/>`
      : `<line x1="${L}" y1="${zero}" x2="${L + pw}" y2="${zero}" stroke="#8d8d8d"/>`,
  );
  return out.join('');
}

let ready: Promise<Buffer[]> | undefined;
const req = createRequire(import.meta.url);
async function init(): Promise<Buffer[]> {
  ready ??= (async () => {
    await initWasm(await readFile(req.resolve('@resvg/resvg-wasm/index_bg.wasm')));
    return Promise.all(
      ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf'].map((f) =>
        readFile(req.resolve(`dejavu-fonts-ttf/ttf/${f}`)),
      ),
    );
  })().catch((e) => {
    ready = undefined;
    throw e;
  });
  return ready;
}

/** Render a prepared chart to a PNG (960×540). */
export async function renderChartPng(c: Ok, title?: string): Promise<Buffer> {
  const fonts = await init();
  const r = new Resvg(chartSvg(c, title), {
    font: { fontBuffers: fonts, defaultFontFamily: FONT, loadSystemFonts: false },
    background: '#ffffff',
  });
  return Buffer.from(r.render().asPng());
}
