// Small SVG chart kit on top of d3 (global). Every chart re-renders on resize,
// carries a hover/focus tooltip, and writes labels with textContent only.
/* global d3 */

const tip = (() => {
  const el = document.createElement('div');
  el.className = 'tooltip';
  el.setAttribute('role', 'status');
  el.hidden = true;
  document.body.appendChild(el);
  return {
    // rows: [{value, label, color?, strong?}] ; title: string
    show(evt, title, rows) {
      el.replaceChildren();
      if (title) {
        const h = document.createElement('div');
        h.className = 'tt-title';
        h.textContent = title;
        el.appendChild(h);
      }
      for (const r of rows) {
        const row = document.createElement('div');
        row.className = 'tt-row';
        if (r.color) {
          const k = document.createElement('span');
          k.className = 'tt-key';
          k.style.background = r.color;
          row.appendChild(k);
        }
        const v = document.createElement('strong');
        v.textContent = r.value;
        const l = document.createElement('span');
        l.textContent = r.label;
        row.append(v, l);
        el.appendChild(row);
      }
      el.hidden = false;
      this.move(evt);
    },
    move(evt) {
      let x, y;
      if (evt && 'clientX' in evt && evt.clientX) {
        x = evt.clientX;
        y = evt.clientY;
      } else if (evt?.target?.getBoundingClientRect) {
        const b = evt.target.getBoundingClientRect();
        x = b.left + b.width / 2;
        y = b.top;
      } else return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const left = Math.min(window.innerWidth - w - 8, Math.max(8, x + 14));
      const top = y - h - 12 < 8 ? y + 16 : y - h - 12;
      el.style.transform = `translate(${left}px, ${top}px)`;
    },
    hide() {
      el.hidden = true;
    },
  };
})();
export { tip };

export const fmt = {
  hours(h) {
    if (h >= 100) return `${Math.round(h).toLocaleString()} h`;
    if (h >= 10) return `${h.toFixed(0)} h`;
    if (h >= 1) return `${h.toFixed(1)} h`;
    return `${Math.round(h * 60)} min`;
  },
  int: (n) => Math.round(n).toLocaleString(),
  compact: (n) => (Math.abs(n) >= 1000 ? d3.format('.2~s')(n).replace('G', 'B') : d3.format(',.0f')(n)),
  pct: (p, d = 0) => `${(p * 100).toFixed(d)}%`,
};

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function observe(el, draw) {
  if (el._ro) el._ro.disconnect();
  let w = 0;
  const ro = new ResizeObserver(() => {
    if (el.clientWidth && el.clientWidth !== w) {
      w = el.clientWidth;
      draw(w);
    }
  });
  ro.observe(el);
  el._ro = ro;
}

// Top-rounded column path anchored on the baseline (square at the base).
function colPath(x, y, w, h, r) {
  r = Math.min(r, h, w / 2);
  if (h <= 0) return '';
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/**
 * Stacked (or single-series) columns with an x-snapping crosshair tooltip.
 * bins:   [{key, label, values: {seriesKey: number}}]
 * series: [{key, label, color}]   (stack order bottom -> top)
 */
export function columns(el, { bins, series, height = 260, yFormat = fmt.compact, valueFormat = yFormat, tickEvery, xLabel = (b) => b.label, onPick, emptyText = 'Nothing here for this period' }) {
  observe(el, (width) => {
    el.replaceChildren();
    if (!bins.length || !d3.sum(bins, (b) => d3.sum(series, (s) => b.values[s.key] || 0))) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = emptyText;
      el.appendChild(p);
      return;
    }
    const m = { t: 12, r: 8, b: 28, l: 44 };
    const iw = width - m.l - m.r;
    const ih = height - m.t - m.b;
    const totals = bins.map((b) => d3.sum(series, (s) => b.values[s.key] || 0));
    const x = d3.scaleBand().domain(bins.map((b) => b.key)).range([0, iw]).paddingInner(0.18).paddingOuter(0.05);
    const y = d3.scaleLinear().domain([0, d3.max(totals) || 1]).nice(4).range([ih, 0]);
    const bw = Math.max(1, Math.min(24, x.bandwidth()));
    const off = (x.bandwidth() - bw) / 2;

    const svg = d3.select(el).append('svg').attr('width', width).attr('height', height).attr('role', 'img');
    const g = svg.append('g').attr('transform', `translate(${m.l},${m.t})`);
    g.append('g')
      .attr('class', 'grid')
      .selectAll('line')
      .data(y.ticks(4))
      .join('line')
      .attr('x1', 0)
      .attr('x2', iw)
      .attr('y1', (d) => y(d) + 0.5)
      .attr('y2', (d) => y(d) + 0.5);
    g.append('g')
      .attr('class', 'axis')
      .selectAll('text')
      .data(y.ticks(4))
      .join('text')
      .attr('x', -8)
      .attr('y', (d) => y(d))
      .attr('dy', '0.32em')
      .attr('text-anchor', 'end')
      .text((d) => yFormat(d));
    g.append('line').attr('class', 'baseline').attr('x1', 0).attr('x2', iw).attr('y1', ih + 0.5).attr('y2', ih + 0.5);

    // x labels: thin out to what fits
    const every = tickEvery || Math.max(1, Math.ceil(bins.length / Math.max(1, Math.floor(iw / 46))));
    g.append('g')
      .attr('class', 'axis')
      .selectAll('text')
      .data(bins.filter((b, i) => i % every === 0))
      .join('text')
      .attr('x', (b) => x(b.key) + x.bandwidth() / 2)
      .attr('y', ih + 18)
      .attr('text-anchor', 'middle')
      .text((b) => xLabel(b));

    const cols = g.append('g');
    const surface = cssVar('--surface-1');
    bins.forEach((b, i) => {
      const col = cols.append('g').attr('class', 'col').attr('data-i', i);
      let acc = 0;
      const segs = series.map((s) => ({ s, v: b.values[s.key] || 0 })).filter((d) => d.v > 0);
      segs.forEach((d, j) => {
        const y0 = y(acc);
        acc += d.v;
        const y1 = y(acc);
        const top = j === segs.length - 1;
        const gap = j > 0 ? 2 : 0; // 2px surface gap between stacked segments
        const h = Math.max(0, y0 - y1 - gap);
        if (h <= 0) return;
        if (top) col.append('path').attr('d', colPath(x(b.key) + off, y1, bw, h, 4)).attr('fill', d.s.color);
        else col.append('rect').attr('x', x(b.key) + off).attr('y', y1).attr('width', bw).attr('height', h).attr('fill', d.s.color);
      });
      void surface;
    });

    const cross = g.append('line').attr('class', 'crosshair').attr('y1', 0).attr('y2', ih).style('opacity', 0);
    const hit = g.append('rect').attr('width', iw).attr('height', ih + m.b).attr('fill', 'transparent').attr('tabindex', 0).attr('aria-label', 'Chart data; use left and right arrows');
    let cur = -1;
    const pick = (i, evt) => {
      if (i < 0 || i >= bins.length) return;
      cur = i;
      const b = bins[i];
      const cx = x(b.key) + x.bandwidth() / 2;
      cross.attr('x1', cx).attr('x2', cx).style('opacity', 1);
      cols.selectAll('.col').classed('dim', function () {
        return +this.dataset.i !== i;
      });
      const rows = series
        .filter((s) => b.values[s.key])
        .slice()
        .reverse()
        .map((s) => ({ value: valueFormat(b.values[s.key]), label: s.label, color: series.length > 1 ? s.color : null }));
      if (series.length > 1) rows.push({ value: valueFormat(totals[i]), label: 'Total' });
      tip.show(evt, b.title || b.label, rows.length ? rows : [{ value: valueFormat(0), label: '' }]);
    };
    const nearest = (evt) => {
      const [px] = d3.pointer(evt, hit.node());
      const step = x.step();
      return Math.max(0, Math.min(bins.length - 1, Math.floor((px - x.paddingOuter() * step + (step * x.paddingInner()) / 2) / step)));
    };
    hit
      .on('pointermove', (evt) => pick(nearest(evt), evt))
      .on('pointerleave blur', () => {
        cur = -1;
        cross.style('opacity', 0);
        cols.selectAll('.col').classed('dim', false);
        tip.hide();
      })
      .on('click', (evt) => onPick && onPick(bins[nearest(evt)]))
      .on('keydown', (evt) => {
        if (evt.key === 'ArrowRight' || evt.key === 'ArrowLeft') {
          evt.preventDefault();
          pick(Math.max(0, Math.min(bins.length - 1, (cur < 0 ? 0 : cur) + (evt.key === 'ArrowRight' ? 1 : -1))), evt);
        } else if (evt.key === 'Enter' && onPick && cur >= 0) onPick(bins[cur]);
      });
    if (onPick) hit.style('cursor', 'pointer');
  });
}

/** Lines (shared % axis) with crosshair, end labels and end dots. points: [{key,label}] ; series: [{key,label,color,values:{pointKey:v}}] */
export function lines(el, { points, series, height = 220, yFormat = (v) => fmt.pct(v), domain = [0, 1] }) {
  observe(el, (width) => {
    el.replaceChildren();
    const m = { t: 14, r: 92, b: 28, l: 44 };
    const iw = width - m.l - m.r;
    const ih = height - m.t - m.b;
    const x = d3.scalePoint().domain(points.map((p) => p.key)).range([0, iw]).padding(0.3);
    const y = d3.scaleLinear().domain(domain).nice(4).range([ih, 0]);
    const svg = d3.select(el).append('svg').attr('width', width).attr('height', height).attr('role', 'img');
    const g = svg.append('g').attr('transform', `translate(${m.l},${m.t})`);
    g.append('g').attr('class', 'grid').selectAll('line').data(y.ticks(4)).join('line').attr('x1', 0).attr('x2', iw).attr('y1', (d) => y(d) + 0.5).attr('y2', (d) => y(d) + 0.5);
    g.append('g').attr('class', 'axis').selectAll('text').data(y.ticks(4)).join('text').attr('x', -8).attr('y', (d) => y(d)).attr('dy', '0.32em').attr('text-anchor', 'end').text(yFormat);
    g.append('g').attr('class', 'axis').selectAll('text').data(points).join('text').attr('x', (p) => x(p.key)).attr('y', ih + 18).attr('text-anchor', 'middle').text((p) => p.label);
    const line = d3.line().x((d) => x(d.k)).y((d) => y(d.v)).curve(d3.curveMonotoneX);
    for (const s of series) {
      const pts = points.filter((p) => s.values[p.key] != null).map((p) => ({ k: p.key, v: s.values[p.key] }));
      g.append('path').attr('d', line(pts)).attr('fill', 'none').attr('stroke', s.color).attr('stroke-width', 2).attr('stroke-linejoin', 'round').attr('stroke-linecap', 'round');
      const last = pts[pts.length - 1];
      if (last) {
        g.append('circle').attr('class', 'dot').attr('cx', x(last.k)).attr('cy', y(last.v)).attr('r', 4).attr('fill', s.color);
        g.append('text').attr('class', 'endlabel').attr('x', x(last.k) + 10).attr('y', y(last.v)).attr('dy', '0.32em').text(`${s.label} ${yFormat(last.v)}`);
      }
    }
    const cross = g.append('line').attr('class', 'crosshair').attr('y1', 0).attr('y2', ih).style('opacity', 0);
    const hit = g.append('rect').attr('width', iw).attr('height', ih).attr('fill', 'transparent').attr('tabindex', 0);
    const show = (i, evt) => {
      const p = points[i];
      cross.attr('x1', x(p.key)).attr('x2', x(p.key)).style('opacity', 1);
      tip.show(evt, p.label, series.filter((s) => s.values[p.key] != null).map((s) => ({ value: yFormat(s.values[p.key]), label: s.label, color: s.color })));
    };
    let cur = 0;
    hit
      .on('pointermove', (evt) => {
        const [px] = d3.pointer(evt);
        cur = d3.minIndex(points, (p) => Math.abs(x(p.key) - px));
        show(cur, evt);
      })
      .on('pointerleave blur', () => {
        cross.style('opacity', 0);
        tip.hide();
      })
      .on('keydown', (evt) => {
        if (evt.key === 'ArrowRight' || evt.key === 'ArrowLeft') {
          evt.preventDefault();
          cur = Math.max(0, Math.min(points.length - 1, cur + (evt.key === 'ArrowRight' ? 1 : -1)));
          show(cur, evt);
        }
      });
  });
}

/** 7x24 heatmap, sequential single-hue ramp. grid[dow][hour] = value */
export function heatmap(el, { grid, rowLabels, colLabel = (h) => h, valueFormat = fmt.hours, ramp }) {
  observe(el, (width) => {
    el.replaceChildren();
    const m = { t: 4, r: 4, b: 24, l: 40 };
    const cols = grid[0].length;
    // Columns shrink to fit the card; rows keep a readable height for their labels.
    const cell = Math.max(6, Math.min(30, Math.floor((width - m.l - m.r) / cols)));
    const rowH = Math.max(cell, 16);
    const iw = cell * cols;
    const ih = rowH * grid.length;
    const max = d3.max(grid.flat()) || 1;
    const color = d3.scaleQuantize().domain([0, max]).range(ramp);
    const svg = d3.select(el).append('svg').attr('width', iw + m.l + m.r).attr('height', ih + m.t + m.b).attr('role', 'img');
    const g = svg.append('g').attr('transform', `translate(${m.l},${m.t})`);
    grid.forEach((row, r) => {
      g.append('text').attr('class', 'axis').attr('x', -8).attr('y', r * rowH + rowH / 2).attr('dy', '0.32em').attr('text-anchor', 'end').text(rowLabels[r]);
      row.forEach((v, c) => {
        g.append('rect')
          .attr('class', 'cell')
          .attr('x', c * cell + 1)
          .attr('y', r * rowH + 1)
          .attr('width', cell - 2)
          .attr('height', rowH - 2)
          .attr('rx', Math.min(3, (cell - 2) / 2))
          .attr('fill', v ? color(v) : 'var(--cell-empty)')
          .attr('tabindex', 0)
          .on('pointerenter pointermove focus', (evt) => tip.show(evt, `${rowLabels[r]} · ${colLabel(c)}`, [{ value: valueFormat(v), label: 'listened' }]))
          .on('pointerleave blur', () => tip.hide());
      });
    });
    for (let c = 0; c < cols; c += cell < 12 ? 6 : cols > 12 ? 3 : 1)
      g.append('text').attr('class', 'axis').attr('x', c * cell + cell / 2).attr('y', ih + 16).attr('text-anchor', 'middle').text(colLabel(c));
  });
}

/** Tall segmented bar (one whole split into parts) + legend. parts: [{label, value, color, ink}] */
export function segmented(el, { parts, valueFormat = fmt.hours, legend = true }) {
  el.replaceChildren();
  const total = d3.sum(parts, (p) => p.value);
  const bar = document.createElement('div');
  bar.className = 'segbar';
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', parts.map((p) => `${p.label} ${fmt.pct(p.value / total)}`).join(', '));
  for (const p of parts) {
    if (!p.value) continue;
    const s = document.createElement('div');
    s.className = 'seg';
    s.style.flexGrow = p.value;
    s.style.background = p.color;
    s.style.color = p.ink || '#fff';
    s.tabIndex = 0;
    const share = p.value / total;
    if (share > 0.07) s.textContent = fmt.pct(share);
    const show = (evt) => tip.show(evt, p.label, [{ value: fmt.pct(share, 1), label: 'share' }, { value: valueFormat(p.value), label: 'listened' }]);
    s.addEventListener('pointermove', show);
    s.addEventListener('focus', show);
    s.addEventListener('pointerleave', () => tip.hide());
    s.addEventListener('blur', () => tip.hide());
    bar.appendChild(s);
  }
  el.appendChild(bar);
  if (legend) el.appendChild(legendEl(parts.filter((p) => p.value)));
}

export function legendEl(items, shape = 'rect') {
  const ul = document.createElement('ul');
  ul.className = 'legend';
  for (const it of items) {
    const li = document.createElement('li');
    const k = document.createElement('span');
    k.className = `lg-key ${shape}`;
    k.style.background = it.color;
    const t = document.createElement('span');
    t.textContent = it.label;
    li.append(k, t);
    ul.appendChild(li);
  }
  return ul;
}

/** Plain table for the "show data" disclosure. columns: [{label, value:(row)=>string, num?:bool}] */
export function table(el, { columns: cols, rows }) {
  el.replaceChildren();
  const t = document.createElement('table');
  t.className = 'data';
  const thead = t.createTHead().insertRow();
  for (const c of cols) {
    const th = document.createElement('th');
    th.textContent = c.label;
    if (c.num) th.className = 'num';
    thead.appendChild(th);
  }
  const tb = t.createTBody();
  for (const r of rows) {
    const tr = tb.insertRow();
    for (const c of cols) {
      const td = tr.insertCell();
      td.textContent = c.value(r);
      if (c.num) td.className = 'num';
    }
  }
  el.appendChild(t);
}
