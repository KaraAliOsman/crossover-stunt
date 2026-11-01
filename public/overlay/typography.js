export const TYPE = Object.freeze({
  display: [800, 72, 125, -0.36],
  headline: [750, 38, 112, 0],
  label: [650, 16, 100, 2.24],
  meta: [500, 20, 100, 0.8],
  data: [550, 28, 100, 0],
  stat: [600, 96, 100, 0],
  caption: [500, 28, 100, 0],
});
export function type(ctx, role, size) {
  const spec = TYPE[role];
  const mono = role === 'data' || role === 'stat';
  ctx.font = `${spec[0]} ${size ?? spec[1]}px "${mono ? 'Geist Mono' : 'Archivo'}", sans-serif`;
  if ('fontStretch' in ctx)
    ctx.fontStretch = spec[2] >= 125 ? 'expanded' : spec[2] > 100 ? 'semi-expanded' : 'normal';
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${spec[3]}px`;
}
export async function loadBroadcastFonts() {
  await Promise.all([
    ...[500, 650, 700, 750, 800].map((weight) => document.fonts.load(`${weight} 40px "Archivo"`)),
    ...[550, 600].map((weight) => document.fonts.load(`${weight} 96px "Geist Mono"`)),
  ]);
  await document.fonts.ready;
}
