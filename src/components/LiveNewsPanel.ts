import { Panel } from './Panel';

// YouTube IFrame Player API types
type YouTubePlayer = {
  mute(): void;
  unMute(): void;
  playVideo(): void;
  pauseVideo(): void;
  loadVideoById(videoId: string): void;
  cueVideoById(videoId: string): void;
  destroy(): void;
};

type YouTubePlayerConstructor = new (
  elementId: string | HTMLElement,
  options: {
    videoId: string;
    playerVars: Record<string, number | string>;
    events: {
      onReady: () => void;
    };
  },
) => YouTubePlayer;

type YouTubeNamespace = {
  Player: YouTubePlayerConstructor;
};

declare global {
  interface Window {
    YT?: YouTubeNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

interface LiveChannel {
  id: string;
  name: string;
  videoId: string;
}

const LIVE_CHANNELS: LiveChannel[] = [
  { id: 'bloomberg', name: 'Bloomberg', videoId: 'iEpJwprxDdk' },
  { id: 'sky', name: 'SkyNews', videoId: 'YDvsBbKfLPA' },
  { id: 'euronews', name: 'Euronews', videoId: 'pykpO5kQJ98' },
  { id: 'dw', name: 'DW', videoId: 'LuKwFajn37U' },
  { id: 'france24', name: 'France24', videoId: 'Ap-UM1O9RBU' },
  { id: 'alarabiya', name: 'AlArabiya', videoId: 'n7eQejkXbnM' },
  { id: 'aljazeera', name: 'AlJazeera', videoId: 'gCNeDWCI0vo' },
];

export class LiveNewsPanel extends Panel {
  private static apiPromise: Promise<void> | null = null;
  private activeChannel: LiveChannel = LIVE_CHANNELS[0]!;
  private channelSwitcher: HTMLElement | null = null;
  private isMuted = true;
  private isPlaying = true;
  private wasPlayingBeforeIdle = true;
  private muteBtn: HTMLButtonElement | null = null;
  private liveBtn: HTMLButtonElement | null = null;
  private idleTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly IDLE_PAUSE_MS = 5 * 60 * 1000; // 5 minutes
  private boundVisibilityHandler!: () => void;
  private boundIdleResetHandler!: () => void;

  // YouTube Player API state
  private player: YouTubePlayer | null = null;
  private playerContainer: HTMLDivElement | null = null;
  private playerElement: HTMLDivElement | null = null;
  private playerElementId: string;
  private isPlayerReady = false;
  private currentVideoId: string | null = null;

  constructor() {
    super({ id: 'live-news', title: 'Live News', showCount: false, trackActivity: false });
    this.playerElementId = `live-news-player-${Date.now()}`;
    this.element.classList.add('panel-wide');
    this.createLiveButton();
    this.createMuteButton();
    this.createChannelSwitcher();
    this.renderPlayer();
    this.setupIdleDetection();
  }

  private setupIdleDetection(): void {
    // Pause when tab becomes hidden
    this.boundVisibilityHandler = () => {
      if (document.hidden) {
        this.pauseForIdle();
      } else {
        this.resumeFromIdle();
      }
    };
    document.addEventListener('visibilitychange', this.boundVisibilityHandler);

    // Track user activity to detect idle
    this.boundIdleResetHandler = () => {
      if (this.idleTimeout) clearTimeout(this.idleTimeout);
      this.idleTimeout = setTimeout(() => this.pauseForIdle(), this.IDLE_PAUSE_MS);
    };

    ['mousedown', 'keydown', 'scroll', 'touchstart'].forEach(event => {
      document.addEventListener(event, this.boundIdleResetHandler, { passive: true });
    });

    // Start the idle timer
    this.boundIdleResetHandler();
  }

  private pauseForIdle(): void {
    if (this.isPlaying) {
      this.wasPlayingBeforeIdle = true;
      this.isPlaying = false;
      this.updateLiveIndicator();
    }
    // Destroy player completely to free memory (iframe consumes ~115 kB/s even when paused)
    this.destroyPlayer();
  }

  private destroyPlayer(): void {
    if (this.player) {
      this.player.destroy();
      this.player = null;
    }
    this.isPlayerReady = false;
    this.currentVideoId = null;
    // Clear the container to remove the iframe
    if (this.playerContainer) {
      this.playerContainer.innerHTML = '';
      // Recreate the player element for when we resume
      this.playerElement = document.createElement('div');
      this.playerElement.id = this.playerElementId;
      this.playerContainer.appendChild(this.playerElement);
    }
  }

  private resumeFromIdle(): void {
    if (this.wasPlayingBeforeIdle && !this.isPlaying) {
      this.isPlaying = true;
      this.updateLiveIndicator();
      // Reinitialize the player
      void this.initializePlayer();
    }
  }

  private createLiveButton(): void {
    this.liveBtn = document.createElement('button');
    this.liveBtn.className = 'live-indicator-btn';
    this.liveBtn.title = 'Toggle playback';
    this.updateLiveIndicator();
    this.liveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePlayback();
    });

    const header = this.element.querySelector('.panel-header');
    header?.appendChild(this.liveBtn);
  }

  private updateLiveIndicator(): void {
    if (!this.liveBtn) return;
    this.liveBtn.innerHTML = this.isPlaying
      ? '<span class="live-dot"></span>Live'
      : '<span class="live-dot paused"></span>Paused';
    this.liveBtn.classList.toggle('paused', !this.isPlaying);
  }

  private togglePlayback(): void {
    this.isPlaying = !this.isPlaying;
    this.wasPlayingBeforeIdle = this.isPlaying; // Track user intent
    this.updateLiveIndicator();
    this.syncPlayerState();
  }

  private createMuteButton(): void {
    this.muteBtn = document.createElement('button');
    this.muteBtn.className = 'live-mute-btn';
    this.muteBtn.title = 'Toggle sound';
    this.updateMuteIcon();
    this.muteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMute();
    });

    const header = this.element.querySelector('.panel-header');
    header?.appendChild(this.muteBtn);
  }

  private updateMuteIcon(): void {
    if (!this.muteBtn) return;
    this.muteBtn.innerHTML = this.isMuted
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
    this.muteBtn.classList.toggle('unmuted', !this.isMuted);
  }

  private toggleMute(): void {
    this.isMuted = !this.isMuted;
    this.updateMuteIcon();
    this.syncPlayerState();
  }

  private createChannelSwitcher(): void {
    this.channelSwitcher = document.createElement('div');
    this.channelSwitcher.className = 'live-news-switcher';

    LIVE_CHANNELS.forEach(channel => {
      const btn = document.createElement('button');
      btn.className = `live-channel-btn ${channel.id === this.activeChannel.id ? 'active' : ''}`;
      btn.dataset.channelId = channel.id;
      btn.textContent = channel.name;
      btn.addEventListener('click', () => this.switchChannel(channel));
      this.channelSwitcher!.appendChild(btn);
    });

    this.element.insertBefore(this.channelSwitcher, this.content);
  }

  private switchChannel(channel: LiveChannel): void {
    if (channel.id === this.activeChannel.id) return;

    this.activeChannel = channel;

    this.channelSwitcher?.querySelectorAll('.live-channel-btn').forEach(btn => {
      btn.classList.toggle('active', (btn as HTMLElement).dataset.channelId === channel.id);
    });

    this.syncPlayerState();
  }

  private renderPlayer(): void {
    this.ensurePlayerContainer();
    void this.initializePlayer();
  }

  private ensurePlayerContainer(): void {
    if (this.playerContainer && this.playerElement) return;

    this.content.innerHTML = '';
    this.playerContainer = document.createElement('div');
    this.playerContainer.className = 'live-news-player';

    this.playerElement = document.createElement('div');
    this.playerElement.id = this.playerElementId;
    this.playerContainer.appendChild(this.playerElement);

    this.content.appendChild(this.playerContainer);
  }

  private static loadYouTubeApi(): Promise<void> {
    if (LiveNewsPanel.apiPromise) return LiveNewsPanel.apiPromise;

    LiveNewsPanel.apiPromise = new Promise((resolve, reject) => {
      if (window.YT?.Player) {
        resolve();
        return;
      }

      const existingScript = document.querySelector<HTMLScriptElement>(
        'script[data-youtube-iframe-api="true"]',
      );

      if (existingScript) {
        if (window.YT?.Player) {
          resolve();
          return;
        }
        const previousReady = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => {
          previousReady?.();
          resolve();
        };
        return;
      }

      const previousReady = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previousReady?.();
        resolve();
      };

      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.dataset.youtubeIframeApi = 'true';
      script.onerror = () => reject(new Error('Failed to load YouTube IFrame API'));
      document.head.appendChild(script);
    });

    return LiveNewsPanel.apiPromise;
  }

  private async initializePlayer(): Promise<void> {
    if (this.player) return;
    await LiveNewsPanel.loadYouTubeApi();
    if (this.player || !this.playerElement) return;

    this.player = new window.YT!.Player(this.playerElement, {
      videoId: this.activeChannel.videoId,
      playerVars: {
        autoplay: this.isPlaying ? 1 : 0,
        mute: this.isMuted ? 1 : 0,
        rel: 0,
        playsinline: 1,
        origin: window.location.origin,
        enablejsapi: 1,
      },
      events: {
        onReady: () => {
          this.isPlayerReady = true;
          this.currentVideoId = this.activeChannel.videoId;
          this.syncPlayerState();
        },
      },
    });
  }

  private syncPlayerState(): void {
    if (!this.player || !this.isPlayerReady) return;

    // Handle channel switch
    if (this.currentVideoId !== this.activeChannel.videoId) {
      this.currentVideoId = this.activeChannel.videoId;
      if (this.isPlaying) {
        this.player.loadVideoById(this.activeChannel.videoId);
      } else {
        this.player.cueVideoById(this.activeChannel.videoId);
      }
    }

    // Handle mute state
    if (this.isMuted) {
      this.player.mute();
    } else {
      this.player.unMute();
    }

    // Handle play/pause state
    if (this.isPlaying) {
      this.player.playVideo();
    } else {
      this.player.pauseVideo();
    }
  }

  public refresh(): void {
    this.syncPlayerState();
  }

  public destroy(): void {
    // Clear idle timeout
    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
      this.idleTimeout = null;
    }

    // Remove global event listeners
    document.removeEventListener('visibilitychange', this.boundVisibilityHandler);
    ['mousedown', 'keydown', 'scroll', 'touchstart'].forEach(event => {
      document.removeEventListener(event, this.boundIdleResetHandler);
    });

    // Destroy YouTube player
    if (this.player) {
      this.player.destroy();
      this.player = null;
    }
    this.isPlayerReady = false;
    this.playerContainer = null;
    this.playerElement = null;

    // Call parent destroy
    super.destroy();
  }
}
