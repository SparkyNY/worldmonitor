import type { AppContext, AppModule } from '@/app/app-context';
import type { PanelConfig } from '@/types';
import type { MapView } from '@/components';
import type { ClusteredEvent } from '@/types';
import type { DashboardSnapshot } from '@/services/storage';
import confetti from 'canvas-confetti';
import {
  PlaybackControl,
  StatusPanel,
  MobileWarningModal,
  PizzIntIndicator,
  CIIPanel,
  PredictionPanel,
} from '@/components';
import {
  buildMapUrl,
  debounce,
  saveToStorage,
  ExportPanel,
  getCurrentTheme,
  setTheme,
} from '@/utils';
import {
  STORAGE_KEYS,
  SITE_VARIANT,
  LAYER_TO_SOURCE,
  FEEDS,
  INTEL_SOURCES,
  DEFAULT_PANELS,
} from '@/config';
import {
  saveSnapshot,
  initAisStream,
  disconnectAisStream,
} from '@/services';
import {
  trackPanelView,
  trackVariantSwitch,
  trackThemeChanged,
  trackMapViewChange,
  trackMapLayerToggle,
  trackPanelToggled,
} from '@/services/analytics';
import { invokeTauri } from '@/services/tauri-bridge';
import { dataFreshness } from '@/services/data-freshness';
import { mlWorker } from '@/services/ml-worker';
import { UnifiedSettings } from '@/components/UnifiedSettings';
import { t } from '@/services/i18n';
import { TvModeController } from '@/services/tv-mode';

type CalendarMilestoneCategory = 'holiday' | 'dst' | 'season';
type CalendarView = 'month' | 'week' | 'quarter';
type WeatherTab = 'today' | 'seven' | 'ten';

interface CalendarMilestone {
  date: Date;
  label: string;
  category: CalendarMilestoneCategory;
}

interface ToolbarWeatherCurrent {
  temperatureF: number | null;
  feelsLikeF: number | null;
  humidityPct: number | null;
  windMph: number | null;
  weatherCode: number | null;
}

interface ToolbarWeatherDay {
  dateIso: string;
  dayLabel: string;
  weatherCode: number | null;
  highF: number | null;
  lowF: number | null;
  feelsHighF: number | null;
  feelsLowF: number | null;
  precipChancePct: number | null;
  windMaxMph: number | null;
  snowTotalIn: number | null;
}

interface ToolbarWeatherHour {
  dateIso: string;
  timeIso: string;
  timeLabel: string;
  weatherCode: number | null;
  temperatureF: number | null;
  feelsLikeF: number | null;
  precipChancePct: number | null;
  precipIn: number | null;
  snowIn: number | null;
  windMph: number | null;
}

interface ToolbarWeatherAlert {
  id: string;
  event: string;
  severity: string;
  headline: string;
  expires: string;
  isMajor: boolean;
}

interface ToolbarWeatherData {
  locationLabel: string;
  sourceLabel: string;
  fetchedAt: number;
  current: ToolbarWeatherCurrent;
  days: ToolbarWeatherDay[];
  hourlyByDate: Record<string, ToolbarWeatherHour[]>;
  alerts: ToolbarWeatherAlert[];
  alertFetchError?: string;
}

interface OpenMeteoForecastResponse {
  current?: {
    temperature_2m?: number;
    apparent_temperature?: number;
    relative_humidity_2m?: number;
    wind_speed_10m?: number;
    weather_code?: number;
  };
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    apparent_temperature_max?: number[];
    apparent_temperature_min?: number[];
    precipitation_probability_max?: number[];
    wind_speed_10m_max?: number[];
    snowfall_sum?: number[];
  };
  hourly?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m?: number[];
    apparent_temperature?: number[];
    precipitation_probability?: number[];
    precipitation?: number[];
    snowfall?: number[];
    wind_speed_10m?: number[];
  };
}

interface NwsPointAlertFeature {
  id?: string;
  properties?: {
    event?: string;
    severity?: string;
    headline?: string;
    expires?: string;
  };
}

interface NwsPointAlertResponse {
  features?: NwsPointAlertFeature[];
}

const CALENDAR_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const BACK_BAY_LAT = 42.3493;
const BACK_BAY_LON = -71.0810;
const WEATHER_CACHE_MS = 10 * 60 * 1000;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toRounded(value: number | undefined, precision = 0): number | null {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** precision;
  return Math.round((value as number) * scale) / scale;
}

function parseDateLabel(dateIso: string): string {
  const date = new Date(`${dateIso}T12:00:00`);
  if (Number.isNaN(date.getTime())) return dateIso;
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function weatherCodeToText(code: number | null): string {
  if (code == null) return 'Unknown';
  if (code === 0) return 'Clear';
  if (code >= 1 && code <= 2) return 'Partly cloudy';
  if (code === 3) return 'Cloudy';
  if (code >= 45 && code <= 48) return 'Fog';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'Rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'Snow';
  if (code >= 95) return 'Thunderstorm';
  return 'Mixed';
}

function weatherCodeToIcon(code: number | null): string {
  if (code == null) return '•';
  if (code === 0) return '☀';
  if (code >= 1 && code <= 2) return '⛅';
  if (code === 3) return '☁';
  if (code >= 45 && code <= 48) return '🌫';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return '🌧';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return '❄';
  if (code >= 95) return '⛈';
  return '•';
}

function isSnowWeatherCode(code: number | null): boolean {
  if (code == null) return false;
  return (code >= 71 && code <= 77) || code === 85 || code === 86;
}

function estimateSnowRangeIn(totalIn: number): { lowIn: number; highIn: number } {
  const spread = Math.max(0.2, totalIn * 0.25);
  const lowIn = Math.max(0, toRounded(totalIn - spread, 1) ?? 0);
  const highIn = Math.max(lowIn, toRounded(totalIn + spread, 1) ?? lowIn);
  return { lowIn, highIn };
}

function isMajorNwsAlert(event: string, severity: string): boolean {
  const s = severity.toLowerCase();
  if (s === 'extreme' || s === 'severe') return true;
  return /\b(warning|emergency|evacuation)\b/i.test(event);
}

async function fetchToolbarWeatherData(): Promise<ToolbarWeatherData> {
  const forecastUrl = new URL('https://api.open-meteo.com/v1/forecast');
  forecastUrl.searchParams.set('latitude', String(BACK_BAY_LAT));
  forecastUrl.searchParams.set('longitude', String(BACK_BAY_LON));
  forecastUrl.searchParams.set('current', 'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code');
  forecastUrl.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_probability_max,wind_speed_10m_max,snowfall_sum');
  forecastUrl.searchParams.set('hourly', 'weather_code,temperature_2m,apparent_temperature,precipitation_probability,precipitation,snowfall,wind_speed_10m');
  forecastUrl.searchParams.set('forecast_days', '10');
  forecastUrl.searchParams.set('temperature_unit', 'fahrenheit');
  forecastUrl.searchParams.set('precipitation_unit', 'inch');
  forecastUrl.searchParams.set('wind_speed_unit', 'mph');
  forecastUrl.searchParams.set('timezone', 'America/New_York');

  const forecastRes = await fetch(forecastUrl.toString(), { headers: { Accept: 'application/json' } });
  if (!forecastRes.ok) throw new Error(`Weather forecast unavailable (HTTP ${forecastRes.status})`);
  const forecast = await forecastRes.json() as OpenMeteoForecastResponse;

  const daily = forecast.daily;
  const dates = daily?.time ?? [];
  if (dates.length === 0) throw new Error('Weather forecast returned no daily data');

  const hourly = forecast.hourly;
  const hourlyTimes = hourly?.time ?? [];
  const hourlyByDate: Record<string, ToolbarWeatherHour[]> = {};
  for (let index = 0; index < hourlyTimes.length; index += 1) {
    const timeIso = hourlyTimes[index];
    if (!timeIso) continue;
    const dateIso = timeIso.split('T')[0];
    if (!dateIso) continue;
    const time = new Date(timeIso);
    const entry: ToolbarWeatherHour = {
      dateIso,
      timeIso,
      timeLabel: Number.isNaN(time.getTime())
        ? timeIso
        : time.toLocaleTimeString(undefined, { hour: 'numeric' }),
      weatherCode: hourly?.weather_code?.[index] ?? null,
      temperatureF: toRounded(hourly?.temperature_2m?.[index]),
      feelsLikeF: toRounded(hourly?.apparent_temperature?.[index]),
      precipChancePct: toRounded(hourly?.precipitation_probability?.[index]),
      precipIn: toRounded(hourly?.precipitation?.[index], 2),
      snowIn: toRounded(hourly?.snowfall?.[index], 2),
      windMph: toRounded(hourly?.wind_speed_10m?.[index]),
    };
    const rows = hourlyByDate[dateIso] ?? [];
    rows.push(entry);
    hourlyByDate[dateIso] = rows;
  }

  const days: ToolbarWeatherDay[] = dates.slice(0, 10).map((dateIso, index) => ({
    dateIso,
    dayLabel: parseDateLabel(dateIso),
    weatherCode: daily?.weather_code?.[index] ?? null,
    highF: toRounded(daily?.temperature_2m_max?.[index]),
    lowF: toRounded(daily?.temperature_2m_min?.[index]),
    feelsHighF: toRounded(daily?.apparent_temperature_max?.[index]),
    feelsLowF: toRounded(daily?.apparent_temperature_min?.[index]),
    precipChancePct: toRounded(daily?.precipitation_probability_max?.[index]),
    windMaxMph: toRounded(daily?.wind_speed_10m_max?.[index]),
    snowTotalIn: toRounded(daily?.snowfall_sum?.[index], 2),
  }));

  const current: ToolbarWeatherCurrent = {
    temperatureF: toRounded(forecast.current?.temperature_2m),
    feelsLikeF: toRounded(forecast.current?.apparent_temperature),
    humidityPct: toRounded(forecast.current?.relative_humidity_2m),
    windMph: toRounded(forecast.current?.wind_speed_10m),
    weatherCode: forecast.current?.weather_code ?? days[0]?.weatherCode ?? null,
  };

  let alerts: ToolbarWeatherAlert[] = [];
  let alertFetchError: string | undefined;
  const nwsUrl = `https://api.weather.gov/alerts/active?point=${BACK_BAY_LAT},${BACK_BAY_LON}`;

  try {
    const nwsRes = await fetch(nwsUrl, {
      headers: {
        Accept: 'application/geo+json, application/json',
        'User-Agent': 'WorldMonitor/1.0 (Boston local weather widget)',
      },
    });
    if (!nwsRes.ok) {
      alertFetchError = `NWS alerts unavailable (HTTP ${nwsRes.status})`;
    } else {
      const nws = await nwsRes.json() as NwsPointAlertResponse;
      alerts = (nws.features ?? []).map((feature, index) => {
        const event = feature.properties?.event || 'Weather Alert';
        const severity = feature.properties?.severity || 'Unknown';
        const headline = feature.properties?.headline || event;
        const expires = feature.properties?.expires || '';
        return {
          id: feature.id || `nws-alert-${index}`,
          event,
          severity,
          headline,
          expires,
          isMajor: isMajorNwsAlert(event, severity),
        };
      }).sort((a, b) => {
        if (a.isMajor !== b.isMajor) return a.isMajor ? -1 : 1;
        return a.event.localeCompare(b.event);
      });
    }
  } catch (error) {
    alertFetchError = `NWS alerts unavailable (${error instanceof Error ? error.message : String(error)})`;
  }

  return {
    locationLabel: 'Back Bay, Boston, MA',
    sourceLabel: 'Open-Meteo + National Weather Service',
    fetchedAt: Date.now(),
    current,
    days,
    hourlyByDate,
    alerts,
    alertFetchError,
  };
}

function localNoonDate(year: number, month: number, day: number): Date {
  return new Date(year, month, day, 12, 0, 0, 0);
}

function getNthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): Date {
  const first = localNoonDate(year, month, 1);
  const offset = (weekday - first.getDay() + 7) % 7;
  return localNoonDate(year, month, 1 + offset + (nth - 1) * 7);
}

function getLastWeekdayOfMonth(year: number, month: number, weekday: number): Date {
  const last = localNoonDate(year, month + 1, 0);
  const offset = (last.getDay() - weekday + 7) % 7;
  return localNoonDate(year, month, last.getDate() - offset);
}

function getObservedFederalHoliday(date: Date): Date {
  const observed = new Date(date);
  const day = observed.getDay();
  if (day === 6) observed.setDate(observed.getDate() - 1); // Saturday -> Friday
  if (day === 0) observed.setDate(observed.getDate() + 1); // Sunday -> Monday
  return localNoonDate(observed.getFullYear(), observed.getMonth(), observed.getDate());
}

function getCalendarDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function startOfWeek(date: Date): Date {
  const d = localNoonDate(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - d.getDay());
  return localNoonDate(d.getFullYear(), d.getMonth(), d.getDate());
}

function endOfWeek(date: Date): Date {
  const start = startOfWeek(date);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return localNoonDate(end.getFullYear(), end.getMonth(), end.getDate());
}

function startOfQuarter(date: Date): Date {
  const month = date.getMonth();
  const quarterStartMonth = month - (month % 3);
  return localNoonDate(date.getFullYear(), quarterStartMonth, 1);
}

function endOfQuarter(date: Date): Date {
  const start = startOfQuarter(date);
  return localNoonDate(start.getFullYear(), start.getMonth() + 3, 0);
}

function buildHolidayMilestonesForYear(year: number): CalendarMilestone[] {
  const milestones: CalendarMilestone[] = [];
  const pushFixedHoliday = (month: number, day: number, label: string): void => {
    const official = localNoonDate(year, month, day);
    const observed = getObservedFederalHoliday(official);
    const observedOnly = observed.getTime() !== official.getTime();
    milestones.push({
      date: observed,
      label: observedOnly ? `${label} (Observed)` : label,
      category: 'holiday',
    });
  };

  pushFixedHoliday(0, 1, "New Year's Day");
  milestones.push({ date: getNthWeekdayOfMonth(year, 0, 1, 3), label: 'Martin Luther King Jr. Day', category: 'holiday' });
  milestones.push({ date: getNthWeekdayOfMonth(year, 1, 1, 3), label: "Presidents' Day", category: 'holiday' });
  milestones.push({ date: getLastWeekdayOfMonth(year, 4, 1), label: 'Memorial Day', category: 'holiday' });
  pushFixedHoliday(5, 19, 'Juneteenth');
  pushFixedHoliday(6, 4, 'Independence Day');
  milestones.push({ date: getNthWeekdayOfMonth(year, 8, 1, 1), label: 'Labor Day', category: 'holiday' });
  milestones.push({ date: getNthWeekdayOfMonth(year, 9, 1, 2), label: 'Indigenous Peoples / Columbus Day', category: 'holiday' });
  pushFixedHoliday(10, 11, 'Veterans Day');
  milestones.push({ date: getNthWeekdayOfMonth(year, 10, 4, 4), label: 'Thanksgiving', category: 'holiday' });
  pushFixedHoliday(11, 25, 'Christmas Day');
  if (year % 4 === 1) {
    let inauguration = localNoonDate(year, 0, 20);
    if (inauguration.getDay() === 0) inauguration = localNoonDate(year, 0, 21);
    milestones.push({ date: inauguration, label: 'Inauguration Day', category: 'holiday' });
  }

  return milestones;
}

function buildDstMilestonesForYear(year: number): CalendarMilestone[] {
  return [
    { date: getNthWeekdayOfMonth(year, 2, 0, 2), label: 'Daylight Saving Time Starts', category: 'dst' },
    { date: getNthWeekdayOfMonth(year, 10, 0, 1), label: 'Daylight Saving Time Ends', category: 'dst' },
  ];
}

function buildSeasonMilestonesForYear(year: number): CalendarMilestone[] {
  return [
    { date: localNoonDate(year, 2, 20), label: 'Spring Begins', category: 'season' },
    { date: localNoonDate(year, 5, 20), label: 'Summer Begins', category: 'season' },
    { date: localNoonDate(year, 8, 22), label: 'Fall Begins', category: 'season' },
    { date: localNoonDate(year, 11, 21), label: 'Winter Begins', category: 'season' },
  ];
}

function buildCalendarMilestonesForYear(year: number): CalendarMilestone[] {
  return [
    ...buildHolidayMilestonesForYear(year),
    ...buildDstMilestonesForYear(year),
    ...buildSeasonMilestonesForYear(year),
  ];
}

function getCalendarMilestonesForRange(start: Date, end: Date, limit = 8): CalendarMilestone[] {
  const startYear = start.getFullYear();
  const endYear = end.getFullYear();
  const years: number[] = [];
  for (let year = startYear; year <= endYear; year += 1) {
    years.push(year);
  }

  const all = years.flatMap((year) => [
    ...buildCalendarMilestonesForYear(year),
  ]);

  return all
    .filter((item) => item.date.getTime() >= start.getTime() && item.date.getTime() <= end.getTime())
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .slice(0, limit);
}

export interface EventHandlerCallbacks {
  updateSearchIndex: () => void;
  loadAllData: () => Promise<void>;
  flushStaleRefreshes: () => void;
  setHiddenSince: (ts: number) => void;
  loadDataForLayer: (layer: string) => void;
  waitForAisData: () => void;
  syncDataFreshnessWithLayers: () => void;
}

export class EventHandlerManager implements AppModule {
  private static readonly KONAMI_SEQUENCE = [
    'arrowup',
    'arrowup',
    'arrowdown',
    'arrowdown',
    'arrowleft',
    'arrowright',
    'arrowleft',
    'arrowright',
    'b',
    'a',
  ];

  private ctx: AppContext;
  private callbacks: EventHandlerCallbacks;

  private boundFullscreenHandler: (() => void) | null = null;
  private boundResizeHandler: (() => void) | null = null;
  private boundVisibilityHandler: (() => void) | null = null;
  private boundDesktopExternalLinkHandler: ((e: MouseEvent) => void) | null = null;
  private boundCalendarOutsideClickHandler: ((e: MouseEvent) => void) | null = null;
  private boundCalendarKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private boundWeatherOutsideClickHandler: ((e: MouseEvent) => void) | null = null;
  private boundWeatherKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private boundIdleResetHandler: (() => void) | null = null;
  private boundKonamiHandler: ((e: KeyboardEvent) => void) | null = null;
  private konamiProgress = 0;
  private konamiOverlay: HTMLDivElement | null = null;
  private konamiAutoCloseTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private idleTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private snapshotIntervalId: ReturnType<typeof setInterval> | null = null;
  private clockIntervalId: ReturnType<typeof setInterval> | null = null;
  private weatherRefreshIntervalId: ReturnType<typeof setInterval> | null = null;
  private calendarDisplayDate: Date = localNoonDate(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
  private calendarView: CalendarView = 'month';
  private weatherActiveTab: WeatherTab = 'today';
  private weatherSelectedDayIso: string | null = null;
  private weatherDataCache: ToolbarWeatherData | null = null;
  private weatherDataFetchedAt = 0;
  private weatherLoadingPromise: Promise<ToolbarWeatherData> | null = null;
  private readonly IDLE_PAUSE_MS = 2 * 60 * 1000;
  private debouncedUrlSync = debounce(() => {
    const shareUrl = this.getShareUrl();
    if (!shareUrl) return;
    history.replaceState(null, '', shareUrl);
  }, 250);

  constructor(ctx: AppContext, callbacks: EventHandlerCallbacks) {
    this.ctx = ctx;
    this.callbacks = callbacks;
  }

  init(): void {
    this.setupEventListeners();
    this.setupIdleDetection();
    this.setupTvMode();
  }

  private setupTvMode(): void {
    if (SITE_VARIANT !== 'happy') return;

    const tvBtn = document.getElementById('tvModeBtn');
    const tvExitBtn = document.getElementById('tvExitBtn');
    if (tvBtn) {
      tvBtn.addEventListener('click', () => this.toggleTvMode());
    }
    if (tvExitBtn) {
      tvExitBtn.addEventListener('click', () => this.toggleTvMode());
    }
    // Keyboard shortcut: Shift+T
    document.addEventListener('keydown', (e) => {
      if (e.shiftKey && e.key === 'T' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const active = document.activeElement;
        if (active?.tagName !== 'INPUT' && active?.tagName !== 'TEXTAREA') {
          e.preventDefault();
          this.toggleTvMode();
        }
      }
    });
  }

  private toggleTvMode(): void {
    const panelKeys = Object.keys(DEFAULT_PANELS).filter(
      key => this.ctx.panelSettings[key]?.enabled !== false
    );
    if (!this.ctx.tvMode) {
      this.ctx.tvMode = new TvModeController({
        panelKeys,
        onPanelChange: () => {
          document.getElementById('tvModeBtn')?.classList.toggle('active', this.ctx.tvMode?.active ?? false);
        }
      });
    } else {
      this.ctx.tvMode.updatePanelKeys(panelKeys);
    }
    this.ctx.tvMode.toggle();
    document.getElementById('tvModeBtn')?.classList.toggle('active', this.ctx.tvMode.active);
  }

  destroy(): void {
    if (this.boundFullscreenHandler) {
      document.removeEventListener('fullscreenchange', this.boundFullscreenHandler);
      this.boundFullscreenHandler = null;
    }
    if (this.boundResizeHandler) {
      window.removeEventListener('resize', this.boundResizeHandler);
      this.boundResizeHandler = null;
    }
    if (this.boundVisibilityHandler) {
      document.removeEventListener('visibilitychange', this.boundVisibilityHandler);
      this.boundVisibilityHandler = null;
    }
    if (this.boundDesktopExternalLinkHandler) {
      document.removeEventListener('click', this.boundDesktopExternalLinkHandler, true);
      this.boundDesktopExternalLinkHandler = null;
    }
    if (this.boundCalendarOutsideClickHandler) {
      document.removeEventListener('click', this.boundCalendarOutsideClickHandler);
      this.boundCalendarOutsideClickHandler = null;
    }
    if (this.boundCalendarKeydownHandler) {
      document.removeEventListener('keydown', this.boundCalendarKeydownHandler);
      this.boundCalendarKeydownHandler = null;
    }
    if (this.boundWeatherOutsideClickHandler) {
      document.removeEventListener('click', this.boundWeatherOutsideClickHandler);
      this.boundWeatherOutsideClickHandler = null;
    }
    if (this.boundWeatherKeydownHandler) {
      document.removeEventListener('keydown', this.boundWeatherKeydownHandler);
      this.boundWeatherKeydownHandler = null;
    }
    if (this.weatherRefreshIntervalId) {
      clearInterval(this.weatherRefreshIntervalId);
      this.weatherRefreshIntervalId = null;
    }
    if (this.idleTimeoutId) {
      clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }
    if (this.boundIdleResetHandler) {
      ['mousedown', 'keydown', 'scroll', 'touchstart', 'mousemove'].forEach(event => {
        document.removeEventListener(event, this.boundIdleResetHandler!);
      });
      this.boundIdleResetHandler = null;
    }
    if (this.snapshotIntervalId) {
      clearInterval(this.snapshotIntervalId);
      this.snapshotIntervalId = null;
    }
    if (this.clockIntervalId) {
      clearInterval(this.clockIntervalId);
      this.clockIntervalId = null;
    }
    if (this.boundKonamiHandler) {
      document.removeEventListener('keydown', this.boundKonamiHandler);
      this.boundKonamiHandler = null;
    }
    if (this.konamiAutoCloseTimeoutId) {
      clearTimeout(this.konamiAutoCloseTimeoutId);
      this.konamiAutoCloseTimeoutId = null;
    }
    this.removeKonamiPopup();
    this.ctx.tvMode?.destroy();
    this.ctx.tvMode = null;
    this.ctx.unifiedSettings?.destroy();
    this.ctx.unifiedSettings = null;
  }

  private setupEventListeners(): void {
    document.getElementById('searchBtn')?.addEventListener('click', () => {
      this.callbacks.updateSearchIndex();
      this.ctx.searchModal?.open();
    });

    document.getElementById('copyLinkBtn')?.addEventListener('click', async () => {
      const shareUrl = this.getShareUrl();
      if (!shareUrl) return;
      const button = document.getElementById('copyLinkBtn');
      try {
        await this.copyToClipboard(shareUrl);
        this.setCopyLinkFeedback(button, 'Copied!');
      } catch (error) {
        console.warn('Failed to copy share link:', error);
        this.setCopyLinkFeedback(button, 'Copy failed');
      }
    });

    window.addEventListener('storage', (e) => {
      if (e.key === STORAGE_KEYS.panels && e.newValue) {
        try {
          this.ctx.panelSettings = JSON.parse(e.newValue) as Record<string, PanelConfig>;
          this.applyPanelSettings();
          this.ctx.unifiedSettings?.refreshPanelToggles();
        } catch (_) {}
      }
      if (e.key === STORAGE_KEYS.liveChannels && e.newValue) {
        const panel = this.ctx.panels['live-news'];
        if (panel && typeof (panel as unknown as { refreshChannelsFromStorage?: () => void }).refreshChannelsFromStorage === 'function') {
          (panel as unknown as { refreshChannelsFromStorage: () => void }).refreshChannelsFromStorage();
        }
      }
    });

    document.getElementById('headerThemeToggle')?.addEventListener('click', () => {
      const next = getCurrentTheme() === 'dark' ? 'light' : 'dark';
      setTheme(next);
      this.updateHeaderThemeIcon();
      trackThemeChanged(next);
    });
    this.setupHeaderCalendar();
    this.setupHeaderWeather();

    const isLocalDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (this.ctx.isDesktopApp || isLocalDev) {
      this.ctx.container.querySelectorAll<HTMLAnchorElement>('.variant-option').forEach(link => {
        link.addEventListener('click', (e) => {
          const variant = link.dataset.variant;
          if (variant && variant !== SITE_VARIANT) {
            e.preventDefault();
            trackVariantSwitch(SITE_VARIANT, variant);
            localStorage.setItem('worldmonitor-variant', variant);
            window.location.reload();
          }
        });
      });
    }

    const fullscreenBtn = document.getElementById('fullscreenBtn');
    if (!this.ctx.isDesktopApp && fullscreenBtn) {
      fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());
      this.boundFullscreenHandler = () => {
        fullscreenBtn.textContent = document.fullscreenElement ? '\u26F6' : '\u26F6';
        fullscreenBtn.classList.toggle('active', !!document.fullscreenElement);
      };
      document.addEventListener('fullscreenchange', this.boundFullscreenHandler);
    }

    const regionSelect = document.getElementById('regionSelect') as HTMLSelectElement;
    regionSelect?.addEventListener('change', () => {
      this.ctx.map?.setView(regionSelect.value as MapView);
      trackMapViewChange(regionSelect.value);
    });

    this.boundResizeHandler = () => {
      this.ctx.map?.render();
    };
    window.addEventListener('resize', this.boundResizeHandler);

    this.setupMapResize();
    this.setupMapPin();

    this.boundVisibilityHandler = () => {
      document.body.classList.toggle('animations-paused', document.hidden);
      if (document.hidden) {
        this.callbacks.setHiddenSince(Date.now());
        mlWorker.unloadOptionalModels();
      } else {
        this.resetIdleTimer();
        this.callbacks.flushStaleRefreshes();
      }
    };
    document.addEventListener('visibilitychange', this.boundVisibilityHandler);

    window.addEventListener('focal-points-ready', () => {
      (this.ctx.panels['cii'] as CIIPanel)?.refresh(true);
    });

    window.addEventListener('theme-changed', () => {
      this.ctx.map?.render();
      this.updateHeaderThemeIcon();
    });

    if (this.ctx.isDesktopApp) {
      if (this.boundDesktopExternalLinkHandler) {
        document.removeEventListener('click', this.boundDesktopExternalLinkHandler, true);
      }
      this.boundDesktopExternalLinkHandler = (e: MouseEvent) => {
        if (!(e.target instanceof Element)) return;
        const anchor = e.target.closest('a[href]') as HTMLAnchorElement | null;
        if (!anchor) return;
        const href = anchor.href;
        if (!href || href.startsWith('javascript:') || href === '#' || href.startsWith('#')) return;
        try {
          const url = new URL(href, window.location.href);
          if (url.origin === window.location.origin) return;
          e.preventDefault();
          e.stopPropagation();
          void invokeTauri<void>('open_url', { url: url.toString() }).catch(() => {
            window.open(url.toString(), '_blank');
          });
        } catch { /* malformed URL -- let browser handle */ }
      };
      document.addEventListener('click', this.boundDesktopExternalLinkHandler, true);
    }

    this.setupKonamiCode();
  }

  private setupHeaderCalendar(): void {
    const menu = document.getElementById('calendarMenu');
    const button = document.getElementById('calendarBtn');
    const dropdown = document.getElementById('calendarDropdown');
    if (!(menu instanceof HTMLElement) || !(button instanceof HTMLButtonElement) || !(dropdown instanceof HTMLElement)) {
      return;
    }

    const openMenu = (): void => {
      this.closeHeaderWeather();
      this.renderHeaderCalendar(dropdown);
      menu.classList.add('open');
      dropdown.hidden = false;
      button.setAttribute('aria-expanded', 'true');
    };

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (menu.classList.contains('open')) {
        this.closeHeaderCalendar();
      } else {
        openMenu();
      }
    });

    dropdown.addEventListener('click', (event) => {
      event.stopPropagation();
      const target = event.target instanceof HTMLElement ? event.target : null;
      const todayBtn = target?.closest<HTMLElement>('[data-calendar-today]');
      if (todayBtn) {
        const now = new Date();
        this.calendarDisplayDate = localNoonDate(now.getFullYear(), now.getMonth(), now.getDate());
        this.renderHeaderCalendar(dropdown);
        return;
      }
      const viewBtn = target?.closest<HTMLElement>('[data-calendar-view]');
      if (viewBtn?.dataset.calendarView) {
        const requested = viewBtn.dataset.calendarView as CalendarView;
        if (requested === 'month' || requested === 'week' || requested === 'quarter') {
          this.calendarView = requested;
          if (requested === 'month') {
            this.calendarDisplayDate = localNoonDate(this.calendarDisplayDate.getFullYear(), this.calendarDisplayDate.getMonth(), 1);
          } else if (requested === 'quarter') {
            this.calendarDisplayDate = startOfQuarter(this.calendarDisplayDate);
          }
          this.renderHeaderCalendar(dropdown);
        }
        return;
      }
      const navBtn = target?.closest<HTMLElement>('[data-calendar-nav]');
      if (!navBtn) return;
      const delta = Number(navBtn.dataset.calendarNav);
      if (!Number.isFinite(delta) || delta === 0) return;
      if (this.calendarView === 'week') {
        this.calendarDisplayDate = localNoonDate(
          this.calendarDisplayDate.getFullYear(),
          this.calendarDisplayDate.getMonth(),
          this.calendarDisplayDate.getDate() + (7 * delta),
        );
      } else if (this.calendarView === 'quarter') {
        this.calendarDisplayDate = localNoonDate(
          this.calendarDisplayDate.getFullYear(),
          this.calendarDisplayDate.getMonth() + (3 * delta),
          1,
        );
      } else {
        this.calendarDisplayDate = localNoonDate(
          this.calendarDisplayDate.getFullYear(),
          this.calendarDisplayDate.getMonth() + delta,
          1,
        );
      }
      this.renderHeaderCalendar(dropdown);
    });

    this.boundCalendarOutsideClickHandler = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!menu.contains(target)) {
        this.closeHeaderCalendar();
      }
    };
    document.addEventListener('click', this.boundCalendarOutsideClickHandler);

    this.boundCalendarKeydownHandler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        this.closeHeaderCalendar();
      }
    };
    document.addEventListener('keydown', this.boundCalendarKeydownHandler);
  }

  private closeHeaderCalendar(): void {
    const menu = document.getElementById('calendarMenu');
    const button = document.getElementById('calendarBtn');
    const dropdown = document.getElementById('calendarDropdown');
    if (menu) menu.classList.remove('open');
    if (dropdown) dropdown.hidden = true;
    if (button instanceof HTMLButtonElement) {
      button.setAttribute('aria-expanded', 'false');
    }
  }

  private renderCalendarMonthGrid(
    monthStart: Date,
    todayKey: string,
    milestonesByDate: Map<string, CalendarMilestone[]>,
    compact = false,
  ): string {
    const isPrideMonth = monthStart.getMonth() === 5;
    const shellClasses = ['calendar-grid-shell'];
    if (compact) shellClasses.push('compact');
    if (isPrideMonth) shellClasses.push('pride-month');
    const firstWeekday = monthStart.getDay();
    const daysInMonth = localNoonDate(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();
    const dayCells: string[] = [];
    for (let i = 0; i < firstWeekday; i += 1) {
      dayCells.push('<div class="calendar-day empty"></div>');
    }
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = localNoonDate(monthStart.getFullYear(), monthStart.getMonth(), day);
      const dateKey = getCalendarDateKey(date);
      const milestones = milestonesByDate.get(dateKey) ?? [];
      const classes = ['calendar-day'];
      if (dateKey === todayKey) classes.push('today');
      if (milestones.length > 0) classes.push('has-event');
      const tooltip = milestones.map((m) => m.label).join(' | ');
      dayCells.push(`<div class="${classes.join(' ')}"${tooltip ? ` title="${escapeHtml(tooltip)}"` : ''}>${day}</div>`);
    }
    return `
      <div class="${shellClasses.join(' ')}">
        ${isPrideMonth ? '<div class="calendar-pride-banner">Pride Month</div>' : ''}
        <div class="calendar-weekdays">
          ${CALENDAR_WEEKDAYS.map((day) => `<span>${day}</span>`).join('')}
        </div>
        <div class="calendar-days">${dayCells.join('')}</div>
      </div>
    `;
  }

  private renderCalendarWeekGrid(
    weekStart: Date,
    todayKey: string,
    milestonesByDate: Map<string, CalendarMilestone[]>,
  ): string {
    const dayCells: string[] = [];
    for (let offset = 0; offset < 7; offset += 1) {
      const date = localNoonDate(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + offset);
      const dateKey = getCalendarDateKey(date);
      const milestones = milestonesByDate.get(dateKey) ?? [];
      const classes = ['calendar-day'];
      if (dateKey === todayKey) classes.push('today');
      if (milestones.length > 0) classes.push('has-event');
      const tooltip = milestones.map((m) => m.label).join(' | ');
      dayCells.push(`
        <div class="${classes.join(' ')}"${tooltip ? ` title="${escapeHtml(tooltip)}"` : ''}>
          <span class="calendar-day-num">${date.getDate()}</span>
          <span class="calendar-day-sub">${escapeHtml(date.toLocaleDateString(undefined, { month: 'short' }))}</span>
        </div>
      `);
    }
    return `
      <div class="calendar-grid-shell">
        <div class="calendar-weekdays">
          ${CALENDAR_WEEKDAYS.map((day) => `<span>${day}</span>`).join('')}
        </div>
        <div class="calendar-days calendar-days-week">${dayCells.join('')}</div>
      </div>
    `;
  }

  private renderHeaderCalendar(container: HTMLElement): void {
    const today = localNoonDate(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
    const todayKey = getCalendarDateKey(today);
    let periodStart: Date;
    let periodEnd: Date;
    let periodLabel: string;
    let prevLabel: string;
    let nextLabel: string;
    let periodGridMarkup: string;
    let milestonesTitle = 'Key Dates This Month';

    if (this.calendarView === 'week') {
      const weekStart = startOfWeek(this.calendarDisplayDate);
      const weekEnd = endOfWeek(this.calendarDisplayDate);
      periodStart = weekStart;
      periodEnd = weekEnd;
      periodLabel = `${weekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} - ${weekEnd.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
      prevLabel = 'Previous week';
      nextLabel = 'Next week';
      milestonesTitle = 'Key Dates This Week';
      const milestones = getCalendarMilestonesForRange(periodStart, periodEnd, 24);
      const milestoneMap = new Map<string, CalendarMilestone[]>();
      for (const milestone of milestones) {
        const key = getCalendarDateKey(milestone.date);
        const list = milestoneMap.get(key) ?? [];
        list.push(milestone);
        milestoneMap.set(key, list);
      }
      periodGridMarkup = this.renderCalendarWeekGrid(weekStart, todayKey, milestoneMap);
    } else if (this.calendarView === 'quarter') {
      const quarterStart = startOfQuarter(this.calendarDisplayDate);
      const quarterEnd = endOfQuarter(this.calendarDisplayDate);
      periodStart = quarterStart;
      periodEnd = quarterEnd;
      const quarterNumber = Math.floor(quarterStart.getMonth() / 3) + 1;
      periodLabel = `Q${quarterNumber} ${quarterStart.getFullYear()} (${quarterStart.toLocaleDateString(undefined, { month: 'short' })} - ${quarterEnd.toLocaleDateString(undefined, { month: 'short' })})`;
      prevLabel = 'Previous quarter';
      nextLabel = 'Next quarter';
      milestonesTitle = 'Key Dates This Quarter';
      const milestones = getCalendarMilestonesForRange(periodStart, periodEnd, 96);
      const milestoneMap = new Map<string, CalendarMilestone[]>();
      for (const milestone of milestones) {
        const key = getCalendarDateKey(milestone.date);
        const list = milestoneMap.get(key) ?? [];
        list.push(milestone);
        milestoneMap.set(key, list);
      }
      const monthCards = [0, 1, 2].map((offset) => {
        const monthStart = localNoonDate(quarterStart.getFullYear(), quarterStart.getMonth() + offset, 1);
        const isPrideMonth = monthStart.getMonth() === 5;
        return `
          <section class="calendar-quarter-month ${isPrideMonth ? 'pride-month' : ''}">
            <h4 class="calendar-quarter-month-title">${escapeHtml(monthStart.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}</h4>
            ${this.renderCalendarMonthGrid(monthStart, todayKey, milestoneMap, true)}
          </section>
        `;
      }).join('');
      periodGridMarkup = `<div class="calendar-quarter-list">${monthCards}</div>`;
    } else {
      const monthStart = localNoonDate(this.calendarDisplayDate.getFullYear(), this.calendarDisplayDate.getMonth(), 1);
      const monthEnd = localNoonDate(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
      periodStart = monthStart;
      periodEnd = monthEnd;
      periodLabel = monthStart.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      prevLabel = 'Previous month';
      nextLabel = 'Next month';
      milestonesTitle = 'Key Dates This Month';
      const milestones = getCalendarMilestonesForRange(periodStart, periodEnd, 48);
      const milestoneMap = new Map<string, CalendarMilestone[]>();
      for (const milestone of milestones) {
        const key = getCalendarDateKey(milestone.date);
        const list = milestoneMap.get(key) ?? [];
        list.push(milestone);
        milestoneMap.set(key, list);
      }
      periodGridMarkup = this.renderCalendarMonthGrid(monthStart, todayKey, milestoneMap);
    }

    const categoryLabels: Record<CalendarMilestoneCategory, string> = {
      holiday: 'Holiday',
      dst: 'DST',
      season: 'Season',
    };
    const periodMilestones = getCalendarMilestonesForRange(periodStart, periodEnd, 12);
    const milestoneRows = periodMilestones.length > 0
      ? periodMilestones.map((item) => {
        const shortDate = item.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        return `
          <li class="calendar-milestone ${item.category}">
            <span class="calendar-milestone-date">${escapeHtml(shortDate)}</span>
            <span class="calendar-milestone-label">${escapeHtml(item.label)}</span>
            <span class="calendar-milestone-tag">${categoryLabels[item.category]}</span>
          </li>
        `;
      }).join('')
      : '<li class="calendar-milestone-empty">No highlighted dates in this view.</li>';
    const todayInCurrentView = today.getTime() >= periodStart.getTime() && today.getTime() <= periodEnd.getTime();

    container.innerHTML = `
      <div class="calendar-popover">
        <div class="calendar-head">
          <button class="calendar-nav-btn" data-calendar-nav="-1" title="${escapeHtml(prevLabel)}" aria-label="${escapeHtml(prevLabel)}">‹</button>
          <div class="calendar-month">${escapeHtml(periodLabel)}</div>
          <button class="calendar-nav-btn" data-calendar-nav="1" title="${escapeHtml(nextLabel)}" aria-label="${escapeHtml(nextLabel)}">›</button>
        </div>
        <div class="calendar-head-sub">
          <div class="calendar-today">${today.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</div>
          <button class="calendar-today-btn ${todayInCurrentView ? 'is-current' : ''}" data-calendar-today title="Jump to today">Today</button>
        </div>
        <div class="calendar-view-tabs">
          <button class="calendar-view-tab ${this.calendarView === 'week' ? 'active' : ''}" data-calendar-view="week">Week</button>
          <button class="calendar-view-tab ${this.calendarView === 'month' ? 'active' : ''}" data-calendar-view="month">Month</button>
          <button class="calendar-view-tab ${this.calendarView === 'quarter' ? 'active' : ''}" data-calendar-view="quarter">Quarter</button>
        </div>
        ${periodGridMarkup}
        <div class="calendar-milestones">
          <div class="calendar-milestones-title">${milestonesTitle}</div>
          <ul>${milestoneRows}</ul>
        </div>
      </div>
    `;
  }

  private setupHeaderWeather(): void {
    const menu = document.getElementById('weatherMenu');
    const button = document.getElementById('weatherBtn');
    const dropdown = document.getElementById('weatherDropdown');
    if (!(menu instanceof HTMLElement) || !(button instanceof HTMLButtonElement) || !(dropdown instanceof HTMLElement)) {
      return;
    }

    const openMenu = async (): Promise<void> => {
      this.closeHeaderCalendar();
      menu.classList.add('open');
      dropdown.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      this.renderWeatherLoading(dropdown);
      await this.refreshToolbarWeather({ force: false, renderIfOpen: true });
    };

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (menu.classList.contains('open')) {
        this.closeHeaderWeather();
      } else {
        void openMenu();
      }
    });

    dropdown.addEventListener('click', (event) => {
      event.stopPropagation();
      const target = event.target instanceof HTMLElement ? event.target : null;
      const tabBtn = target?.closest<HTMLElement>('[data-weather-tab]');
      if (tabBtn?.dataset.weatherTab) {
        const requested = tabBtn.dataset.weatherTab as WeatherTab;
        if (requested === 'today' || requested === 'seven' || requested === 'ten') {
          this.weatherActiveTab = requested;
          if (this.weatherDataCache) {
            const count = requested === 'seven' ? 7 : requested === 'ten' ? 10 : 1;
            const visibleDays = this.weatherDataCache.days.slice(0, count);
            if (requested === 'today') {
              this.weatherSelectedDayIso = visibleDays[0]?.dateIso ?? null;
            } else if (!this.weatherSelectedDayIso || !visibleDays.some((day) => day.dateIso === this.weatherSelectedDayIso)) {
              this.weatherSelectedDayIso = visibleDays[0]?.dateIso ?? null;
            }
            this.renderHeaderWeather(dropdown, this.weatherDataCache);
          }
        }
        return;
      }
      const dayBtn = target?.closest<HTMLElement>('[data-weather-day]');
      if (dayBtn?.dataset.weatherDay && this.weatherDataCache) {
        this.weatherSelectedDayIso = dayBtn.dataset.weatherDay;
        this.renderHeaderWeather(dropdown, this.weatherDataCache);
        return;
      }
      const refreshBtn = target?.closest<HTMLElement>('[data-weather-refresh]');
      if (refreshBtn) {
        this.renderWeatherLoading(dropdown);
        void this.refreshToolbarWeather({ force: true, renderIfOpen: true });
      }
    });

    this.boundWeatherOutsideClickHandler = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!menu.contains(target)) this.closeHeaderWeather();
    };
    document.addEventListener('click', this.boundWeatherOutsideClickHandler);

    this.boundWeatherKeydownHandler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') this.closeHeaderWeather();
    };
    document.addEventListener('keydown', this.boundWeatherKeydownHandler);

    void this.refreshToolbarWeather({ force: false, renderIfOpen: false });
    this.weatherRefreshIntervalId = setInterval(() => {
      void this.refreshToolbarWeather({ force: true, renderIfOpen: menu.classList.contains('open') });
    }, WEATHER_CACHE_MS);
  }

  private closeHeaderWeather(): void {
    const menu = document.getElementById('weatherMenu');
    const button = document.getElementById('weatherBtn');
    const dropdown = document.getElementById('weatherDropdown');
    if (menu) menu.classList.remove('open');
    if (dropdown) dropdown.hidden = true;
    if (button instanceof HTMLButtonElement) {
      button.setAttribute('aria-expanded', 'false');
    }
  }

  private renderWeatherLoading(container: HTMLElement): void {
    container.innerHTML = `
      <div class="weather-popover">
        <div class="weather-loading">Loading Back Bay weather...</div>
      </div>
    `;
  }

  private renderWeatherError(container: HTMLElement, message: string): void {
    container.innerHTML = `
      <div class="weather-popover">
        <div class="weather-error">${escapeHtml(message)}</div>
        <button class="weather-refresh-btn" data-weather-refresh>Retry</button>
      </div>
    `;
  }

  private renderHeaderWeather(container: HTMLElement, data: ToolbarWeatherData): void {
    const current = data.current;
    const today = data.days[0];
    const tabs: Array<{ id: WeatherTab; label: string }> = [
      { id: 'today', label: 'Today' },
      { id: 'seven', label: '7-Day' },
      { id: 'ten', label: '10-Day' },
    ];
    const dayCount = this.weatherActiveTab === 'seven' ? 7 : this.weatherActiveTab === 'ten' ? 10 : 1;
    const rows = data.days.slice(0, dayCount);
    if (rows.length > 0 && (!this.weatherSelectedDayIso || !rows.some((day) => day.dateIso === this.weatherSelectedDayIso))) {
      this.weatherSelectedDayIso = rows[0]?.dateIso ?? null;
    }
    const selectedDay = rows.find((day) => day.dateIso === this.weatherSelectedDayIso) ?? rows[0];
    const selectedDayHours = selectedDay
      ? (data.hourlyByDate[selectedDay.dateIso] ?? []).filter((_, index) => index % 3 === 0)
      : [];
    const computedSnowIn = selectedDay
      ? toRounded((data.hourlyByDate[selectedDay.dateIso] ?? []).reduce((sum, hour) => sum + (hour.snowIn ?? 0), 0), 2)
      : null;
    const selectedDaySnowIn = selectedDay?.snowTotalIn ?? computedSnowIn ?? null;
    const hasSnowSignal = Boolean(
      selectedDay && ((selectedDaySnowIn ?? 0) > 0 || isSnowWeatherCode(selectedDay.weatherCode)),
    );
    const selectedDayDate = selectedDay ? new Date(`${selectedDay.dateIso}T12:00:00`) : null;
    const springStart = selectedDayDate
      ? localNoonDate(selectedDayDate.getFullYear(), 2, 20)
      : null;
    const showSnowPrompt = Boolean(
      hasSnowSignal
      && selectedDay
      && selectedDayDate
      && springStart
      && selectedDayDate.getTime() < springStart.getTime(),
    );
    const daysUntilSpring = (selectedDayDate && springStart)
      ? Math.max(0, Math.ceil((springStart.getTime() - selectedDayDate.getTime()) / (24 * 60 * 60 * 1000)))
      : null;
    const snowRange = (selectedDaySnowIn != null && selectedDaySnowIn > 0)
      ? estimateSnowRangeIn(selectedDaySnowIn)
      : null;
    const majorCount = data.alerts.filter((a) => a.isMajor).length;
    const fetchedStamp = new Date(data.fetchedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    const todayMarkup = `
      <div class="weather-now">
        <div class="weather-now-top">
          <span class="weather-now-icon">${weatherCodeToIcon(current.weatherCode)}</span>
          <div class="weather-now-main">
            <div class="weather-now-temp">${current.temperatureF != null ? `${current.temperatureF}°F` : '--'}</div>
            <div class="weather-now-text">${escapeHtml(weatherCodeToText(current.weatherCode))}</div>
          </div>
        </div>
        <div class="weather-metrics">
          <span>Feels ${current.feelsLikeF != null ? `${current.feelsLikeF}°F` : '--'}</span>
          <span>Humidity ${current.humidityPct != null ? `${current.humidityPct}%` : '--'}</span>
          <span>Wind ${current.windMph != null ? `${current.windMph} mph` : '--'}</span>
          <span>Precip ${today?.precipChancePct != null ? `${today.precipChancePct}%` : '--'}</span>
          <span>Snow ${today?.snowTotalIn != null ? `${today.snowTotalIn} in` : '0 in'}</span>
          <span>High/Low ${today?.highF != null ? `${today.highF}°` : '--'}/${today?.lowF != null ? `${today.lowF}°` : '--'}</span>
        </div>
      </div>
    `;

    const listMarkup = rows.map((day) => `
      <li class="weather-day-row ${day.dateIso === this.weatherSelectedDayIso ? 'selected' : ''}">
        <button class="weather-day-btn" data-weather-day="${escapeHtml(day.dateIso)}">
          <span class="weather-day-name">${escapeHtml(day.dayLabel)}</span>
          <span class="weather-day-icon">${weatherCodeToIcon(day.weatherCode)}</span>
          <span class="weather-day-desc">${escapeHtml(weatherCodeToText(day.weatherCode))}</span>
          <span class="weather-day-temp">
            ${day.highF != null ? `${day.highF}°` : '--'}/${day.lowF != null ? `${day.lowF}°` : '--'}
            <small>
              Feels ${day.feelsHighF != null ? `${day.feelsHighF}°` : '--'}/${day.feelsLowF != null ? `${day.feelsLowF}°` : '--'}
              · Precip ${day.precipChancePct != null ? `${day.precipChancePct}%` : '--'}
            </small>
          </span>
        </button>
      </li>
    `).join('');

    const hourlyMarkup = selectedDayHours.length > 0
      ? `
        <div class="weather-hourly">
          <div class="weather-hourly-title">Hourly Breakdown</div>
          <ul class="weather-hourly-list">
            ${selectedDayHours.map((hour) => `
              <li class="weather-hourly-row">
                <span class="weather-hourly-time">${escapeHtml(hour.timeLabel)}</span>
                <span class="weather-hourly-cond">${weatherCodeToIcon(hour.weatherCode)} ${escapeHtml(weatherCodeToText(hour.weatherCode))}</span>
                <span class="weather-hourly-temp">${hour.temperatureF != null ? `${hour.temperatureF}°F` : '--'}</span>
                <span class="weather-hourly-metrics">
                  Feels ${hour.feelsLikeF != null ? `${hour.feelsLikeF}°` : '--'} · Precip ${hour.precipChancePct != null ? `${hour.precipChancePct}%` : '--'} (${hour.precipIn != null ? `${hour.precipIn} in` : '--'}) · Snow ${hour.snowIn != null ? `${hour.snowIn} in` : '0 in'}
                </span>
              </li>
            `).join('')}
          </ul>
        </div>
      `
      : '<div class="weather-hourly-empty">Hourly details unavailable for this day.</div>';

    const selectedDayDetailMarkup = selectedDay ? `
      <div class="weather-day-detail">
        <div class="weather-day-detail-head">
          <div class="weather-day-detail-title">${this.weatherActiveTab === 'today' ? 'Today Detail' : 'Selected Day Detail'}</div>
          <div class="weather-day-detail-date">${escapeHtml(selectedDay.dayLabel)}</div>
        </div>
        <div class="weather-day-detail-condition">${weatherCodeToIcon(selectedDay.weatherCode)} ${escapeHtml(weatherCodeToText(selectedDay.weatherCode))}</div>
        <div class="weather-day-detail-grid">
          <span>High/Low ${selectedDay.highF != null ? `${selectedDay.highF}°` : '--'}/${selectedDay.lowF != null ? `${selectedDay.lowF}°` : '--'}</span>
          <span>Feels ${selectedDay.feelsHighF != null ? `${selectedDay.feelsHighF}°` : '--'}/${selectedDay.feelsLowF != null ? `${selectedDay.feelsLowF}°` : '--'}</span>
          <span>Precip ${selectedDay.precipChancePct != null ? `${selectedDay.precipChancePct}%` : '--'}</span>
          <span>Wind ${selectedDay.windMaxMph != null ? `${selectedDay.windMaxMph} mph` : '--'}</span>
          <span>Snowfall ${snowRange ? `${snowRange.lowIn}-${snowRange.highIn} in` : (selectedDaySnowIn != null ? `${selectedDaySnowIn} in` : '0 in')}</span>
        </div>
        ${showSnowPrompt
          ? `
            <div class="weather-snow-note">
              <div class="weather-spring-countdown">Days until Spring: ${daysUntilSpring ?? '--'}</div>
            </div>
          `
          : ''}
        ${hourlyMarkup}
      </div>
    ` : '';

    const alertsMarkup = data.alerts.length > 0
      ? data.alerts.slice(0, 3).map((alert) => `
        <li class="weather-alert-row ${alert.isMajor ? 'major' : ''}">
          <span class="weather-alert-severity">${escapeHtml(alert.severity)}</span>
          <span class="weather-alert-event">${escapeHtml(alert.event)}</span>
        </li>
      `).join('')
      : '<li class="weather-alert-empty">No local active NWS alerts.</li>';

    container.innerHTML = `
      <div class="weather-popover">
        <div class="weather-head">
          <div class="weather-title">Boston Weather</div>
          <div class="weather-subtitle">${escapeHtml(data.locationLabel)}</div>
        </div>
        <div class="weather-toolbar">
          ${tabs.map((tab) => `<button class="weather-tab ${this.weatherActiveTab === tab.id ? 'active' : ''}" data-weather-tab="${tab.id}">${tab.label}</button>`).join('')}
          <button class="weather-refresh-btn" data-weather-refresh>Refresh</button>
        </div>
        ${this.weatherActiveTab === 'today'
          ? `${todayMarkup}${selectedDayDetailMarkup}`
          : `<ul class="weather-day-list">${listMarkup}</ul>${selectedDayDetailMarkup}`}
        <div class="weather-alerts ${majorCount > 0 ? 'has-major' : ''}">
          <div class="weather-alerts-title">${majorCount > 0 ? '⚠ Active Weather Alerts' : 'Local Alerts'}${majorCount > 0 ? ` (${majorCount} major)` : ''}</div>
          <ul>${alertsMarkup}</ul>
          ${data.alertFetchError ? `<div class="weather-alert-note">${escapeHtml(data.alertFetchError)}</div>` : ''}
        </div>
        <div class="weather-foot">Updated ${escapeHtml(fetchedStamp)} · ${escapeHtml(data.sourceLabel)}</div>
      </div>
    `;
  }

  private updateWeatherBadge(data: ToolbarWeatherData | null): void {
    const badge = document.getElementById('weatherAlertBadge');
    const button = document.getElementById('weatherBtn');
    const menu = document.getElementById('weatherMenu');
    if (!(badge instanceof HTMLElement) || !(button instanceof HTMLButtonElement) || !(menu instanceof HTMLElement)) return;

    const majorCount = data ? data.alerts.filter((alert) => alert.isMajor).length : 0;
    if (majorCount > 0) {
      badge.hidden = false;
      badge.textContent = '⚠';
      button.title = `Boston Weather (${majorCount} major alert${majorCount === 1 ? '' : 's'})`;
      menu.classList.add('has-alert');
    } else {
      badge.hidden = true;
      button.title = 'Boston Weather';
      menu.classList.remove('has-alert');
    }
  }

  private async loadToolbarWeather(force: boolean): Promise<ToolbarWeatherData> {
    if (!force && this.weatherDataCache && (Date.now() - this.weatherDataFetchedAt) < WEATHER_CACHE_MS) {
      return this.weatherDataCache;
    }

    if (this.weatherLoadingPromise) {
      return this.weatherLoadingPromise;
    }

    this.weatherLoadingPromise = fetchToolbarWeatherData()
      .then((data) => {
        this.weatherDataCache = data;
        this.weatherDataFetchedAt = Date.now();
        this.updateWeatherBadge(data);
        return data;
      })
      .finally(() => {
        this.weatherLoadingPromise = null;
      });

    return this.weatherLoadingPromise;
  }

  private async refreshToolbarWeather(options: { force: boolean; renderIfOpen: boolean }): Promise<void> {
    const dropdown = document.getElementById('weatherDropdown');
    const menu = document.getElementById('weatherMenu');
    const shouldRender = options.renderIfOpen && menu instanceof HTMLElement && menu.classList.contains('open');
    if (shouldRender && dropdown instanceof HTMLElement) {
      this.renderWeatherLoading(dropdown);
    }
    try {
      const data = await this.loadToolbarWeather(options.force);
      if (shouldRender && dropdown instanceof HTMLElement) {
        this.renderHeaderWeather(dropdown, data);
      }
    } catch (error) {
      if (shouldRender && dropdown instanceof HTMLElement) {
        this.renderWeatherError(dropdown, error instanceof Error ? error.message : String(error));
      }
    }
  }

  private setupKonamiCode(): void {
    if (this.boundKonamiHandler) {
      document.removeEventListener('keydown', this.boundKonamiHandler);
    }

    this.boundKonamiHandler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (this.isTypingTarget(event.target)) {
        this.konamiProgress = 0;
        return;
      }

      const key = event.key.toLowerCase();
      const expected = EventHandlerManager.KONAMI_SEQUENCE[this.konamiProgress];

      if (key === expected) {
        this.konamiProgress += 1;
        if (this.konamiProgress === EventHandlerManager.KONAMI_SEQUENCE.length) {
          this.konamiProgress = 0;
          this.showKonamiPopup();
          this.launchKonamiConfetti();
        }
        return;
      }

      this.konamiProgress = key === EventHandlerManager.KONAMI_SEQUENCE[0] ? 1 : 0;
    };

    document.addEventListener('keydown', this.boundKonamiHandler);
  }

  private isTypingTarget(target: EventTarget | null): boolean {
    const element = target instanceof HTMLElement ? target : null;
    if (!element) return false;
    if (element.isContentEditable) return true;
    if (element.closest('[contenteditable=""], [contenteditable="true"], [contenteditable]')) {
      return true;
    }
    return element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT';
  }

  private showKonamiPopup(): void {
    this.removeKonamiPopup();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay active konami-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Konami celebration');

    const modal = document.createElement('div');
    modal.className = 'modal konami-modal';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'modal-close konami-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';

    const headline = document.createElement('h2');
    headline.className = 'konami-headline';
    headline.textContent = 'He-HEYYYY!!!';

    modal.append(closeBtn, headline);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    this.konamiOverlay = overlay;

    const dismiss = () => this.removeKonamiPopup();
    closeBtn.addEventListener('click', dismiss);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) dismiss();
    });

    this.konamiAutoCloseTimeoutId = setTimeout(() => {
      this.removeKonamiPopup();
    }, 5000);
  }

  private removeKonamiPopup(): void {
    if (this.konamiAutoCloseTimeoutId) {
      clearTimeout(this.konamiAutoCloseTimeoutId);
      this.konamiAutoCloseTimeoutId = null;
    }
    if (this.konamiOverlay) {
      this.konamiOverlay.remove();
      this.konamiOverlay = null;
    }
  }

  private launchKonamiConfetti(): void {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const base = {
      particleCount: 120,
      spread: 90,
      startVelocity: 42,
      ticks: 220,
      scalar: 1.1,
      zIndex: 2000,
    };
    void confetti({
      ...base,
      angle: 60,
      origin: { x: 0.1, y: 0.72 },
    });
    void confetti({
      ...base,
      angle: 120,
      origin: { x: 0.9, y: 0.72 },
    });
  }

  private setupIdleDetection(): void {
    this.boundIdleResetHandler = () => {
      if (this.ctx.isIdle) {
        this.ctx.isIdle = false;
        document.body.classList.remove('animations-paused');
      }
      this.resetIdleTimer();
    };

    ['mousedown', 'keydown', 'scroll', 'touchstart', 'mousemove'].forEach(event => {
      document.addEventListener(event, this.boundIdleResetHandler!, { passive: true });
    });

    this.resetIdleTimer();
  }

  resetIdleTimer(): void {
    if (this.idleTimeoutId) {
      clearTimeout(this.idleTimeoutId);
    }
    this.idleTimeoutId = setTimeout(() => {
      if (!document.hidden) {
        this.ctx.isIdle = true;
        document.body.classList.add('animations-paused');
        console.log('[App] User idle - pausing animations to save resources');
      }
    }, this.IDLE_PAUSE_MS);
  }

  setupUrlStateSync(): void {
    if (!this.ctx.map) return;

    this.ctx.map.onStateChanged(() => {
      this.debouncedUrlSync();
      const regionSelect = document.getElementById('regionSelect') as HTMLSelectElement;
      if (regionSelect && this.ctx.map) {
        const state = this.ctx.map.getState();
        if (regionSelect.value !== state.view) {
          regionSelect.value = state.view;
        }
      }
    });
    this.debouncedUrlSync();
  }

  syncUrlState(): void {
    this.debouncedUrlSync();
  }

  getShareUrl(): string | null {
    if (!this.ctx.map) return null;
    const state = this.ctx.map.getState();
    const center = this.ctx.map.getCenter();
    const baseUrl = `${window.location.origin}${window.location.pathname}`;
    return buildMapUrl(baseUrl, {
      view: state.view,
      zoom: state.zoom,
      center,
      timeRange: state.timeRange,
      layers: state.layers,
      country: this.ctx.countryBriefPage?.isVisible() ? (this.ctx.countryBriefPage.getCode() ?? undefined) : undefined,
    });
  }

  private async copyToClipboard(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }

  private setCopyLinkFeedback(button: HTMLElement | null, message: string): void {
    if (!button) return;
    const originalText = button.textContent ?? '';
    button.textContent = message;
    button.classList.add('copied');
    window.setTimeout(() => {
      button.textContent = originalText;
      button.classList.remove('copied');
    }, 1500);
  }

  toggleFullscreen(): void {
    if (document.fullscreenElement) {
      try { void document.exitFullscreen()?.catch(() => {}); } catch {}
    } else {
      const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
      if (el.requestFullscreen) {
        try { void el.requestFullscreen()?.catch(() => {}); } catch {}
      } else if (el.webkitRequestFullscreen) {
        try { el.webkitRequestFullscreen(); } catch {}
      }
    }
  }

  updateHeaderThemeIcon(): void {
    const btn = document.getElementById('headerThemeToggle');
    if (!btn) return;
    const isDark = getCurrentTheme() === 'dark';
    btn.innerHTML = isDark
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>';
  }

  startHeaderClock(): void {
    const el = document.getElementById('headerClock');
    if (!el) return;
    const tick = () => {
      el.textContent = new Date().toUTCString().replace('GMT', 'UTC');
    };
    tick();
    this.clockIntervalId = setInterval(tick, 1000);
  }

  setupMobileWarning(): void {
    if (MobileWarningModal.shouldShow()) {
      this.ctx.mobileWarningModal = new MobileWarningModal();
      this.ctx.mobileWarningModal.show();
    }
  }

  setupStatusPanel(): void {
    this.ctx.statusPanel = new StatusPanel();
    const headerLeft = this.ctx.container.querySelector('.header-left');
    if (headerLeft) {
      headerLeft.appendChild(this.ctx.statusPanel.getElement());
    }
  }

  setupPizzIntIndicator(): void {
    if (SITE_VARIANT !== 'full') return;

    this.ctx.pizzintIndicator = new PizzIntIndicator();
    const headerLeft = this.ctx.container.querySelector('.header-left');
    if (headerLeft) {
      headerLeft.appendChild(this.ctx.pizzintIndicator.getElement());
    }
  }

  setupExportPanel(): void {
    this.ctx.exportPanel = new ExportPanel(() => ({
      news: this.ctx.latestClusters.length > 0 ? this.ctx.latestClusters : this.ctx.allNews,
      markets: this.ctx.latestMarkets,
      predictions: this.ctx.latestPredictions,
      timestamp: Date.now(),
    }));

    const headerRight = this.ctx.container.querySelector('.header-right');
    if (headerRight) {
      headerRight.insertBefore(this.ctx.exportPanel.getElement(), headerRight.firstChild);
    }
  }

  setupUnifiedSettings(): void {
    this.ctx.unifiedSettings = new UnifiedSettings({
      getPanelSettings: () => this.ctx.panelSettings,
      togglePanel: (key: string) => {
        const config = this.ctx.panelSettings[key];
        if (config) {
          config.enabled = !config.enabled;
          trackPanelToggled(key, config.enabled);
          saveToStorage(STORAGE_KEYS.panels, this.ctx.panelSettings);
          this.applyPanelSettings();
        }
      },
      getDisabledSources: () => this.ctx.disabledSources,
      toggleSource: (name: string) => {
        if (this.ctx.disabledSources.has(name)) {
          this.ctx.disabledSources.delete(name);
        } else {
          this.ctx.disabledSources.add(name);
        }
        saveToStorage(STORAGE_KEYS.disabledFeeds, Array.from(this.ctx.disabledSources));
      },
      setSourcesEnabled: (names: string[], enabled: boolean) => {
        for (const name of names) {
          if (enabled) this.ctx.disabledSources.delete(name);
          else this.ctx.disabledSources.add(name);
        }
        saveToStorage(STORAGE_KEYS.disabledFeeds, Array.from(this.ctx.disabledSources));
      },
      getAllSourceNames: () => this.getAllSourceNames(),
      getLocalizedPanelName: (key: string, fallback: string) => this.getLocalizedPanelName(key, fallback),
      isDesktopApp: this.ctx.isDesktopApp,
    });

    const mount = document.getElementById('unifiedSettingsMount');
    if (mount) {
      mount.appendChild(this.ctx.unifiedSettings.getButton());
    }
  }

  setupPlaybackControl(): void {
    this.ctx.playbackControl = new PlaybackControl();
    this.ctx.playbackControl.onSnapshot((snapshot) => {
      if (snapshot) {
        this.ctx.isPlaybackMode = true;
        this.restoreSnapshot(snapshot);
      } else {
        this.ctx.isPlaybackMode = false;
        this.callbacks.loadAllData();
      }
    });

    const headerRight = this.ctx.container.querySelector('.header-right');
    if (headerRight) {
      headerRight.insertBefore(this.ctx.playbackControl.getElement(), headerRight.firstChild);
    }
  }

  setupSnapshotSaving(): void {
    const saveCurrentSnapshot = async () => {
      if (this.ctx.isPlaybackMode || this.ctx.isDestroyed) return;

      const marketPrices: Record<string, number> = {};
      this.ctx.latestMarkets.forEach(m => {
        if (m.price !== null) marketPrices[m.symbol] = m.price;
      });

      await saveSnapshot({
        timestamp: Date.now(),
        events: this.ctx.latestClusters,
        marketPrices,
        predictions: this.ctx.latestPredictions.map(p => ({
          title: p.title,
          yesPrice: p.yesPrice
        })),
        hotspotLevels: this.ctx.map?.getHotspotLevels() ?? {}
      });
    };

    void saveCurrentSnapshot().catch((e) => console.warn('[Snapshot] save failed:', e));
    this.snapshotIntervalId = setInterval(() => void saveCurrentSnapshot().catch((e) => console.warn('[Snapshot] save failed:', e)), 15 * 60 * 1000);
  }

  restoreSnapshot(snapshot: DashboardSnapshot): void {
    for (const panel of Object.values(this.ctx.newsPanels)) {
      panel.showLoading();
    }

    const events = snapshot.events as ClusteredEvent[];
    this.ctx.latestClusters = events;

    const predictions = snapshot.predictions.map((p, i) => ({
      id: `snap-${i}`,
      title: p.title,
      yesPrice: p.yesPrice,
      noPrice: 100 - p.yesPrice,
      volume24h: 0,
      liquidity: 0,
    }));
    this.ctx.latestPredictions = predictions;
    (this.ctx.panels['polymarket'] as PredictionPanel).renderPredictions(predictions);

    this.ctx.map?.setHotspotLevels(snapshot.hotspotLevels);
  }

  setupMapLayerHandlers(): void {
    this.ctx.map?.setOnLayerChange((layer, enabled, source) => {
      console.log(`[App.onLayerChange] ${layer}: ${enabled} (${source})`);
      trackMapLayerToggle(layer, enabled, source);
      this.ctx.mapLayers[layer] = enabled;
      saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
      this.syncUrlState();

      const sourceIds = LAYER_TO_SOURCE[layer];
      if (sourceIds) {
        for (const sourceId of sourceIds) {
          dataFreshness.setEnabled(sourceId, enabled);
        }
      }

      if (layer === 'ais') {
        if (enabled) {
          this.ctx.map?.setLayerLoading('ais', true);
          initAisStream();
          this.callbacks.waitForAisData();
        } else {
          disconnectAisStream();
        }
        return;
      }

      if (enabled) {
        this.callbacks.loadDataForLayer(layer);
      }
    });
  }

  setupPanelViewTracking(): void {
    const viewedPanels = new Set<string>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio >= 0.3) {
          const id = (entry.target as HTMLElement).dataset.panel;
          if (id && !viewedPanels.has(id)) {
            viewedPanels.add(id);
            trackPanelView(id);
          }
        }
      }
    }, { threshold: 0.3 });

    const grid = document.getElementById('panelsGrid');
    if (grid) {
      for (const child of Array.from(grid.children)) {
        if ((child as HTMLElement).dataset.panel) {
          observer.observe(child);
        }
      }
    }
  }

  showToast(msg: string): void {
    document.querySelector('.toast-notification')?.remove();
    const el = document.createElement('div');
    el.className = 'toast-notification';
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('visible'));
    setTimeout(() => { el.classList.remove('visible'); setTimeout(() => el.remove(), 300); }, 3000);
  }

  shouldShowIntelligenceNotifications(): boolean {
    return !this.ctx.isMobile && !!this.ctx.findingsBadge?.isPopupEnabled();
  }

  setupMapResize(): void {
    const mapSection = document.getElementById('mapSection');
    const resizeHandle = document.getElementById('mapResizeHandle');
    if (!mapSection || !resizeHandle) return;

    const getMinHeight = () => (window.innerWidth >= 2000 ? 320 : 400);
    const getMaxHeight = () => Math.max(getMinHeight(), window.innerHeight - 60);

    const savedHeight = localStorage.getItem('map-height');
    if (savedHeight) {
      const numeric = Number.parseInt(savedHeight, 10);
      if (Number.isFinite(numeric)) {
        const clamped = Math.max(getMinHeight(), Math.min(numeric, getMaxHeight()));
        mapSection.style.height = `${clamped}px`;
        if (clamped !== numeric) {
          localStorage.setItem('map-height', `${clamped}px`);
        }
      } else {
        localStorage.removeItem('map-height');
      }
    }

    let isResizing = false;
    let startY = 0;
    let startHeight = 0;

    resizeHandle.addEventListener('mousedown', (e) => {
      isResizing = true;
      startY = e.clientY;
      startHeight = mapSection.offsetHeight;
      mapSection.classList.add('resizing');
      document.body.style.cursor = 'ns-resize';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const deltaY = e.clientY - startY;
      const newHeight = Math.max(getMinHeight(), Math.min(startHeight + deltaY, getMaxHeight()));
      mapSection.style.height = `${newHeight}px`;
      this.ctx.map?.render();
    });

    document.addEventListener('mouseup', () => {
      if (!isResizing) return;
      isResizing = false;
      mapSection.classList.remove('resizing');
      document.body.style.cursor = '';
      localStorage.setItem('map-height', mapSection.style.height);
      this.ctx.map?.render();
    });
  }

  setupMapPin(): void {
    const mapSection = document.getElementById('mapSection');
    const pinBtn = document.getElementById('mapPinBtn');
    if (!mapSection || !pinBtn) return;

    const isPinned = localStorage.getItem('map-pinned') === 'true';
    if (isPinned) {
      mapSection.classList.add('pinned');
      pinBtn.classList.add('active');
    }

    pinBtn.addEventListener('click', () => {
      const nowPinned = mapSection.classList.toggle('pinned');
      pinBtn.classList.toggle('active', nowPinned);
      localStorage.setItem('map-pinned', String(nowPinned));
    });
  }

  getLocalizedPanelName(panelKey: string, fallback: string): string {
    if (panelKey === 'runtime-config') {
      return t('modals.runtimeConfig.title');
    }
    const key = panelKey.replace(/-([a-z])/g, (_match, group: string) => group.toUpperCase());
    const lookup = `panels.${key}`;
    const localized = t(lookup);
    return localized === lookup ? fallback : localized;
  }

  getAllSourceNames(): string[] {
    const sources = new Set<string>();
    Object.values(FEEDS).forEach(feeds => {
      if (feeds) feeds.forEach(f => sources.add(f.name));
    });
    INTEL_SOURCES.forEach(f => sources.add(f.name));
    return Array.from(sources).sort((a, b) => a.localeCompare(b));
  }

  applyPanelSettings(): void {
    Object.entries(this.ctx.panelSettings).forEach(([key, config]) => {
      if (key === 'map') {
        const mapSection = document.getElementById('mapSection');
        if (mapSection) {
          mapSection.classList.toggle('hidden', !config.enabled);
        }
        return;
      }
      const panel = this.ctx.panels[key];
      panel?.toggle(config.enabled);
    });
  }
}
