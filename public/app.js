// Kasa Studio — lighting console frontend. Talks to the local Express/WS backend only.

const state = {
  devices: new Map(),
  groups: [],
  view: 'all',
  editingGroupId: null,
};
const cards = new Map();
let groupsJsonCache = '';

// ---------- tiny helpers ----------

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || res.statusText);
  }
  return res.status === 204 ? null : res.json();
}

function throttle(fn, delay) {
  let last = 0;
  let timer = null;
  let pendingArgs = null;
  return (...args) => {
    pendingArgs = args;
    const now = Date.now();
    const remaining = delay - (now - last);
    if (remaining <= 0) {
      last = now;
      fn(...pendingArgs);
      pendingArgs = null;
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        if (pendingArgs) fn(...pendingArgs);
        pendingArgs = null;
      }, remaining);
    }
  };
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function kelvinToRgb(kelvin) {
  const temp = kelvin / 100;
  let r;
  let g;
  let b;
  if (temp <= 66) {
    r = 255;
    g = 99.47 * Math.log(temp) - 161.12;
  } else {
    r = 329.7 * (temp - 60) ** -0.133;
    g = 288.12 * (temp - 60) ** -0.0755;
  }
  if (temp >= 66) b = 255;
  else if (temp <= 19) b = 0;
  else b = 138.5 * Math.log(temp - 10) - 305.04;
  const c = (x) => clamp(Math.round(x), 0, 255);
  return `rgb(${c(r)}, ${c(g)}, ${c(b)})`;
}

let toastHost = null;
function showError(err) {
  const message = err?.message || String(err);
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.style.position = 'fixed';
    toastHost.style.bottom = '18px';
    toastHost.style.right = '18px';
    toastHost.style.display = 'flex';
    toastHost.style.flexDirection = 'column';
    toastHost.style.gap = '8px';
    toastHost.style.zIndex = '999';
    document.body.appendChild(toastHost);
  }
  const el = document.createElement('div');
  el.textContent = message;
  el.style.background = '#2a1418';
  el.style.color = '#ff9a9a';
  el.style.border = '1px solid rgba(255,107,107,0.4)';
  el.style.borderRadius = '8px';
  el.style.padding = '8px 12px';
  el.style.fontSize = '12.5px';
  el.style.maxWidth = '320px';
  el.style.boxShadow = '0 4px 16px rgba(0,0,0,0.4)';
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), 4000);
  // eslint-disable-next-line no-console
  console.error(message);
}

/** Wires a range+number pair for live local feedback + throttled/committed sends. */
function wireLinkedControl(slider, number, sendFn, { min, max } = {}) {
  const lo = min ?? Number(slider.min) ?? 0;
  const hi = max ?? Number(slider.max) ?? 100;
  const c = (v) => clamp(Math.round(Number(v) || 0), lo, hi);
  const setLive = () => {
    slider.dataset.live = '1';
    number.dataset.live = '1';
  };
  let clearTimer = null;
  const clearLiveSoon = () => {
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
      delete slider.dataset.live;
      delete number.dataset.live;
    }, 500);
  };
  const throttled = throttle((v) => sendFn(v).catch(showError), 120);

  slider.addEventListener('pointerdown', setLive);
  slider.addEventListener('input', () => {
    setLive();
    const v = c(slider.value);
    number.value = v;
    throttled(v);
  });
  slider.addEventListener('change', () => {
    const v = c(slider.value);
    sendFn(v).catch(showError);
    clearLiveSoon();
  });
  number.addEventListener('focus', setLive);
  number.addEventListener('input', () => {
    setLive();
    slider.value = c(number.value);
  });
  number.addEventListener('change', () => {
    const v = c(number.value);
    slider.value = v;
    number.value = v;
    sendFn(v).catch(showError);
    clearLiveSoon();
  });
  number.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') number.blur();
  });
}

const EFFECT_DEFS = {
  strobe: [{ key: 'hz', label: 'Hz', min: 1, max: 6, default: 2 }],
  pulse: [
    { key: 'periodSec', label: 'Period(s)', min: 1, max: 30, default: 4 },
    { key: 'min', label: 'Min%', min: 0, max: 100, default: 8 },
    { key: 'max', label: 'Max%', min: 0, max: 100, default: 100 },
  ],
  candle: [
    { key: 'baseBrightness', label: 'Base%', min: 1, max: 100, default: 65 },
    { key: 'intensity', label: 'Flicker', min: 0, max: 50, default: 25 },
  ],
  fire: [
    { key: 'baseBrightness', label: 'Base%', min: 1, max: 100, default: 70 },
    { key: 'intensity', label: 'Flicker', min: 0, max: 60, default: 40 },
  ],
  paparazzi: [
    { key: 'baseBrightness', label: 'Base%', min: 0, max: 100, default: 4 },
    { key: 'chance', label: 'Flash%', min: 1, max: 60, default: 18 },
  ],
  fireworks: [
    { key: 'baseBrightness', label: 'Base%', min: 0, max: 100, default: 4 },
    { key: 'chance', label: 'Burst%', min: 1, max: 60, default: 15 },
  ],
  faultyBulb: [
    { key: 'baseBrightness', label: 'Base%', min: 1, max: 100, default: 85 },
    { key: 'chance', label: 'Glitch%', min: 1, max: 60, default: 12 },
  ],
  lightning: [
    { key: 'baseBrightness', label: 'Base%', min: 0, max: 100, default: 3 },
    { key: 'chance', label: 'Strike%', min: 1, max: 60, default: 6 },
  ],
  tv: [
    { key: 'baseBrightness', label: 'Base%', min: 1, max: 100, default: 80 },
    { key: 'intensity', label: 'Flicker', min: 0, max: 60, default: 25 },
  ],
  explosion: [
    { key: 'baseBrightness', label: 'Base%', min: 0, max: 100, default: 5 },
    { key: 'chance', label: 'Blast%', min: 1, max: 60, default: 6 },
  ],
  welding: [
    { key: 'baseBrightness', label: 'Base%', min: 1, max: 100, default: 90 },
    { key: 'chance', label: 'Dip%', min: 1, max: 60, default: 15 },
  ],
  colorCycle: [
    { key: 'periodSec', label: 'Period(s)', min: 2, max: 60, default: 10 },
    { key: 'saturation', label: 'Sat%', min: 0, max: 100, default: 100 },
    { key: 'brightness', label: 'Bright%', min: 1, max: 100, default: 100 },
  ],
  copCar: [{ key: 'hz', label: 'Hz', min: 1, max: 6, default: 3 }],
  partyLights: [{ key: 'hz', label: 'Changes/s', min: 1, max: 6, default: 3 }],
  clubLights: [{ key: 'hz', label: 'Hz', min: 1, max: 6, default: 3 }],
};

const COLOR_ONLY_EFFECTS = ['colorCycle', 'copCar', 'partyLights', 'clubLights'];
const WARM_TUNABLE_EFFECTS = ['candle', 'fire'];

// ---------- rendering ----------

function totalOnlineCounts() {
  let online = 0;
  for (const d of state.devices.values()) if (d.online) online += 1;
  return { online, total: state.devices.size };
}

function renderTopbar() {
  const { online, total } = totalOnlineCounts();
  document.getElementById('onlineCount').textContent = `${online}/${total} online`;
}

function renderSidebar() {
  const viewList = document.getElementById('viewList');
  viewList.innerHTML = '';
  const allItem = document.createElement('li');
  allItem.className = `view-item ${state.view === 'all' ? 'active' : ''}`;
  allItem.innerHTML = `<span class="view-item-name">All Lights</span><span class="view-item-count">${state.devices.size}</span>`;
  allItem.addEventListener('click', () => selectView('all'));
  viewList.appendChild(allItem);

  const groupList = document.getElementById('groupList');
  groupList.innerHTML = '';
  for (const group of state.groups) {
    const li = document.createElement('li');
    li.className = `view-item ${state.view === group.id ? 'active' : ''}`;
    const count = [...state.devices.values()].filter((d) => d.groupIds.includes(group.id)).length;

    if (state.editingGroupId === group.id) {
      li.innerHTML = '';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = group.name;
      input.style.width = '100%';
      li.appendChild(input);
      const commit = () => {
        const name = input.value.trim();
        state.editingGroupId = null;
        if (name && name !== group.name) {
          api(`/api/groups/${group.id}`, 'PATCH', { name }).catch(showError);
        } else {
          renderSidebar();
        }
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') {
          state.editingGroupId = null;
          renderSidebar();
        }
      });
      groupList.appendChild(li);
      input.focus();
      input.select();
      continue;
    }

    li.innerHTML = `
      <span class="view-item-name">${escapeHtml(group.name)}</span>
      <span class="view-item-actions">
        <button class="btn btn--icon" data-action="rename" title="Rename">✎</button>
        <button class="btn btn--icon" data-action="delete" title="Delete">×</button>
      </span>
      <span class="view-item-count">${count}</span>
    `;
    li.querySelector('[data-action="rename"]').addEventListener('click', (e) => {
      e.stopPropagation();
      state.editingGroupId = group.id;
      renderSidebar();
    });
    li.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
      e.stopPropagation();
      if (window.confirm(`Delete group "${group.name}"? Lights stay put, they just lose this grouping.`)) {
        api(`/api/groups/${group.id}`, 'DELETE').catch(showError);
        if (state.view === group.id) selectView('all');
      }
    });
    li.addEventListener('click', () => selectView(group.id));
    groupList.appendChild(li);
  }
}

function selectView(view) {
  state.view = view;
  renderSidebar();
  renderMasterBar();
  renderGrid();
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function renderMasterBar() {
  const bar = document.getElementById('masterBar');
  const visible = visibleDevices();
  bar.hidden = state.devices.size === 0;
  if (bar.hidden) return;
  const group = state.groups.find((g) => g.id === state.view);
  document.getElementById('masterBarName').textContent = group ? group.name : 'All Lights';
  document.getElementById('masterBarCount').textContent = `${visible.length} light${visible.length === 1 ? '' : 's'}`;
}

function visibleDevices() {
  const list = [...state.devices.values()];
  const filtered = state.view === 'all' ? list : list.filter((d) => d.groupIds.includes(state.view));
  return filtered.sort((a, b) => a.name.localeCompare(b.name));
}

function renderGrid() {
  const visible = visibleDevices();
  const visibleIds = new Set(visible.map((d) => d.id));
  for (const [id, card] of cards) {
    if (!visibleIds.has(id)) {
      card.root.remove();
      cards.delete(id);
    }
  }
  const gridEl = document.getElementById('grid');
  document.getElementById('emptyState').hidden = visible.length > 0;
  for (const device of visible) {
    let card = cards.get(device.id);
    if (!card) {
      card = createCard(device);
      cards.set(device.id, card);
    }
    gridEl.appendChild(card.root);
    updateCard(card, device);
  }
}

function renderAll() {
  renderTopbar();
  renderSidebar();
  renderMasterBar();
  renderGrid();
}

// ---------- card creation ----------

function createCard(device) {
  const template = document.getElementById('cardTemplate');
  const root = template.content.firstElementChild.cloneNode(true);
  const q = (sel) => root.querySelector(sel);

  const refs = {
    onlineDot: q('[data-online-dot]'),
    label: q('[data-label]'),
    labelInput: q('[data-label-input]'),
    sub: q('[data-sub]'),
    identify: q('[data-identify]'),
    power: q('[data-power]'),
    powerLabel: q('[data-power-label]'),
    groupPills: q('[data-group-pills]'),
    brightnessRow: q('[data-brightness-row]'),
    brightness: q('[data-brightness]'),
    brightnessNum: q('[data-brightness-num]'),
    presetsRow: q('[data-brightness-presets]'),
    colorTabs: q('[data-color-tabs]'),
    tempRow: q('[data-temp-row]'),
    temp: q('[data-temp]'),
    tempNum: q('[data-temp-num]'),
    colorPanel: q('[data-color-panel]'),
    hue: q('[data-hue]'),
    hueNum: q('[data-hue-num]'),
    sat: q('[data-sat]'),
    satNum: q('[data-sat-num]'),
    swatchRow: q('[data-swatch-row]'),
    swatch: q('[data-swatch]'),
    swatchLabel: q('[data-swatch-label]'),
    effectsRow: q('[data-effects-row]'),
    effectType: q('[data-effect-type]'),
    effectToggle: q('[data-effect-toggle]'),
    effectParams: q('[data-effect-params]'),
  };

  const card = { root, refs, id: device.id, colorMode: null, lastEffectType: '' };

  // label editing
  const enterLabelEdit = () => {
    root.dataset.editingLabel = '1';
    refs.labelInput.value = card.device?.label ?? '';
    refs.labelInput.placeholder = card.device?.alias ?? '';
    refs.label.hidden = true;
    refs.labelInput.hidden = false;
    refs.labelInput.focus();
    refs.labelInput.select();
  };
  const commitLabel = () => {
    const value = refs.labelInput.value.trim();
    delete root.dataset.editingLabel;
    refs.label.hidden = false;
    refs.labelInput.hidden = true;
    api(`/api/devices/${device.id}/label`, 'PATCH', { label: value }).catch(showError);
  };
  refs.label.addEventListener('click', enterLabelEdit);
  refs.label.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') enterLabelEdit();
  });
  refs.labelInput.addEventListener('blur', commitLabel);
  refs.labelInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') refs.labelInput.blur();
    if (e.key === 'Escape') {
      delete root.dataset.editingLabel;
      refs.label.hidden = false;
      refs.labelInput.hidden = true;
    }
  });

  // identify
  refs.identify.addEventListener('click', async () => {
    refs.identify.classList.add('is-busy');
    refs.identify.disabled = true;
    try {
      await api(`/api/devices/${device.id}/identify`, 'POST');
    } catch (err) {
      showError(err);
    } finally {
      refs.identify.classList.remove('is-busy');
      refs.identify.disabled = false;
    }
  });

  // power
  refs.power.addEventListener('change', () => {
    api(`/api/devices/${device.id}/power`, 'POST', { on: refs.power.checked }).catch(showError);
  });

  // brightness
  wireLinkedControl(refs.brightness, refs.brightnessNum, (v) => api(`/api/devices/${device.id}/brightness`, 'POST', { value: v }), {
    min: 0,
    max: 100,
  });
  refs.presetsRow.querySelectorAll('button[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = Number(btn.dataset.preset);
      refs.brightness.value = v;
      refs.brightnessNum.value = v;
      api(`/api/devices/${device.id}/brightness`, 'POST', { value: v }).catch(showError);
    });
  });

  // color temp
  wireLinkedControl(refs.temp, refs.tempNum, (v) => api(`/api/devices/${device.id}/color-temp`, 'POST', { kelvin: v }));

  // hue / saturation
  wireLinkedControl(refs.hue, refs.hueNum, (v) => api(`/api/devices/${device.id}/color`, 'POST', { hue: v }), { min: 0, max: 360 });
  wireLinkedControl(refs.sat, refs.satNum, (v) => api(`/api/devices/${device.id}/color`, 'POST', { saturation: v }), { min: 0, max: 100 });

  // color/white tabs
  refs.colorTabs.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      card.colorMode = tab.dataset.tab;
      applyColorMode(card);
    });
  });

  // effects
  refs.effectType.addEventListener('change', () => {
    card.lastEffectType = refs.effectType.value;
    rebuildEffectParams(card);
  });
  refs.effectToggle.addEventListener('click', async () => {
    try {
      if (card.device?.effect) {
        await api(`/api/devices/${device.id}/effect`, 'DELETE');
      } else {
        const type = refs.effectType.value;
        if (!type) return;
        const params = {};
        refs.effectParams.querySelectorAll('input[data-param]').forEach((inp) => {
          params[inp.dataset.param] = Number(inp.value);
        });
        await api(`/api/devices/${device.id}/effect`, 'POST', { type, params });
      }
    } catch (err) {
      showError(err);
    }
  });

  return card;
}

function applyColorMode(card) {
  const { refs } = card;
  const showTabs = !refs.colorTabs.hidden;
  if (showTabs) {
    refs.colorTabs.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === card.colorMode));
  }
  refs.tempRow.hidden = !(card.device.capabilities.colorTemp && card.colorMode === 'white');
  refs.colorPanel.hidden = !(card.device.capabilities.color && card.colorMode === 'color');
}

function rebuildEffectParams(card) {
  const { refs, device } = card;
  refs.effectParams.innerHTML = '';
  const type = refs.effectType.value;
  const defs = EFFECT_DEFS[type];
  if (!defs) return;
  for (const def of defs) {
    const wrap = document.createElement('label');
    wrap.className = 'effect-param';
    wrap.innerHTML = `<span>${def.label}</span>`;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = def.min;
    input.max = def.max;
    input.value = def.default;
    input.dataset.param = def.key;
    wrap.appendChild(input);
    refs.effectParams.appendChild(wrap);
  }
  if (WARM_TUNABLE_EFFECTS.includes(type) && device?.capabilities?.colorTemp) {
    const wrap = document.createElement('label');
    wrap.className = 'effect-param';
    wrap.innerHTML = '<span>Temp(K)</span>';
    const input = document.createElement('input');
    input.type = 'number';
    input.min = device.capabilities.colorTempRange?.min ?? 2500;
    input.max = device.capabilities.colorTempRange?.max ?? 3200;
    input.value = device.capabilities.colorTempRange?.min ?? 2700;
    input.dataset.param = 'colorTemp';
    wrap.appendChild(input);
    refs.effectParams.appendChild(wrap);
  }
}

function isLive(el) {
  return el.dataset.live === '1' || document.activeElement === el;
}

function updateCard(card, device) {
  card.device = device;
  const { refs, root } = card;

  root.classList.toggle('is-offline', !device.online);
  refs.onlineDot.className = `dot ${device.online ? 'dot--good' : 'dot--off'}`;

  if (!root.dataset.editingLabel) {
    refs.label.textContent = device.name;
  }
  refs.sub.textContent = `${device.model} · ${device.host}`;

  if (!isLive(refs.power)) refs.power.checked = !!device.power;
  refs.powerLabel.textContent = device.power ? 'On' : 'Off';

  // group pills
  refs.groupPills.innerHTML = '';
  for (const group of state.groups) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = `pill ${device.groupIds.includes(group.id) ? 'is-on' : ''}`;
    pill.textContent = group.name;
    pill.title = device.groupIds.includes(group.id) ? `Remove from ${group.name}` : `Add to ${group.name}`;
    pill.addEventListener('click', () => {
      const next = device.groupIds.includes(group.id)
        ? device.groupIds.filter((g) => g !== group.id)
        : [...device.groupIds, group.id];
      api(`/api/devices/${device.id}/groups`, 'PATCH', { groupIds: next }).catch(showError);
    });
    refs.groupPills.appendChild(pill);
  }

  const cap = device.capabilities;

  // brightness
  const hasBrightness = !!cap.brightness;
  refs.brightnessRow.hidden = !hasBrightness;
  refs.presetsRow.hidden = !hasBrightness;
  if (hasBrightness && !isLive(refs.brightness) && !isLive(refs.brightnessNum)) {
    refs.brightness.value = device.brightness ?? 0;
    refs.brightnessNum.value = device.brightness ?? 0;
  }

  // color temp range (bulb only, static once known)
  if (cap.colorTemp && cap.colorTempRange) {
    if (refs.temp.min !== String(cap.colorTempRange.min)) {
      refs.temp.min = cap.colorTempRange.min;
      refs.temp.max = cap.colorTempRange.max;
      refs.tempNum.min = cap.colorTempRange.min;
      refs.tempNum.max = cap.colorTempRange.max;
    }
  }
  if (cap.colorTemp && !isLive(refs.temp) && !isLive(refs.tempNum) && device.colorTemp != null) {
    refs.temp.value = device.colorTemp;
    refs.tempNum.value = device.colorTemp;
  }
  if (cap.color && !isLive(refs.hue) && !isLive(refs.hueNum) && device.hue != null) {
    refs.hue.value = device.hue;
    refs.hueNum.value = device.hue;
  }
  if (cap.color && !isLive(refs.sat) && !isLive(refs.satNum) && device.saturation != null) {
    refs.sat.value = device.saturation;
    refs.satNum.value = device.saturation;
  }

  // tabs / mode visibility
  refs.colorTabs.hidden = !(cap.color && cap.colorTemp);
  refs.swatchRow.hidden = !(cap.color || cap.colorTemp);
  if (card.colorMode === null) {
    card.colorMode = cap.color && device.saturation > 0 ? 'color' : 'white';
  }
  if (!cap.color && cap.colorTemp) {
    refs.tempRow.hidden = false;
    refs.colorPanel.hidden = true;
  } else if (cap.color && !cap.colorTemp) {
    refs.tempRow.hidden = true;
    refs.colorPanel.hidden = false;
  } else if (cap.color && cap.colorTemp) {
    applyColorMode(card);
  } else {
    refs.tempRow.hidden = true;
    refs.colorPanel.hidden = true;
  }

  // swatch preview
  if (!refs.swatchRow.hidden) {
    const usingColor = cap.color && (!cap.colorTemp || card.colorMode === 'color');
    if (usingColor) {
      const l = clamp(20 + (device.brightness ?? 100) * 0.5, 20, 70);
      refs.swatch.style.background = `hsl(${device.hue ?? 0}deg ${device.saturation ?? 0}% ${l}%)`;
      refs.swatchLabel.textContent = `H${Math.round(device.hue ?? 0)}° S${Math.round(device.saturation ?? 0)}%`;
    } else {
      refs.swatch.style.background = kelvinToRgb(device.colorTemp ?? 4000);
      refs.swatchLabel.textContent = `${device.colorTemp ?? '—'}K`;
    }
    refs.swatch.style.opacity = device.power ? '1' : '0.35';
  }

  // effects
  refs.effectsRow.hidden = !cap.effects;
  if (cap.effects) {
    if (device.effect) {
      if (document.activeElement !== refs.effectType) refs.effectType.value = device.effect.type;
      refs.effectToggle.textContent = 'Stop';
      refs.effectToggle.classList.add('is-active');
    } else {
      refs.effectToggle.textContent = 'Start';
      refs.effectToggle.classList.remove('is-active');
    }
    if (!cap.color && !refs.effectType.dataset.colorOptionsDisabled) {
      for (const value of COLOR_ONLY_EFFECTS) {
        const opt = refs.effectType.querySelector(`option[value="${value}"]`);
        if (opt) opt.disabled = true;
      }
      refs.effectType.dataset.colorOptionsDisabled = '1';
    }
    if (card.lastEffectType !== refs.effectType.value) {
      card.lastEffectType = refs.effectType.value;
      rebuildEffectParams(card);
    }
    if (refs.effectParams.children.length === 0 && refs.effectType.value) {
      rebuildEffectParams(card);
    }
  }
}

// ---------- master bar wiring ----------

function applyMasterPatch(patch) {
  if (state.view === 'all') {
    const ids = [...state.devices.keys()];
    return Promise.all(ids.map((id) => api(`/api/devices/${id}/state`, 'POST', patch).catch(showError)));
  }
  return api(`/api/groups/${state.view}/state`, 'POST', patch).catch(showError);
}

function initMasterBar() {
  document.querySelector('[data-master-action="on"]').addEventListener('click', () => applyMasterPatch({ power: true }));
  document.querySelector('[data-master-action="off"]').addEventListener('click', () => applyMasterPatch({ power: false }));
  document.querySelector('[data-master-action="stop-effects"]').addEventListener('click', () => {
    if (state.view === 'all') {
      Promise.all([...state.devices.keys()].map((id) => api(`/api/devices/${id}/effect`, 'DELETE').catch(() => {})));
    } else {
      api(`/api/groups/${state.view}/effect`, 'DELETE').catch(showError);
    }
  });
  wireLinkedControl(document.getElementById('masterBrightness'), document.getElementById('masterBrightnessNum'), (v) =>
    applyMasterPatch({ brightness: v }),
  {
    min: 0,
    max: 100,
  });
  wireLinkedControl(document.getElementById('masterTemp'), document.getElementById('masterTempNum'), (v) =>
    applyMasterPatch({ colorTemp: v }),
  {
    min: 2500,
    max: 6500,
  });
}

// ---------- groups ----------

function initSidebarActions() {
  document.getElementById('newGroupBtn').addEventListener('click', () => {
    const name = window.prompt('New group name (e.g. Key Lights, Rim, Background)', 'New Group');
    if (name && name.trim()) {
      api('/api/groups', 'POST', { name: name.trim() }).catch(showError);
    }
  });
  document.getElementById('rescanBtn').addEventListener('click', async () => {
    const spinner = document.getElementById('rescanSpinner');
    spinner.hidden = false;
    try {
      await api('/api/discover', 'POST');
    } catch (err) {
      showError(err);
    } finally {
      setTimeout(() => {
        spinner.hidden = true;
      }, 1200);
    }
  });
}

// ---------- data intake ----------

function applyState(payload) {
  const nextGroupsJson = JSON.stringify(payload.groups ?? []);
  const groupsChanged = nextGroupsJson !== groupsJsonCache;
  if (groupsChanged && state.editingGroupId === null) {
    groupsJsonCache = nextGroupsJson;
    state.groups = payload.groups ?? [];
  }

  const seen = new Set();
  for (const device of payload.devices ?? []) {
    seen.add(device.id);
    state.devices.set(device.id, device);
  }
  for (const id of [...state.devices.keys()]) {
    if (!seen.has(id)) state.devices.delete(id);
  }

  renderAll();
}

// ---------- websocket ----------

function connectWs() {
  const dot = document.getElementById('wsDot');
  const label = document.getElementById('wsLabel');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.addEventListener('open', () => {
    dot.className = 'dot dot--good';
    label.textContent = 'connected';
  });
  ws.addEventListener('close', () => {
    dot.className = 'dot dot--warn';
    label.textContent = 'reconnecting…';
    setTimeout(connectWs, 1500);
  });
  ws.addEventListener('error', () => ws.close());
  ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'state') applyState(msg);
    } catch (err) {
      showError(err);
    }
  });
}

// ---------- boot ----------

async function boot() {
  initMasterBar();
  initSidebarActions();
  try {
    const initial = await api('/api/state');
    applyState(initial);
  } catch (err) {
    showError(err);
  }
  connectWs();
}

boot();
