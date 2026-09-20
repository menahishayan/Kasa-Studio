// Standalone-appliance networking: manages the Pi's self-hosted Wi-Fi access
// point (for Kasa bulbs + control-panel clients) via NetworkManager, and the
// mDNS hostname (via avahi/hostnamectl) that lets people reach this app by
// name instead of an IP address. Everything shells out to `sudo nmcli` /
// `sudo hostnamectl`, which is why the service account needs passwordless
// sudo for those two binaries (see deploy/README.md).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const AP_CON_NAME = 'kasa-studio-ap';
const AP_IFACE = process.env.KASA_AP_IFACE || 'wlan0';
const WAN_IFACE = process.env.KASA_WAN_IFACE || 'eth0';

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

class NetworkError extends Error {}

async function run(cmd, args) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 15000 });
    return stdout;
  } catch (err) {
    const detail = err.stderr?.trim() || err.message;
    throw new NetworkError(`${cmd} ${args.join(' ')} failed: ${detail}`);
  }
}
const nmcli = (...args) => run('sudo', ['nmcli', ...args]);
const hostnamectl = (...args) => run('sudo', ['hostnamectl', ...args]);

export function validateHostname(name) {
  if (typeof name !== 'string' || !HOSTNAME_RE.test(name)) {
    throw new NetworkError(
      'Hostname must be 1-63 characters, lowercase letters/digits/hyphens only, and cannot start or end with a hyphen.',
    );
  }
  return name;
}

export function validateSsid(ssid) {
  if (typeof ssid !== 'string' || ssid.trim().length < 1 || ssid.length > 32) {
    throw new NetworkError('Wi-Fi network name must be 1-32 characters.');
  }
  return ssid.trim();
}

export function validatePassword(password) {
  if (password === '' || password == null) return '';
  if (typeof password !== 'string' || password.length < 8 || password.length > 63) {
    throw new NetworkError('Wi-Fi password must be empty (open network) or 8-63 characters.');
  }
  return password;
}

/** Idempotently ensures the AP connection profile exists with the given ssid/password. */
async function ensureApProfile(ssid, password) {
  const exists = await nmcli('-t', '-f', 'NAME', 'connection', 'show')
    .then((out) => out.split('\n').includes(AP_CON_NAME))
    .catch(() => false);

  if (!exists) {
    await nmcli(
      'connection',
      'add',
      'type',
      'wifi',
      'ifname',
      AP_IFACE,
      'con-name',
      AP_CON_NAME,
      'autoconnect',
      'no',
      'save',
      'yes',
      'ssid',
      ssid,
    );
  }

  const modifyArgs = [
    'connection',
    'modify',
    AP_CON_NAME,
    '802-11-wireless.ssid',
    ssid,
    '802-11-wireless.mode',
    'ap',
    '802-11-wireless.band',
    'bg',
    'ipv4.method',
    'shared',
    'ipv6.method',
    'ignore',
    'connection.interface-name',
    AP_IFACE,
  ];
  await nmcli(...modifyArgs);

  if (password) {
    await nmcli(
      'connection',
      'modify',
      AP_CON_NAME,
      '802-11-wireless-security.key-mgmt',
      'wpa-psk',
      '802-11-wireless-security.psk',
      password,
      '802-11-wireless-security.proto',
      'rsn',
      // Disables PMF/WPA-PSK-SHA256 negotiation. NetworkManager otherwise
      // auto-adds the SHA256 variant, which the Pi's onboard Wi-Fi chip
      // (brcmfmac) fails to bring up in AP mode ("Hotspot network creation
      // took too long, failing activation").
      '802-11-wireless-security.pmf',
      '1',
    );
  } else {
    // Open network: drop the security setting entirely.
    await nmcli('connection', 'modify', AP_CON_NAME, '-802-11-wireless-security.key-mgmt').catch(() => {});
  }
}

export async function applyApState({ enabled, ssid, password }) {
  const cleanSsid = validateSsid(ssid);
  const cleanPassword = validatePassword(password);
  await ensureApProfile(cleanSsid, cleanPassword);
  await nmcli('connection', 'modify', AP_CON_NAME, 'autoconnect', enabled ? 'yes' : 'no');
  if (enabled) {
    await nmcli('connection', 'up', AP_CON_NAME).catch((err) => {
      throw new NetworkError(
        `Could not bring up the access point (${err.message}). If this device is connected over the same Wi-Fi radio, bringing up the AP will drop that connection — reconnect via Ethernet or the new "${cleanSsid}" network.`,
      );
    });
  } else {
    await nmcli('connection', 'down', AP_CON_NAME).catch(() => {});
  }
}

export async function restartAp({ ssid, password }) {
  await applyApState({ enabled: false, ssid, password });
  await applyApState({ enabled: true, ssid, password });
}

export async function setHostname(hostname) {
  const clean = validateHostname(hostname);
  await hostnamectl('set-hostname', clean);
  await run('sudo', ['sed', '-i', `s/^127\\.0\\.1\\.1.*/127.0.1.1\t${clean}/`, '/etc/hosts']).catch(() => {});
  await run('sudo', ['systemctl', 'restart', 'avahi-daemon']).catch(() => {});
  return clean;
}

async function apStatus() {
  const active = await nmcli('-t', '-f', 'NAME,DEVICE', 'connection', 'show', '--active')
    .then((out) =>
      out
        .split('\n')
        .filter(Boolean)
        .some((line) => line.startsWith(`${AP_CON_NAME}:`)),
    )
    .catch(() => false);

  let ssid = null;
  let hasPassword = false;
  try {
    const fields = await nmcli(
      '-t',
      '-g',
      '802-11-wireless.ssid,802-11-wireless-security.key-mgmt',
      'connection',
      'show',
      AP_CON_NAME,
    );
    const [rawSsid, keyMgmt] = fields.trim().split(':');
    ssid = rawSsid || null;
    hasPassword = !!keyMgmt;
  } catch {
    // profile doesn't exist yet — no configuration applied so far
  }

  return { active, ssid, hasPassword };
}

async function wanStatus() {
  try {
    const out = await run('nmcli', ['-t', '-f', 'DEVICE,STATE,CONNECTION', 'device', 'status']);
    const line = out.split('\n').find((l) => l.startsWith(`${WAN_IFACE}:`));
    if (!line) return { connected: false };
    const [, deviceState] = line.split(':');
    return { connected: deviceState === 'connected' };
  } catch {
    return { connected: false };
  }
}

export async function getStatus() {
  const [ap, wan, hostnameOut] = await Promise.all([
    apStatus(),
    wanStatus(),
    run('hostnamectl', ['--static']).catch(() => ''),
  ]);
  return {
    ap,
    wan,
    hostname: hostnameOut.trim() || null,
  };
}
