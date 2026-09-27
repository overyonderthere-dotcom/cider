const $app = document.getElementById('app');

const SCORE_LABELS = ['', 'Pour it out', 'Drinkable', 'Good', 'Very good', 'Make it again'];
let filter = 'all';
let suggestions = null;

// ---------- utilities ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const today = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const fmtDate = (s) => s
  ? new Date(s + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  : '';
const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `The server returned an error (${res.status}).`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

async function getSuggestions() {
  if (!suggestions) {
    try { suggestions = await api('GET', '/api/suggestions'); }
    catch { suggestions = { juices: [], yeasts: [], ingredients: [], additions: [] }; }
  }
  return suggestions;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}

const stageOf = (b) => (!b.bottled_date ? 'fermenting' : (b.rating_count || (b.ratings && b.ratings.length)) ? 'rated' : 'bottled');

// ---------- the jug ----------
const JUG_BODY = 'M24 5 H36 V14 C36 19 52 22 52 35 V70 Q52 76 46 76 H14 Q8 76 8 70 V35 C8 22 24 19 24 14 Z';
let jugCount = 0;
function jug(stage, size = 44) {
  const id = 'jugclip' + (++jugCount);
  const fermenting = stage === 'fermenting';
  const bubbles = fermenting
    ? `<g>
        <circle class="bubble" cx="20" cy="68" r="1.8" fill="#fff"/>
        <circle class="bubble" cx="31" cy="70" r="1.4" fill="#fff"/>
        <circle class="bubble" cx="40" cy="66" r="2" fill="#fff"/>
        <circle class="bubble" cx="26" cy="72" r="1.2" fill="#fff"/>
      </g>`
    : '';
  const top = fermenting
    ? '<path d="M30 5 V1" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>'
    : '<rect x="22" y="1" width="16" height="6" rx="1.5" fill="currentColor"/>';
  return `<svg class="jug" width="${size}" height="${Math.round(size * 80 / 60)}" viewBox="0 0 60 80" aria-hidden="true">
    <defs><clipPath id="${id}"><path d="${JUG_BODY}"/></clipPath></defs>
    <g clip-path="url(#${id})">
      <rect x="0" y="27" width="60" height="60" fill="${fermenting ? 'var(--must)' : 'var(--cider)'}"/>
      ${bubbles}
    </g>
    <path d="${JUG_BODY}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="M40 18 C52 12 60 23 51 30" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
    ${top}
  </svg>`;
}

const dots = (score) =>
  `<span class="dots" aria-label="${score} out of 5">${[1, 2, 3, 4, 5].map((n) => `<i class="${n <= Math.round(score) ? 'on' : ''}"></i>`).join('')}</span>`;

// ---------- shared form pieces ----------
function datalists(s) {
  const dl = (id, arr) => `<datalist id="${id}">${arr.map((v) => `<option value="${esc(v)}">`).join('')}</datalist>`;
  return dl('dl-juice', s.juices) + dl('dl-yeast', s.yeasts) + dl('dl-ingredient', s.ingredients) + dl('dl-addition', s.additions);
}

function itemRow(listId, placeholder, item = {}) {
  return `<div class="item-row">
    <input type="text" class="item-name" list="${listId}" placeholder="${esc(placeholder)}" value="${esc(item.name)}" aria-label="Name">
    <input type="text" class="item-amount" placeholder="Amount" value="${esc(item.amount)}" aria-label="Amount">
    <button type="button" class="icon-btn" data-remove aria-label="Remove">×</button>
  </div>`;
}

function itemsEditor(id, items, listId, placeholder, addLabel) {
  const rows = (items && items.length ? items : [{}]).map((i) => itemRow(listId, placeholder, i)).join('');
  return `<div class="items" id="${id}" data-list="${listId}" data-placeholder="${esc(placeholder)}">${rows}</div>
    <button type="button" class="btn-text" data-add="${id}">${addLabel}</button>`;
}

const readItems = (container) => [...container.querySelectorAll('.item-row')]
  .map((r) => ({ name: r.querySelector('.item-name').value.trim(), amount: r.querySelector('.item-amount').value.trim() }))
  .filter((i) => i.name);

$app.addEventListener('click', (e) => {
  const add = e.target.closest('[data-add]');
  if (add) {
    const box = document.getElementById(add.dataset.add);
    box.insertAdjacentHTML('beforeend', itemRow(box.dataset.list, box.dataset.placeholder));
    box.lastElementChild.querySelector('input').focus();
    return;
  }
  const remove = e.target.closest('[data-remove]');
  if (remove) {
    const box = remove.closest('.items');
    if (box.children.length > 1) remove.closest('.item-row').remove();
    else box.querySelectorAll('input').forEach((i) => (i.value = ''));
  }
});

async function submitWith(form, fn) {
  const btn = form.querySelector('[type="submit"]');
  const err = form.querySelector('.form-error');
  btn.disabled = true;
  err.textContent = '';
  try { await fn(); }
  catch (e) { err.textContent = e.message; btn.disabled = false; }
}

const itemList = (items) => items.length
  ? `<ul class="item-list">${items.map((i) => `<li>${esc(i.name)}${i.amount ? ` <span class="amt">${esc(i.amount)}</span>` : ''}</li>`).join('')}</ul>`
  : '<span class="muted">None</span>';

// ---------- views ----------
async function renderList() {
  const batches = await api('GET', '/api/batches');

  if (!batches.length) {
    $app.innerHTML = `<div class="empty">
      ${jug('fermenting', 72)}
      <h1>No batches yet</h1>
      <p>Log your first gallon to start tracking juice, yeast, bottling and tasting notes.</p>
      <a class="btn btn-primary" href="#/new">Start a batch</a>
    </div>`;
    return;
  }

  const counts = { all: batches.length, fermenting: 0, bottled: 0, rated: 0 };
  batches.forEach((b) => counts[stageOf(b)]++);
  const shown = filter === 'all' ? batches : batches.filter((b) => stageOf(b) === filter);
  const names = { all: 'All', fermenting: 'Fermenting', bottled: 'Bottled', rated: 'Rated' };

  const rows = shown.map((b) => {
    const stage = stageOf(b);
    let status;
    if (stage === 'fermenting') status = `<strong>Fermenting</strong>Day ${Math.max(0, daysBetween(b.start_date, today()))}`;
    else if (stage === 'bottled') status = `<strong>Bottled</strong>${fmtDate(b.bottled_date)}`;
    else status = `<strong>${dots(b.avg_score)}</strong>${b.avg_score} avg, ${b.rating_count} rating${b.rating_count === 1 ? '' : 's'}`;
    return `<li class="batch-row"><a href="#/batch/${b.id}">
      ${jug(stage)}
      <span>
        <span class="batch-name">${esc(b.name || 'Batch ' + b.id)}</span>
        <span class="batch-meta">${fmtDate(b.start_date)}. ${esc(b.juice)} with ${esc(b.yeast)}</span>
      </span>
      <span class="batch-status">${status}</span>
    </a></li>`;
  }).join('');

  $app.innerHTML = `
    <div class="list-head">
      <h1>Batches</h1>
      <div class="filters" role="group" aria-label="Filter batches">
        ${Object.keys(names).map((k) => `<button type="button" data-filter="${k}" aria-pressed="${filter === k}">${names[k]} (${counts[k]})</button>`).join('')}
      </div>
    </div>
    ${shown.length ? `<ul class="batches">${rows}</ul>` : `<p class="muted">No ${names[filter].toLowerCase()} batches right now.</p>`}`;

  $app.querySelectorAll('[data-filter]').forEach((btn) =>
    btn.addEventListener('click', () => { filter = btn.dataset.filter; renderList(); }));
}

async function renderBatchForm(id) {
  const [s, batch] = await Promise.all([getSuggestions(), id ? api('GET', `/api/batches/${id}`) : null]);
  const b = batch || { start_date: today(), ingredients: [] };

  $app.innerHTML = `
    ${id ? `<a class="back" href="#/batch/${id}">Back to batch</a>` : '<a class="back" href="#/">All batches</a>'}
    <h1 class="form-title">${id ? 'Edit batch start' : 'Start a batch'}</h1>
    <form class="panel" id="batch-form" novalidate>
      ${datalists(s)}
      <div class="field">
        <label for="f-name">Batch name <span class="hint">(optional)</span></label>
        <input type="text" id="f-name" value="${esc(b.name)}" placeholder="Honeycrisp with cinnamon">
      </div>
      <div class="field">
        <label for="f-start">Start date</label>
        <input type="date" id="f-start" value="${esc(b.start_date)}" required>
      </div>
      <div class="row-2">
        <div class="field">
          <label for="f-juice">Apple juice</label>
          <input type="text" id="f-juice" list="dl-juice" value="${esc(b.juice)}" placeholder="Brand or orchard" required>
        </div>
        <div class="field">
          <label for="f-yeast">Yeast</label>
          <input type="text" id="f-yeast" list="dl-yeast" value="${esc(b.yeast)}" placeholder="Strain" required>
        </div>
      </div>
      <div class="field">
        <span class="label">Other ingredients</span>
        ${itemsEditor('f-ingredients', b.ingredients, 'dl-ingredient', 'Ingredient', 'Add ingredient')}
      </div>
      <div class="field">
        <label for="f-notes">Notes <span class="hint">(optional)</span></label>
        <textarea id="f-notes" placeholder="Starting gravity, process, anything worth remembering">${esc(b.start_notes)}</textarea>
      </div>
      <p class="form-error"></p>
      <div class="actions">
        <button type="submit" class="btn btn-primary">${id ? 'Save changes' : 'Start batch'}</button>
        <a class="btn-text" href="${id ? `#/batch/${id}` : '#/'}">Cancel</a>
      </div>
    </form>`;

  const form = document.getElementById('batch-form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitWith(form, async () => {
      const body = {
        name: form.querySelector('#f-name').value,
        start_date: form.querySelector('#f-start').value,
        juice: form.querySelector('#f-juice').value,
        yeast: form.querySelector('#f-yeast').value,
        ingredients: readItems(form.querySelector('#f-ingredients')),
        start_notes: form.querySelector('#f-notes').value,
      };
      const saved = id ? await api('PUT', `/api/batches/${id}`, body) : await api('POST', '/api/batches', body);
      suggestions = null;
      toast(id ? 'Changes saved' : 'Batch started');
      location.hash = `#/batch/${saved.id}`;
    });
  });
  if (!id) form.querySelector('#f-name').focus();
}

async function renderDetail(id, opts = {}) {
  const [b, s] = await Promise.all([api('GET', `/api/batches/${id}`), getSuggestions()]);
  const stage = stageOf(b);
  const title = b.name || 'Batch ' + b.id;
  const latestRating = b.ratings[0];

  const stages = `<ol class="stages" aria-label="Batch progress">
    <li class="done"><b>Started</b>${fmtDate(b.start_date)}</li>
    <li class="${b.bottled_date ? 'done' : 'current'}"><b>Bottled</b>${b.bottled_date ? fmtDate(b.bottled_date) : 'Fermenting'}</li>
    <li class="${latestRating ? 'done' : ''}"><b>Rated</b>${latestRating ? fmtDate(latestRating.rating_date) : 'Not yet'}</li>
  </ol>`;

  const startPanel = `<section class="panel">
    <div class="panel-head"><h2>Start</h2><a class="btn-text" href="#/batch/${b.id}/edit">Edit</a></div>
    <dl class="facts">
      <dt>Start date</dt><dd>${fmtDate(b.start_date)}</dd>
      <dt>Apple juice</dt><dd>${esc(b.juice)}</dd>
      <dt>Yeast</dt><dd>${esc(b.yeast)}</dd>
      <dt>Other ingredients</dt><dd>${itemList(b.ingredients)}</dd>
      ${b.start_notes ? `<dt>Notes</dt><dd class="notes">${esc(b.start_notes)}</dd>` : ''}
    </dl>
  </section>`;

  const showBottlingForm = !b.bottled_date || opts.editBottling;
  let bottlingPanel;
  if (showBottlingForm) {
    bottlingPanel = `<section class="panel">
      <div class="panel-head"><h2>Bottling</h2></div>
      ${!b.bottled_date ? `<p class="panel-hint">Fermenting for ${Math.max(0, daysBetween(b.start_date, today()))} days. Log the details when you bottle.</p>` : ''}
      <form id="bottling-form" novalidate>
        <div class="field">
          <label for="b-date">Date bottled</label>
          <input type="date" id="b-date" value="${esc(b.bottled_date || today())}" required>
        </div>
        <div class="field">
          <span class="label">Added at bottling</span>
          ${itemsEditor('b-additions', b.bottling_additions, 'dl-addition', 'Priming sugar', 'Add another')}
        </div>
        <div class="field">
          <label for="b-notes">Notes <span class="hint">(optional)</span></label>
          <textarea id="b-notes" placeholder="Final gravity, number of bottles, clarity">${esc(b.bottling_notes)}</textarea>
        </div>
        <p class="form-error"></p>
        <div class="actions">
          <button type="submit" class="btn btn-primary">${b.bottled_date ? 'Save changes' : 'Log bottling'}</button>
          ${b.bottled_date ? '<button type="button" class="btn-text" id="cancel-bottling">Cancel</button><button type="button" class="btn-text btn-danger" id="clear-bottling">Remove bottling record</button>' : ''}
        </div>
      </form>
    </section>`;
  } else {
    bottlingPanel = `<section class="panel">
      <div class="panel-head"><h2>Bottling</h2><button type="button" class="btn-text" id="edit-bottling">Edit</button></div>
      <dl class="facts">
        <dt>Date bottled</dt><dd>${fmtDate(b.bottled_date)} <span class="muted">(day ${daysBetween(b.start_date, b.bottled_date)})</span></dd>
        <dt>Added at bottling</dt><dd>${itemList(b.bottling_additions)}</dd>
        ${b.bottling_notes ? `<dt>Notes</dt><dd class="notes">${esc(b.bottling_notes)}</dd>` : ''}
      </dl>
    </section>`;
  }

  const ratingItems = b.ratings.map((r) => `<li class="rating">
      <span class="rating-score">${dots(r.score)} ${r.score}. ${SCORE_LABELS[r.score]}</span>
      <button type="button" class="btn-text btn-danger" data-delete-rating="${r.id}">Delete</button>
      <span class="rating-date">${fmtDate(r.rating_date)}${b.bottled_date ? `, ${daysBetween(b.bottled_date, r.rating_date)} days after bottling` : ''}</span>
      ${r.notes ? `<p class="notes">${esc(r.notes)}</p>` : ''}
    </li>`).join('');

  const ratingsPanel = `<section class="panel">
    <div class="panel-head"><h2>Ratings</h2></div>
    ${b.ratings.length ? `<ul class="ratings">${ratingItems}</ul>` : `<p class="panel-hint">${b.bottled_date ? 'Rate this batch after you taste it. Add more ratings as it ages.' : 'You can rate the batch once it has been bottled, or anytime you taste it.'}</p>`}
    <form id="rating-form" novalidate>
      ${b.ratings.length ? '<h3 class="subhead">Add a rating</h3>' : ''}
      <div class="field">
        <label for="r-date">Rating date</label>
        <input type="date" id="r-date" value="${today()}" required>
      </div>
      <div class="field">
        <span class="label" id="score-label">Score</span>
        <div class="scores" role="radiogroup" aria-labelledby="score-label">
          ${[1, 2, 3, 4, 5].map((n) => `<input type="radio" name="score" id="s${n}" value="${n}"><label for="s${n}"><b>${n}</b><span>${SCORE_LABELS[n]}</span></label>`).join('')}
        </div>
        <p class="score-caption" id="score-caption"></p>
      </div>
      <div class="field">
        <label for="r-notes">Tasting notes <span class="hint">(optional)</span></label>
        <textarea id="r-notes" placeholder="Carbonation, sweetness, aroma, what to change next time"></textarea>
      </div>
      <p class="form-error"></p>
      <div class="actions"><button type="submit" class="btn btn-primary">Add rating</button></div>
    </form>
  </section>`;

  $app.innerHTML = `
    <a class="back" href="#/">All batches</a>
    <div class="detail-head">
      ${jug(stage, 88)}
      <div style="flex:1;min-width:0">
        <h1>${esc(title)}</h1>
        ${stages}
      </div>
    </div>
    ${datalists(s)}
    ${startPanel}
    ${bottlingPanel}
    ${ratingsPanel}
    <div class="danger-zone"><button type="button" class="btn-text btn-danger" id="delete-batch">Delete this batch</button></div>`;

  // bottling
  const bf = document.getElementById('bottling-form');
  if (bf) {
    bf.addEventListener('submit', (e) => {
      e.preventDefault();
      submitWith(bf, async () => {
        await api('PUT', `/api/batches/${b.id}/bottling`, {
          bottled_date: bf.querySelector('#b-date').value,
          bottling_additions: readItems(bf.querySelector('#b-additions')),
          bottling_notes: bf.querySelector('#b-notes').value,
        });
        suggestions = null;
        toast(b.bottled_date ? 'Changes saved' : 'Bottling logged');
        renderDetail(b.id);
      });
    });
    if (opts.editBottling) bf.querySelector('#b-date').focus();
  }
  document.getElementById('edit-bottling')?.addEventListener('click', () => renderDetail(b.id, { editBottling: true }));
  document.getElementById('cancel-bottling')?.addEventListener('click', () => renderDetail(b.id));
  document.getElementById('clear-bottling')?.addEventListener('click', async () => {
    if (!confirm('Remove the bottling record? The batch will show as fermenting again.')) return;
    await api('DELETE', `/api/batches/${b.id}/bottling`);
    toast('Bottling record removed');
    renderDetail(b.id);
  });

  // ratings
  const rf = document.getElementById('rating-form');
  rf.addEventListener('change', (e) => {
    if (e.target.name === 'score') rf.querySelector('#score-caption').textContent = SCORE_LABELS[e.target.value];
  });
  rf.addEventListener('submit', (e) => {
    e.preventDefault();
    submitWith(rf, async () => {
      const score = rf.querySelector('input[name="score"]:checked');
      if (!score) throw new Error('Pick a score from 1 to 5.');
      await api('POST', `/api/batches/${b.id}/ratings`, {
        rating_date: rf.querySelector('#r-date').value,
        score: Number(score.value),
        notes: rf.querySelector('#r-notes').value,
      });
      toast('Rating added');
      renderDetail(b.id);
    });
  });
  $app.querySelectorAll('[data-delete-rating]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this rating?')) return;
      await api('DELETE', `/api/ratings/${btn.dataset.deleteRating}`);
      toast('Rating deleted');
      renderDetail(b.id);
    }));

  document.getElementById('delete-batch').addEventListener('click', async () => {
    if (!confirm(`Delete "${title}" and all its ratings? This cannot be undone.`)) return;
    await api('DELETE', `/api/batches/${b.id}`);
    suggestions = null;
    toast('Batch deleted');
    location.hash = '#/';
  });
}

function renderError(err) {
  $app.innerHTML = `<div class="empty">
    <h1>Can't load this page</h1>
    <p>${esc(err.message)}</p>
    <a class="btn" href="#/">Go to all batches</a>
  </div>`;
}

// ---------- router ----------
async function route() {
  const parts = (location.hash.slice(1) || '/').split('/').filter(Boolean);
  document.getElementById('new-link').hidden = parts[0] === 'new';
  try {
    if (parts[0] === 'new') await renderBatchForm();
    else if (parts[0] === 'batch' && parts[1]) {
      if (parts[2] === 'edit') await renderBatchForm(parts[1]);
      else await renderDetail(parts[1]);
    } else await renderList();
  } catch (e) {
    renderError(e);
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
route();
