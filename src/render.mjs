const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const red = c('31');
export const green = c('32');
export const yellow = c('33');
export const blue = c('34');
export const magenta = c('35');
export const cyan = c('36');
export const dim = c('90');
export const bold = c('1');

export const rule = (w = 74) => dim('='.repeat(w));
export const thin = (w = 70) => dim('-'.repeat(w));

export function pad(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 3) + '...' : s.padEnd(n);
}

export function indent(text, spaces = 6, width = 100) {
  if (!text) return [];
  const prefix = ' '.repeat(spaces);
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.length <= width) { out.push(prefix + line); continue; }
    let buf = '';
    for (const word of line.split(' ')) {
      if (buf && buf.length + word.length + 1 > width) { out.push(prefix + buf); buf = word; }
      else buf = buf ? `${buf} ${word}` : word;
    }
    if (buf) out.push(prefix + buf);
  }
  return out;
}

export function fmtElapsed(sec) {
  if (sec == null) return '-';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? `${m}m ${s}s` : `${s}s`;
}

/**
 * Turns a pass/fail sequence into a verdict. Transitions matter more than the
 * raw failure rate: '..X..X..X.' is flaky, while '....XXXXXX' is a test that
 * broke once and stayed broken — a regression, not flake.
 */
export function classify(seq) {
  const runs = seq.length;
  const failures = seq.filter((s) => s === 'X').length;
  let flips = 0;
  for (let i = 1; i < runs; i++) if (seq[i] !== seq[i - 1]) flips++;
  const failPct = runs ? Math.round((100 * failures) / runs) : 0;

  let verdict;
  if (failures === 0) verdict = 'stable';
  else if (failures === runs) verdict = 'always failing';
  else if (flips >= 3) verdict = 'FLAKY';
  else if (seq[runs - 1] === 'X') verdict = 'broke recently';
  else verdict = 'intermittent';

  return { runs, failures, failPct, flips, verdict, last: seq[runs - 1], pattern: seq.join('') };
}

export function verdictColor(v) {
  switch (v) {
    case 'stable': return green;
    case 'FLAKY': return yellow;
    case 'always failing': return red;
    case 'broke recently': return red;
    default: return yellow;
  }
}
