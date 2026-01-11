import { Panel } from './Panel';

interface LiveChannel {
  id: string;
  name: string;
  videoId: string;
}

const LIVE_CHANNELS: LiveChannel[] = [
  { id: 'aljazeera', name: 'Al Jazeera', videoId: 'gCNeDWCI0vo' },
  { id: 'sky', name: 'Sky News', videoId: 'YDvsBbKfLPA' },
  { id: 'bloomberg', name: 'Bloomberg', videoId: 'iEpJwprxDdk' },
  { id: 'france24', name: 'France 24', videoId: 'Ap-UM1O9RBU' },
  { id: 'dw', name: 'DW News', videoId: 'LuKwFajn37U' },
  { id: 'euronews', name: 'Euronews', videoId: 'pykpO5kQJ98' },
  { id: 'alarabiya', name: 'Al Arabiya', videoId: 'n7eQejkXbnM' },
];

export class LiveNewsPanel extends Panel {
  private activeChannel: LiveChannel = LIVE_CHANNELS[0]!;
  private channelSwitcher: HTMLElement | null = null;

  constructor() {
    super({ id: 'live-news', title: 'Live News', showCount: false, trackActivity: false });
    this.element.classList.add('panel-wide');
    this.createChannelSwitcher();
    this.renderPlayer();
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

    this.renderPlayer();
  }

  private renderPlayer(): void {
    const embedUrl = `https://www.youtube.com/embed/${this.activeChannel.videoId}?autoplay=1&mute=1&rel=0`;

    this.content.innerHTML = `
      <div class="live-news-player">
        <iframe
          src="${embedUrl}"
          frameborder="0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowfullscreen
        ></iframe>
      </div>
    `;
  }

  public refresh(): void {
    this.renderPlayer();
  }
}
