'use strict';

/*
 * Tram Depot — Car Allocation Board (client)
 * Vanilla ES2020, no framework, no bundler, history router, no inline handlers.
 */

(function () {
  const DEMO_FALLBACK = { email: 'cenius@cenius.ai', password: 'cenius' };

  /* ---------------------------------------------------------------- *
   * DOM helper: build nodes, never innerHTML with data
   * ---------------------------------------------------------------- */

  function appendChildren(node, children) {
    for (const child of children) {
      if (child === null || child === undefined || child === false || child === '') continue;
      if (Array.isArray(child)) appendChildren(node, child);
      else if (child instanceof Node) node.append(child);
      else node.append(document.createTextNode(String(child)));
    }
  }

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key.startsWith('on') && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else {
          node.setAttribute(key, value === true ? '' : String(value));
        }
      }
    }
    appendChildren(node, children);
    return node;
  }

  function clear(node) {
    node.replaceChildren();
    return node;
  }

  /* ---------------------------------------------------------------- *
   * Formatting
   * ---------------------------------------------------------------- */

  function todayLocal() {
    const now = new Date();
    return [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('-');
  }

  function formatServiceDate(iso) {
    const parsed = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return iso;
    return parsed.toLocaleDateString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }

  function relativeTime(iso) {
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return 'Time not recorded';
    const minutes = Math.round((Date.now() - then.getTime()) / 60000);
    if (minutes <= 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.round(hours / 24);
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days} days ago`;
    return then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function roleLabel(role) {
    if (role === 'dispatcher') return 'Dispatcher';
    if (role === 'inspector') return 'Inspector';
    return role ? String(role) : 'Staff';
  }

  function capitalise(value) {
    const text = String(value || '');
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
  }

  /* ---------------------------------------------------------------- *
   * API client
   * ---------------------------------------------------------------- */

  class ApiFailure extends Error {
    constructor(status, message, fields) {
      super(message);
      this.status = status;
      this.fields = fields || null;
    }
  }

  async function api(path, options) {
    const settings = options || {};
    const init = {
      method: settings.method || 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    };
    if (settings.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(settings.body);
    }

    let response;
    try {
      response = await fetch(path, init);
    } catch {
      throw new ApiFailure(0, 'Cannot reach the depot server. Check your connection and try again.');
    }

    if (response.status === 204) return null;

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      throw new ApiFailure(
        response.status,
        (payload && payload.error) || `Request failed (${response.status})`,
        (payload && payload.fields) || null,
      );
    }
    return payload;
  }

  /* ---------------------------------------------------------------- *
   * Client state
   * ---------------------------------------------------------------- */

  const state = {
    staff: null,
    reference: null,
    demo: DEMO_FALLBACK,
    board: { serviceDate: todayLocal(), shiftId: null },
    next: null,
    depotMessages: {},
  };

  async function ensureReference(force) {
    if (!state.reference || force) state.reference = await api('/api/reference');
    return state.reference;
  }

  /* ---------------------------------------------------------------- *
   * Shared fragments
   * ---------------------------------------------------------------- */

  function severityBadge(severity) {
    if (!severity) return null;
    return h(
      'span',
      { class: `sev-badge sev-badge--${severity}` },
      h('span', { class: 'sev-dot', 'aria-hidden': 'true' }),
      capitalise(severity),
    );
  }

  function statusChip(status) {
    return h('span', { class: `status-chip status-chip--${status}` }, capitalise(status).replace('-', ' '));
  }

  function field(options) {
    const id = options.id;
    const wrapper = h(
      'div',
      { class: 'field', dataset: { field: id } },
      h('label', { class: 'field-label', for: id }, options.label),
      options.control,
      options.hint ? h('p', { class: 'field-hint', id: `${id}-hint` }, options.hint) : null,
      h('p', { class: 'field-error', id: `${id}-error`, hidden: true }),
    );
    return wrapper;
  }

  function setFieldError(form, name, message) {
    const wrapper = form.querySelector(`[data-field="${name}"]`);
    if (!wrapper) return;
    const slot = wrapper.querySelector('.field-error');
    if (slot) {
      slot.textContent = message;
      slot.hidden = !message;
    }
    wrapper.dataset.invalid = message ? 'true' : 'false';
    const control = wrapper.querySelector('input, select, textarea');
    if (control) control.setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  function clearFieldErrors(form) {
    form.querySelectorAll('[data-field]').forEach((wrapper) => {
      wrapper.dataset.invalid = 'false';
      const slot = wrapper.querySelector('.field-error');
      if (slot) {
        slot.textContent = '';
        slot.hidden = true;
      }
      const control = wrapper.querySelector('input, select, textarea');
      if (control) control.removeAttribute('aria-invalid');
    });
    const banner = form.querySelector('.form-error');
    if (banner) {
      banner.textContent = '';
      banner.hidden = true;
    }
  }

  function showFormError(form, message) {
    const banner = form.querySelector('.form-error');
    if (!banner) return;
    banner.textContent = message;
    banner.hidden = false;
  }

  function selectControl(id, options, selected) {
    const select = h('select', { id, class: 'input' });
    for (const option of options) {
      select.append(h('option', { value: option.value }, option.label));
    }
    select.value = selected !== undefined && selected !== null ? String(selected) : options[0] ? String(options[0].value) : '';
    return select;
  }

  function errorPanel(message, retry) {
    return h(
      'section',
      { class: 'panel panel--error', role: 'alert' },
      h('p', { class: 'panel-title' }, 'That request could not be completed'),
      h('p', { class: 'panel-body' }, message),
      retry ? h('button', { type: 'button', class: 'btn', onclick: retry }, 'Retry') : null,
    );
  }

  function skeletonCards(count) {
    return Array.from({ length: count }, () =>
      h(
        'article',
        { class: 'alloc-card alloc-card--skeleton', 'aria-hidden': 'true' },
        h('span', { class: 'sk sk--sm' }),
        h('span', { class: 'sk sk--lg' }),
        h('span', { class: 'sk sk--md' }),
        h('span', { class: 'sk sk--md' }),
      ),
    );
  }

  function render(node) {
    document.body.replaceChildren(node);
  }

  /* ---------------------------------------------------------------- *
   * Shell: dark left rail + dense workspace
   * ---------------------------------------------------------------- */

  const NAV_ITEMS = [
    { path: '/', label: 'Allocation board', glyph: '→', key: 'board' },
    { path: '/depot', label: 'Depot sidings', glyph: '▸', key: 'depot' },
    { path: '/notices', label: 'Pantograph notices', glyph: '◆', key: 'notices' },
  ];

  async function signOut() {
    try {
      await api('/api/auth/logout', { method: 'POST', body: {} });
    } catch {
      /* a failed sign-out still clears the client identity below */
    }
    state.staff = null;
    state.reference = null;
    state.next = null;
    go('/login', true);
  }

  function rail(activeKey) {
    const links = NAV_ITEMS.map((item) =>
      h(
        'a',
        {
          class: 'rail-link',
          href: item.path,
          'aria-current': activeKey === item.key ? 'page' : null,
          onclick: (event) => {
            event.preventDefault();
            go(item.path);
          },
        },
        h('span', { class: 'glyph', 'aria-hidden': 'true' }, item.glyph),
        h('span', {}, item.label),
      ),
    );

    return h(
      'aside',
      { class: 'rail' },
      h(
        'div',
        { class: 'rail-brand' },
        h('span', { class: 'rail-mark', 'aria-hidden': 'true' }, '→'),
        h('span', { class: 'rail-title' }, 'Tram Depot'),
        h('span', { class: 'rail-sub' }, 'Car Allocation Board'),
      ),
      h(
        'nav',
        { class: 'rail-nav', 'aria-label': 'Primary' },
        h('p', { class: 'rail-section' }, 'Operations'),
        links,
      ),
      h(
        'div',
        { class: 'rail-user' },
        h('p', { class: 'rail-user-name' }, state.staff ? state.staff.name : 'Signed out'),
        h('p', { class: 'rail-user-role' }, state.staff ? roleLabel(state.staff.role) : ''),
        h('button', { type: 'button', class: 'rail-signout', onclick: signOut }, 'Sign out'),
      ),
    );
  }

  function shell(options) {
    return h(
      'div',
      { class: 'app' },
      rail(options.active),
      h(
        'div',
        { class: 'workspace' },
        h(
          'header',
          { class: 'page-header' },
          h(
            'div',
            { class: 'page-head' },
            options.eyebrow ? h('p', { class: 'eyebrow' }, options.eyebrow) : null,
            h(
              'h1',
              { class: `page-title${options.hero ? ' page-title--hero' : ''}` },
              options.title,
            ),
          ),
          options.actions ? h('div', { class: 'page-actions' }, options.actions) : null,
        ),
        h('main', { class: 'page-body', id: 'main' }, options.body || null),
      ),
    );
  }

  /* ---------------------------------------------------------------- *
   * Router
   * ---------------------------------------------------------------- */

  function currentPath() {
    const raw = window.location.pathname.replace(/\/+$/, '');
    return raw === '' ? '/' : raw;
  }

  function go(path, replace) {
    if (replace) window.history.replaceState({}, '', path);
    else window.history.pushState({}, '', path);
    renderRoute();
  }

  function renderRoute() {
    const path = currentPath();

    if (!state.staff) {
      if (path !== '/login') {
        state.next = path === '/' ? null : path;
        window.history.replaceState({}, '', '/login');
      }
      loginPage();
      return;
    }

    if (path === '/login') {
      go('/', true);
      return;
    }

    if (path === '/') return boardPage();
    if (path === '/depot') return depotPage();
    if (path === '/notices') return noticesPage();
    return notFoundPage(path);
  }

  window.addEventListener('popstate', renderRoute);

  /* ---------------------------------------------------------------- *
   * Login screen
   * ---------------------------------------------------------------- */

  function loginPage() {
    document.title = 'Sign in — Tram Depot';

    const emailInput = h('input', {
      id: 'login-email',
      name: 'email',
      type: 'email',
      class: 'input',
      autocomplete: 'username',
      autocapitalize: 'none',
      spellcheck: 'false',
      required: true,
      'aria-describedby': 'login-email-error',
    });

    const passwordInput = h('input', {
      id: 'login-password',
      name: 'password',
      type: 'password',
      class: 'input',
      autocomplete: 'current-password',
      required: true,
      'aria-describedby': 'login-password-error',
    });

    const toggle = h(
      'button',
      {
        type: 'button',
        class: 'pw-toggle',
        'aria-pressed': 'false',
        onclick: () => {
          const showing = passwordInput.type === 'text';
          passwordInput.type = showing ? 'password' : 'text';
          toggle.setAttribute('aria-pressed', showing ? 'false' : 'true');
          toggle.textContent = showing ? 'Show' : 'Hide';
          passwordInput.focus();
        },
      },
      'Show',
    );

    const submitButton = h('button', { type: 'submit', class: 'btn btn--primary btn--block' }, 'Sign in');
    const errorBanner = h('p', { class: 'form-error', role: 'alert', hidden: true });

    const demoEmail = h('dd', {}, state.demo.email);
    const demoPassword = h('dd', {}, state.demo.password);
    const demoHint = h('p', { class: 'field-hint' }, `Demo: ${state.demo.email} / ${state.demo.password}`);

    const form = h(
      'form',
      { class: 'login-form', novalidate: true, 'aria-labelledby': 'login-form-title' },
      h('h2', { class: 'login-form-title', id: 'login-form-title' }, 'Depot staff sign-in'),
      field({ id: 'login-email', label: 'Email', control: emailInput }),
      field({
        id: 'login-password',
        label: 'Password',
        control: h('div', { class: 'pw-wrap' }, passwordInput, toggle),
      }),
      errorBanner,
      submitButton,
    );

    let busy = false;

    const fillDemo = () => {
      emailInput.value = state.demo.email;
      passwordInput.value = state.demo.password;
      clearFieldErrors(form);
      submitButton.focus();
    };

    function validate() {
      clearFieldErrors(form);
      const email = emailInput.value.trim();
      const password = passwordInput.value;
      let firstInvalid = null;

      if (!email) {
        setFieldError(form, 'login-email', 'Email is required');
        firstInvalid = firstInvalid || emailInput;
      } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        setFieldError(form, 'login-email', 'Enter a valid email address');
        firstInvalid = firstInvalid || emailInput;
      }
      if (!password) {
        setFieldError(form, 'login-password', 'Password is required');
        firstInvalid = firstInvalid || passwordInput;
      }
      if (firstInvalid) firstInvalid.focus();
      return !firstInvalid;
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (busy) return;
      if (!validate()) return;

      busy = true;
      submitButton.disabled = true;
      submitButton.textContent = 'Signing in…';

      try {
        state.staff = await api('/api/auth/login', {
          method: 'POST',
          body: { email: emailInput.value.trim(), password: passwordInput.value },
        });
        state.reference = null;
        const next = state.next;
        state.next = null;
        go(next || '/', true);
      } catch (error) {
        if (error instanceof ApiFailure && error.fields) {
          for (const [name, message] of Object.entries(error.fields)) {
            setFieldError(form, `login-${name}`, message);
          }
        } else {
          showFormError(form, error.message);
        }
      } finally {
        busy = false;
        submitButton.disabled = false;
        submitButton.textContent = 'Sign in';
      }
    });

    const intro = h(
      'section',
      { class: 'login-intro' },
      h('p', { class: 'login-brand' }, h('span', { class: 'glyph', 'aria-hidden': 'true' }, '→'), 'Tram Depot · Operations'),
      h('div', {},
        h('h1', { class: 'login-title' }, 'Car Allocation Board'),
        h('p', { class: 'login-lead' },
          'Allocate tram cars to routes for every shift, track which car stands on which siding, and record pantograph wear before it takes a car out of service.'),
      ),
      h('ul', { class: 'login-facts' },
        h('li', {}, h('span', { class: 'glyph', 'aria-hidden': 'true' }, '▸'), 'Early, Late and Night shift boards'),
        h('li', {}, h('span', { class: 'glyph', 'aria-hidden': 'true' }, '▸'), '12 siding slots across three depot tracks'),
        h('li', {}, h('span', { class: 'glyph', 'aria-hidden': 'true' }, '◆'), 'Pantograph wear inspections, 0–60 mm'),
      ),
    );

    const card = h(
      'section',
      { class: 'login-card', 'aria-label': 'Sign in' },
      form,
      h(
        'section',
        { class: 'demo-panel', 'aria-label': 'Demo account' },
        h('p', { class: 'demo-head' }, 'Demo account'),
        h('dl', { class: 'demo-rows' },
          h('div', { class: 'demo-row' }, h('dt', {}, 'Email'), demoEmail),
          h('div', { class: 'demo-row' }, h('dt', {}, 'Password'), demoPassword),
        ),
        demoHint,
        h('button', { type: 'button', class: 'btn', onclick: fillDemo }, 'Use demo account'),
      ),
    );

    render(h('div', { class: 'login' }, intro, card));

    api('/api/demo-account')
      .then((demo) => {
        if (!demo || !demo.email) return;
        state.demo = demo;
        demoEmail.textContent = demo.email;
        demoPassword.textContent = demo.password;
        demoHint.textContent = `Demo: ${demo.email} / ${demo.password}`;
      })
      .catch(() => {
        /* the printed fallback credential stays on screen */
      });

    emailInput.focus();
  }

  /* ---------------------------------------------------------------- *
   * Allocation board
   * ---------------------------------------------------------------- */

  function counterCell(label, value, note) {
    return h(
      'div',
      { class: 'counter' },
      h('span', { class: 'counter-label' }, label),
      h('span', { class: 'counter-value tabular' }, value),
      note ? h('span', { class: 'counter-note' }, note) : null,
    );
  }

  function allocationCard(allocation) {
    return h(
      'article',
      { class: 'alloc-card' },
      h(
        'div',
        { class: 'alloc-top' },
        h(
          'p',
          { class: 'alloc-route' },
          h('span', { class: 'glyph', 'aria-hidden': 'true' }, '→'),
          `Route ${allocation.routeCode}`,
        ),
        severityBadge(allocation.worstNoticeSeverity),
      ),
      h('h2', { class: 'alloc-name' }, allocation.routeName),
      h(
        'dl',
        { class: 'alloc-meta' },
        h('div', {}, h('dt', {}, 'Car'), h('dd', { class: 'tabular' }, allocation.carFleetNumber)),
        h('div', {}, h('dt', {}, 'Siding'), h('dd', {}, allocation.sidingSlot || 'Not parked')),
        h('div', {}, h('dt', {}, 'Shift'), h('dd', {}, allocation.shiftLabel)),
      ),
      allocation.note ? h('p', { class: 'alloc-note' }, allocation.note) : null,
      h(
        'div',
        { class: 'alloc-actions' },
        h(
          'button',
          { type: 'button', class: 'btn btn--quiet', onclick: () => openAllocationDialog(allocation) },
          'Edit',
        ),
        h(
          'button',
          { type: 'button', class: 'btn btn--quiet btn--danger-quiet', onclick: () => openDeleteDialog(allocation) },
          'Delete',
        ),
      ),
    );
  }

  function boardToolbar(reference) {
    const dateInput = h('input', {
      id: 'service-date',
      type: 'date',
      class: 'input',
      required: true,
      value: state.board.serviceDate,
      onchange: () => {
        if (!dateInput.value) {
          dateInput.value = state.board.serviceDate;
          return;
        }
        state.board.serviceDate = dateInput.value;
        boardPage();
      },
    });

    const segment = h(
      'div',
      { class: 'segmented', role: 'group', 'aria-label': 'Shift' },
      reference.shifts.map((shift) =>
        h(
          'button',
          {
            type: 'button',
            class: 'seg-btn',
            'aria-pressed': state.board.shiftId === shift.id ? 'true' : 'false',
            onclick: () => {
              state.board.shiftId = shift.id;
              boardPage();
            },
          },
          h('span', { class: 'seg-label' }, shift.label),
          h('span', { class: 'seg-time tabular' }, `${shift.startTime}–${shift.endTime}`),
        ),
      ),
    );

    return h(
      'section',
      { class: 'toolbar' },
      h(
        'div',
        { class: 'toolbar-group' },
        h(
          'div',
          { class: 'field-inline' },
          h('label', { class: 'field-label', for: 'service-date' }, 'Service date'),
          dateInput,
        ),
        h(
          'div',
          { class: 'field-inline' },
          h('span', { class: 'field-label', id: 'shift-label' }, 'Shift'),
          segment,
        ),
      ),
      h(
        'button',
        { type: 'button', class: 'btn btn--primary', onclick: () => openAllocationDialog(null) },
        'New allocation',
      ),
    );
  }

  function emptyBoardPanel() {
    return h(
      'section',
      { class: 'panel panel--empty' },
      h('p', { class: 'panel-title' }, 'No cars allocated for this shift yet'),
      h(
        'p',
        { class: 'panel-body' },
        `Nothing is rostered for ${formatServiceDate(state.board.serviceDate)} on this shift. Pick a route and a tram car to start the board.`,
      ),
      h(
        'button',
        { type: 'button', class: 'btn btn--primary', onclick: () => openAllocationDialog(null) },
        'New allocation',
      ),
    );
  }

  function paintBoard(board, countersSlot, listSlot) {
    countersSlot.replaceChildren(
      counterCell('Cars allocated', String(board.counters.allocated), formatServiceDate(board.date)),
      counterCell('Cars unallocated', String(board.counters.unallocated), 'Free for this shift'),
      counterCell('Open notices', String(board.counters.openNotices), 'Pantograph inspections'),
    );

    if (!board.allocations.length) {
      listSlot.replaceChildren(emptyBoardPanel());
      return;
    }

    listSlot.replaceChildren(
      h('div', { class: 'alloc-grid stagger' }, board.allocations.map((allocation) => allocationCard(allocation))),
    );
  }

  async function boardPage() {
    document.title = 'Allocation board — Tram Depot';

    const content = h('div', { class: 'stack' });
    render(
      shell({
        active: 'board',
        eyebrow: 'Operations · car allocation',
        title: 'Allocation board',
        hero: true,
        body: content,
      }),
    );

    const toolbarSlot = h(
      'section',
      { class: 'toolbar' },
      h('p', { class: 'field-hint' }, 'Loading board controls…'),
    );
    const countersSlot = h(
      'div',
      { class: 'counters', 'aria-hidden': 'true' },
      ['Cars allocated', 'Cars unallocated', 'Open notices'].map((label) =>
        h(
          'div',
          { class: 'counter' },
          h('span', { class: 'counter-label' }, label),
          h('span', { class: 'sk sk--lg' }),
        ),
      ),
    );
    const listSlot = h('div', {}, h('div', { class: 'alloc-grid stagger' }, skeletonCards(3)));
    const results = h('div', { class: 'stack' }, countersSlot, listSlot);
    content.append(toolbarSlot, results);

    let reference;
    try {
      reference = await ensureReference();
    } catch (error) {
      content.replaceChildren(
        errorPanel(error.message, () => {
          state.reference = null;
          boardPage();
        }),
      );
      return;
    }

    const knownShift = reference.shifts.some((shift) => shift.id === state.board.shiftId);
    if (!knownShift) {
      const preferred = reference.shifts.find((shift) => shift.code === 'EARLY') || reference.shifts[0];
      state.board.shiftId = preferred ? preferred.id : null;
    }

    toolbarSlot.replaceWith(boardToolbar(reference));

    const query = `/api/dashboard?serviceDate=${encodeURIComponent(state.board.serviceDate)}&shiftId=${encodeURIComponent(state.board.shiftId || '')}`;
    try {
      const board = await api(query);
      paintBoard(board, countersSlot, listSlot);
    } catch (error) {
      results.replaceChildren(
        errorPanel(error.message, () => {
          boardPage();
        }),
      );
    }
  }

  /* ---------------------------------------------------------------- *
   * Allocation create / edit / delete dialogs
   * ---------------------------------------------------------------- */

  function openDialogShell(dialog) {
    document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove());
    dialog.showModal();
    return dialog;
  }

  function openAllocationDialog(allocation) {
    const reference = state.reference;
    if (!reference) return;

    const isEdit = Boolean(allocation);
    const title = isEdit ? 'Edit allocation' : 'New allocation';

    const dateInput = h('input', {
      id: 'alloc-serviceDate',
      type: 'date',
      class: 'input',
      required: true,
      value: allocation ? allocation.serviceDate : state.board.serviceDate,
    });

    const routeSelect = selectControl(
      'alloc-routeId',
      reference.routes.map((route) => ({ value: route.id, label: `${route.code} · ${route.name}` })),
      allocation ? allocation.routeId : (reference.routes.find((route) => route.active) || reference.routes[0] || {}).id,
    );

    const shiftSelect = selectControl(
      'alloc-shiftId',
      reference.shifts.map((shift) => ({ value: shift.id, label: `${shift.label} (${shift.startTime}–${shift.endTime})` })),
      allocation ? allocation.shiftId : state.board.shiftId,
    );

    const carSelect = selectControl(
      'alloc-carId',
      reference.cars.map((car) => ({ value: car.id, label: `${car.fleetNumber} · ${car.class}` })),
      allocation ? allocation.carId : (reference.cars[0] || {}).id,
    );

    const noteInput = h('input', {
      id: 'alloc-note',
      type: 'text',
      class: 'input',
      maxlength: '200',
      value: allocation ? allocation.note : '',
      placeholder: 'Optional note for the duty sheet',
    });

    const submitButton = h(
      'button',
      { type: 'submit', class: 'btn btn--primary' },
      isEdit ? 'Save allocation' : 'Create allocation',
    );

    const form = h(
      'form',
      { class: 'sheet-form', novalidate: true, 'aria-labelledby': 'alloc-dialog-title' },
      h(
        'div',
        { class: 'sheet-head' },
        h('h2', { class: 'sheet-title', id: 'alloc-dialog-title' }, title),
        h('button', { type: 'button', class: 'sheet-close', onclick: () => dialog.close() }, 'Close'),
      ),
      h(
        'div',
        { class: 'sheet-body' },
        field({ id: 'alloc-serviceDate', label: 'Service date', control: dateInput }),
        field({ id: 'alloc-routeId', label: 'Route', control: routeSelect }),
        field({ id: 'alloc-shiftId', label: 'Shift', control: shiftSelect }),
        field({ id: 'alloc-carId', label: 'Tram car', control: carSelect }),
        field({
          id: 'alloc-note',
          label: 'Note (optional)',
          control: noteInput,
          hint: 'Up to 200 characters, shown on the card.',
        }),
        h('p', { class: 'form-error', role: 'alert', hidden: true }),
      ),
      h(
        'div',
        { class: 'sheet-foot' },
        h('button', { type: 'button', class: 'btn', onclick: () => dialog.close() }, 'Cancel'),
        submitButton,
      ),
    );

    const dialog = h('dialog', { class: 'sheet' }, form);
    let busy = false;

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (busy) return;

      clearFieldErrors(form);
      const payload = {
        serviceDate: dateInput.value,
        routeId: routeSelect.value,
        shiftId: shiftSelect.value,
        carId: carSelect.value,
        note: noteInput.value,
      };

      busy = true;
      submitButton.disabled = true;
      submitButton.textContent = 'Saving…';

      try {
        const result = isEdit
          ? await api(`/api/allocations/${encodeURIComponent(allocation.id)}`, { method: 'PATCH', body: payload })
          : await api('/api/allocations', { method: 'POST', body: payload });

        const saved = result.allocation;
        state.board.serviceDate = saved.serviceDate;
        state.board.shiftId = saved.shiftId;
        dialog.close();
        boardPage();
      } catch (error) {
        if (error instanceof ApiFailure && error.fields) {
          const map = {
            serviceDate: 'alloc-serviceDate',
            routeId: 'alloc-routeId',
            shiftId: 'alloc-shiftId',
            carId: 'alloc-carId',
            note: 'alloc-note',
          };
          let firstInvalid = null;
          for (const [name, message] of Object.entries(error.fields)) {
            const fieldId = map[name] || name;
            setFieldError(form, fieldId, message);
            firstInvalid = firstInvalid || form.querySelector(`[data-field="${fieldId}"] input, [data-field="${fieldId}"] select`);
          }
          if (firstInvalid) firstInvalid.focus();
          if (!Object.keys(error.fields).length) showFormError(form, error.message);
        } else {
          showFormError(form, error.message);
        }
        busy = false;
        submitButton.disabled = false;
        submitButton.textContent = isEdit ? 'Save allocation' : 'Create allocation';
      }
    });

    openDialogShell(dialog);
    dateInput.focus();
  }

  function openDeleteDialog(allocation) {
    const dialog = h('dialog', { class: 'sheet', 'aria-labelledby': 'delete-dialog-title' });
    const errorSlot = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const confirmButton = h('button', { type: 'button', class: 'btn btn--danger' }, 'Delete allocation');
    let busy = false;

    confirmButton.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      confirmButton.disabled = true;
      confirmButton.textContent = 'Deleting…';
      try {
        await api(`/api/allocations/${encodeURIComponent(allocation.id)}`, { method: 'DELETE' });
        dialog.close();
        boardPage();
      } catch (error) {
        errorSlot.textContent = error.message;
        errorSlot.hidden = false;
        busy = false;
        confirmButton.disabled = false;
        confirmButton.textContent = 'Delete allocation';
      }
    });

    const form = h(
      'div',
      { class: 'sheet-form' },
      h(
        'div',
        { class: 'sheet-head' },
        h('h2', { class: 'sheet-title', id: 'delete-dialog-title' }, 'Delete this allocation?'),
        h('button', { type: 'button', class: 'sheet-close', onclick: () => dialog.close() }, 'Close'),
      ),
      h(
        'div',
        { class: 'sheet-body' },
        h(
          'p',
          { class: 'panel-body' },
          `Route ${allocation.routeCode} · car ${allocation.carFleetNumber} on the ${allocation.shiftLabel} shift of ${formatServiceDate(allocation.serviceDate)} will be taken off the board.`,
        ),
        errorSlot,
      ),
      h(
        'div',
        { class: 'sheet-foot' },
        h('button', { type: 'button', class: 'btn', onclick: () => dialog.close() }, 'Cancel'),
        confirmButton,
      ),
    );

    dialog.append(form);
    openDialogShell(dialog);
    confirmButton.focus();
  }

  /* ---------------------------------------------------------------- *
   * Depot sidings
   * ---------------------------------------------------------------- */

  function depotSkeleton() {
    return h(
      'div',
      { class: 'tracks', 'aria-hidden': 'true' },
      [0, 1, 2].map(() =>
        h(
          'section',
          { class: 'track' },
          h('div', { class: 'track-head' }, h('span', { class: 'sk sk--sm' })),
          h('div', { class: 'slot' }, h('span', { class: 'sk sk--lg' })),
          h('div', { class: 'slot' }, h('span', { class: 'sk sk--lg' })),
          h('div', { class: 'slot' }, h('span', { class: 'sk sk--lg' })),
        ),
      ),
    );
  }

  async function assignCarToSlot(slot, carId, button) {
    if (!carId) return;
    button.disabled = true;
    button.textContent = 'Assigning…';
    state.depotMessages = {};
    try {
      await api(`/api/cars/${encodeURIComponent(carId)}`, {
        method: 'PATCH',
        body: { sidingPositionId: slot.id },
      });
      depotPage();
    } catch (error) {
      state.depotMessages = { [slot.id]: error.message };
      depotPage();
    }
  }

  async function releaseSlot(slot, button) {
    button.disabled = true;
    button.textContent = 'Releasing…';
    state.depotMessages = {};
    try {
      await api(`/api/cars/${encodeURIComponent(slot.car.id)}`, {
        method: 'PATCH',
        body: { sidingPositionId: null },
      });
      depotPage();
    } catch (error) {
      state.depotMessages = { [slot.id]: error.message };
      depotPage();
    }
  }

  function slotRow(track, slot, freeCars) {
    const message = state.depotMessages[slot.id] || '';
    const row = h('div', { class: `slot${slot.car ? '' : ' slot--empty'}` });

    row.append(
      h('p', { class: 'slot-code' }, slot.slot, h('small', {}, `Track ${track.track}`)),
    );

    if (slot.car) {
      row.append(
        h(
          'div',
          { class: 'slot-main' },
          h(
            'p',
            { class: 'slot-car' },
            `Car ${slot.car.fleetNumber}`,
            statusChip(slot.car.status),
          ),
          h(
            'p',
            { class: 'slot-detail' },
            `${slot.car.class} · pantograph ${slot.car.pantographMm} mm`,
          ),
        ),
      );

      const releaseButton = h(
        'button',
        { type: 'button', class: 'btn' },
        'Release slot',
      );
      releaseButton.addEventListener('click', () => releaseSlot(slot, releaseButton));
      row.append(h('div', { class: 'slot-actions' }, releaseButton));
    } else {
      row.append(
        h('div', { class: 'slot-main' }, h('p', { class: 'slot-car' }, 'Empty'), h('p', { class: 'slot-detail' }, slot.notes)),
      );

      if (freeCars.length) {
        const select = selectControl(
          `assign-${slot.id}`,
          freeCars.map((car) => ({ value: car.id, label: `Car ${car.fleetNumber} · ${car.class}` })),
          freeCars[0].id,
        );
        select.setAttribute('aria-label', `Car to park in slot ${slot.slot}`);
        const assignButton = h('button', { type: 'button', class: 'btn' }, 'Assign car');
        assignButton.addEventListener('click', () => assignCarToSlot(slot, select.value, assignButton));
        row.append(h('div', { class: 'slot-actions' }, select, assignButton));
      } else {
        row.append(
          h('div', { class: 'slot-actions' }, h('p', { class: 'slot-detail' }, 'Every car already has a siding slot.')),
        );
      }
    }

    row.append(h('p', { class: 'slot-message', role: 'alert' }, message));
    return row;
  }

  async function depotPage() {
    document.title = 'Depot sidings — Tram Depot';

    const content = h('div', { class: 'stack' });
    render(
      shell({
        active: 'depot',
        eyebrow: 'Operations · siding positions',
        title: 'Depot sidings',
        body: content,
      }),
    );

    const tracksSlot = h('div', {}, depotSkeleton());
    content.append(
      h('p', { class: 'field-hint' }, 'Every car stands on at most one siding slot; a slot holds at most one car.'),
      tracksSlot,
    );

    let tracks;
    let cars;
    try {
      const [sidings, carList] = await Promise.all([api('/api/sidings'), api('/api/cars')]);
      tracks = sidings.tracks;
      cars = carList.cars;
    } catch (error) {
      content.replaceChildren(errorPanel(error.message, () => depotPage()));
      return;
    }

    const freeCars = cars.filter((car) => !car.sidingSlot);
    const parked = cars.length - freeCars.length;
    const slotTotal = tracks.reduce((total, track) => total + track.slots.length, 0);

    content.replaceChildren(
      h(
        'div',
        { class: 'counters' },
        counterCell('Siding slots', String(slotTotal), `Across ${tracks.length} tracks`),
        counterCell('Cars parked', String(parked), 'Standing on a siding'),
        counterCell('Cars without a slot', String(freeCars.length), 'Out on the system or spare'),
      ),
      h(
        'div',
        { class: 'tracks stagger' },
        tracks.map((track) =>
          h(
            'section',
            { class: 'track', 'aria-label': `Track ${track.track}` },
            h(
              'div',
              { class: 'track-head' },
              h('h2', { class: 'track-title' }, `Track ${track.track}`),
              h('p', { class: 'track-meta' }, `${track.slots.length} slots · ${track.slots.filter((slot) => slot.car).length} standing`),
            ),
            track.slots.map((slot) => slotRow(track, slot, freeCars)),
          ),
        ),
      ),
    );
  }

  /* ---------------------------------------------------------------- *
   * Pantograph notices
   * ---------------------------------------------------------------- */

  const SEVERITY_OPTIONS = ['minor', 'major', 'critical'];

  function noticeRow(notice) {
    return h(
      'article',
      { class: 'notice' },
      h(
        'div',
        { class: 'notice-top' },
        severityBadge(notice.severity),
        h('span', { class: 'notice-car' }, `Car ${notice.carFleetNumber}`),
        h('span', { class: 'notice-wear' }, `${notice.wearMm} mm`),
      ),
      notice.note ? h('p', { class: 'notice-note' }, notice.note) : null,
      h('p', { class: 'notice-meta' }, `Raised by ${notice.raisedBy} · ${relativeTime(notice.createdAt)}`),
    );
  }

  function noticeListPanel(notices) {
    if (!notices.length) {
      return h(
        'section',
        { class: 'panel panel--empty' },
        h('p', { class: 'panel-title' }, 'No pantograph inspections recorded'),
        h('p', { class: 'panel-body' }, 'Use the raise-notice form on the left to record the first wear reading against a car.'),
        h('a', {
          class: 'btn',
          href: '#notice-form',
          onclick: (event) => {
            event.preventDefault();
            const carSelect = document.getElementById('notice-carId');
            if (carSelect) carSelect.focus();
          },
        }, 'Go to the form'),
      );
    }

    return h(
      'div',
      { class: 'notice-list' },
      h(
        'div',
        { class: 'notice-list-head' },
        h('span', {}, 'Newest first'),
        h('span', { class: 'tabular' }, `${notices.length} notice${notices.length === 1 ? '' : 's'}`),
      ),
      notices.map((notice) => noticeRow(notice)),
    );
  }

  function noticeForm(reference, cars, flash) {
    const carSelect = selectControl(
      'notice-carId',
      cars.map((car) => ({ value: car.id, label: `${car.fleetNumber} · ${car.class} · ${car.pantographMm} mm` })),
      cars[0] ? cars[0].id : '',
    );

    const severitySelect = selectControl(
      'notice-severity',
      SEVERITY_OPTIONS.map((severity) => ({ value: severity, label: capitalise(severity) })),
      'minor',
    );

    const wearInput = h('input', {
      id: 'notice-wearMm',
      type: 'number',
      class: 'input',
      min: '0',
      max: '60',
      step: '1',
      inputmode: 'numeric',
      required: true,
      value: cars[0] ? String(cars[0].pantographMm) : '0',
      'aria-describedby': 'notice-wearMm-hint',
    });

    const noteInput = h('input', {
      id: 'notice-note',
      type: 'text',
      class: 'input',
      maxlength: '200',
      placeholder: 'What did the inspection find?',
    });

    carSelect.addEventListener('change', () => {
      const car = cars.find((candidate) => candidate.id === carSelect.value);
      if (car) wearInput.value = String(car.pantographMm);
    });

    const submitButton = h('button', { type: 'submit', class: 'btn btn--primary btn--block' }, 'Raise notice');
    const successSlot = h('p', { class: 'notice-success', role: 'status', hidden: !flash }, flash || '');

    const form = h(
      'form',
      { class: 'notice-form', id: 'notice-form', novalidate: true, 'aria-labelledby': 'notice-form-title' },
      h('h2', { class: 'form-title', id: 'notice-form-title' }, 'Raise a pantograph notice'),
      field({ id: 'notice-carId', label: 'Tram car', control: carSelect }),
      field({ id: 'notice-severity', label: 'Severity', control: severitySelect }),
      field({
        id: 'notice-wearMm',
        label: 'Wear reading (mm)',
        control: wearInput,
        hint: '0-60 mm · the latest reading replaces the car’s current value.',
      }),
      field({ id: 'notice-note', label: 'Note (optional)', control: noteInput }),
      h('p', { class: 'form-error', role: 'alert', hidden: true }),
      successSlot,
      submitButton,
    );

    let busy = false;

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (busy) return;

      clearFieldErrors(form);
      successSlot.hidden = true;

      const car = cars.find((candidate) => candidate.id === carSelect.value);
      const rawWear = wearInput.value.trim();
      const wearNumber = rawWear === '' ? Number.NaN : Number(rawWear);
      let invalid = false;

      if (!carSelect.value) {
        setFieldError(form, 'notice-carId', 'Select a tram car');
        invalid = true;
      }
      if (!Number.isFinite(wearNumber)) {
        setFieldError(form, 'notice-wearMm', 'Wear reading is required (0-60 mm)');
        invalid = true;
      } else if (wearNumber < 0 || wearNumber > 60) {
        setFieldError(form, 'notice-wearMm', 'Wear reading must be between 0 and 60 mm');
        invalid = true;
      }
      if (invalid) {
        wearInput.focus();
        return;
      }

      busy = true;
      submitButton.disabled = true;
      submitButton.textContent = 'Raising…';

      try {
        await api('/api/notices', {
          method: 'POST',
          body: {
            carId: carSelect.value,
            severity: severitySelect.value,
            wearMm: wearNumber,
            note: noteInput.value,
          },
        });
        state.noticeFlash = `Notice raised for car ${car ? car.fleetNumber : ''}`.trim();
        noticesPage();
      } catch (error) {
        if (error instanceof ApiFailure && error.fields) {
          const map = {
            carId: 'notice-carId',
            severity: 'notice-severity',
            wearMm: 'notice-wearMm',
            note: 'notice-note',
          };
          for (const [name, message] of Object.entries(error.fields)) {
            setFieldError(form, map[name] || name, message);
          }
        } else {
          showFormError(form, error.message);
        }
        busy = false;
        submitButton.disabled = false;
        submitButton.textContent = 'Raise notice';
      }
    });

    return form;
  }

  async function noticesPage() {
    document.title = 'Pantograph notices — Tram Depot';

    const content = h('div', { class: 'stack' });
    render(
      shell({
        active: 'notices',
        eyebrow: 'Fleet · pantograph wear',
        title: 'Pantograph notices',
        body: content,
      }),
    );

    const formSlot = h('div', {}, h('div', { class: 'sk sk--lg' }));
    const listSlot = h('div', { class: 'notice-list' },
      h('div', { class: 'notice-list-head' }, h('span', {}, 'Loading inspections…')),
      h('div', { class: 'notice' }, h('span', { class: 'sk sk--lg' }), h('span', { class: 'sk sk--md' })),
      h('div', { class: 'notice' }, h('span', { class: 'sk sk--lg' }), h('span', { class: 'sk sk--md' })),
    );
    content.append(h('div', { class: 'notices-layout' }, formSlot, listSlot));

    let reference;
    let cars;
    let notices;
    try {
      reference = await ensureReference();
      const [carList, noticeList] = await Promise.all([api('/api/cars'), api('/api/notices')]);
      cars = carList.cars;
      notices = noticeList.notices;
    } catch (error) {
      content.replaceChildren(errorPanel(error.message, () => noticesPage()));
      return;
    }

    const flash = state.noticeFlash;
    state.noticeFlash = null;

    formSlot.replaceWith(noticeForm(reference, cars, flash));
    listSlot.replaceWith(noticeListPanel(notices));
  }

  /* ---------------------------------------------------------------- *
   * Not found (inside the app shell)
   * ---------------------------------------------------------------- */

  function notFoundPage(path) {
    document.title = 'Page not found — Tram Depot';
    render(
      shell({
        active: '',
        eyebrow: '404',
        title: 'Page not found',
        body: h(
          'section',
          { class: 'panel' },
          h('p', { class: 'panel-title' }, `No screen lives at ${path}`),
          h(
            'p',
            { class: 'panel-body' },
            'The depot runs on three screens: the allocation board, the siding positions and the pantograph notice log.',
          ),
          h(
            'a',
            {
              class: 'btn',
              href: '/',
              onclick: (event) => {
                event.preventDefault();
                go('/');
              },
            },
            'Back to the allocation board',
          ),
        ),
      }),
    );
  }

  /* ---------------------------------------------------------------- *
   * Boot: session probe first, then render the requested route
   * ---------------------------------------------------------------- */

  state.noticeFlash = null;

  (async function boot() {
    try {
      state.staff = await api('/api/session');
    } catch {
      state.staff = null;
    }
    renderRoute();
  })();
})();
