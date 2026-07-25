import express from 'express';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { KasaManager } from './kasa.js';
import { Store } from './store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 4173;

const store = new Store();
const manager = new KasaManager(store);
manager.startDiscovery();

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public')));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

function stateSnapshot() {
  return { devices: manager.listSnapshots(), groups: store.listGroups() };
}

let broadcastTimer = null;
function broadcastState() {
  const payload = JSON.stringify({ type: 'state', ...stateSnapshot() });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}
function scheduleBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    broadcastState();
  }, 150);
}

manager.on('change', scheduleBroadcast);
manager.on('error', (err) => console.error('[kasa]', err?.message ?? err));

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'state', ...stateSnapshot() }));
});

function asyncRoute(handler) {
  return (req, res) => {
    handler(req, res).catch((err) => {
      res.status(400).json({ error: err.message });
    });
  };
}

// --- devices ---

app.get(
  '/api/state',
  asyncRoute(async (_req, res) => {
    res.json(stateSnapshot());
  }),
);

app.post(
  '/api/discover',
  asyncRoute(async (_req, res) => {
    manager.rescan();
    res.status(202).json({ ok: true });
  }),
);

app.post(
  '/api/devices/:id/power',
  asyncRoute(async (req, res) => {
    await manager.setPower(req.params.id, !!req.body.on);
    res.json(manager.getSnapshot(req.params.id));
  }),
);

app.post(
  '/api/devices/:id/brightness',
  asyncRoute(async (req, res) => {
    await manager.setBrightness(req.params.id, req.body.value);
    res.json(manager.getSnapshot(req.params.id));
  }),
);

app.post(
  '/api/devices/:id/color',
  asyncRoute(async (req, res) => {
    await manager.setColor(req.params.id, { hue: req.body.hue, saturation: req.body.saturation });
    res.json(manager.getSnapshot(req.params.id));
  }),
);

app.post(
  '/api/devices/:id/color-temp',
  asyncRoute(async (req, res) => {
    await manager.setColorTemp(req.params.id, req.body.kelvin);
    res.json(manager.getSnapshot(req.params.id));
  }),
);

app.post(
  '/api/devices/:id/state',
  asyncRoute(async (req, res) => {
    await manager.setState(req.params.id, req.body);
    res.json(manager.getSnapshot(req.params.id));
  }),
);

app.post(
  '/api/devices/:id/identify',
  asyncRoute(async (req, res) => {
    await manager.identify(req.params.id);
    res.json(manager.getSnapshot(req.params.id));
  }),
);

app.post(
  '/api/devices/:id/effect',
  asyncRoute(async (req, res) => {
    manager.startEffect(req.params.id, req.body.type, req.body.params ?? {});
    res.json(manager.getSnapshot(req.params.id));
  }),
);

app.delete(
  '/api/devices/:id/effect',
  asyncRoute(async (req, res) => {
    await manager.stopEffect(req.params.id, { restore: req.query.restore !== 'false' });
    res.json(manager.getSnapshot(req.params.id));
  }),
);

app.patch(
  '/api/devices/:id/label',
  asyncRoute(async (req, res) => {
    const meta = store.setLabel(req.params.id, req.body.label ?? '');
    broadcastState();
    res.json(meta);
  }),
);

app.patch(
  '/api/devices/:id/groups',
  asyncRoute(async (req, res) => {
    const meta = store.setDeviceGroups(req.params.id, req.body.groupIds ?? []);
    broadcastState();
    res.json(meta);
  }),
);

// --- groups ---

app.get(
  '/api/groups',
  asyncRoute(async (_req, res) => {
    res.json(store.listGroups());
  }),
);

app.post(
  '/api/groups',
  asyncRoute(async (req, res) => {
    const group = store.createGroup(req.body.name);
    broadcastState();
    res.status(201).json(group);
  }),
);

app.patch(
  '/api/groups/:id',
  asyncRoute(async (req, res) => {
    const group = store.renameGroup(req.params.id, req.body.name);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    broadcastState();
    res.json(group);
  }),
);

app.delete(
  '/api/groups/:id',
  asyncRoute(async (req, res) => {
    store.deleteGroup(req.params.id);
    broadcastState();
    res.json({ ok: true });
  }),
);

app.post(
  '/api/groups/:id/state',
  asyncRoute(async (req, res) => {
    const deviceIds = store.devicesInGroup(req.params.id);
    const results = await Promise.allSettled(deviceIds.map((id) => manager.setState(id, req.body)));
    const failed = results.filter((r) => r.status === 'rejected').length;
    res.json({ ok: true, applied: deviceIds.length - failed, failed });
  }),
);

app.post(
  '/api/groups/:id/effect',
  asyncRoute(async (req, res) => {
    const deviceIds = store.devicesInGroup(req.params.id);
    let applied = 0;
    let failed = 0;
    for (const id of deviceIds) {
      try {
        manager.startEffect(id, req.body.type, req.body.params ?? {});
        applied += 1;
      } catch {
        failed += 1;
      }
    }
    res.json({ ok: true, applied, failed });
  }),
);

app.delete(
  '/api/groups/:id/effect',
  asyncRoute(async (req, res) => {
    const deviceIds = store.devicesInGroup(req.params.id);
    await Promise.allSettled(deviceIds.map((id) => manager.stopEffect(id, { restore: req.query.restore !== 'false' })));
    res.json({ ok: true });
  }),
);

function lanAddresses() {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

httpServer.listen(PORT, () => {
  console.log(`Kasa Studio console running at http://localhost:${PORT}`);
  for (const address of lanAddresses()) {
    console.log(`  on your network (e.g. from a phone): http://${address}:${PORT}`);
  }
});

function shutdown() {
  manager.shutdown();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
