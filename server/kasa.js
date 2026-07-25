import { EventEmitter } from 'node:events';
import tplink from 'tplink-smarthome-api';

const { Client } = tplink;

const DISCOVERY_INTERVAL_MS = 4000;
const MIN_EFFECT_TICK_MS = 120;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clampInt = (value, min, max) => Math.min(max, Math.max(min, Math.round(Number(value))));
const wrapHue = (value) => ((Math.round(Number(value)) % 360) + 360) % 360;

function stateFromDevice(device) {
  if (device.deviceType === 'bulb') {
    const ls = device.sysInfo.light_state ?? {};
    return {
      on: !!ls.on_off,
      brightness: device.supportsBrightness ? ls.brightness ?? 100 : null,
      hue: device.supportsColor ? ls.hue ?? 0 : null,
      saturation: device.supportsColor ? ls.saturation ?? 0 : null,
      colorTemp: device.supportsColorTemperature
        ? ls.color_temp ?? device.colorTemperatureRange?.min ?? null
        : null,
    };
  }
  return {
    on: !!device.sysInfo.relay_state,
    brightness: device.supportsDimmer ? device.sysInfo.brightness ?? 100 : null,
    hue: null,
    saturation: null,
    colorTemp: null,
  };
}

function capabilitiesFor(device) {
  if (device.deviceType === 'bulb') {
    return {
      power: true,
      brightness: device.supportsBrightness,
      color: device.supportsColor,
      colorTemp: device.supportsColorTemperature,
      colorTempRange: device.colorTemperatureRange,
      effects: true,
    };
  }
  return {
    power: true,
    brightness: device.supportsDimmer,
    color: false,
    colorTemp: false,
    colorTempRange: null,
    effects: false,
  };
}

const COLOR_REQUIRED_EFFECTS = new Set(['colorCycle', 'copCar', 'partyLights', 'clubLights']);

function hzToHalfPeriodMs(hz) {
  return Math.max(MIN_EFFECT_TICK_MS, Math.round(1000 / (clampInt(hz ?? 2, 1, 6) * 2)));
}

function effectTickMs(type, params) {
  switch (type) {
    case 'strobe':
    case 'clubLights':
    case 'copCar':
      return hzToHalfPeriodMs(params.hz);
    case 'partyLights':
      return Math.max(MIN_EFFECT_TICK_MS, Math.round(1000 / clampInt(params.hz ?? 3, 1, 6)));
    case 'pulse':
    case 'colorCycle':
      return 200;
    case 'candle':
      return 180;
    case 'fire':
      return 150;
    case 'paparazzi':
      return 150;
    case 'fireworks':
      return 170;
    case 'faultyBulb':
      return 200;
    case 'lightning':
      return 220;
    case 'tv':
      return 140;
    case 'explosion':
      return 180;
    case 'welding':
      return 130;
    default:
      return 300;
  }
}

/**
 * Shared "flash then decay" state machine for bursty effects (paparazzi,
 * fireworks, explosion). `decay` is the brightness sequence played out once
 * triggered (first value returned immediately); between bursts it falls back
 * to `effect.params.baseBrightness`. Returns whether this tick started a
 * fresh burst so callers can layer a one-off color choice onto it.
 */
function nextBurstValue(effect, decay) {
  const burst = effect.burst ?? (effect.burst = { queue: [] });
  if (burst.queue.length) {
    return { value: burst.queue.shift(), triggered: false };
  }
  const chance = clampInt(effect.params.chance ?? 15, 0, 100) / 100;
  if (Math.random() < chance) {
    burst.queue = decay.slice(1);
    return { value: decay[0], triggered: true };
  }
  return { value: clampInt(effect.params.baseBrightness ?? 5, 0, 100), triggered: false };
}

/**
 * Owns the tplink-smarthome-api Client, tracks every discovered device's
 * displayed state in `record.state`, and layers software-driven lighting
 * effects on top since Kasa bulbs don't expose local scene/effect presets.
 */
export class KasaManager extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.client = new Client({ logLevel: 'error' });
    this.records = new Map();

    this.client.on('device-new', (device) => this._upsert(device, true));
    this.client.on('device-online', (device) => this._upsert(device, true));
    this.client.on('device-offline', (device) => this._markOffline(device));
    this.client.on('error', (err) => this.emit('error', err));
  }

  startDiscovery() {
    this.client.startDiscovery({
      deviceTypes: ['bulb', 'plug'],
      discoveryInterval: DISCOVERY_INTERVAL_MS,
      offlineTolerance: 3,
      breakoutChildren: true,
    });
    return this;
  }

  rescan() {
    this.client.stopDiscovery();
    this.startDiscovery();
  }

  shutdown() {
    for (const record of this.records.values()) this._stopEffectInternal(record);
    this.client.stopDiscovery();
  }

  _upsert(device, online) {
    let record = this.records.get(device.id);
    if (!record) {
      record = { device, online, state: stateFromDevice(device), effect: null };
      this.records.set(device.id, record);
    } else {
      record.device = device;
      record.online = online;
      if (!record.effect) record.state = stateFromDevice(device);
    }
    this.emit('change');
  }

  _markOffline(device) {
    const record = this.records.get(device.id);
    if (!record) return;
    record.online = false;
    this._stopEffectInternal(record);
    this.emit('change');
  }

  _requireRecord(deviceId) {
    const record = this.records.get(deviceId);
    if (!record) throw new Error(`Unknown device: ${deviceId}`);
    return record;
  }

  listSnapshots() {
    return [...this.records.values()].map((record) => this._snapshot(record));
  }

  getSnapshot(deviceId) {
    const record = this.records.get(deviceId);
    return record ? this._snapshot(record) : null;
  }

  _snapshot(record) {
    const { device, online, state, effect } = record;
    const meta = this.store.getDeviceMeta(device.id);
    return {
      id: device.id,
      host: device.host,
      mac: device.macNormalized,
      model: device.model,
      alias: device.alias,
      label: meta.label,
      name: meta.label || device.alias || device.model,
      deviceType: device.deviceType,
      online,
      groupIds: meta.groupIds ?? [],
      capabilities: capabilitiesFor(device),
      power: state.on,
      brightness: state.brightness,
      hue: state.hue,
      saturation: state.saturation,
      colorTemp: state.colorTemp,
      effect: effect ? { type: effect.type, params: effect.params } : null,
    };
  }

  // --- direct control ---

  async setPower(deviceId, on) {
    const record = this._requireRecord(deviceId);
    this._stopEffectInternal(record);
    const { device } = record;
    if (device.deviceType === 'bulb') {
      await device.lighting.setLightState({ on_off: on ? 1 : 0, transition_period: 200 });
    } else {
      await device.setPowerState(!!on);
    }
    record.state.on = !!on;
    this.emit('change');
  }

  async setBrightness(deviceId, percent) {
    const record = this._requireRecord(deviceId);
    this._stopEffectInternal(record);
    const { device } = record;
    if (!device.supportsBrightness && !device.supportsDimmer) {
      throw new Error('Device is not dimmable');
    }
    const value = clampInt(percent, 0, 100);
    if (device.deviceType === 'bulb') {
      await device.lighting.setLightState({ on_off: 1, brightness: value, transition_period: 200 });
    } else {
      await device.setPowerState(true);
      await device.dimmer.setBrightness(value);
    }
    record.state.on = true;
    record.state.brightness = value;
    this.emit('change');
  }

  async setColor(deviceId, { hue, saturation }) {
    const record = this._requireRecord(deviceId);
    this._stopEffectInternal(record);
    const { device } = record;
    if (device.deviceType !== 'bulb' || !device.supportsColor) {
      throw new Error('Device does not support color');
    }
    const payload = { on_off: 1, transition_period: 200 };
    if (hue !== undefined) payload.hue = wrapHue(hue);
    if (saturation !== undefined) payload.saturation = clampInt(saturation, 0, 100);
    await device.lighting.setLightState(payload);
    record.state.on = true;
    if (payload.hue !== undefined) record.state.hue = payload.hue;
    if (payload.saturation !== undefined) record.state.saturation = payload.saturation;
    this.emit('change');
  }

  async setColorTemp(deviceId, kelvin) {
    const record = this._requireRecord(deviceId);
    this._stopEffectInternal(record);
    const { device } = record;
    if (device.deviceType !== 'bulb' || !device.supportsColorTemperature) {
      throw new Error('Device does not support color temperature');
    }
    const range = device.colorTemperatureRange;
    let value = Math.round(kelvin);
    if (range) value = clampInt(value, range.min, range.max);
    await device.lighting.setLightState({ on_off: 1, color_temp: value, transition_period: 200 });
    record.state.on = true;
    record.state.colorTemp = value;
    this.emit('change');
  }

  /** Generic bulk setter used by group control and precise-intensity apply. */
  async setState(deviceId, patch) {
    const record = this._requireRecord(deviceId);
    this._stopEffectInternal(record);
    const { device } = record;
    if (device.deviceType === 'bulb') {
      const payload = { transition_period: patch.transitionMs ?? 200 };
      if (patch.power !== undefined) payload.on_off = patch.power ? 1 : 0;
      if (patch.brightness !== undefined && device.supportsBrightness) {
        payload.brightness = clampInt(patch.brightness, 0, 100);
      }
      if (patch.hue !== undefined && device.supportsColor) payload.hue = wrapHue(patch.hue);
      if (patch.saturation !== undefined && device.supportsColor) {
        payload.saturation = clampInt(patch.saturation, 0, 100);
      }
      if (patch.colorTemp !== undefined && device.supportsColorTemperature) {
        let v = Math.round(patch.colorTemp);
        const range = device.colorTemperatureRange;
        if (range) v = clampInt(v, range.min, range.max);
        payload.color_temp = v;
      }
      await device.lighting.setLightState(payload);
      if (patch.power !== undefined) record.state.on = !!patch.power;
      if (payload.brightness !== undefined) record.state.brightness = payload.brightness;
      if (payload.hue !== undefined) record.state.hue = payload.hue;
      if (payload.saturation !== undefined) record.state.saturation = payload.saturation;
      if (payload.color_temp !== undefined) record.state.colorTemp = payload.color_temp;
    } else {
      if (patch.power !== undefined) {
        await device.setPowerState(!!patch.power);
        record.state.on = !!patch.power;
      }
      if (patch.brightness !== undefined && device.supportsDimmer) {
        const value = clampInt(patch.brightness, 0, 100);
        await device.dimmer.setBrightness(value);
        record.state.brightness = value;
      }
    }
    this.emit('change');
  }

  async identify(deviceId) {
    const record = this._requireRecord(deviceId);
    this._stopEffectInternal(record);
    const { device } = record;
    const before = { ...record.state };
    try {
      if (device.deviceType === 'bulb') {
        for (let i = 0; i < 3; i += 1) {
          await device.lighting.setLightState({ on_off: 1, brightness: 100, transition_period: 0 });
          await sleep(260);
          await device.lighting.setLightState({ on_off: 0, transition_period: 0 });
          await sleep(260);
        }
      } else {
        for (let i = 0; i < 3; i += 1) {
          await device.setPowerState(true);
          await sleep(260);
          await device.setPowerState(false);
          await sleep(260);
        }
      }
    } finally {
      try {
        if (device.deviceType === 'bulb') {
          await device.lighting.setLightState({
            on_off: before.on ? 1 : 0,
            brightness: before.brightness ?? undefined,
            hue: before.hue ?? undefined,
            saturation: before.saturation ?? undefined,
            color_temp: before.colorTemp ?? undefined,
            transition_period: 200,
          });
        } else {
          await device.setPowerState(before.on);
          if (device.supportsDimmer && before.brightness != null) {
            await device.dimmer.setBrightness(before.brightness);
          }
        }
      } catch (err) {
        this.emit('error', err);
      }
      record.state = before;
      this.emit('change');
    }
  }

  // --- effects ---

  startEffect(deviceId, type, params = {}) {
    const record = this._requireRecord(deviceId);
    const { device } = record;
    if (device.deviceType !== 'bulb') throw new Error('Effects require a bulb');
    if (COLOR_REQUIRED_EFFECTS.has(type) && !device.supportsColor) {
      throw new Error(`${type} requires a color bulb`);
    }
    this._stopEffectInternal(record);

    const tickMs = effectTickMs(type, params);
    const effect = { type, params, snapshot: { ...record.state }, phase: 0, timer: null };

    const runners = {
      strobe: () => this._tickStrobe(device, effect),
      pulse: () => this._tickPulse(device, effect, tickMs),
      colorCycle: () => this._tickColorCycle(device, effect, tickMs),
      candle: () => this._tickCandle(device, effect),
      fire: () => this._tickFire(device, effect),
      paparazzi: () => this._tickPaparazzi(device, effect),
      fireworks: () => this._tickFireworks(device, effect),
      faultyBulb: () => this._tickFaultyBulb(device, effect),
      lightning: () => this._tickLightning(device, effect),
      tv: () => this._tickTv(device, effect),
      explosion: () => this._tickExplosion(device, effect),
      welding: () => this._tickWelding(device, effect),
      copCar: () => this._tickCopCar(device, effect),
      partyLights: () => this._tickPartyLights(device, effect),
      clubLights: () => this._tickClubLights(device, effect),
    };
    const runner = runners[type];
    if (!runner) throw new Error(`Unknown effect type: ${type}`);

    effect.timer = setInterval(() => {
      runner()
        .then((patch) => {
          if (patch) Object.assign(record.state, patch);
          this.emit('change');
        })
        .catch((err) => this.emit('error', err));
    }, tickMs);

    record.effect = effect;
    this.emit('change');
  }

  async stopEffect(deviceId, { restore = true } = {}) {
    const record = this._requireRecord(deviceId);
    const effect = record.effect;
    this._stopEffectInternal(record);
    if (restore && effect) {
      const s = effect.snapshot;
      await record.device.lighting.setLightState({
        on_off: s.on ? 1 : 0,
        brightness: s.brightness ?? undefined,
        hue: s.hue ?? undefined,
        saturation: s.saturation ?? undefined,
        color_temp: s.colorTemp ?? undefined,
        transition_period: 300,
      });
      record.state = { ...s };
    }
    this.emit('change');
  }

  _stopEffectInternal(record) {
    if (record.effect) {
      clearInterval(record.effect.timer);
      record.effect = null;
    }
  }

  async _tickStrobe(device, effect) {
    effect.phase = effect.phase ? 0 : 1;
    await device.lighting.setLightState({ on_off: effect.phase, brightness: 100, transition_period: 0 });
    return { on: !!effect.phase, brightness: 100 };
  }

  async _tickPulse(device, effect, tickMs) {
    const min = clampInt(effect.params.min ?? 8, 0, 100);
    const max = clampInt(effect.params.max ?? 100, 0, 100);
    const periodMs = Math.max(500, (effect.params.periodSec ?? 4) * 1000);
    effect.phase = (effect.phase + tickMs / periodMs) % 1;
    const brightness = Math.round(min + (max - min) * (0.5 - 0.5 * Math.cos(2 * Math.PI * effect.phase)));
    await device.lighting.setLightState({ on_off: 1, brightness, transition_period: tickMs });
    return { on: true, brightness };
  }

  async _tickColorCycle(device, effect, tickMs) {
    const periodMs = Math.max(1000, (effect.params.periodSec ?? 10) * 1000);
    const saturation = clampInt(effect.params.saturation ?? 100, 0, 100);
    const brightness = clampInt(effect.params.brightness ?? 100, 1, 100);
    effect.phase = (effect.phase + (tickMs / periodMs) * 360) % 360;
    const hue = Math.round(effect.phase);
    await device.lighting.setLightState({ on_off: 1, hue, saturation, brightness, transition_period: tickMs });
    return { on: true, hue, saturation, brightness };
  }

  async _tickCandle(device, effect) {
    const base = clampInt(effect.params.baseBrightness ?? 65, 1, 100);
    const depth = clampInt(effect.params.intensity ?? 25, 0, 50);
    const brightness = clampInt(base + (Math.random() - 0.5) * 2 * depth, 1, 100);
    const payload = { on_off: 1, brightness, transition_period: 150 };
    const patch = { on: true, brightness };
    if (device.supportsColorTemperature) {
      payload.color_temp = effect.params.colorTemp ?? device.colorTemperatureRange?.min ?? 2700;
      patch.colorTemp = payload.color_temp;
    } else if (device.supportsColor) {
      payload.hue = 28;
      payload.saturation = 60;
      patch.hue = 28;
      patch.saturation = 60;
    }
    await device.lighting.setLightState(payload);
    return patch;
  }

  async _tickFire(device, effect) {
    const base = clampInt(effect.params.baseBrightness ?? 70, 1, 100);
    const depth = clampInt(effect.params.intensity ?? 40, 0, 60);
    const flare = Math.random() < 0.08;
    const brightness = flare
      ? clampInt(base + depth + Math.random() * 15, 1, 100)
      : clampInt(base + (Math.random() - 0.5) * 2 * depth, 1, 100);
    const payload = { on_off: 1, brightness, transition_period: 100 };
    const patch = { on: true, brightness };
    if (device.supportsColorTemperature) {
      payload.color_temp = effect.params.colorTemp ?? device.colorTemperatureRange?.min ?? 2700;
      patch.colorTemp = payload.color_temp;
    } else if (device.supportsColor) {
      payload.hue = 18;
      payload.saturation = 75;
      patch.hue = 18;
      patch.saturation = 75;
    }
    await device.lighting.setLightState(payload);
    return patch;
  }

  /** Rapid, mostly-dark camera-flash bursts — a single bright tick, then straight back down. */
  async _tickPaparazzi(device, effect) {
    const { value } = nextBurstValue(effect, [100]);
    await device.lighting.setLightState({ on_off: value > 0 ? 1 : 0, brightness: Math.max(value, 1), transition_period: 0 });
    return { on: value > 0, brightness: value };
  }

  /** Colorful bursts that bloom then fade, each burst picking a fresh hue if the bulb supports color. */
  async _tickFireworks(device, effect) {
    const { value, triggered } = nextBurstValue(effect, [100, 55, 20]);
    const payload = { on_off: value > 0 ? 1 : 0, brightness: Math.max(value, 1), transition_period: 0 };
    const patch = { on: value > 0, brightness: value };
    if (device.supportsColor) {
      if (triggered) effect.burstHue = Math.floor(Math.random() * 360);
      const base = clampInt(effect.params.baseBrightness ?? 4, 0, 100);
      if (effect.burstHue != null && value > base) {
        payload.hue = effect.burstHue;
        payload.saturation = 100;
        patch.hue = effect.burstHue;
        patch.saturation = 100;
      }
    }
    await device.lighting.setLightState(payload);
    return patch;
  }

  /** Steady bulb that occasionally glitches: a brief dim/blackout dip, then straight back to normal. */
  async _tickFaultyBulb(device, effect) {
    const base = clampInt(effect.params.baseBrightness ?? 85, 1, 100);
    const chance = clampInt(effect.params.chance ?? 12, 0, 100) / 100;
    const burst = effect.burst ?? (effect.burst = { queue: [] });
    let brightness;
    if (burst.queue.length) {
      brightness = burst.queue.shift();
    } else if (Math.random() < chance) {
      burst.queue = [base];
      brightness = Math.random() < 0.15 ? 0 : Math.round(Math.random() * 30);
    } else {
      brightness = base;
    }
    await device.lighting.setLightState({
      on_off: brightness > 0 ? 1 : 0,
      brightness: Math.max(brightness, 1),
      transition_period: 0,
    });
    return { on: brightness > 0, brightness };
  }

  /** Mostly dark with rare bright cool-white strikes, occasionally a quick double-flash. */
  async _tickLightning(device, effect) {
    const base = clampInt(effect.params.baseBrightness ?? 3, 0, 100);
    const chance = clampInt(effect.params.chance ?? 6, 0, 100) / 100;
    const burst = effect.burst ?? (effect.burst = { queue: [] });
    let brightness;
    let flashing;
    if (burst.queue.length) {
      brightness = burst.queue.shift();
      flashing = brightness > 50;
    } else if (Math.random() < chance) {
      burst.queue = Math.random() < 0.4 ? [10, 100, base] : [base];
      brightness = 100;
      flashing = true;
    } else {
      brightness = base;
      flashing = false;
    }
    const payload = { on_off: 1, brightness: Math.max(brightness, 1), transition_period: 0 };
    const patch = { on: true, brightness };
    if (flashing) {
      if (device.supportsColorTemperature) {
        payload.color_temp = device.colorTemperatureRange?.max ?? 6500;
        patch.colorTemp = payload.color_temp;
      } else if (device.supportsColor) {
        payload.hue = 215;
        payload.saturation = 15;
        patch.hue = 215;
        patch.saturation = 15;
      }
    }
    await device.lighting.setLightState(payload);
    return patch;
  }

  /** Fast, chaotic brightness (and occasional tint) jitter mimicking a television's glow. */
  async _tickTv(device, effect) {
    const base = clampInt(effect.params.baseBrightness ?? 80, 1, 100);
    const variance = clampInt(effect.params.intensity ?? 25, 0, 60);
    const brightness = clampInt(base + (Math.random() - 0.5) * 2 * variance, 1, 100);
    const payload = { on_off: 1, brightness, transition_period: 0 };
    const patch = { on: true, brightness };
    if (Math.random() < 0.25) {
      if (device.supportsColorTemperature) {
        const range = device.colorTemperatureRange;
        const t = range ? clampInt(4500 + Math.random() * (range.max - 4500), range.min, range.max) : 5000;
        payload.color_temp = t;
        patch.colorTemp = t;
      } else if (device.supportsColor) {
        payload.hue = 200 + Math.round(Math.random() * 40);
        payload.saturation = 10 + Math.round(Math.random() * 15);
        patch.hue = payload.hue;
        patch.saturation = payload.saturation;
      }
    }
    await device.lighting.setLightState(payload);
    return patch;
  }

  /** A single sudden bright burst that decays away, then quiet until the next one. */
  async _tickExplosion(device, effect) {
    const { value } = nextBurstValue(effect, [100, 65, 30, 10]);
    await device.lighting.setLightState({ on_off: value > 0 ? 1 : 0, brightness: Math.max(value, 1), transition_period: 0 });
    return { on: value > 0, brightness: value };
  }

  /** Near-continuous intense cool-white flicker with sharp dips, like an arc welder. */
  async _tickWelding(device, effect) {
    const base = clampInt(effect.params.baseBrightness ?? 90, 1, 100);
    const chance = clampInt(effect.params.chance ?? 15, 0, 100) / 100;
    const dip = Math.random() < chance;
    const brightness = dip
      ? clampInt(15 + Math.random() * 15, 1, 100)
      : clampInt(base - Math.random() * 10, 1, 100);
    const payload = { on_off: 1, brightness, transition_period: 0 };
    const patch = { on: true, brightness };
    if (device.supportsColorTemperature) {
      payload.color_temp = device.colorTemperatureRange?.max ?? 6500;
      patch.colorTemp = payload.color_temp;
    } else if (device.supportsColor) {
      payload.hue = 210;
      payload.saturation = 20;
      patch.hue = 210;
      patch.saturation = 20;
    }
    await device.lighting.setLightState(payload);
    return patch;
  }

  /** Alternating red/blue at full brightness, like an emergency light bar. */
  async _tickCopCar(device, effect) {
    effect.phase = effect.phase ? 0 : 1;
    const hue = effect.phase ? 0 : 230;
    await device.lighting.setLightState({ on_off: 1, hue, saturation: 100, brightness: 100, transition_period: 0 });
    return { on: true, hue, saturation: 100, brightness: 100 };
  }

  /** Continuous random hue jumps at full brightness/saturation, like a dance-floor color light. */
  async _tickPartyLights(device, effect) {
    const hue = Math.floor(Math.random() * 360);
    await device.lighting.setLightState({ on_off: 1, hue, saturation: 100, brightness: 100, transition_period: 120 });
    return { on: true, hue, saturation: 100, brightness: 100 };
  }

  /** Strobe on/off, picking a fresh random color for every "on" pulse. */
  async _tickClubLights(device, effect) {
    effect.phase = effect.phase ? 0 : 1;
    if (effect.phase) effect.clubHue = Math.floor(Math.random() * 360);
    const payload = { on_off: effect.phase, brightness: 100, transition_period: 0 };
    const patch = { on: !!effect.phase, brightness: 100 };
    if (effect.phase && device.supportsColor) {
      payload.hue = effect.clubHue;
      payload.saturation = 100;
      patch.hue = effect.clubHue;
      patch.saturation = 100;
    }
    await device.lighting.setLightState(payload);
    return patch;
  }
}
