import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DATA_FILE = join(DATA_DIR, 'store.json');

const EMPTY_STATE = { devices: {}, groups: {}, presets: {} };

export class Store {
  constructor() {
    this.state = this.load();
  }

  load() {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    if (!existsSync(DATA_FILE)) {
      writeFileSync(DATA_FILE, JSON.stringify(EMPTY_STATE, null, 2));
      return structuredClone(EMPTY_STATE);
    }
    try {
      const raw = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
      return { ...structuredClone(EMPTY_STATE), ...raw };
    } catch {
      return structuredClone(EMPTY_STATE);
    }
  }

  save() {
    writeFileSync(DATA_FILE, JSON.stringify(this.state, null, 2));
  }

  // --- device metadata (label, group membership) ---

  getDeviceMeta(deviceId) {
    return this.state.devices[deviceId] ?? { label: null, groupIds: [] };
  }

  setLabel(deviceId, label) {
    const meta = this.state.devices[deviceId] ?? { label: null, groupIds: [] };
    meta.label = label && label.trim() ? label.trim() : null;
    this.state.devices[deviceId] = meta;
    this.save();
    return meta;
  }

  setDeviceGroups(deviceId, groupIds) {
    const meta = this.state.devices[deviceId] ?? { label: null, groupIds: [] };
    meta.groupIds = [...new Set(groupIds)].filter((id) => this.state.groups[id]);
    this.state.devices[deviceId] = meta;
    this.save();
    return meta;
  }

  forgetDevice(deviceId) {
    delete this.state.devices[deviceId];
    this.save();
  }

  // --- groups ---

  listGroups() {
    return Object.values(this.state.groups).sort((a, b) => a.order - b.order);
  }

  createGroup(name) {
    const id = nanoid(10);
    const order = Object.keys(this.state.groups).length;
    this.state.groups[id] = { id, name: name?.trim() || 'New Group', order };
    this.save();
    return this.state.groups[id];
  }

  renameGroup(id, name) {
    if (!this.state.groups[id]) return null;
    this.state.groups[id].name = name?.trim() || this.state.groups[id].name;
    this.save();
    return this.state.groups[id];
  }

  deleteGroup(id) {
    delete this.state.groups[id];
    for (const meta of Object.values(this.state.devices)) {
      meta.groupIds = (meta.groupIds ?? []).filter((g) => g !== id);
    }
    this.save();
  }

  addDeviceToGroup(deviceId, groupId) {
    if (!this.state.groups[groupId]) return null;
    const meta = this.state.devices[deviceId] ?? { label: null, groupIds: [] };
    if (!meta.groupIds.includes(groupId)) meta.groupIds.push(groupId);
    this.state.devices[deviceId] = meta;
    this.save();
    return meta;
  }

  removeDeviceFromGroup(deviceId, groupId) {
    const meta = this.state.devices[deviceId];
    if (!meta) return null;
    meta.groupIds = meta.groupIds.filter((g) => g !== groupId);
    this.save();
    return meta;
  }

  devicesInGroup(groupId) {
    return Object.entries(this.state.devices)
      .filter(([, meta]) => meta.groupIds?.includes(groupId))
      .map(([deviceId]) => deviceId);
  }
}
