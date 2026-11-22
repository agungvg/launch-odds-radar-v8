// Launch-Odds Radar v8 — entrypoint (Node 22+, standard library only).
//
// Reads the sealed snapshot, fits the value + odds models at runtime
// (lib/model.ts), ranks 198 pre-token protocols (40 watchlist + 158 early),
// and writes board.json, data.js, dashboard/, screenshots/ and dossier.json.
// Nothing is hardcoded from a past version: every figure the dashboard
// shows is fitted from this snapshot on this run.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot, sha256Hex } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json). */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar v8: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const mainSha = sha256Hex(readFileSync(join(here, 'main.ts'), 'utf8'));
const { board, radar } = buildRadar(snapshot, mainSha);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar v8: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar v8: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar v8: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

process.stdout.write(
  `token radar v8: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live shown)\n` +
    `token radar v8: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')}, ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);

// Evidence summary, printed every run so a bad model cannot hide: the
// held-out numbers are the entry's claim, and they are printed next to
// the targets the build was asked to hold.
const ev = radar.evidence;
process.stdout.write(
  `token radar v8: value LOO x${ev.loo} (naive x${ev.naive_loo}) | walk-forward x${ev.wf} (naive x${ev.naive_wf}, 66 older / 29 newer) | 5-fold median x${ev.five_fold_median} worst x${ev.five_fold_worst}\n` +
    `token radar v8: ranges P25-P75 cover ${ev.range_inner_cov}% / P10-P90 cover ${ev.range_outer_cov}% (LOO, w=${ev.range_w}) | odds AUC ${ev.odds_auc} Brier ${ev.odds_brier}\n` +
    `token radar v8: verdicts Farm ${ev.farm_counts.farm} / Thin ${ev.farm_counts.thin} / Skip ${ev.farm_counts.skip} | ledger ${board.length} ranked + ${radar.set_aside_n} set aside + ${radar.token_bearing_n} token-bearing = ${board.length + radar.set_aside_n + radar.token_bearing_n} of ${snapshot.protocols.length}\n` +
    `token radar v8: top row ${board[0]!.slug} implied $${board[0]!.implied_value_usd} | main.ts sha256 ${mainSha.slice(0, 16)}…\n`,
);
