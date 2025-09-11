// == webrtc-hook.mini.js ==
// Mục tiêu: log khi có audio track mới +  log người đang nói (stream_id).
// Dùng cho meet.google.com

(() => {
  if (!('RTCPeerConnection' in window)) return;
  try {
    const h = String(location.hostname || '');
    if (!h.endsWith('meet.google.com')) return;
  } catch {}

  if (window.__webrtcMiniInstalled) return;
  window.__webrtcMiniInstalled = true;

  // Chỉ log ở top-frame để tránh spam từ các iframe trong meet
  const IS_TOP = (() => {
    try { return window.top === window && window.frameElement == null; }
    catch { return false; }
  })();
  const log = (...a) => { if (IS_TOP) console.log('[webrtc-mini]', ...a); };

  // State
  const tracks = new Map(); // key: track.id -> {track, receiver, mid, streamId, name?, tileEl?}
  let ACTIVE = false;       // chặn script chỉ chạy sau khi join, để log active-speaker định kỳ

  // Helper: throttle
  function throttle(fn, ms) {
    let last = 0; let tid = null; let savedArgs = null;
    return (...args) => {
      const now = Date.now();
      savedArgs = args;
      const run = () => { last = Date.now(); tid = null; fn(...savedArgs); };
      if (now - last >= ms) run();
      else if (!tid) tid = setTimeout(run, ms - (now - last));
    };
  }

  // ==== Best-effort map streamId -> tile & name ====
  function tryFindTileByStreamId(streamId) {
    if (!streamId) return { el: null, name: null };
    // Tìm <video> hoặc <audio> có srcObject.id === streamId
    const mediaEls = Array.from(document.querySelectorAll('video,audio'));
    for (const el of mediaEls) {
      const so = el.srcObject;
      if (so && so.id === streamId) {
        const name = guessNameFromTile(el);
        return { el, name: name || null };
      }
    }
    return { el: null, name: null };
  }

  function guessNameFromTile(mediaEl) {
    // Từ <video>/<audio>, leo lên DOM để tìm nhãn. Google Meet thay đổi class liên tục,
    // nên ta thử một số hướng "an toàn":
    let cur = mediaEl;
    for (let d = 0; d < 6 && cur; d++, cur = cur.parentElement) {
      // 1) aria-label ở container
      const aria = cur.getAttribute && cur.getAttribute('aria-label');
      if (aria && /\S/.test(aria)) return cleanLabel(aria);

      // 2) Tìm node có role="button" / aria-label chứa tên
      const labelBtn = cur.querySelector && cur.querySelector('[aria-label*="Pinned by"],[aria-label*="Được ghim"],[aria-label*=" by "]');
      if (labelBtn && labelBtn.getAttribute) {
        const a = labelBtn.getAttribute('aria-label');
        if (a && /\S/.test(a)) return cleanLabel(a);
      }

      // 3) Tìm phần tử có thuộc tính dữ liệu tên (tuỳ phiên bản)
      const dataName = cur.querySelector && cur.querySelector('[data-name],[data-self-name]');
      if (dataName) {
        const n = dataName.getAttribute('data-name') || dataName.getAttribute('data-self-name');
        if (n && /\S/.test(n)) return cleanLabel(n);
      }

      // 4) Một số layout có caption tên hiển thị trong thẻ span nhỏ
      const spans = cur.querySelectorAll ? cur.querySelectorAll('span') : [];
      for (const s of spans) {
        const t = s.textContent?.trim();
        // Loại trừ text rỗng / quá ngắn hoặc text có ký tự kỹ thuật
        if (t && t.length >= 2 && !/^(HD|SD|Live|Mic|Video)$/i.test(t)) {
          // Heuristic: chọn span ngắn (< 40 ký tự) làm tên
          if (t.length <= 40) return cleanLabel(t);
        }
      }
    }
    return null;
  }

  function cleanLabel(s) {
    // hoặc "Người trình bày: A B" -> "A B"
    return String(s)
      .replace(/^(Video tile of|Ô video của|Khung video của)\s*/i, '')
      .replace(/^(Speaker|Người trình bày)\s*:\s*/i, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  // ==== Active speaker polling (throttled) ====
  const pollActive = throttle(() => {
    if (!ACTIVE) return;
    for (const info of tracks.values()) {
      const { receiver, streamId } = info;
      if (!receiver?.getContributingSources) continue;
      let sources = [];
      try { sources = receiver.getContributingSources() || []; } catch {}
      if (!sources.length) continue;

      // Sắp theo audioLevel giảm dần
      sources.sort((a, b) => (b.audioLevel || 0) - (a.audioLevel || 0));
      const top = sources[0];
      const level = top?.audioLevel || 0;
      if (level > 0.01) {
        // Tìm/ghi tên nếu chưa có
        if (!info.name || !info.tileEl) {
          const { el, name } = tryFindTileByStreamId(streamId);
          if (el) info.tileEl = el;
          if (name) info.name = name;
        }
        const who = info.name || `(stream ${streamId || 'n/a'})`;
        log(`active-speaker ~ ${who} | level=${level.toFixed(3)} | source=${String(top.source || '')}`);
      }
    }
  }, 500); // 2 lần/giây

  // ==== Hook RTCPeerConnection ====
  const NativePC = window.RTCPeerConnection;
  function attach(pc) {
    if (pc.__webrtcMini) return;
    pc.__webrtcMini = true;

    pc.addEventListener('track', (ev) => {
      try {
        if (!ev?.track || ev.track.kind !== 'audio') return;
        const track = ev.track;
        const receiver = ev.receiver;
        const streamId = ev.streams?.[0]?.id || null;
        const mid = ev.transceiver?.mid || null;

        tracks.set(track.id, { track, receiver, mid, streamId, name: null, tileEl: null });
        log('audio track detected:', {
          trackId: track.id, mid, streamId,
          label: track.label || null
        });

        // Thử map tên ngay khi có track
        const { el, name } = tryFindTileByStreamId(streamId);
        if (el) tracks.get(track.id).tileEl = el;
        if (name) {
          tracks.get(track.id).name = name;
          log(`→ guessed user: ${name} (stream ${streamId || 'n/a'})`);
        }

        // Khi track kết thúc
        track.addEventListener('ended', () => {
          log('audio track ended:', { trackId: track.id, mid, streamId });
          tracks.delete(track.id);
        });
      } catch (e) {
        log('ontrack error', e?.message || e);
      }
    });
  }

  let installed = false;
  try {
    const Wrapped = new Proxy(NativePC, {
      construct(target, args, newTarget) {
        const pc = Reflect.construct(target, args, newTarget);
        try { attach(pc); } catch {}
        return pc;
      }
    });
    window.RTCPeerConnection = Wrapped; // !IMPORTANT: hook attach() vào RTC để lấy data truyền về
    installed = true;
  } catch {
    try {
      window.RTCPeerConnection = function(...args) {
        const pc = new NativePC(...args);
        try { attach(pc); } catch {}
        return pc;
      };
      window.RTCPeerConnection.prototype = NativePC.prototype;
      installed = true;
    } catch (e2) {
      console.warn('[webrtc-mini] install failed:', e2?.message || e2);
    }
  }

  if (installed && IS_TOP) log('installed');

  // Mini API để bạn điều khiển
  window.webrtcMini = {
    activate() { ACTIVE = true; log('active-speaker polling ON'); },
    deactivate() { ACTIVE = false; log('active-speaker polling OFF'); },
    dump() {
      const out = [];
      for (const [id, v] of tracks) {
        out.push({
          trackId: id, mid: v.mid, streamId: v.streamId,
          name: v.name || null, hasTile: !!v.tileEl
        });
      }
      log('dump:', out);
      return out;
    }
  };

  // Poll vòng lặp nhẹ để log active speaker (khi ACTIVE = true)
  setInterval(() => { try { pollActive(); } catch {} }, 250);
})();
