chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'PLAY_ALARM') return;

  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = 800;
      gain.gain.value = 0.4;
      const start = now + i * 0.3;
      osc.start(start);
      osc.stop(start + 0.2);
    }
  } catch (e) {
    console.error('[ClearCap offscreen] audio error:', e);
  }
});
