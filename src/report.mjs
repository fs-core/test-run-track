import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function buildHtmlReport({ card, env, filter, rows, rerunFilter, elapsedSec, clusters, out }) {
  const failed = rows.filter((r) => r.outcome === 'Failed');
  const passed = rows.filter((r) => r.outcome === 'Passed');
  const skipped = rows.filter((r) => !['Passed', 'Failed'].includes(r.outcome));

  const verdict = rows.length === 0 ? 'No tests matched'
    : failed.length === 0 ? 'All clear' : `${failed.length} failing`;
  const vClass = rows.length === 0 ? 'warn' : failed.length === 0 ? 'ok' : 'bad';

  const clusterHtml = clusters?.length ? `
  <section><h2>Shared root cause</h2>
    ${clusters.map((c) => `
    <article class="cluster">
      <h3>${c.test_count} tests, one error signature <span class="fp">${esc(c.fingerprint)}</span></h3>
      <pre class="err">${esc((c.sample ?? '').split(/\r?\n/).slice(0, 4).join('\n'))}</pre>
      <div class="muted">${esc(c.tests)}</div>
    </article>`).join('')}
  </section>` : '';

  const failHtml = failed.length ? `
  <section><h2>Failures</h2>
    ${failed.map((f) => `
    <article class="failure">
      <h3>${esc(f.display_name)}</h3>
      <div class="label">Error</div><pre class="err">${esc(f.message)}</pre>
      <div class="label">Stack trace</div><pre>${esc(f.stack)}</pre>
    </article>`).join('')}
  </section>` : '';

  const listSection = (title, items, extra) => items.length ? `
  <section><h2>${title} <span class="muted">(${items.length})</span></h2>
    <ul class="plain">${items.map((r) => `<li>${esc(r.display_name)}<span class="dur">${extra(r)}</span></li>`).join('')}</ul>
  </section>` : '';

  const rerunHtml = rerunFilter ? `
  <section><h2>Rerun filter</h2>
    <pre class="filter" id="filter">${esc(rerunFilter)}</pre>
    <button onclick="navigator.clipboard.writeText(document.getElementById('filter').innerText)">Copy filter</button>
  </section>` : '';

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(card)} E2E results</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
<style>
 :root{--teal:#1E4854;--green:#07A279;--blue:#007BC2;--orange:#DF7543;
       --lgreen:#4DC491;--blush:#FEF0E9;--mint:#DFF2E9;--icy:#E0EFFC}
 *{box-sizing:border-box}
 body{margin:0;font-family:'DM Sans',system-ui,sans-serif;font-size:15px;color:var(--teal);background:#fff}
 header{background:var(--teal);color:#fff;padding:32px 40px}
 header h1{margin:0;font-size:38px;font-weight:700;color:var(--lgreen)}
 header .meta{margin-top:8px;font-size:13px;color:#cfe0e5}
 header code{background:rgba(255,255,255,.12);padding:2px 6px;border-radius:4px}
 .verdict{padding:16px 40px;font-size:22px;font-weight:700}
 .verdict.ok{background:var(--mint);color:var(--green)}
 .verdict.bad{background:var(--blush);color:var(--orange)}
 .verdict.warn{background:var(--icy);color:var(--blue)}
 .stats{display:flex;gap:16px;padding:28px 40px;background:var(--blush);flex-wrap:wrap}
 .stat{min-width:110px}.stat .n{font-size:60px;font-weight:700;line-height:1}
 .stat .l{font-size:12px;text-transform:uppercase;letter-spacing:.06em}
 .n.ok{color:var(--green)}.n.bad{color:var(--orange)}.n.warn{color:var(--blue)}.n.tot{color:var(--teal)}
 main{padding:8px 40px 60px}section{margin-top:36px}
 h2{font-size:22px;font-weight:500;color:var(--blue);margin:0 0 14px}
 h3{font-size:16px;font-weight:700;color:var(--orange);margin:0 0 10px}
 .muted{color:#7a949c;font-weight:400;font-size:13px}
 .fp{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#7a949c;font-weight:400}
 .label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#7a949c;margin:12px 0 4px}
 pre{font-family:ui-monospace,Consolas,monospace;font-size:12.5px;background:#fff;border:1px solid var(--icy);
     border-left:3px solid var(--blue);padding:12px 14px;border-radius:6px;white-space:pre-wrap;margin:0;overflow-x:auto}
 pre.err{border-left-color:var(--orange);background:var(--blush)}
 pre.filter{border-left-color:var(--green);background:var(--mint);font-size:13px}
 article{background:#fff;border:1px solid var(--blush);border-radius:10px;padding:18px 20px;margin-bottom:16px}
 article.cluster{background:var(--icy);border-color:var(--icy)}
 ul.plain{list-style:none;padding:0;margin:0}
 ul.plain li{padding:7px 12px;border-radius:6px;background:var(--mint);margin-bottom:5px;display:flex;justify-content:space-between}
 ul.plain li .dur{color:#7a949c;font-size:12px}
 button{font-family:inherit;font-size:14px;font-weight:500;background:var(--teal);color:#fff;border:0;
        padding:10px 18px;border-radius:6px;margin-top:10px;cursor:pointer}
 button:hover{background:var(--green)}
 footer{padding:20px 40px;background:var(--icy);font-size:12px;color:#5b7a83}
</style></head><body>
<header><h1>${esc(card)}</h1>
 <div class="meta">env <code>${esc(env)}</code> &middot; filter <code>${esc(filter)}</code>
 &middot; ${Math.round(elapsedSec ?? 0)}s &middot; ${new Date().toISOString().slice(0, 16).replace('T', ' ')}</div>
</header>
<div class="verdict ${vClass}">${esc(verdict)}</div>
<div class="stats">
 <div class="stat"><div class="n tot">${rows.length}</div><div class="l">Total</div></div>
 <div class="stat"><div class="n ok">${passed.length}</div><div class="l">Passed</div></div>
 <div class="stat"><div class="n bad">${failed.length}</div><div class="l">Failed</div></div>
 <div class="stat"><div class="n warn">${skipped.length}</div><div class="l">Not run</div></div>
</div>
<main>
${clusterHtml}${rerunHtml}${failHtml}
${listSection('Passed', passed, (r) => (r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : ''))}
${listSection('Not run', skipped, (r) => esc(r.outcome))}
</main>
<footer>Panorama CRM &middot; E2E results for ${esc(card)}</footer>
</body></html>`;

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html, 'utf8');
  return out;
}
