/**
 * scrypted-dynamic-birdseye (seamless-first, defensive)
 *
 * - Dynamic single-stream virtual camera that switches to the most relevant camera
 *   based on ObjectDetector events with EMA + priorities + hysteresis + backoff.
 * - Defensive against SDK/API shape differences across Scrypted versions.
 * - Compatible with scrypted-webpack/ts-loader Node16+ module semantics.
 *
 * UI goals:
 * - Monitored Cameras: dropdown of devices that look like they can emit detections.
 * - Default Camera: dropdown of actual video cameras.
 * - If default is empty but monitored has at least one video camera, auto-pick the first one.
 */

import {
  ScryptedDeviceBase,
  DeviceProvider,
  VideoCamera,
  MediaObject,
  ScryptedInterface,
  ScryptedDeviceType,
  Setting,
  Settings,
  RequestMediaStreamOptions,
  ResponseMediaStreamOptions,
} from '@scrypted/sdk';

/* --------------------------------- Globals --------------------------------- */
/**
 * Do NOT capture these once at module load. Always read them from globalThis
 * so calls coming from other plugins (prebuffer, rebroadcast, etc.) see
 * the real managers.
 */
function getDeviceManager() {
  return (globalThis as any).deviceManager;
}
function getSystemManager() {
  return (globalThis as any).systemManager;
}
function getEndpointManager() {
  return (globalThis as any).endpointManager;
}
function getMediaManager() {
  return (globalThis as any).mediaManager;
}

function now() {
  return Date.now();
}

/* --------------------------------- Consts ---------------------------------- */

const NATIVE_ID = 'dynamic-birdseye-v2';

const EMA_STORAGE_KEY = 'emaMap_v2';
const FAILED_LISTENERS_KEY = 'failedListeners_v2';
const ERROR_LOG_KEY = 'errorLog_v2';

const ENDPOINT_PATH_KEY = 'rebroadcastPath_v2';
const ENDPOINT_AUTH_PATH_KEY = 'rebroadcastAuthPath_v2';
const REBROADCAST_DEVICE_KEY = 'rebroadcastDevice_v2';

const MAX_ERROR_LOG = 200;
const DEFAULT_RETRY_INTERVAL_MS = 60_000;
const DEFAULT_ENDPOINT_REFRESH_MS = 3_600_000;

// bump to 1080p
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
// 2 Mbps target
const DEFAULT_BITRATE = 2_000_000;

const DETECTION_CLASS_PRESETS = ['person', 'vehicle', 'person,vehicle', 'package'];

/* --------------------------------- Types ----------------------------------- */

type ObjectsDetected = {
  detections?: Array<{ className?: string; score?: number; [k: string]: any }>;
  [k: string]: any;
};

type ActiveDetection = {
  cameraId: string;
  cameraName: string;
  rawScore: number;
  emaScore: number;
  timestamp: number;
  finalScore: number;
};

type SimpleStorage = {
  getItem(key: string): string | null | undefined;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
};

type TimeoutHandle = ReturnType<typeof setTimeout>;

type NormalizedDeviceInfo = {
  id: string;
  name: string;
  type?: string;
  interfaces: string[];
};

/* ------------------------------ HTTP helpers ------------------------------- */

function writeStatus(res: any, code: number) {
  try {
    if ('statusCode' in (res || {})) {
      (res as any).statusCode = code;
    } else if (typeof res?.writeHead === 'function') {
      res.writeHead(code);
    }
  } catch {
    // ignore
  }
}

function sendBody(res: any, body: string) {
  try {
    if (typeof res?.send === 'function') {
      res.send(body);
      return;
    }
  } catch {}
  try {
    if (typeof res?.end === 'function') {
      res.end(body);
      return;
    }
  } catch {}
}

function sendJSON(res: any, code: number, obj: any) {
  try {
    if (res?.setHeader) res.setHeader('content-type', 'application/json');
  } catch {}
  writeStatus(res, code);
  sendBody(res, JSON.stringify(obj));
}

function redirect(res: any, url: string) {
  writeStatus(res, 302);
  try {
    if (res?.setHeader) res.setHeader('location', url);
  } catch {}
  sendBody(res, '');
}

/* ------------------------- System/device helpers --------------------------- */

function getSystemState(): any {
  const sm = getSystemManager();
  try {
    return sm?.getSystemState ? sm.getSystemState() : {};
  } catch {
    return {};
  }
}

function normalizeDeviceEntry(id: string, entry: any): NormalizedDeviceInfo {
  const name =
    (entry?.name && typeof entry.name === 'object' && 'value' in entry.name ? entry.name.value : entry?.name) ||
    id;
  const type =
    (entry?.type && typeof entry.type === 'object' && 'value' in entry.type ? entry.type.value : entry?.type) ||
    undefined;
  let interfaces: string[] = [];
  const rawIfaces = entry?.interfaces?.value ?? entry?.interfaces;
  if (Array.isArray(rawIfaces)) {
    interfaces = rawIfaces.slice();
  } else if (rawIfaces && typeof rawIfaces === 'object') {
    interfaces = Object.keys(rawIfaces);
  }
  return { id, name, type, interfaces };
}

function listSystemDevices(): NormalizedDeviceInfo[] {
  const sys = getSystemState();
  const out: NormalizedDeviceInfo[] = [];
  for (const [id, entry] of Object.entries<any>(sys || {})) {
    out.push(normalizeDeviceEntry(id, entry));
  }
  return out;
}

/**
 * Robustly get interfaces for a device id.
 * Tries live device first, then system state.
 */
function getDeviceInterfaces(id: string): string[] {
  const sm = getSystemManager();
  const dev = sm?.getDeviceById?.(id);
  const live = (dev as any)?.interfaces;
  if (Array.isArray(live)) return live;
  if (live && typeof live === 'object') return Object.keys(live);

  const state = getSystemState();
  const entry = state?.[id];
  if (entry?.interfaces) {
    const raw = entry.interfaces.value ?? entry.interfaces;
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object') return Object.keys(raw);
  }

  return [];
}

function parseDeviceChoice(v: string): string {
  const m = /\(([^)]+)\)$/.exec(v);
  if (m && m[1]) {
    return m[1];
  }
  return v;
}

/* =============================== Provider ================================== */

class DynamicCameraProvider extends ScryptedDeviceBase implements DeviceProvider {
  private deviceInstance: BirdseyeDevice | undefined;

  constructor(nativeId?: string) {
    super(nativeId);
    this.discoverDevice().catch((e) => console.warn('onDeviceDiscovered error', e));
  }

  private async discoverDevice() {
    try {
      const dm = getDeviceManager();
      if (!dm?.onDeviceDiscovered) {
        if (dm?.onDevicesChanged) {
          await dm.onDevicesChanged({
            devices: [
              {
                nativeId: NATIVE_ID,
                name: 'Dynamic Birdseye',
                interfaces: [ScryptedInterface.VideoCamera, ScryptedInterface.Settings],
                type: ScryptedDeviceType.Camera,
              },
            ],
          });
        }
        return;
      }
      await dm.onDeviceDiscovered({
        nativeId: NATIVE_ID,
        name: 'Dynamic Birdseye',
        interfaces: [ScryptedInterface.VideoCamera, ScryptedInterface.Settings],
        type: ScryptedDeviceType.Camera,
      });
    } catch (e) {
      console.warn('onDeviceDiscovered error', e);
    }
  }

  async getDevice(nativeId: string) {
    if (nativeId !== NATIVE_ID) return undefined;
    if (!this.deviceInstance) this.deviceInstance = new BirdseyeDevice(nativeId);
    return this.deviceInstance;
  }

  async releaseDevice(_id: string, nativeId: string) {
    if (nativeId !== NATIVE_ID) return;
    if (this.deviceInstance) {
      await this.deviceInstance.shutdown();
      this.deviceInstance = undefined;
    }
  }

  async onRequest(request: any, response: any) {
    try {
      const dev = (await this.getDevice(NATIVE_ID)) as BirdseyeDevice | undefined;
      if (!dev) {
        sendJSON(response, 500, { error: 'device not available' });
        return;
      }

      const urlString: string = request?.url || '/';
      const u = new URL(urlString, 'http://scrypted.local');
      const path = (u.pathname || '/').replace(/^\/+/, '');
      const query = Object.fromEntries(u.searchParams.entries());

      if (path === '' || path.startsWith('status')) {
        let devicePath = '';
        try {
          const em = getEndpointManager();
          if (em?.getAuthenticatedPath) devicePath = await em.getAuthenticatedPath(NATIVE_ID);
          else if (em?.getPath) devicePath = await em.getPath(NATIVE_ID);
        } catch {}
        sendJSON(response, 200, { devicePath, telemetry: dev.getTelemetry() });
        return;
      }

      if (path.startsWith('rebroadcast')) {
        try {
          const r = await dev.getRebroadcastRedirectUrl();
          if (query['json'] === '1' || query['json'] === 'true') {
            sendJSON(response, 200, { url: r.url });
            return;
          }
          if (r.url) {
            redirect(response, r.url);
            return;
          }
          sendJSON(response, 502, { error: 'no media url' });
          return;
        } catch (e: any) {
          sendJSON(response, 500, { error: String(e?.message || e) });
          return;
        }
      }

      sendJSON(response, 404, { error: 'not found' });
    } catch (e: any) {
      sendJSON(response, 500, { error: String(e?.message || e) });
    }
  }
}

/* ============================== Device ===================================== */

class BirdseyeDevice extends ScryptedDeviceBase implements VideoCamera, Settings {
  private listeners: any[] = [];
  private activeDetections: Map<string, ActiveDetection> = new Map();

  private emaMap: { [id: string]: number } = {};
  private emaPersistTimer: TimeoutHandle | undefined;
  private emaPersistDebounceMs = 4_000;

  private monitoredCameraIds: string[] = [];
  private defaultCameraId: string | undefined;

  private detectionClasses: string[] = ['person', 'vehicle'];
  private detectionEMAAlpha = 0.4;
  private hysteresisPercent = 0.2;
  private minScoreThreshold = 0.15;

  private idleTimeoutMs = 30_000;
  private detectionTtlMs = 45_000;
  private minSwitchDurationMs = 10_000;

  private codecPreference: 'auto' | 'h264' | 'h265' = 'auto';
  private cameraPriorities: { [id: string]: number } = {};

  private autoDetectObjectDetectors = true;
  private prebufferMs = 3000;

  private failedListenerIds: string[] = [];

  private persistedEndpointPath: string | undefined;
  private persistedEndpointAuthPath: string | undefined;

  private retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS;
  private retryTimer: TimeoutHandle | undefined;
  private endpointRefreshIntervalMs = DEFAULT_ENDPOINT_REFRESH_MS;
  private endpointRefreshTimer: TimeoutHandle | undefined;
  private idleTimer: TimeoutHandle | undefined;

  private errorLog: Array<{ ts: number; message: string; ctx?: any }> = [];

  private autoCreateRebroadcast = false;
  private rebroadcastDeviceId: string | undefined;

  private lastSwitchTimestamp = 0;
  private currentActiveCameraId: string | undefined;

  constructor(nativeId?: string) {
    super(nativeId);
    this.safeInit();
  }

  private normalizeDetectionClasses(list: Array<string>): string[] {
    const normalized = list
      .map((entry) => (typeof entry === 'string' ? entry.trim().toLowerCase() : ''))
      .filter((entry) => !!entry);

    const unique: string[] = [];
    const seen = new Set<string>();
    for (const entry of normalized) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      unique.push(entry);
    }

    return unique.length ? unique : ['person', 'vehicle'];
  }

  private applyDetectionClassesFromInput(value: any): void {
    let incoming: string[] = [];
    if (Array.isArray(value)) {
      incoming = value.map((v) => String(v));
    } else if (typeof value === 'string') {
      incoming = value.split(',');
    } else if (value !== undefined && value !== null) {
      incoming = [String(value)];
    } else {
      incoming = this.detectionClasses.slice();
    }

    const normalized = this.normalizeDetectionClasses(incoming);
    this.detectionClasses = normalized;
    try {
      (this as any).storage.setItem('detectionClasses', JSON.stringify(this.detectionClasses));
    } catch (e) {
      this.logError('applyDetectionClasses', e);
    }
  }

  /* ------------------------------ Lifecycle -------------------------------- */

  private safeInit() {
    try {
      this.loadConfiguration();
      this.loadPersistedEMA();
      this.scrubEmaForMissingDevices();
      this.loadFailedListeners();
      this.loadErrorLog();
      this.initializeListeners();
      if (!this.defaultCameraId && this.monitoredCameraIds?.length) {
        // pick first monitored that is actually a VideoCamera
        const firstVid = this.monitoredCameraIds.find((id) => {
          const ifaces = getDeviceInterfaces(id);
          return ifaces.includes(ScryptedInterface.VideoCamera);
        });
        this.defaultCameraId = firstVid || this.monitoredCameraIds[0];
      }
      if (!this.currentActiveCameraId) this.currentActiveCameraId = this.defaultCameraId;
      this.activeDetections.clear();
      this.resetIdleTimer();
      this.startRetryTimer();
      this.startEndpointRefreshTimer();

      if (this.autoCreateRebroadcast) {
        this.attemptCreateRebroadcast().catch((e) => this.logError('attemptCreateRebroadcast', e));
      }
    } catch (e) {
      this.logError('safeInit', e);
    }
  }

  async shutdown() {
    try {
      for (const l of this.listeners) {
        try {
          l.removeListener?.();
        } catch {}
      }
      this.listeners = [];
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = undefined;
      }
      if (this.retryTimer) {
        clearInterval(this.retryTimer);
        this.retryTimer = undefined;
      }
      if (this.endpointRefreshTimer) {
        clearInterval(this.endpointRefreshTimer);
        this.endpointRefreshTimer = undefined;
      }
      if (this.emaPersistTimer) {
        clearTimeout(this.emaPersistTimer);
        this.emaPersistTimer = undefined;
      }
      await this.persistEMA();
      this.persistFailedListeners();
      this.persistEndpointPaths().catch(() => {});
      this.persistErrorLog();
    } catch (e) {
      this.logError('shutdown', e);
    }
  }

  /* -------------------------------- Settings ------------------------------- */

  async putSetting(key: string, value: string): Promise<void> {
    await this.putSettings({ [key]: value });
  }

  async putSettings(values: { [k: string]: any }): Promise<void> {
    try {
      let needListenerRefresh = false;

      if (values['autoDetectObjectDetectors'] !== undefined) {
        this.autoDetectObjectDetectors = String(values['autoDetectObjectDetectors']) === 'true';
        (this as any).storage.setItem('autoDetectObjectDetectors', String(this.autoDetectObjectDetectors));
        needListenerRefresh = true;
      }

      // monitored cameras comes from the dropdown as names like "Front Door (123)"
      if (values['monitoredCameras'] !== undefined) {
        const raw = values['monitoredCameras'];
        let selected: string[] = [];

        if (Array.isArray(raw)) {
          selected = raw.map((s) => parseDeviceChoice(String(s))).filter(Boolean);
        } else if (typeof raw === 'string') {
          selected = raw
            .split(',')
            .map((s) => parseDeviceChoice(s.trim()))
            .filter(Boolean);
        }

        const uniqueSelected = Array.from(new Set(selected));
        const valid: string[] = [];
        for (const id of uniqueSelected) {
          if (!id) continue;
          const resolved = this.resolveDeviceId(id) || id;
          const ifaces = getDeviceInterfaces(resolved);
          if (ifaces.includes(ScryptedInterface.ObjectDetector)) {
            valid.push(resolved);
          }
        }

        this.monitoredCameraIds = Array.from(new Set(valid));
        (this as any).storage.setItem('monitoredCameras', JSON.stringify(this.monitoredCameraIds));
        needListenerRefresh = true;
        // if default is missing but we have at least one monitored, set it later below
      }

      if (values['defaultCamera'] !== undefined) {
        const raw = String(values['defaultCamera'] ?? '').trim();
        const id = raw ? parseDeviceChoice(raw) : '';
        const normalized = id ? this.resolveDeviceId(id) || id : undefined;
        if (normalized) {
          const ifaces = getDeviceInterfaces(normalized);
          const isDetector = ifaces.includes(ScryptedInterface.ObjectDetector);
          const isVideo = ifaces.includes(ScryptedInterface.VideoCamera);
          if (isDetector && isVideo) {
            if (!this.monitoredCameraIds.includes(normalized)) {
              this.monitoredCameraIds = [...this.monitoredCameraIds, normalized];
              (this as any).storage.setItem('monitoredCameras', JSON.stringify(this.monitoredCameraIds));
              needListenerRefresh = true;
            }
            this.defaultCameraId = normalized;
            (this as any).storage.setItem('defaultCamera', this.defaultCameraId);
          } else if (isDetector) {
            if (!this.monitoredCameraIds.includes(normalized)) {
              this.monitoredCameraIds = [...this.monitoredCameraIds, normalized];
              (this as any).storage.setItem('monitoredCameras', JSON.stringify(this.monitoredCameraIds));
              needListenerRefresh = true;
            }
            // keep default unset so the UI prompts for a valid video camera
            this.defaultCameraId = undefined;
            try {
              (this as any).storage.removeItem?.('defaultCamera');
            } catch {}
            if (!(this as any).storage.removeItem) {
              (this as any).storage.setItem('defaultCamera', '');
            }
          }
        } else {
          this.defaultCameraId = undefined;
          try {
            (this as any).storage.removeItem?.('defaultCamera');
          } catch {}
          if (!(this as any).storage.removeItem) {
            (this as any).storage.setItem('defaultCamera', '');
          }
        }
      }

      // ensure default is among monitored if possible
      if (
        (!this.defaultCameraId ||
          (this.monitoredCameraIds.length && !this.monitoredCameraIds.includes(this.defaultCameraId))) &&
        this.monitoredCameraIds.length
      ) {
        const firstVideo = this.monitoredCameraIds.find((id) => {
          const ifaces = getDeviceInterfaces(id);
          return ifaces.includes(ScryptedInterface.VideoCamera);
        });
        const fallback = firstVideo || this.monitoredCameraIds[0];
        this.defaultCameraId = fallback;
        (this as any).storage.setItem('defaultCamera', this.defaultCameraId);
      }

      if (!this.monitoredCameraIds.length) {
        this.defaultCameraId = undefined;
        try {
          (this as any).storage.removeItem?.('defaultCamera');
        } catch {}
        if (!(this as any).storage.removeItem) {
          (this as any).storage.setItem('defaultCamera', '');
        }
      }

      if (values['detectionClasses'] !== undefined) {
        this.applyDetectionClassesFromInput(values['detectionClasses']);
      }

      if (values['detectionClassesPreset'] !== undefined) {
        const preset = String(values['detectionClassesPreset'] || '').trim();
        if (preset) this.applyDetectionClassesFromInput(preset.split(','));
      }

      if (values['smoothingFactor'] !== undefined) {
        const n = Number(values['smoothingFactor']);
        this.detectionEMAAlpha = Number.isFinite(n) && n >= 0 && n <= 1 ? n : this.detectionEMAAlpha;
        (this as any).storage.setItem('smoothingFactor', String(this.detectionEMAAlpha));
      }

      if (values['hysteresisPercent'] !== undefined) {
        const n = Number(values['hysteresisPercent']);
        this.hysteresisPercent = Number.isFinite(n) && n >= 0 ? n : this.hysteresisPercent;
        (this as any).storage.setItem('hysteresisPercent', String(this.hysteresisPercent));
      }

      if (values['minScoreThreshold'] !== undefined) {
        const n = Number(values['minScoreThreshold']);
        this.minScoreThreshold = Number.isFinite(n) && n >= 0 ? n : this.minScoreThreshold;
        (this as any).storage.setItem('minScoreThreshold', String(this.minScoreThreshold));
      }

      if (values['idleTimeout'] !== undefined) {
        const n = Number(values['idleTimeout']);
        this.idleTimeoutMs = Number.isFinite(n) && n > 0 ? Math.floor(n) * 1000 : this.idleTimeoutMs;
        (this as any).storage.setItem('idleTimeout', String(this.idleTimeoutMs));
      }

      if (values['detectionTtl'] !== undefined) {
        const n = Number(values['detectionTtl']);
        this.detectionTtlMs = Number.isFinite(n) && n > 0 ? Math.floor(n) * 1000 : this.detectionTtlMs;
        (this as any).storage.setItem('detectionTtl', String(this.detectionTtlMs));
      }

      if (values['minSwitchDuration'] !== undefined) {
        const n = Number(values['minSwitchDuration']);
        this.minSwitchDurationMs = Number.isFinite(n) && n >= 0 ? Math.floor(n) * 1000 : this.minSwitchDurationMs;
        (this as any).storage.setItem('minSwitchDuration', String(this.minSwitchDurationMs));
      }

      if (values['codecPreference'] !== undefined) {
        const v = String(values['codecPreference'] || 'auto');
        this.codecPreference = v === 'h264' || v === 'h265' ? (v as any) : 'auto';
        (this as any).storage.setItem('codecPreference', this.codecPreference);
      }

      if (values['cameraPriorities'] !== undefined) {
        try {
          const parsed =
            typeof values['cameraPriorities'] === 'string' && values['cameraPriorities'].trim().length
              ? JSON.parse(values['cameraPriorities'])
              : values['cameraPriorities'] || {};
          const map: { [k: string]: number } = {};
          for (const k of Object.keys(parsed)) {
            const id = this.resolveDeviceId(k) || k;
            const v = Number(parsed[k]);
            map[id] = Number.isFinite(v) ? v : 1;
          }
          this.cameraPriorities = map;
          (this as any).storage.setItem('cameraPriorities', JSON.stringify(this.cameraPriorities));
        } catch (e) {
          this.logError('putSettings.cameraPriorities', e);
        }
      }

      if (values['prebufferMs'] !== undefined) {
        const n = Number(values['prebufferMs']);
        this.prebufferMs = Number.isFinite(n) && n >= 0 ? Math.floor(n) : this.prebufferMs;
        (this as any).storage.setItem('prebufferMs', String(this.prebufferMs));
      }

      if (values['autoCreateRebroadcast'] !== undefined) {
        this.autoCreateRebroadcast = String(values['autoCreateRebroadcast']) === 'true';
        (this as any).storage.setItem('autoCreateRebroadcast', String(this.autoCreateRebroadcast));
        if (this.autoCreateRebroadcast)
          this.attemptCreateRebroadcast().catch((e) => this.logError('autoCreateRebroadcast', e));
      }

      // After user changes monitored list, make sure default is sane
      if ((!this.defaultCameraId || !this.monitoredCameraIds.includes(this.defaultCameraId)) && this.monitoredCameraIds.length) {
        const vid = this.monitoredCameraIds.find((id) => this.deviceHasVideoCapability(id));
        if (vid) {
          this.defaultCameraId = vid;
          (this as any).storage.setItem('defaultCamera', this.defaultCameraId);
        }
      }

      this.loadConfiguration();
      this.scrubEmaForMissingDevices();

      if (needListenerRefresh) {
        this.initializeListeners();
      }

      this.resetIdleTimer();
      await this.persistEndpointPaths();
      try {
        this.onDeviceEvent?.(ScryptedInterface.Settings, undefined);
      } catch {}
    } catch (e) {
      this.logError('putSettings', e);
    }
  }

  async getSettings(): Promise<Setting[]> {
    try {
      const devices = listSystemDevices();
      const detectionDevices = devices.filter(
        (d) => d.id !== this.id && d.interfaces.includes(ScryptedInterface.ObjectDetector)
      );
      const objectDetectorFilter = `interface:${ScryptedInterface.ObjectDetector}`;

      const detectionSet = new Set(detectionDevices.map((d) => d.id));
      const monitoredIds = this.monitoredCameraIds.filter(Boolean);
      const monitoredInPicker = monitoredIds.filter((id) => detectionSet.has(id));
      const missingMonitored = monitoredIds.filter((id) => id && !detectionSet.has(id));

      const defaultId =
        this.defaultCameraId &&
        detectionSet.has(this.defaultCameraId) &&
        monitoredInPicker.includes(this.defaultCameraId)
          ? this.defaultCameraId
          : undefined;

      const detectionSet = new Set(detectionDevices.map((d) => d.id));
      const monitoredIds = this.monitoredCameraIds.filter(Boolean);
      const monitoredInPicker = monitoredIds.filter((id) => detectionSet.has(id));

      settings.push(
        {
          title: 'Monitored Cameras',
          key: 'monitoredCameras',
          type: 'device',
          multiple: true,
          deviceFilter: objectDetectorFilter,
          value: monitoredInPicker,
          placeholder: 'Select monitored cameras',
        },
        {
          title: 'Default Camera',
          key: 'defaultCamera',
          type: 'device',
          deviceFilter: objectDetectorFilter,
          value: defaultId || '',
          placeholder: 'Choose a default camera',
        },
        {
          title: 'Auto-detect ObjectDetector cameras',
          key: 'autoDetectObjectDetectors',
          type: 'boolean',
          value: this.autoDetectObjectDetectors,
        },
      );

      if (missingMonitored.length) {
        settings.push({
          title: '⚠️ Missing monitored cameras',
          key: 'monitoredCamerasMissing',
          type: 'string',
          readonly: true,
          description: 'These saved entries no longer expose ObjectDetector and are ignored.',
          value: missingMonitored.join(', '),
        });
      }

      // rest: detection etc.
      const normalizedDetectionString = this.detectionClasses.join(',');
      const presetValue = DETECTION_CLASS_PRESETS.find((preset) => {
        const normalizedPreset = this.normalizeDetectionClasses(preset.split(','));
        return normalizedPreset.join(',') === normalizedDetectionString;
      }) || '';

      settings.push(
        {
          title: 'Detection class preset',
          key: 'detectionClassesPreset',
          type: 'string',
          choices: DETECTION_CLASS_PRESETS,
          value: presetValue,
        },
        {
          title: 'Detection classes (comma separated)',
          key: 'detectionClasses',
          type: 'string',
          value: this.detectionClasses.join(', '),
        },
        {
          title: 'Smoothing factor (EMA alpha 0..1)',
          key: 'smoothingFactor',
          type: 'number',
          value: String(this.detectionEMAAlpha),
        },
        {
          title: 'Hysteresis percent',
          key: 'hysteresisPercent',
          type: 'number',
          value: String(this.hysteresisPercent),
        },
        {
          title: 'Min score threshold (0..1)',
          key: 'minScoreThreshold',
          type: 'number',
          value: String(this.minScoreThreshold),
        },
        {
          title: 'Idle timeout (seconds)',
          key: 'idleTimeout',
          type: 'number',
          value: String(Math.floor(this.idleTimeoutMs / 1000)),
        },
        {
          title: 'Per-detection TTL (seconds)',
          key: 'detectionTtl',
          type: 'number',
          value: String(Math.floor(this.detectionTtlMs / 1000)),
        },
        {
          title: 'Min switch duration (seconds)',
          key: 'minSwitchDuration',
          type: 'number',
          value: String(Math.floor(this.minSwitchDurationMs / 1000)),
        },
        {
          title: 'Video codec preference',
          key: 'codecPreference',
          type: 'string',
          value: this.codecPreference,
          description: 'auto|h264|h265',
        },
        {
          title: 'Prebuffer (ms, hint)',
          key: 'prebufferMs',
          type: 'number',
          value: String(this.prebufferMs),
        },
      );

      return settings;
    } catch (e: any) {
      this.logError('getSettings', e);
      return [
        {
          title: '⚠️ Settings Error',
          key: 'settingsError',
          type: 'string',
          readonly: true,
          value: `Failed to load settings: ${String(e?.message || e)}`,
        },
      ];
    }
  }

  /* ----------------------------- Initialization ---------------------------- */

  private normalizeDurationFromStorage(n: number | undefined, fallback: number): number {
    if (!Number.isFinite(n as number)) return fallback;
    const v = n as number;
    if (v > 0 && v < 10000) return v * 1000;
    return v;
  }

  private loadConfiguration() {
    try {
      const s = (this as any).storage as SimpleStorage;

      const monRaw = s.getItem('monitoredCameras');
      if (monRaw) {
        try {
          const parsed = JSON.parse(monRaw);
          this.monitoredCameraIds = Array.isArray(parsed)
            ? parsed
            : String(monRaw)
                .split(',')
                .map((t: string) => t.trim())
                .filter(Boolean);
        } catch {
          this.monitoredCameraIds = String(monRaw)
            .split(',')
            .map((t: string) => t.trim())
            .filter(Boolean);
        }
        if (this.monitoredCameraIds?.length) {
          this.monitoredCameraIds = this.normalizeDeviceIdList(this.monitoredCameraIds);
        }
      }

      const autoRaw = s.getItem('autoDetectObjectDetectors');
      if (autoRaw !== null && autoRaw !== undefined) this.autoDetectObjectDetectors = String(autoRaw) === 'true';
      if ((!this.monitoredCameraIds?.length) && this.autoDetectObjectDetectors) this.populateAutoDetectedCameras();

      const defaultRaw = s.getItem('defaultCamera');
      if (defaultRaw) {
        const parsedDefault = parseDeviceChoice(String(defaultRaw));
        this.defaultCameraId = parsedDefault ? this.resolveDeviceId(parsedDefault) || parsedDefault : undefined;
      }

      const classesRaw = s.getItem('detectionClasses');
      if (classesRaw) {
        try {
          const parsed = JSON.parse(classesRaw);
          if (Array.isArray(parsed)) {
            this.detectionClasses = this.normalizeDetectionClasses(parsed.map((t: any) => String(t)));
          } else if (typeof parsed === 'string') {
            this.detectionClasses = this.normalizeDetectionClasses(parsed.split(','));
          }
        } catch {
          this.detectionClasses = this.normalizeDetectionClasses(String(classesRaw).split(','));
        }
      }
      this.detectionClasses = this.normalizeDetectionClasses(this.detectionClasses);

      const smoothingRaw = s.getItem('smoothingFactor');
      if (smoothingRaw) {
        const n = Number(smoothingRaw);
        if (Number.isFinite(n) && n >= 0 && n <= 1) this.detectionEMAAlpha = n;
      }
      const hystRaw = s.getItem('hysteresisPercent');
      if (hystRaw) {
        const n = Number(hystRaw);
        if (Number.isFinite(n) && n >= 0) this.hysteresisPercent = n;
      }
      const minScoreRaw = s.getItem('minScoreThreshold');
      if (minScoreRaw) {
        const n = Number(minScoreRaw);
        if (Number.isFinite(n) && n >= 0) this.minScoreThreshold = n;
      }
      const idleRaw = s.getItem('idleTimeout');
      if (idleRaw) {
        const n = Number(idleRaw);
        this.idleTimeoutMs = this.normalizeDurationFromStorage(n, this.idleTimeoutMs);
      }
      const ttlRaw = s.getItem('detectionTtl');
      if (ttlRaw) {
        const n = Number(ttlRaw);
        this.detectionTtlMs = this.normalizeDurationFromStorage(n, this.detectionTtlMs);
      }
      const minSwitchRaw = s.getItem('minSwitchDuration');
      if (minSwitchRaw) {
        const n = Number(minSwitchRaw);
        this.minSwitchDurationMs = this.normalizeDurationFromStorage(n, this.minSwitchDurationMs);
      }

      const codecRaw = s.getItem('codecPreference');
      if (codecRaw && (codecRaw === 'h264' || codecRaw === 'h265' || codecRaw === 'auto'))
        this.codecPreference = codecRaw as any;

      const priRaw = s.getItem('cameraPriorities');
      if (priRaw) {
        try {
          const parsed = JSON.parse(priRaw);
          const out: any = {};
          for (const k of Object.keys(parsed)) {
            const id = this.resolveDeviceId(k) || k;
            const v = Number(parsed[k]);
            out[id] = Number.isFinite(v) ? v : 1;
          }
          this.cameraPriorities = out;
        } catch {
          this.cameraPriorities = {};
        }
      }

      const pPath = s.getItem(ENDPOINT_PATH_KEY);
      if (pPath) this.persistedEndpointPath = pPath;
      const pAuth = s.getItem(ENDPOINT_AUTH_PATH_KEY);
      if (pAuth) this.persistedEndpointAuthPath = pAuth;

      const autoReb = s.getItem('autoCreateRebroadcast');
      if (autoReb) this.autoCreateRebroadcast = String(autoReb) === 'true';
      const rebId = s.getItem(REBROADCAST_DEVICE_KEY);
      if (rebId) this.rebroadcastDeviceId = rebId;

      const pb = s.getItem('prebufferMs');
      if (pb) {
        const n = Number(pb);
        if (Number.isFinite(n) && n >= 0) this.prebufferMs = Math.floor(n);
      }
    } catch (e) {
      this.logError('loadConfiguration', e);
    }
  }

  private populateAutoDetectedCameras() {
    try {
      const devices = listSystemDevices();
      const ids: string[] = [];
      for (const d of devices) {
        if (d.interfaces.includes(ScryptedInterface.ObjectDetector)) {
          ids.push(d.id);
        }
      }
      if (ids.length) {
        const normalized = this.normalizeDeviceIdList(ids);
        this.monitoredCameraIds = normalized;
        (this as any).storage.setItem('monitoredCameras', JSON.stringify(normalized));
        if (!this.defaultCameraId) {
          const vid = normalized.find((id) => getDeviceInterfaces(id).includes(ScryptedInterface.VideoCamera));
          this.defaultCameraId = vid || normalized[0];
        }
      }
    } catch (e) {
      this.logError('populateAutoDetectedCameras', e);
    }
  }

  private pruneMonitoredCamerasWithoutDetectors() {
    try {
      if (!this.monitoredCameraIds?.length) return;

      const keep: string[] = [];
      let changed = false;

      for (const id of this.monitoredCameraIds) {
        if (!id) continue;
        if (this.deviceHasObjectDetector(id)) {
          keep.push(id);
          continue;
        }
        changed = true;
      }

      if (!changed) return;

      this.monitoredCameraIds = keep;
      (this as any).storage.setItem('monitoredCameras', JSON.stringify(keep));

        if (this.defaultCameraId && !keep.includes(this.defaultCameraId)) {
          if (keep.length) {
            const nextDefault = keep.find((nextId) => this.deviceHasVideoCapability(nextId));
            if (nextDefault) {
              this.defaultCameraId = nextDefault;
              (this as any).storage.setItem('defaultCamera', this.defaultCameraId);
            } else {
              this.defaultCameraId = undefined;
              try {
                (this as any).storage.removeItem?.('defaultCamera');
              } catch {}
              if (!(this as any).storage.removeItem) {
                (this as any).storage.setItem('defaultCamera', '');
              }
            }
          } else {
            this.defaultCameraId = undefined;
            try {
              (this as any).storage.removeItem?.('defaultCamera');
            } catch {}
            if (!(this as any).storage.removeItem) {
              (this as any).storage.setItem('defaultCamera', '');
            }
          }
        }
    } catch (e) {
      this.logError('pruneMonitoredCamerasWithoutDetectors', e);
    }
  }

  private initializeListeners() {
    try {
      for (const l of this.listeners) {
        try {
          l.removeListener?.();
        } catch {}
      }
    } finally {
      this.listeners = [];
    }
    this.failedListenerIds = [];

    if ((!this.monitoredCameraIds?.length) && this.autoDetectObjectDetectors) {
      this.populateAutoDetectedCameras();
    }

    if (!this.monitoredCameraIds?.length) {
      this.persistFailedListeners();
      return;
    }

    const sm = getSystemManager();

    for (const id of this.monitoredCameraIds) {
      try {
        // don’t pre-check interfaces; just try to listen
        const listener = sm?.listenDevice?.(
          id,
          ScryptedInterface.ObjectDetector,
          (source: any, details: any, data: any) => {
            try {
              this.handleObjectDetection(source, details, data as ObjectsDetected);
            } catch (e) {
              this.logError('listenerCallback', e);
            }
          }
        );

        if (!listener) {
          this.failedListenerIds.push(id);
          continue;
        }

        this.listeners.push(listener);
      } catch (e) {
        this.logError('initializeListeners', e);
        this.failedListenerIds.push(id);
      }
    }

    this.persistFailedListeners();
  }

  private startRetryTimer() {
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = setInterval(() => {
      try {
        this.retryFailedListeners();
      } catch (e) {
        this.logError('retryTimer', e);
      }
    }, this.retryIntervalMs);
  }

  private async retryFailedListeners() {
    if (!this.failedListenerIds?.length) return;
    const sm = getSystemManager();
    const toTry = [...this.failedListenerIds];
    const recovered: string[] = [];

    for (const id of toTry) {
      try {
        const dev = sm?.getDeviceById?.(id);
        const ifaces = getDeviceInterfaces(id);
        if (!dev) continue;
        if (!ifaces.includes(ScryptedInterface.ObjectDetector)) continue;

        const listener = sm?.listenDevice?.(id, ScryptedInterface.ObjectDetector, (source: any, details: any, data: any) => {
          try {
            this.handleObjectDetection(source, details, data as ObjectsDetected);
          } catch (e) {
            this.logError('listenerCallback', e);
          }
        });
        if (listener) {
          this.listeners.push(listener);
          recovered.push(id);
        }
      } catch (e) {
        this.logError('retryFailedListeners', e);
      }
    }

    if (recovered.length) {
      this.failedListenerIds = this.failedListenerIds.filter((x) => !recovered.includes(x));
      this.persistFailedListeners();
    }
  }

  /* ----------------------------- Persistence ------------------------------- */

  private loadPersistedEMA() {
    try {
      const raw = (this as any).storage.getItem(EMA_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') this.emaMap = parsed;
    } catch (e) {
      this.logError('loadPersistedEMA', e);
      this.emaMap = {};
    }
  }

  private schedulePersistEMA() {
    if (this.emaPersistTimer) clearTimeout(this.emaPersistTimer);
    this.emaPersistTimer = setTimeout(() => {
      this.persistEMA().catch((e) => this.logError('persistEMA', e));
    }, this.emaPersistDebounceMs);
  }

  private async persistEMA() {
    try {
      (this as any).storage.setItem(EMA_STORAGE_KEY, JSON.stringify(this.emaMap));
    } catch (e) {
      this.logError('persistEMA', e);
    }
  }

  private loadFailedListeners() {
    try {
      const raw = (this as any).storage.getItem(FAILED_LISTENERS_KEY);
      if (!raw) this.failedListenerIds = [];
      else this.failedListenerIds = Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [];

    } catch {
      this.failedListenerIds = [];
    }
  }

  private persistFailedListeners() {
    try {
      (this as any).storage.setItem(FAILED_LISTENERS_KEY, JSON.stringify(this.failedListenerIds));
    } catch (e) {
      this.logError('persistFailedListeners', e);
    }
  }

  private loadErrorLog() {
    try {
      const raw = (this as any).storage.getItem(ERROR_LOG_KEY);
      if (!raw) {
        this.errorLog = [];
        return;
      }
      const parsed = JSON.parse(raw);
      this.errorLog = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.errorLog = [];
    }
  }

  private persistErrorLog() {
    try {
      (this as any).storage.setItem(ERROR_LOG_KEY, JSON.stringify(this.errorLog.slice(-MAX_ERROR_LOG)));
    } catch {}
  }

  private logError(ctx: string, e: any) {
    try {
      const msg = e && e.stack ? e.stack : String(e);
      console.error('Dynamic Birdseye ERR', ctx, msg);
      this.errorLog.push({ ts: now(), message: msg, ctx });
      if (this.errorLog.length > MAX_ERROR_LOG) this.errorLog.shift();
      this.persistErrorLog();
    } catch {}
  }

  private startEndpointRefreshTimer() {
    if (this.endpointRefreshTimer) clearInterval(this.endpointRefreshTimer);
    this.endpointRefreshTimer = setInterval(() => {
      try {
        this.persistEndpointPaths();
      } catch (e) {
        this.logError('endpointRefresh', e);
      }
    }, this.endpointRefreshIntervalMs);
  }

  private async persistEndpointPaths() {
    try {
      const em = getEndpointManager();
      try {
        if (em?.getAuthenticatedPath) {
          const p = await em.getAuthenticatedPath(NATIVE_ID);
          if (p) {
            this.persistedEndpointAuthPath = p;
            (this as any).storage.setItem(ENDPOINT_AUTH_PATH_KEY, p);
          }
        }
      } catch {}
      try {
        if (em?.getPath) {
          const p = await em.getPath(NATIVE_ID);
          if (p) {
            this.persistedEndpointPath = p;
            (this as any).storage.setItem(ENDPOINT_PATH_KEY, p);
          }
        }
      } catch {}
    } catch (e) {
      this.logError('persistEndpointPaths', e);
    }
  }

  /* ------------------------------ Detection flow --------------------------- */

  private handleObjectDetection(eventSource: any, _details: any, eventData: ObjectsDetected) {
    try {
      const deviceId = eventSource?.id || _details?.id;
      const deviceName = eventSource?.name || _details?.name || deviceId || 'unknown';
      if (!deviceId) return;

      const detections = Array.isArray(eventData?.detections) ? eventData.detections : [];
      if (!detections.length) {
        if (this.activeDetections.has(deviceId)) {
          this.activeDetections.delete(deviceId);
          this.determineActiveCamera();
        }
        return;
      }

      // build relevant list but do NOT emit className: undefined (to appease exactOptionalPropertyTypes)
      const relevant: Array<{ score: number; className?: string }> = [];
      for (const d of detections) {
        if (!d) continue;
        const cnameRaw = typeof d.className === 'string' ? d.className : undefined;
        const cname = cnameRaw ? cnameRaw.toLowerCase() : undefined;
        if (!cname || !this.detectionClasses.includes(cname)) continue;
        const scoreNum = Math.max(0, Math.min(1, Number(d.score || 0)));
        const obj: { score: number; className?: string } = { score: scoreNum };
        if (cnameRaw) obj.className = cnameRaw;
        relevant.push(obj);
      }

      if (!relevant.length) {
        if (this.activeDetections.has(deviceId)) {
          this.activeDetections.delete(deviceId);
          this.determineActiveCamera();
        }
        return;
      }

      // pick best manually
      let best: { score: number; className?: string } | undefined = undefined;
      for (const r of relevant) {
        if (!best || r.score > best.score) best = r;
      }
      if (!best) {
        if (this.activeDetections.has(deviceId)) {
          this.activeDetections.delete(deviceId);
          this.determineActiveCamera();
        }
        return;
      }

      const rawScore = best.score;
      const prevEMA = typeof this.emaMap[deviceId] === 'number' ? this.emaMap[deviceId] : rawScore;
      const ema = this.detectionEMAAlpha * rawScore + (1 - this.detectionEMAAlpha) * prevEMA;
      this.emaMap[deviceId] = ema;
      this.schedulePersistEMA();

      const priority =
        this.cameraPriorities && this.cameraPriorities[deviceId]
          ? Number(this.cameraPriorities[deviceId])
          : 1;
      const finalScore = ema * (Number.isFinite(priority) ? priority : 1);

      this.activeDetections.set(deviceId, {
        cameraId: deviceId,
        cameraName: deviceName,
        rawScore,
        emaScore: ema,
        timestamp: now(),
        finalScore,
      });

      this.pruneStaleDetections();
      this.resetIdleTimer();
      this.determineActiveCamera();
    } catch (e) {
      this.logError('handleObjectDetection', e);
    }
  }

  private pruneStaleDetections() {
    const t = now();
    for (const [id, d] of Array.from(this.activeDetections.entries())) {
      if (t - d.timestamp > this.detectionTtlMs) this.activeDetections.delete(id);
    }
  }

  private determineActiveCamera() {
    this.pruneStaleDetections();
    const t = now();
    let cand: ActiveDetection | undefined;

    for (const d of this.activeDetections.values()) {
      if (d.emaScore < this.minScoreThreshold) continue;
      if (!cand || d.finalScore > cand.finalScore) cand = d;
      else if (cand && d.finalScore === cand.finalScore) {
        const pa = Number(this.cameraPriorities[d.cameraId] || 1);
        const pb = Number(this.cameraPriorities[cand.cameraId] || 1);
        if (pa > pb) cand = d;
        else if (pa === pb) {
          if (d.emaScore > cand.emaScore) cand = d;
          else if (d.emaScore === cand.emaScore) {
            if (d.timestamp > cand.timestamp) cand = d;
            else if (d.timestamp === cand.timestamp) {
              if (d.cameraId < cand.cameraId) cand = d;
            }
          }
        }
      }
    }

    let targetId = cand ? cand.cameraId : undefined;
    if (targetId && !this.tryResolveVideoCamera(targetId)) {
      this.activeDetections.delete(targetId);
      targetId = undefined;
    }

    if (!targetId) {
      const fallback = this.enumerateVideoCameraCandidates()[0];
      targetId = fallback?.id;
    }

    if (!targetId) return;
    if (this.currentActiveCameraId === targetId) return;
    if (t - this.lastSwitchTimestamp < this.minSwitchDurationMs) return;

    if (this.currentActiveCameraId && cand) {
      const cur = this.activeDetections.get(this.currentActiveCameraId);
      if (cur) {
        const threshold = (cur.emaScore || 0) * (1 + this.hysteresisPercent);
        if (cand.emaScore <= threshold) return;
      }
    }

    if (!this.tryResolveVideoCamera(targetId)) return;

    this.currentActiveCameraId = targetId;
    this.lastSwitchTimestamp = t;
  }

  private resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      try {
        this.activeDetections.clear();
        const fallbackOrder = [this.defaultCameraId, ...(this.monitoredCameraIds || [])];
        let reassigned: string | undefined;
        for (const id of fallbackOrder) {
          if (!id) continue;
          if (this.tryResolveVideoCamera(id)) {
            reassigned = id;
            break;
          }
        }
        this.currentActiveCameraId = reassigned;
      } catch (e) {
        this.logError('idleTimer', e);
      }
    }, this.idleTimeoutMs);
  }

  /* -------------------------------- Streaming ------------------------------- */

  async getRebroadcastRedirectUrl(): Promise<{ url?: string }> {
    const [target, ...fallbacks] = this.enumerateVideoCameraCandidates();
    if (!target) throw new Error('No video-capable monitored camera available');
    const opts: RequestMediaStreamOptions = this.buildRequestOptions();
    try {
      const mo: MediaObject = await this.tryGetStreamWithFallback(target.camera, opts);
      const url = await this.convertMediaObjectToLocalUrl(mo);
      await this.persistEndpointPaths();
      if (this.currentActiveCameraId !== target.id) this.currentActiveCameraId = target.id;
      return { url };
    } catch (e) {
      this.logError('getRebroadcastRedirectUrl', e);
      for (const fb of fallbacks) {
        try {
          const mo: MediaObject = await this.tryGetStreamWithFallback(fb.camera, opts);
          const url = await this.convertMediaObjectToLocalUrl(mo);
          await this.persistEndpointPaths();
          if (this.currentActiveCameraId !== fb.id) this.currentActiveCameraId = fb.id;
          return { url };
        } catch (inner) {
          this.logError('getRebroadcastRedirectUrl.fallback', inner);
        }
      }
      throw e;
    }
  }

  async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
    return [
      {
        id: 'birdseye',
        video: {
          codec: this.codecPreference === 'auto' ? undefined : this.codecPreference,
          width: DEFAULT_WIDTH,
          height: DEFAULT_HEIGHT,
          bitrate: DEFAULT_BITRATE,
        } as any,
      },
    ];
  }

  async getVideoStream(options?: RequestMediaStreamOptions): Promise<MediaObject> {
    const [target, ...fallbacks] = this.enumerateVideoCameraCandidates();
    if (!target) throw new Error('No video-capable monitored camera available');
    const requestOptions: RequestMediaStreamOptions = this.buildRequestOptions(options);

    try {
      const mo = await this.tryGetStreamWithFallback(target.camera, requestOptions);
      if (this.currentActiveCameraId !== target.id) this.currentActiveCameraId = target.id;
      return mo;
    } catch (e) {
      this.logError('getVideoStream', e);
      for (const fb of fallbacks) {
        try {
          const mo = await this.tryGetStreamWithFallback(fb.camera, requestOptions);
          if (this.currentActiveCameraId !== fb.id) this.currentActiveCameraId = fb.id;
          return mo;
        } catch (inner) {
          this.logError('getVideoStream.fallback', inner);
        }
      }
      throw e;
    }
  }

  private buildRequestOptions(base?: RequestMediaStreamOptions): RequestMediaStreamOptions {
    const videoBase: any = (base as any)?.video || {};
    const ro: RequestMediaStreamOptions = {
      ...base,
      prebuffer: (base as any)?.prebuffer ?? this.prebufferMs,
      video: {
        ...videoBase,
        width: videoBase.width || DEFAULT_WIDTH,
        height: videoBase.height || DEFAULT_HEIGHT,
        bitrate: videoBase.bitrate || DEFAULT_BITRATE,
        codec: this.codecPreference !== 'auto' ? this.codecPreference : videoBase.codec,
        prebuffer: videoBase.prebuffer ?? this.prebufferMs,
      } as any,
    } as any;
    return ro;
  }

  private async tryGetStreamWithFallback(cam: VideoCamera, baseOptions: RequestMediaStreamOptions): Promise<MediaObject> {
    if (!cam || typeof cam.getVideoStream !== 'function') throw new Error('No video camera to fetch stream from');

    const tried = new Set<string>();
    const seq: RequestMediaStreamOptions[] = [];

    seq.push({ ...baseOptions });
    const baseCodec = (baseOptions as any)?.video?.codec;

    if (baseCodec === 'h264')
      seq.push({ ...baseOptions, video: { ...(baseOptions as any).video, codec: 'h265' } });
    else if (baseCodec === 'h265')
      seq.push({ ...baseOptions, video: { ...(baseOptions as any).video, codec: 'h264' } });
    else {
      seq.push({ ...baseOptions, video: { ...(baseOptions as any).video, codec: 'h264' } });
      seq.push({ ...baseOptions, video: { ...(baseOptions as any).video, codec: 'h265' } });
    }
    seq.push({ ...baseOptions, video: { ...(baseOptions as any).video } });

    let lastErr: any;
    for (const opts of seq) {
      const hint = (opts as any)?.video?.codec ? String((opts as any).video.codec) : 'none';
      if (tried.has(hint)) continue;
      tried.add(hint);
      try {
        return await cam.getVideoStream(opts);
      } catch (e) {
        lastErr = e;
        this.logError('tryGetStreamWithFallback', e);
      }
    }
    throw lastErr || new Error('no stream');
  }

  private enumerateVideoCameraCandidates(): Array<{ id: string; camera: VideoCamera }> {
    const visited = new Set<string>();
    const out: Array<{ id: string; camera: VideoCamera }> = [];
    const ids = [this.currentActiveCameraId, this.defaultCameraId, ...(this.monitoredCameraIds || [])];
    for (const id of ids) {
      if (!id || visited.has(id)) continue;
      visited.add(id);
      const cam = this.tryResolveVideoCamera(id);
      if (cam) out.push({ id, camera: cam });
    }
    return out;
  }

  private tryResolveVideoCamera(id: string | undefined): VideoCamera | undefined {
    if (!id) return undefined;
    try {
      const sm = getSystemManager();
      const devAny = sm?.getDeviceById?.(id);
      if (!devAny) return undefined;
      const ifaces = getDeviceInterfaces(id);
      if (ifaces.includes(ScryptedInterface.VideoCamera)) return devAny as unknown as VideoCamera;
      if (typeof (devAny as any)?.getVideoStream === 'function') return devAny as unknown as VideoCamera;
    } catch (e) {
      this.logError('tryResolveVideoCamera', e);
    }
    return undefined;
  }

  private async convertMediaObjectToLocalUrl(mediaObject: MediaObject, mime = 'video/mp4') {
    const mm = getMediaManager();
    if (mm?.convertMediaObjectToLocalUrl) {
      return await mm.convertMediaObjectToLocalUrl(mediaObject, mime);
    } else if (mm?.convertMediaObjectToInsecureLocalUrl) {
      return await mm.convertMediaObjectToInsecureLocalUrl(mediaObject, mime);
    }
    throw new Error('mediaManager convert functions unavailable');
  }

  /* ---------------------- Programmatic Rebroadcast (best-effort) ------------ */

  async attemptCreateRebroadcast(): Promise<boolean> {
    try {
      const devices = listSystemDevices();
      const rebPlugin = devices.find((d) => (d.name || '').toLowerCase().includes('rebroadcast'));
      if (!rebPlugin) {
        return false;
      }

      const sm = getSystemManager();
      try {
        const dev = sm?.getDeviceById?.(rebPlugin.id);
        if (dev && typeof (dev as any).createRebroadcast === 'function') {
          const cfg = {
            name: 'Birdseye Rebroadcast',
            port: 8554,
            path: `/birdseye-${Math.floor(Math.random() * 9000) + 1000}`,
          };
          const result = await (dev as any).createRebroadcast(cfg);
          if (result?.nativeId) {
            this.rebroadcastDeviceId = result.nativeId;
            (this as any).storage.setItem(REBROADCAST_DEVICE_KEY, this.rebroadcastDeviceId);
            return true;
          }
        }
      } catch (e) {
        this.logError('attemptCreateRebroadcast.call', e);
      }

      return false;
    } catch (e) {
      this.logError('attemptCreateRebroadcast', e);
      return false;
    }
  }

  /* --------------------------------- Utils --------------------------------- */

  private normalizeDeviceIdList(entries: string[]): string[] {
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!entry) continue;
      const parsed = parseDeviceChoice(String(entry));
      const resolved = parsed ? this.resolveDeviceId(parsed) || parsed : undefined;
      if (!resolved || seen.has(resolved)) continue;
      seen.add(resolved);
      normalized.push(resolved);
    }
    return normalized;
  }

  private resolveDeviceId(input: string): string | undefined {
    if (!input) return undefined;
    const devices = listSystemDevices();

    // exact id
    const byId = devices.find((d) => d.id === input);
    if (byId?.id) return byId.id;

    // handle "Name (id)" format
    const parenMatch = input.match(/\(([^)]+)\)\s*$/);
    if (parenMatch && parenMatch[1]) {
      const innerId = parenMatch[1].trim();
      const byInner = devices.find((d) => d.id === innerId);
      if (byInner?.id) return byInner.id;
    }

    const lower = input.trim().toLowerCase();
    const byName = devices.find((d) => (d.name || '').trim().toLowerCase() === lower);
    if (byName?.id) return byName.id;

    return undefined;
  }

  private scrubEmaForMissingDevices() {
    try {
      const devices = listSystemDevices();
      const ids = new Set(devices.map((d) => d.id));
      let changed = false;
      for (const key of Object.keys(this.emaMap)) {
        if (!ids.has(key)) {
          delete this.emaMap[key];
          changed = true;
        }
      }
      if (changed) this.schedulePersistEMA();
    } catch (e) {
      this.logError('scrubEmaForMissingDevices', e);
    }
  }

  /* -------------------------------- Telemetry ------------------------------- */

  getTelemetry() {
    const detections: any[] = [];
    for (const [id, d] of this.activeDetections.entries()) {
      detections.push({
        cameraId: id,
        cameraName: d.cameraName,
        rawScore: d.rawScore,
        emaScore: d.emaScore,
        finalScore: d.finalScore,
        timestamp: d.timestamp,
      });
    }
    return {
      currentActiveCameraId: this.currentActiveCameraId,
      defaultCameraId: this.defaultCameraId,
      monitoredCameraIds: this.monitoredCameraIds,
      lastSwitchTimestamp: this.lastSwitchTimestamp,
      detections,
      emaMap: this.emaMap,
      endpointPath: this.persistedEndpointPath,
      endpointAuthPath: this.persistedEndpointAuthPath,
      failedListenerIds: this.failedListenerIds,
      errorLog: this.errorLog.slice(-20),
      rebroadcastDeviceId: this.rebroadcastDeviceId,
      settings: {
        detectionEMAAlpha: this.detectionEMAAlpha,
        hysteresisPercent: this.hysteresisPercent,
        minScoreThreshold: this.minScoreThreshold,
        idleTimeoutMs: this.idleTimeoutMs,
        detectionTtlMs: this.detectionTtlMs,
        minSwitchDurationMs: this.minSwitchDurationMs,
        codecPreference: this.codecPreference,
        autoDetectObjectDetectors: this.autoDetectObjectDetectors,
        autoCreateRebroadcast: this.autoCreateRebroadcast,
        prebufferMs: this.prebufferMs,
      },
    };
  }
}

/* --------------------------------- Export ---------------------------------- */

export default new DynamicCameraProvider();
