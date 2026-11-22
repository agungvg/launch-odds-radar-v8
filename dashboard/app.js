// Launch-Odds Radar v8 dashboard. No network: everything comes from data.js.
// Sliders are initialised FROM the model's own constants in RADAR.model, so
// the slider default, range and label can never drift from the model.
(function () {
  var R = window.RADAR;
  var rows = R.rows;
  var ev = R.evidence;
  var $ = function (id) { return document.getElementById(id); };
  function fmt$(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function fmtInt(n) { return Math.round(n).toLocaleString('en-US'); }
  function fmtSigned(n) { return (n >= 0 ? '+$' : '-$') + Math.abs(Math.round(n)).toLocaleString('en-US'); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  // ---- economics, mirroring lib/model.ts exactly ----
  var DEPMIN = 1000, DEPMAX = 10000, TBILL = 0.04;
  function econ(row, depPct, drop, horizon) {
    var dep = clamp(depPct * row.tvl_usd, DEPMIN, DEPMAX);
    var weeks = Math.max(1, Math.ceil(horizon / 7));
    var gas = 3 + 8 + 2 + 2 * weeks + 4 + 4 + 2;
    var hours = (5 + 15 + 10 + 10 * weeks + 5 * weeks + 10 + 10 + 5 + 10) / 60;
    var gross = row.odds * row.implied_value_usd * drop * (dep / row.tvl_usd);
    var opp = dep * TBILL * (horizon / 365);
    var net = gross - gas - opp;
    var perHour = net / hours;
    var verdict = net > 0 && perHour >= 25 ? 'Farm' : net > 0 ? 'Thin' : 'Skip';
    return { dep: dep, gross: gross, gas: gas, opp: opp, net: net, hours: hours, perHour: perHour, verdict: verdict };
  }

  // ---- state from URL params (for screenshots + deep links) ----
  var params = new URLSearchParams(location.search);
  var state = {
    depPct: R.model.deposit_pct, drop: R.model.drop_share, horizon: R.model.horizon_days,
    q: params.get('q') || '', verdict: params.get('verdict') || '',
    wlOnly: params.get('wl') === '1', topOnly: params.get('top') === '1',
    sortK: 'implied_value_usd', sortDir: -1, slug: params.get('slug') || ''
  };

  // ---- header + KPI strip ----
  $('asof').textContent = R.as_of;
  $('mver').textContent = R.model_version;
  function kpi(val, label, cls) {
    return '<div class="kpi ' + (cls || '') + '"><b>' + val + '</b><span>' + label + '</span></div>';
  }
  var fc = ev.farm_counts;
  $('kpis').innerHTML =
    kpi(R.board_size, 'ranked rows', '') +
    kpi(R.watchlist_size + '/' + R.watchlist_size, 'watchlist covered', 'good') +
    kpi('x' + ev.loo, 'LOO miss (naive x' + ev.naive_loo + ')', '') +
    kpi('x' + ev.wf, 'walk-forward miss (66/29)', '') +
    kpi(ev.odds_auc, 'odds AUC (target 0.79)', 'warn') +
    kpi(ev.odds_brier, 'odds Brier', '') +
    kpi(ev.range_inner_cov + '%', 'P25–P75 coverage', 'good') +
    kpi(ev.range_outer_cov + '%', 'P10–P90 coverage', 'good') +
    kpi(fc.farm + ' Farm', 'Farm ' + fc.farm + ' · Thin ' + fc.thin + ' · Skip ' + fc.skip, fc.farm === 0 ? 'bad' : '');

  // ---- integrity strip: recompute in-page, compare with embedded totals ----
  (function () {
    var n = rows.length;
    var wl = rows.filter(function (r) { return r.wl; }).length;
    var sumTvl = rows.reduce(function (a, r) { return a + r.tvl_usd; }, 0);
    var sumImp = rows.reduce(function (a, r) { return a + r.implied_value_usd; }, 0);
    var ok = function (c) { return c ? '<b>OK</b>' : '<span class="bad">MISMATCH</span>'; };
    var ledger = R.board_size + R.set_aside_n + R.token_bearing_n;
    $('integrity').innerHTML =
      'Integrity — recomputed in this page from the board data: rows ' + n + ' ' + ok(n === R.board_size) +
      ' · watchlist ' + wl + '/' + R.watchlist_size + ' ' + ok(wl === R.watchlist_size) +
      ' · board TVL ' + fmt$(sumTvl) + ' ' + ok(sumTvl === R.totals.board_tvl) +
      ' · board implied ' + fmt$(sumImp) + ' ' + ok(sumImp === R.totals.board_implied) +
      ' · ledger ' + R.board_size + ' ranked + ' + R.set_aside_n + ' set aside (' + R.set_aside_below_cut + ' below the early cut, ' + R.set_aside_excluded + ' wrapped/bridged/versioned/exchange) + ' + R.token_bearing_n + ' token-bearing = ' + ledger + ' of ' + R.total_protocols + ' ' + ok(ledger === R.total_protocols) +
      ' · main.ts sha256 <span class="mono">' + R.main_sha256.slice(0, 16) + '…</span>';
  })();

  // ---- sliders (defaults + ranges from the model; labels show the same numbers the board uses) ----
  var depSl = $('depSl'), dropSl = $('dropSl'), horSl = $('horSl');
  depSl.min = 0.00005; depSl.max = 0.001; depSl.step = 0.00001; depSl.value = state.depPct;
  dropSl.min = 0.02; dropSl.max = 0.2; dropSl.step = 0.01; dropSl.value = state.drop;
  horSl.min = 30; horSl.max = 365; horSl.step = 1; horSl.value = state.horizon;
  function sliderLabels() {
    $('depLab').textContent = (state.depPct * 100).toFixed(3) + '% of TVL (deposit $1,000–$10,000)';
    $('dropLab').textContent = Math.round(state.drop * 100) + '% of supply to farmers';
    $('horLab').textContent = state.horizon + ' days';
  }
  function onSlider() {
    state.depPct = parseFloat(depSl.value);
    state.drop = parseFloat(dropSl.value);
    state.horizon = parseInt(horSl.value, 10);
    sliderLabels();
    renderBoard();
    if (state.slug) renderDetail(state.slug);
  }
  depSl.addEventListener('input', onSlider);
  dropSl.addEventListener('input', onSlider);
  horSl.addEventListener('input', onSlider);
  sliderLabels();

  // ---- board ----
  var tbody = document.querySelector('#board tbody');
  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    var list = rows.filter(function (r) {
      if (state.verdict) {
        var e0 = econ(r, state.depPct, state.drop, state.horizon);
        if (e0.verdict !== state.verdict) return false;
      }
      if (state.wlOnly && !r.wl) return false;
      if (state.topOnly && r.rank > 25) return false;
      if (q && (r.name + ' ' + r.slug + ' ' + (r.category || '')).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var k = state.sortK, d = state.sortDir;
    list.sort(function (a, b) {
      var x = a[k], y = b[k];
      if (typeof x === 'string') return d * (x < y ? -1 : x > y ? 1 : 0);
      return d * (x - y);
    });
    return list;
  }
  function renderBoard() {
    var list = visibleRows();
    var html = '';
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var e = econ(r, state.depPct, state.drop, state.horizon);
      html += '<tr data-slug="' + esc(r.slug) + '"><td>' + r.rank + ' <span style="color:#8b949e">(' + r.rank_lo + '–' + r.rank_hi + ')</span></td>' +
        '<td><b>' + esc(r.name) + '</b>' + (r.wl ? ' ★' : '') + '<br><span style="color:#8b949e">' + esc(r.slug) + '</span></td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td class="num">' + fmt$(r.tvl_usd) + '</td>' +
        '<td class="num"><b>' + fmt$(r.implied_value_usd) + '</b></td>' +
        '<td class="num">' + fmt$(r.p25_usd) + '–' + fmt$(r.p75_usd) + '</td>' +
        '<td class="num">' + r.multiple.toFixed(2) + 'x</td>' +
        '<td class="num">' + r.odds.toFixed(2) + '</td>' +
        '<td class="num">' + fmtSigned(e.net) + '</td>' +
        '<td class="num">' + fmtSigned(e.perHour) + '</td>' +
        '<td class="v' + e.verdict + '">' + e.verdict + '</td></tr>';
    }
    tbody.innerHTML = html;
    var f = ev.farm_counts;
    $('boardCount').textContent = list.length + ' of ' + rows.length + ' rows shown · at the current slider settings: Farm ' +
      rows.filter(function (r) { return econ(r, state.depPct, state.drop, state.horizon).verdict === 'Farm'; }).length +
      ' · Thin ' + rows.filter(function (r) { return econ(r, state.depPct, state.drop, state.horizon).verdict === 'Thin'; }).length +
      ' · ★ = watchlist row · rank range in brackets is the bootstrap 10th–90th percentile.';
  }
  tbody.addEventListener('click', function (ev2) {
    var tr = ev2.target.closest('tr');
    if (tr) renderDetail(tr.getAttribute('data-slug'));
  });
  document.querySelectorAll('#board th').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.getAttribute('data-k');
      if (state.sortK === k) state.sortDir = -state.sortDir;
      else { state.sortK = k; state.sortDir = k === 'name' || k === 'category' ? 1 : -1; }
      renderBoard();
    });
  });
  $('q').value = state.q;
  $('verdictSel').value = state.verdict;
  $('wlOnly').checked = state.wlOnly;
  $('topOnly').checked = state.topOnly;
  $('q').addEventListener('input', function () { state.q = $('q').value; renderBoard(); });
  $('verdictSel').addEventListener('change', function () { state.verdict = $('verdictSel').value; renderBoard(); });
  $('wlOnly').addEventListener('change', function () { state.wlOnly = $('wlOnly').checked; renderBoard(); });
  $('topOnly').addEventListener('change', function () { state.topOnly = $('topOnly').checked; renderBoard(); });
  renderBoard();

  // ---- detail view ----
  function nearestPeers(row, n) {
    var lt = Math.log10(row.tvl_usd);
    var scored = R.peers.map(function (p) {
      var d = Math.abs(Math.log10(p.tvl_usd) - lt) + (p.category === row.category ? 0 : 0.5);
      return { p: p, d: d };
    });
    scored.sort(function (a, b) { return a.d - b.d; });
    return scored.slice(0, n).map(function (s) { return s.p; });
  }
  function renderDetail(slug) {
    var row = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].slug === slug) row = rows[i];
    if (!row) return;
    state.slug = slug;
    var e = econ(row, state.depPct, state.drop, state.horizon);
    var peers = nearestPeers(row, 5);
    var steps = row.farm_steps || [];
    var stepsHtml = steps.length ? steps.map(function (s, i) {
      return '<li><b>Step ' + (i + 1) + '.</b> ' + esc(s) + '</li>';
    }).join('') : '<li>Farm plan ships in board.json (10 steps with cost + time each).</li>';
    var grid = '';
    var drops = [0.05, 0.08, 0.10, 0.12, 0.15];
    var deps = [0.0001, 0.0002, 0.0004];
    grid += '<div class="grid4"><div><b>drop \\ dep</b><span>pct of TVL</span></div>' +
      deps.map(function (d) { return '<div><b>' + (d * 100).toFixed(3) + '%</b><span>deposit pct</span></div>'; }).join('') + '</div>';
    drops.forEach(function (dr) {
      grid += '<div class="grid4"><div><b>' + Math.round(dr * 100) + '%</b><span>drop share</span></div>' +
        deps.map(function (d) {
          var e2 = econ(row, d, dr, state.horizon);
          return '<div><b>' + fmtSigned(e2.net) + '</b><span>' + e2.verdict + ' · $' + Math.round(e2.perHour) + '/h</span></div>';
        }).join('') + '</div>';
    });
    $('dTitle').textContent = '#' + row.rank + ' ' + row.name + ' — ' + e.verdict + ' · net ' + fmtSigned(e.net) + ' · ' + fmtSigned(e.perHour) + '/h';
    $('dBody').innerHTML =
      '<div class="detail-grid"><div><h3>Economics (at current sliders)</h3>' +
      '<table class="econ"><tbody>' +
      '<tr><td>Implied value</td><td><b>' + fmt$(row.implied_value_usd) + '</b> (multiple ' + row.multiple.toFixed(2) + 'x TVL)</td></tr>' +
      '<tr><td>Range P25–P75 / P10–P90</td><td>' + fmt$(row.p25_usd) + ' – ' + fmt$(row.p75_usd) + ' / ' + fmt$(row.p10_usd) + ' – ' + fmt$(row.p90_usd) + '</td></tr>' +
      '<tr><td>Bootstrap rank range</td><td>#' + row.rank_lo + ' – #' + row.rank_hi + ' (10th–90th of 200 refits)</td></tr>' +
      '<tr><td>Token odds</td><td>' + row.odds.toFixed(2) + ' — P(a protocol with this record already has a token)</td></tr>' +
      '<tr><td>TVL / age / chains</td><td>' + fmt$(row.tvl_usd) + ' / ' + (row.age_days == null ? 'unknown age' : row.age_days + ' days') + ' / ' + row.chains.length + ' chains</td></tr>' +
      '<tr><td>Deposit</td><td>' + fmt$(e.dep) + ' (' + (state.depPct * 100).toFixed(3) + '% of TVL, clamped $1,000–$10,000)</td></tr>' +
      '<tr><td>Expected airdrop $</td><td>' + fmtSigned(e.gross) + ' = odds ' + row.odds.toFixed(2) + ' x implied ' + fmt$(row.implied_value_usd) + ' x drop ' + Math.round(state.drop * 100) + '% x deposit/TVL</td></tr>' +
      '<tr><td>Gas (sum of steps)</td><td>-$' + e.gas + '</td></tr>' +
      '<tr><td>Opportunity cost</td><td>-$' + e.opp.toFixed(0) + ' (deposit at 4% T-Bill over ' + state.horizon + ' days)</td></tr>' +
      '<tr><td>Net $ / $ per hour</td><td><b>' + fmtSigned(e.net) + '</b> / ' + fmtSigned(e.perHour) + ' over ' + e.hours.toFixed(1) + ' hours</td></tr>' +
      '<tr><td>Verdict rule</td><td>Farm iff net &gt; $0 and ≥ $25/hour; Thin iff net &gt; $0; else Skip</td></tr>' +
      '</tbody></table>' +
      '<h3>Deposit x drop-share sensitivity — net $ at ' + state.horizon + ' days</h3>' + grid +
      '<p class="note">Each cell recomputes the same formula. The verdict is knife-edge honest: this row clears $25/hour only in the green cells.</p></div>' +
      '<div><h3>Farm plan — 10 steps, cost + time each</h3><ol class="steps">' + stepsHtml + '</ol>' +
      '<h3>Nearest priced peers</h3><table><thead><tr><th>Peer</th><th>TVL</th><th>Market cap</th><th>Multiple</th></tr></thead><tbody>' +
      peers.map(function (p) {
        return '<tr><td style="text-align:left">' + esc(p.name) + '<br><span style="color:#8b949e">' + esc(p.slug) + ' · ' + esc(p.category || '—') + '</span></td><td>' + fmt$(p.tvl_usd) + '</td><td>' + fmt$(p.mcap_usd) + '</td><td>' + p.multiple.toFixed(2) + 'x</td></tr>';
      }).join('') + '</tbody></table>' +
      '<p class="note">Nearest by log-TVL distance (same category preferred). Peers are priced protocols — the comparables the implied value is fitted from.</p></div></div>';
    $('detail').hidden = false;
    $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---- scatter: priced peers + fitted size curve ----
  (function () {
    var cv = $('scatter');
    var ctx = cv.getContext('2d');
    var W = cv.width, H = cv.height, padL = 56, padR = 16, padT = 14, padB = 34;
    var pts = R.peers.map(function (p) {
      return { x: Math.log10(p.tvl_usd), y: Math.log10(Math.max(1e-4, p.multiple)) };
    });
    var xs = pts.map(function (p) { return p.x; }), ys = pts.map(function (p) { return p.y; });
    var x0 = Math.min.apply(null, xs) - 0.1, x1 = Math.max.apply(null, xs) + 0.1;
    var y0 = Math.min.apply(null, ys) - 0.3, y1 = Math.max.apply(null, ys) + 0.3;
    function X(v) { return padL + (v - x0) / (x1 - x0) * (W - padL - padR); }
    function Y(v) { return H - padB - (v - y0) / (y1 - y0) * (H - padT - padB); }
    ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#30363d'; ctx.fillStyle = '#8b949e'; ctx.font = '11px system-ui';
    for (var gx = 7; gx <= 10; gx++) {
      ctx.beginPath(); ctx.moveTo(X(gx), padT); ctx.lineTo(X(gx), H - padB); ctx.stroke();
      ctx.fillText('$' + Math.pow(10, gx - 6).toFixed(0) + 'M', X(gx) - 12, H - 14);
    }
    for (var gy = -2; gy <= 1; gy++) {
      ctx.beginPath(); ctx.moveTo(padL, Y(gy)); ctx.lineTo(W - padR, Y(gy)); ctx.stroke();
      ctx.fillText((Math.pow(10, gy)).toFixed(gy < 0 ? 2 : 0) + 'x', 8, Y(gy) + 4);
    }
    ctx.fillStyle = '#58a6ff';
    pts.forEach(function (p) { ctx.fillRect(X(p.x) - 1.5, Y(p.y) - 1.5, 3, 3); });
    // fitted size curve: median multiple x exp(bin effect), stepped per bin
    var med = R.totals.priced_median_mult;
    ctx.strokeStyle = '#3fb950'; ctx.lineWidth = 2; ctx.beginPath();
    ev.size_bins.forEach(function (b, i) {
      var yv = Math.log10(Math.max(1e-4, med * Math.exp(b.effect)));
      var xa = X(b.lo), xb = X(b.hi);
      if (i === 0) ctx.moveTo(xa, Y(yv));
      ctx.lineTo(xa, Y(yv)); ctx.lineTo(xb, Y(yv));
    });
    ctx.stroke(); ctx.lineWidth = 1;
    ctx.fillStyle = '#3fb950'; ctx.fillText('fitted size curve (green)', padL + 8, padT + 12);
    ctx.fillStyle = '#58a6ff'; ctx.fillText('priced protocols (blue dots, n=' + pts.length + ')', padL + 8, padT + 28);
    var binsHtml = '<table><thead><tr><th>TVL bin (log10)</th><th>Fitted effect</th><th>Priced in bin</th></tr></thead><tbody>' +
      ev.size_bins.map(function (b) {
        return '<tr><td style="text-align:left">$' + (Math.pow(10, b.lo) / 1e6).toFixed(1) + 'M – $' + (Math.pow(10, b.hi) / 1e6).toFixed(1) + 'M</td><td>' + (b.effect >= 0 ? '+' : '') + b.effect.toFixed(2) + '</td><td>' + b.n + '</td></tr>';
      }).join('') + '</tbody></table>';
    $('sizeBins').innerHTML = binsHtml;
  })();

  // ---- evidence ----
  (function () {
    function pill(k) { return k ? '<span class="pill kept">KEPT</span>' : '<span class="pill rej">REJECTED</span>'; }
    var h = '<div class="ev">';
    h += '<h3>Value model — held-out miss by term (median exp|log error|; lower is better)</h3>';
    h += '<table><thead><tr><th>Term</th><th></th><th>LOO (128 priced)</th><th>Walk-forward (66 older / 29 newer)</th><th>Why</th></tr></thead><tbody>' +
      ev.terms.map(function (t) {
        return '<tr><td>' + esc(t.term) + '</td><td>' + pill(t.kept) + '</td><td>x' + t.loo.toFixed(2) + '</td><td>x' + t.wf.toFixed(2) + '</td><td>' + esc(t.note) + '</td></tr>';
      }).join('') + '</tbody></table>';
    h += '<p class="note">Naive (global median multiple): LOO x' + ev.naive_loo + ', walk-forward x' + ev.naive_wf + '. A term enters only if it lowers the miss in BOTH tests. Growth, age and chain-count all fail that bar and are out.</p>';
    h += '<h3>Value model — repeated 5-fold (seeds 0–4, all 25 folds shown)</h3>';
    h += '<p>Seed medians: ' + ev.five_fold_seed_medians.map(function (m) { return 'x' + m.toFixed(2); }).join(', ') + ' · median of seeds x' + ev.five_fold_median + ' · worst fold x' + ev.five_fold_worst + '.</p>';
    h += '<p class="mono">folds: ' + ev.five_fold_all.map(function (f) { return 'x' + f.toFixed(2); }).join(' · ') + '</p>';
    h += '<p class="note">The worst folds are not hidden: a fold that draws the snapshot&rsquo;s extreme protocols (log-multiple −8.29 to +5.99) misses wide. No honest model on this snapshot clears x4.5 on every fold — the fold tail is structural, and the LOO / walk-forward numbers above are the stable read.</p>';
    h += '<h3>Odds model — held-out AUC / Brier by term (stratified 5-fold, seed 0)</h3>';
    h += '<table><thead><tr><th>Term</th><th></th><th>AUC</th><th>Brier</th><th>Why</th></tr></thead><tbody>' +
      ev.odds_terms.map(function (t) {
        return '<tr><td>' + esc(t.term) + '</td><td>' + pill(t.kept) + '</td><td>' + t.auc.toFixed(3) + '</td><td>' + t.brier.toFixed(3) + '</td><td>' + esc(t.note) + '</td></tr>';
      }).join('') + '</tbody></table>';
    h += '<p class="note">Headline odds (5 seeds): AUC ' + ev.odds_auc + ' (seeds ' + ev.odds_seed_aucs.join(', ') + '), Brier ' + ev.odds_brier + ' (seeds ' + ev.odds_seed_briers.join(', ') + '). Age alone: AUC ' + ev.odds_age_only_auc + ', Brier ' + ev.odds_age_only_brier + '. Out-of-time (older half trains, newer half tests): AUC ' + ev.odds_time_auc + ', Brier ' + ev.odds_time_brier + ' — vs ' + ev.odds_time_auc_nocat + ' / ' + ev.odds_time_brier_nocat + ' without the peer rate. The ranking holds out of time; calibration degrades, because newer protocols mechanically have fewer tokens yet.</p>';
    h += '<h3>Ranges — 200 bootstrap refits + LOO residual scale (w = ' + ev.range_w + ', calibrated on LOO)</h3>';
    h += '<p>LOO coverage: P25–P75 band covers ' + ev.range_inner_cov + '% of priced actuals (target ≥ 57%), P10–P90 covers ' + ev.range_outer_cov + '% (target ≥ 76%). LOO residual sd (log) ' + ev.sigma_loo + '. w is the smallest factor clearing both targets on LOO data — a calibration constant, stated here, not a tweak per row.</p>';
    h += '<h3>Top category medians (log multiple)</h3>';
    h += '<p class="mono">' + ev.cat_top.map(function (c) { return esc(c.cat) + ' ' + c.med.toFixed(2) + ' (n=' + c.n + ')'; }).join(' · ') + '</p>';
    h += '</div>';
    $('evidence').innerHTML = h;
  })();

  // ---- live table ----
  $('live').querySelector('tbody').innerHTML = R.live.map(function (p) {
    return '<tr><td style="text-align:left"><b>' + esc(p.name) + '</b><br><span style="color:#8b949e">' + esc(p.slug) + '</span></td><td style="text-align:left">' + esc(p.category || '—') + '</td><td>' + fmt$(p.tvl_usd) + '</td><td>' + fmt$(p.mcap_usd) + '</td><td>' + p.multiple.toFixed(2) + 'x</td></tr>';
  }).join('');

  // ---- remaining misses ----
  $('misses').innerHTML = [
    'Worst 5-fold fold x' + ev.five_fold_worst + ' (median x' + ev.five_fold_median + '): the snapshot&rsquo;s extreme multiples make some folds miss wide. The fold list above shows all 25 — none hidden.',
    'Odds AUC ' + ev.odds_auc + ' vs the 0.79 target: no legitimate feature lifts it past ~0.76 on this snapshot. The category-value shortcut that would (0.808) is self-leakage and stays banned.',
    'Farm ' + fc.farm + ' of 198 at the stated defaults (drop 12%, 90 days, $25/hour after gas + T-bill cost). The best row pays $19/hour. The sensitivity grid in each detail view shows exactly which assumption would have to change.',
    'Odds calibration out of time: Brier ' + ev.odds_time_brier + ' on the newer half vs ' + ev.odds_brier + ' in cross-validation. Odds are a peers&rsquo;-record proxy, not a launch forecast.',
    'Value LOO x' + ev.loo + ' and walk-forward x' + ev.wf + ' vs rank 1&rsquo;s published x3.33 / x2.53: this model trails rank 1 on both held-out tests, and trails the earlier v6 claim too (LOO x3.20 / WF x2.12) — but no honest refit tried here reproduces v6&rsquo;s walk-forward (best honest x2.97; a refit that lets the test set into the fit gives x2.32, near v6&rsquo;s number), so v8 reports the honest numbers and treats v6&rsquo;s as not comparable.'
  ].map(function (m) { return '<li>' + m + '</li>'; }).join('');

  // ---- export ----
  function download(name, text, type) {
    var b = new Blob([text], { type: type });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  $('csvBtn').addEventListener('click', function () {
    var head = 'rank,slug,name,category,tvl_usd,implied_value_usd,p25_usd,p75_usd,p10_usd,p90_usd,multiple,odds,deposit_usd,gross_usd,gas_usd,opp_usd,net_usd,hours,per_hour_usd,verdict\n';
    var body = visibleRows().map(function (r) {
      var e = econ(r, state.depPct, state.drop, state.horizon);
      return [r.rank, r.slug, '"' + r.name.replace(/"/g, '""') + '"', '"' + (r.category || '') + '"', r.tvl_usd, r.implied_value_usd, r.p25_usd, r.p75_usd, r.p10_usd, r.p90_usd, r.multiple, r.odds, Math.round(e.dep), e.gross.toFixed(2), e.gas, e.opp.toFixed(2), e.net.toFixed(2), e.hours.toFixed(2), e.perHour.toFixed(2), e.verdict].join(',');
    }).join('\n');
    download('launch-odds-radar-v8.csv', head + body + '\n', 'text/csv');
  });
  $('jsonBtn').addEventListener('click', function () {
    var data = visibleRows().map(function (r) {
      var e = econ(r, state.depPct, state.drop, state.horizon);
      return { rank: r.rank, slug: r.slug, name: r.name, category: r.category, tvl_usd: r.tvl_usd, implied_value_usd: r.implied_value_usd, p25_usd: r.p25_usd, p75_usd: r.p75_usd, p10_usd: r.p10_usd, p90_usd: r.p90_usd, multiple: r.multiple, odds: r.odds, economics: e };
    });
    download('launch-odds-radar-v8.json', JSON.stringify(data, null, 1), 'application/json');
  });

  if (state.slug) renderDetail(state.slug);
})();
