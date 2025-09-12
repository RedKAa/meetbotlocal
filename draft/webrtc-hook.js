// scripts/webrtc-hook.js
(() => {
  if (!('RTCPeerConnection' in window)) return;

  // Domain guard: chỉ chạy trên meet.google.com
  try {
    const h = String(location.hostname || '');
    if (!h.endsWith('meet.google.com')) return;
  } catch {}

  // Guard mỗi frame/doc
  if (window.__webrtcHookInstalled) return;
  window.__webrtcHookInstalled = true;

  // Log chỉ ở top-frame để đỡ ồn
  const IS_TOP = (() => { try { return window.top === window; } catch { return false; } })();
  const log = (...a) => { if (IS_TOP) (window.botLog ? window.botLog(a.join(' ')) : console.log('[hook]', ...a)); };

  // Map streamId -> participantId (bạn có thể bơm từ DOM qua hookUpdateStreamMap)
  const StreamMap = new Map(); // streamId(string) -> participantId(string)

  // API để Node/DOM cập nhật participants & stream map
  window.hookUpdateParticipants = (arr) => {
    try { window.webrtcEvent && window.webrtcEvent('participants', arr || []); } catch {}
  };
  window.hookUpdateStreamMap = (pairs) => {
    try {
      (pairs || []).forEach(p => {
        if (p && p.stream_id && p.participant_id) StreamMap.set(String(p.stream_id), String(p.participant_id));
      });
    } catch {}
  };

  // Convert Float32 [-1..1] -> Int16LE
  function f32ToI16(f32) {
    const out = new Uint8Array(f32.length * 2);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < f32.length; i++) {
      let s = Math.max(-1, Math.min(1, f32[i]));
      dv.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return out;
  }
  const fire = (fn) => { try { Promise.resolve(fn()); } catch {} };

  async function startProcessor(track, receiver, streamId, mid) {
    const key = `${Date.now()}_${Math.random().toString(36).slice(2)}_${track.id}`;
    const meta = { key, trackId: track.id, streamId, mid };

    // Open event + open writer (chưa có sample rate)
    try {
      window.webrtcEvent && window.webrtcEvent('track-open', { key, trackId: track.id, streamId, mid });
      window.webrtcOpenTrack && await window.webrtcOpenTrack(key, { track_id: track.id, stream_id: streamId, mid });
    } catch (e) { log('openTrack err', e?.message || e); }

    if (!('MediaStreamTrackProcessor' in window)) { log('no MediaStreamTrackProcessor'); return; }

    const processor = new MediaStreamTrackProcessor({ track });
    const reader = processor.readable.getReader();

    let firstFrame = true;

    const pump = async () => {
      while (true) {
        const { value: frame, done } = await reader.read();
        if (done) break;
        try {
          const numCh = frame.numberOfChannels;
          const numFr = frame.numberOfFrames;
          const sr = frame.sampleRate;
          const mono = new Float32Array(numFr);

          // Gửi meta sau khi biết sample_rate/channels
          if (firstFrame) {
            firstFrame = false;
            try {
              window.webrtcEvent && window.webrtcEvent('track-meta', {
                key, sample_rate: sr, channels: numCh
              });
            } catch {}
          }

          // Copy an toàn: planar trước, không được thì interleaved
          try {
            const chBuf = new Array(numCh);
            for (let ch = 0; ch < numCh; ch++) {
              const size = frame.allocationSize({ planeIndex: ch, format: 'f32-planar' });
              const ab = new ArrayBuffer(size);
              const dv = new DataView(ab);
              frame.copyTo(dv, { planeIndex: ch, format: 'f32-planar' });
              chBuf[ch] = new Float32Array(ab);
            }
            if (numCh === 1) mono.set(chBuf[0]);
            else {
              for (let i = 0; i < numFr; i++) {
                let s = 0; for (let ch = 0; ch < numCh; ch++) s += chBuf[ch][i];
                mono[i] = s / numCh;
              }
            }
          } catch {
            const size = frame.allocationSize({ format: 'f32' });
            const ab = new ArrayBuffer(size);
            const dv = new DataView(ab);
            frame.copyTo(dv, { format: 'f32' }); // interleaved
            const inter = new Float32Array(ab); // len = numFr * numCh
            if (numCh === 1) mono.set(inter);
            else {
              for (let i = 0; i < numFr; i++) {
                let s = 0; const base = i * numCh;
                for (let ch = 0; ch < numCh; ch++) s += inter[base + ch];
                mono[i] = s / numCh;
              }
            }
          }

          // (Tùy chọn) xác định participant theo contributingSources (audioLevel lớn nhất)
          let participantId = null;
          try {
            const sources = receiver?.getContributingSources?.() || [];
            if (sources.length) {
              sources.sort((a,b)=> (b.audioLevel||0)-(a.audioLevel||0));
              const top = sources[0];
              const sid = String(top.source);
              participantId = StreamMap.get(sid) || null; // cần hookUpdateStreamMap để map
            }
          } catch {}

          // Gửi chunk về Node
          const i16 = f32ToI16(mono);
          window.webrtcWriteTrack && fire(() => window.webrtcWriteTrack(key, Array.from(i16)));

          // (Tùy chọn) báo active speaker theo frame
          if (participantId && window.webrtcEvent) {
            fire(() => window.webrtcEvent('active-speaker', { key, participant_id: participantId }));
          }
        } catch (e) {
          log('processor err', e?.message || e);
        } finally {
          try { frame.close(); } catch {}
        }
      }
    };

    track.addEventListener('ended', async () => {
      try { window.webrtcEvent && window.webrtcEvent('track-close', { key }); } catch {}
      try { window.webrtcCloseTrack && await window.webrtcCloseTrack(key); } catch {}
    });

    pump().catch(e => log('pump error', e?.message || e));
  }

  let ACTIVE = false;
  const pending = new Map(); // trackId -> {track, receiver, streamId, mid}

  window.webrtcActivate = () => {
    ACTIVE = true;
    for (const it of pending.values()) startProcessor(it.track, it.receiver, it.streamId, it.mid);
    pending.clear();
  };

  // Hook RTCPeerConnection bằng Proxy
  const NativePC = window.RTCPeerConnection;

  function attachTrackListener(pc) {
    if (pc.__hookedTrack) return;
    pc.__hookedTrack = true;
    pc.addEventListener('track', (ev) => {
      try {
        if (!ev?.track || ev.track.kind !== 'audio') return;
        const track = ev.track;
        const streamId = ev.streams?.[0]?.id || null;
        const mid = ev.transceiver?.mid || null;
        const receiver = ev.receiver;
        if (!ACTIVE) {
          pending.set(track.id, { track, receiver, streamId, mid });
          return;
        }
        startProcessor(track, receiver, streamId, mid);
      } catch (e) { log('ontrack error', e?.message || e); }
    });
  }

  let installed = false;
  try {
    const WrappedPC = new Proxy(NativePC, {
      construct(target, args, newTarget) {
        const pc = Reflect.construct(target, args, newTarget);
        try { attachTrackListener(pc); } catch {}
        return pc;
      }
    });
    window.RTCPeerConnection = WrappedPC;
    installed = true;
  } catch {
    try {
      window.RTCPeerConnection = function(...args) {
        const pc = new NativePC(...args);
        try { attachTrackListener(pc); } catch {}
        return pc;
      };
      window.RTCPeerConnection.prototype = NativePC.prototype;
      installed = true;
    } catch (e2) { console.warn('[hook] install failed:', e2?.message || e2); }
  }

  if (installed) log('webrtc-hook installed (early)');
})();
