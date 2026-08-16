// Background music.
//
// Rides the `music` bus that already exists alongside engine, tyre and road,
// so its level is balanced against the car in the same place as everything
// else, and one master mute covers all of it.
//
// Deliberately loaded AFTER the engine samples and never awaited by them: the
// track is a few megabytes against a few hundred kilobytes of engine loops, so
// blocking on it would leave the car silent for the first seconds of driving,
// which is exactly when you want to hear it.

const MUSIC_URL = './assets/audio/bg-music.mp3';
const STORAGE_KEY = 'carsim.music.muted';
const FADE = 0.4;      // seconds; a hard cut on a music track sounds like a fault

export class Music {
  constructor(ctx, bus) {
    this.ctx = ctx;
    this.bus = bus;
    this.source = null;
    this.gain = null;
    this.ready = false;
    // Muting music is a preference, not a per-session decision -- someone who
    // turns it off wants it to stay off tomorrow.
    this._muted = localStorage.getItem(STORAGE_KEY) === '1';
  }

  get muted() { return this._muted; }

  async load() {
    if (!this.ctx || !this.bus || this.ready) return;
    try {
      const res = await fetch(MUSIC_URL);
      if (!res.ok) {
        // Not an error worth shouting about: the game is perfectly playable
        // without a soundtrack, and the file is optional.
        console.info(`no background music at ${MUSIC_URL} (HTTP ${res.status})`);
        return;
      }
      const buffer = await this.ctx.decodeAudioData(await res.arrayBuffer());

      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0;
      this.gain.connect(this.bus);

      this.source = this.ctx.createBufferSource();
      this.source.buffer = buffer;
      this.source.loop = true;
      this.source.connect(this.gain);
      this.source.start();

      this.ready = true;
      this._applyGain(0);          // fade in from silence, or stay muted
    } catch (err) {
      console.warn('background music unavailable:', err);
    }
  }

  setMuted(muted) {
    this._muted = muted;
    try { localStorage.setItem(STORAGE_KEY, muted ? '1' : '0'); } catch { /* private browsing */ }
    this._applyGain();
    return this._muted;
  }

  toggle() { return this.setMuted(!this._muted); }

  _applyGain(fade = FADE) {
    if (!this.gain) return;
    const target = this._muted ? 0 : 1;
    // The bus already carries musicVolume, so this gain only handles mute and
    // its fade -- keeping the two concerns from fighting over the same value.
    this.gain.gain.setTargetAtTime(target, this.ctx.currentTime, fade);
  }
}
