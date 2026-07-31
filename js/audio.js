// CRAZY EIGHTS — quiet procedural WebAudio, following the Btown Games fleet.
// No audio files: the context is created lazily after the first gesture.

const LS_MUTED = 'crazy-eights-muted';
const MAX_VOICES = 12;

let ctx = null;
let master = null;
let activeVoices = 0;
let muted = readMuted();

function readMuted() {
  try {
    return localStorage.getItem(LS_MUTED) === '1';
  } catch (e) {
    return false;
  }
}

function saveMuted() {
  try {
    localStorage.setItem(LS_MUTED, muted ? '1' : '0');
  } catch (e) { /* private mode etc. — sound still works for this visit */ }
}

function unlock() {
  if (muted) return;
  if (!ctx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.3;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
}

function voice(start, dur, build) {
  if (muted || !ctx || !master || activeVoices >= MAX_VOICES) return;
  const t = ctx.currentTime + start;
  activeVoices++;
  const source = build(ctx, t, master);
  if (!source) {
    activeVoices--;
    return;
  }
  source.onended = () => {
    activeVoices = Math.max(0, activeVoices - 1);
    (source._nodes || [source]).forEach((node) => {
      try { node.disconnect(); } catch (e) { /* already disconnected */ }
    });
  };
  source.start(t);
  source.stop(t + dur + 0.04);
}

function tone(freq, start, dur, { type = 'sine', gain = 0.12, slide = 0 } = {}) {
  voice(start, dur, (audio, t, out) => {
    const osc = audio.createOscillator();
    const g = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slide) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(35, freq + slide), t + dur);
    }
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(out);
    osc._nodes = [osc, g];
    return osc;
  });
}

function noise(start, dur, { gain = 0.06, highpass = 700 } = {}) {
  voice(start, dur, (audio, t, out) => {
    const frames = Math.max(1, Math.floor(audio.sampleRate * dur));
    const buffer = audio.createBuffer(1, frames, audio.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    const source = audio.createBufferSource();
    const filter = audio.createBiquadFilter();
    const g = audio.createGain();
    source.buffer = buffer;
    filter.type = 'highpass';
    filter.frequency.value = highpass;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    source.connect(filter).connect(g).connect(out);
    source._nodes = [source, filter, g];
    return source;
  });
}

export const sound = {
  get muted() {
    return muted;
  },
  unlock,
  toggleMuted() {
    muted = !muted;
    saveMuted();
    if (!muted) unlock();
    return muted;
  },
  deal() {
    if (muted) return;
    [0, 0.055, 0.11, 0.165].forEach((start, i) => {
      noise(start, 0.07, { gain: 0.045 + i * 0.004, highpass: 850 });
      tone(250 + i * 28, start, 0.075, { type: 'triangle', gain: 0.035, slide: -55 });
    });
  },
  slap() {
    if (muted) return;
    noise(0, 0.05, { gain: 0.075, highpass: 950 });
    tone(145, 0, 0.075, { type: 'triangle', gain: 0.075, slide: -45 });
  },
  draw(level = 1) {
    if (muted) return;
    const lift = Math.max(0, Math.min(2, level - 1));
    noise(0, 0.07, { gain: 0.04 + lift * 0.008, highpass: 1200 });
    tone(310 + lift * 45, 0.012, 0.1, {
      type: 'triangle',
      gain: 0.045 + lift * 0.01,
      slide: 50 + lift * 25,
    });
  },
  nope() {
    if (muted) return;
    tone(185, 0, 0.09, { type: 'sine', gain: 0.04, slide: -28 });
  },
  wild() {
    if (muted) return;
    [392, 523, 659, 784].forEach((freq, i) => {
      tone(freq, i * 0.045, 0.32, { type: 'triangle', gain: 0.1 });
    });
  },
  oneCard() {
    if (muted) return;
    [523, 659, 880].forEach((freq, i) => {
      tone(freq, i * 0.075, 0.3, { type: 'triangle', gain: 0.12 });
    });
  },
  win() {
    if (muted) return;
    [392, 494, 587, 784].forEach((freq, i) => {
      tone(freq, i * 0.1, 0.27, { type: 'triangle', gain: 0.14 });
    });
    tone(1047, 0.4, 0.48, { type: 'triangle', gain: 0.12 });
  },
  lose() {
    if (muted) return;
    [330, 294, 247].forEach((freq, i) => {
      tone(freq, i * 0.13, 0.25, { type: 'triangle', gain: 0.09 });
    });
    tone(196, 0.38, 0.34, { type: 'sine', gain: 0.06 });
  },
};
