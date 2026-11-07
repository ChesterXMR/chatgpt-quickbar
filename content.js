// ChatGPT Quick Bar — adds effort (Instant / Medium / High) and tool (Web / Image)
// buttons above the composer, and drives ChatGPT's own controls underneath.
(() => {
  'use strict';
  if (window.__cgqbLoaded) return;
  window.__cgqbLoaded = true;

  const BAR_ID = 'cgqb-bar';

  const EFFORTS = [
    { key: 'instant', label: 'Instant', attr: ['none', 'instant'], index: 0 },
    { key: 'medium', label: 'Medium', attr: ['medium'], index: 1 },
    { key: 'high', label: 'High', attr: ['high'], index: 2 },
  ];

  const ICONS = {
    web:
      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="10" cy="10" r="7.25"/><path d="M2.75 10h14.5"/>' +
      '<path d="M10 2.75c1.9 2 2.9 4.4 2.9 7.25S11.9 15.25 10 17.25C8.1 15.25 7.1 12.85 7.1 10S8.1 4.75 10 2.75z"/></svg>',
    image:
      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="2.75" y="3.75" width="14.5" height="12.5" rx="3"/><circle cx="7.25" cy="8" r="1.4"/>' +
      '<path d="M3.25 14l4.1-3.6a1.2 1.2 0 0 1 1.6 0l1.55 1.4 2.4-2.35a1.2 1.2 0 0 1 1.7 0l2.15 2.15"/></svg>',
  };

  const HINTS = [
    { key: 'web', label: 'Web', type: 'search', menuText: /^web search/i, title: 'Web search' },
    { key: 'image', label: 'Image', type: 'picture_v2', menuText: /^create image/i, title: 'Create image' },
  ];

  // ---------- helpers ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeout = 2000, step = 40) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  function pointer(el, type, x, y) {
    el.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse',
        isPrimary: true, button: 0, buttons: type === 'pointerdown' ? 1 : 0,
      })
    );
  }

  function pressAt(el, x, y) {
    if (x === undefined) {
      const r = el.getBoundingClientRect();
      x = r.left + r.width / 2;
      y = r.top + r.height / 2;
    }
    pointer(el, 'pointerdown', x, y);
    pointer(el, 'pointerup', x, y);
  }

  function pressEscape() {
    const opts = { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true };
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', opts));
    document.dispatchEvent(new KeyboardEvent('keydown', opts));
  }

  const editor = () =>
    document.querySelector('[data-composer-markdown][contenteditable="true"]') ||
    document.querySelector('#prompt-textarea');

  const composerForm = () => {
    const ed = editor();
    if (!ed) return null;
    return ed.closest('form') || ed.closest('fieldset')?.parentElement || null;
  };

  const effortTrigger = () =>
    document.querySelector('button[data-composer-navigation-target="reasoning"]') ||
    document.querySelector('button[aria-label="Select ChatGPT model"]');

  const plusButton = () =>
    document.querySelector('button[data-composer-navigation-target="add-context"]') ||
    document.querySelector('button[aria-label="Add files and more"]');

  const pill = (type) => editor()?.querySelector(`[data-system-hint-type="${type}"]`) || null;

  function focusEditorEnd() {
    const ed = editor();
    if (!ed) return;
    ed.focus();
    try {
      const sel = getSelection();
      const r = document.createRange();
      r.selectNodeContents(ed);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    } catch (_) {}
  }

  // ---------- reading state ----------
  function currentEffort() {
    const trig = effortTrigger();
    if (!trig) return null;
    const attr = (trig.getAttribute('data-selected-reasoning-effort') || '').toLowerCase();
    let match = EFFORTS.find((e) => e.attr.includes(attr));
    if (match) return match.key;
    const text = (trig.innerText || '').toLowerCase();
    match = EFFORTS.find((e) => text.includes(e.key));
    return match ? match.key : null;
  }

  // ---------- driving ChatGPT ----------
  let busy = false;

  async function drive(fn) {
    if (busy) return;
    busy = true;
    const bar = document.getElementById(BAR_ID);
    bar?.classList.add('cgqb-busy');
    document.documentElement.classList.add('cgqb-driving');
    try {
      await fn();
    } catch (err) {
      console.warn('[ChatGPT Quick Bar]', err);
    } finally {
      document.documentElement.classList.remove('cgqb-driving');
      bar?.classList.remove('cgqb-busy');
      busy = false;
      refresh();
    }
  }

  async function setEffort(key) {
    const target = EFFORTS.find((e) => e.key === key);
    const trig = effortTrigger();
    if (!trig || !target) return flashUnavailable(key);
    if (currentEffort() === key) return;

    await drive(async () => {
      // Open ChatGPT's effort menu (Radix opens on pointerdown).
      pressAt(trig);
      const root = await waitFor(() =>
        document.querySelector('[role="menu"][data-state="open"] span[data-locked]')
      );
      if (!root) throw new Error('Effort menu did not open');

      const menu = root.closest('[role="menu"]');
      const labelNow = () => (menu.querySelector('[data-effort-only]')?.textContent || '').trim().toLowerCase();
      const dots = [...root.querySelectorAll('span[data-selected]')];

      // Try the expected slider stop first, then any other stop, until the label matches.
      const order = [target.index, ...dots.map((_, i) => i).filter((i) => i !== target.index)];
      let ok = false;
      for (const i of order) {
        const dot = dots[i];
        if (!dot) continue;
        const r = dot.getBoundingClientRect();
        pressAt(root, r.left + r.width / 2, r.top + r.height / 2);
        if (await waitFor(() => labelNow() === target.key, 400)) { ok = true; break; }
      }

      // Close the menu.
      pressEscape();
      const closed = await waitFor(() => !document.querySelector('[role="menu"][data-state="open"] span[data-locked]'), 600);
      if (!closed) pressAt(trig);
      await sleep(50);
      focusEditorEnd();
      if (!ok) flashUnavailable(key);
    });
  }

  function removePill(node) {
    const ed = editor();
    if (!ed || !node) return;
    ed.focus();
    const sel = getSelection();
    const r = document.createRange();
    r.selectNode(node);
    sel.removeAllRanges();
    sel.addRange(r);
    document.execCommand('delete');
  }

  async function toggleHint(key) {
    const hint = HINTS.find((h) => h.key === key);
    if (!hint) return;

    const existing = pill(hint.type);
    if (existing) {
      await drive(async () => {
        removePill(existing);
        await waitFor(() => !pill(hint.type), 500);
        focusEditorEnd();
      });
      return;
    }

    const plus = plusButton();
    if (!plus) return flashUnavailable(key);

    await drive(async () => {
      // ChatGPT only allows one tool chip per message; clear the other one cleanly first.
      for (const other of HINTS) {
        if (other.key !== key && pill(other.type)) {
          removePill(pill(other.type));
          await waitFor(() => !pill(other.type), 500);
        }
      }

      const ed = editor();
      if (ed && document.activeElement !== ed) focusEditorEnd();

      if (plus.getAttribute('aria-expanded') !== 'true') plus.click();

      const findItem = () => {
        const items = document.querySelectorAll(
          '[data-mention-list-scroll-area] button, [data-composer-overlay-floating-ui] button, [role="menu"] [role="menuitem"]'
        );
        for (const it of items) {
          const first = (it.innerText || '').trim().split('\n')[0].trim();
          if (hint.menuText.test(first)) return it;
        }
        return null;
      };

      const item = await waitFor(findItem, 2500);
      if (!item) {
        pressEscape();
        if (plus.getAttribute('aria-expanded') === 'true') plus.click();
        flashUnavailable(key);
        return;
      }
      item.click();
      await waitFor(() => pill(hint.type), 1000);
      if (plus.getAttribute('aria-expanded') === 'true') pressEscape();
      focusEditorEnd();
    });
  }

  // ---------- UI ----------
  function flashUnavailable(key) {
    const btn = document.querySelector(`#${BAR_ID} button[data-key="${key}"]`);
    if (!btn) return;
    btn.classList.add('cgqb-unavailable');
    setTimeout(() => btn.classList.remove('cgqb-unavailable'), 900);
  }

  function makeButton(def, onClick, title) {
    const b = document.createElement('button');
    b.type = 'button';
    if (ICONS[def.key]) b.insertAdjacentHTML('beforeend', ICONS[def.key]);
    const span = document.createElement('span');
    span.textContent = def.label;
    b.appendChild(span);
    b.dataset.key = def.key;
    b.title = title;
    b.setAttribute('aria-pressed', 'false');
    // Keep focus (and the caret) in ChatGPT's editor.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick(def.key);
    });
    return b;
  }

  function buildBar() {
    const bar = document.createElement('div');
    bar.id = BAR_ID;

    const effortGroup = document.createElement('div');
    effortGroup.className = 'cgqb-group cgqb-effort';
    effortGroup.setAttribute('role', 'radiogroup');
    EFFORTS.forEach((e) => effortGroup.appendChild(makeButton(e, setEffort, `Thinking effort: ${e.label}`)));

    const sep = document.createElement('span');
    sep.className = 'cgqb-sep';

    const hintGroup = document.createElement('div');
    hintGroup.className = 'cgqb-group cgqb-tools';
    HINTS.forEach((h) => hintGroup.appendChild(makeButton(h, toggleHint, h.title)));

    bar.append(effortGroup, sep, hintGroup);
    return bar;
  }

  // Match the page background (so chat text doesn't show behind the bar) and pick light/dark.
  let lastThemeCheck = 0;
  function applyTheme(bar) {
    const now = Date.now();
    if (now - lastThemeCheck < 1000 && bar.dataset.theme) return;
    lastThemeCheck = now;
    let bg = null;
    for (let p = bar.parentElement; p; p = p.parentElement) {
      const c = getComputedStyle(p).backgroundColor;
      const m = c && c.match(/rgba?\(([^)]+)\)/);
      if (!m) continue;
      const parts = m[1].split(',').map((s) => parseFloat(s));
      if (parts.length === 4 && parts[3] < 0.95) continue;
      bg = parts;
      break;
    }
    if (!bg) bg = [255, 255, 255];
    const [r, g, b] = bg;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    bar.dataset.theme = lum < 128 ? 'dark' : 'light';
    bar.style.setProperty('--cgqb-page-bg', `rgb(${r}, ${g}, ${b})`);
  }

  function refresh() {
    const bar = document.getElementById(BAR_ID);
    if (!bar) return;
    applyTheme(bar);
    const eff = currentEffort();
    const hasTrigger = !!effortTrigger();
    EFFORTS.forEach((e) => {
      const b = bar.querySelector(`button[data-key="${e.key}"]`);
      const on = eff === e.key;
      b.classList.toggle('cgqb-on', on);
      b.setAttribute('aria-pressed', String(on));
      b.style.display = hasTrigger ? '' : 'none';
    });
    bar.querySelector('.cgqb-sep').style.display = hasTrigger ? '' : 'none';
    HINTS.forEach((h) => {
      const b = bar.querySelector(`button[data-key="${h.key}"]`);
      const on = !!pill(h.type);
      b.classList.toggle('cgqb-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  function ensureBar() {
    const form = composerForm();
    if (!form || !form.parentElement) return;
    let bar = document.getElementById(BAR_ID);
    if (bar && bar.nextElementSibling === form) return refresh();
    if (!bar) bar = buildBar();
    form.parentElement.insertBefore(bar, form);
    refresh();
  }

  // ---------- keep in sync with ChatGPT's SPA ----------
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      ensureBar();
    });
  };

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-selected-reasoning-effort', 'data-system-hint-type'],
  });

  ensureBar();
})();
