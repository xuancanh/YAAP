/**
 * Self-contained HTML slide deck renderer for the slides_create tool.
 * Everything is inline (CSS + a tiny keyboard-nav script, no external
 * requests) so the deck renders inside the sandboxed, network-denied preview
 * iframe (FR-13.1) and can be shared as a single file.
 */
export interface SlideInput {
  title: string;
  bullets?: string[];
  notes?: string;
}

const MAX_SLIDES = 50;
const MAX_BULLETS = 20;

export function validateSlides(title: unknown, slides: unknown): { title: string; slides: SlideInput[] } {
  if (typeof title !== 'string' || title.length === 0) throw new Error('invalid arguments: "title" must be a non-empty string');
  if (!Array.isArray(slides) || slides.length === 0) throw new Error('invalid arguments: "slides" must be a non-empty array');
  if (slides.length > MAX_SLIDES) throw new Error(`invalid arguments: at most ${MAX_SLIDES} slides`);
  const out: SlideInput[] = [];
  for (const s of slides) {
    const slide = s as Record<string, unknown>;
    if (typeof slide?.title !== 'string' || slide.title.length === 0) {
      throw new Error('invalid arguments: every slide needs a "title" string');
    }
    const bullets = Array.isArray(slide.bullets) ? slide.bullets : [];
    if (bullets.length > MAX_BULLETS || bullets.some((b) => typeof b !== 'string')) {
      throw new Error(`invalid arguments: "bullets" must be up to ${MAX_BULLETS} strings`);
    }
    out.push({
      title: slide.title,
      bullets: bullets as string[],
      notes: typeof slide.notes === 'string' ? slide.notes : undefined,
    });
  }
  return { title, slides: out };
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderSlidesHtml(title: string, slides: SlideInput[]): string {
  const sections = slides.map((s, i) => `
  <section class="slide${i === 0 ? ' active' : ''}">
    <h2>${esc(s.title)}</h2>
    ${s.bullets && s.bullets.length > 0 ? `<ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
    ${s.notes ? `<aside class="notes">${esc(s.notes)}</aside>` : ''}
  </section>`).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  html, body { height: 100%; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0e1013; color: #e6e8eb; overflow: hidden; }
  .slide { display: none; height: 100vh; padding: 8vh 10vw; flex-direction: column; justify-content: center; }
  .slide.active { display: flex; }
  h2 { font-size: 2.6em; margin-bottom: 0.8em; color: #f5c451; }
  ul { font-size: 1.5em; line-height: 1.7; padding-left: 1.2em; }
  .notes { display: none; }
  body.show-notes .notes { display: block; margin-top: 2em; padding: 1em; background: #16181d; border-left: 3px solid #f5c451; font-size: 1em; color: #8b93a1; }
  #hud { position: fixed; bottom: 14px; right: 18px; color: #8b93a1; font-size: 13px; }
</style>
</head>
<body>
${sections}
<div id="hud"></div>
<script>
  var slides = document.querySelectorAll('.slide'), i = 0;
  var hud = document.getElementById('hud');
  function show(n) {
    i = Math.max(0, Math.min(slides.length - 1, n));
    slides.forEach(function (s, k) { s.classList.toggle('active', k === i); });
    hud.textContent = (i + 1) + ' / ' + slides.length + '  (arrows: navigate, n: notes)';
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') show(i + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') show(i - 1);
    else if (e.key === 'Home') show(0);
    else if (e.key === 'End') show(slides.length - 1);
    else if (e.key === 'n') document.body.classList.toggle('show-notes');
  });
  document.addEventListener('click', function () { show(i + 1); });
  show(0);
</script>
</body>
</html>`;
}
