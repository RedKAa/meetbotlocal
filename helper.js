// helper.js — CommonJS
// Export 1 hàm: enableCaptionsVietnameseViaSettings(page)
// - Mở Settings từ mọi nút "Tùy chọn khác/More options" có menu "Cài đặt/Settings"
// - Vào tab Phụ đề/Captions
// - Mở list ngôn ngữ robust (nhiều chiến lược, không throw sai)
// - Chọn "Tiếng Việt (Việt Nam)"
// - Bật Live Captions (switch trong Settings; nếu không thấy, đóng panel và dùng phím tắt C / Shift+C)
// - KHÔNG đóng browser nếu có lỗi (throw ra ngoài để bạn thấy màn hình)

async function enableCaptionsVietnameseViaSettings(page) {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  // ---------- Utils ----------
  async function revealControls() {
    const vp = page.viewportSize() || { width: 1280, height: 720 };
    const x = vp.width / 2, y = vp.height - 12;
    await page.mouse.move(x, y - 40); await wait(60);
    await page.mouse.move(x, y);       await wait(60);
  }
  async function waitSettingsDialog() {
    await page.waitForSelector(
      '[role="dialog"][aria-label="Cài đặt"], [role="dialog"][aria-label="Settings"]',
      { timeout: 7000 }
    );
    return page.locator('[role="dialog"][aria-label="Cài đặt"], [role="dialog"][aria-label="Settings"]').first();
  }
  async function ensureCaptionsViaShortcut() {
    try { await page.keyboard.press('KeyC'); await wait(200); } catch {}
  }

  try {
    // ---------- 1) Mở Settings từ các nút "Tùy chọn khác/More options" ----------
    const MORE_BTNS = [
      'button[aria-label="Tùy chọn khác"]',
      'button[aria-label*="Tùy chọn" i]',
      'button[aria-label="More options"]',
      'button[aria-label*="More options" i]',
      'button[aria-haspopup="menu"]:has(i.google-symbols:has-text("more_vert"))',
    ];
    const SETTINGS_ITEMS = [
      '[role="menuitem"][aria-label="Cài đặt"]',
      '[role="menuitem"]:has-text("Cài đặt")',
      '[role="menuitem"][aria-label="Settings"]',
      '[role="menuitem"]:has-text("Settings")',
    ];

    await revealControls();

    let opened = false;
    for (const sel of MORE_BTNS) {
      const btns = page.locator(sel);
      const n = await btns.count().catch(()=>0);
      for (let i = 0; i < n; i++) {
        const btn = btns.nth(i);
        if (!(await btn.isVisible().catch(()=>false))) continue;

        await btn.click().catch(()=>{});
        await wait(250);

        const hasSettings = await page.locator(SETTINGS_ITEMS.join(',')).first().isVisible().catch(()=>false);
        if (hasSettings) {
          await page.locator(SETTINGS_ITEMS.join(',')).first().click({ timeout: 2000 }).catch(()=>{});
          opened = true; break;
        } else {
          await page.keyboard.press('Escape').catch(()=>{});
          await wait(120);
        }
      }
      if (opened) break;
    }
    if (!opened) throw new Error('Không tìm thấy menu có mục "Cài đặt/Settings".');

    const dialog = await waitSettingsDialog();

    // ---------- 2) Sang tab Phụ đề/Captions ----------
    const captionsTabOrRegion = dialog.locator([
      '[role="region"][aria-label="Phụ đề"]',
      '[role="region"][aria-label="Captions"]',
      'button[role="tab"][aria-label="Phụ đề"]',
      'button[role="tab"]:has-text("Phụ đề")',
      'button[role="tab"][aria-label="Captions"]',
      'button[role="tab"]:has-text("Captions")',
    ].join(', ')).first();
    await captionsTabOrRegion.click({ timeout: 3000 }).catch(()=>{}); // nếu là region thì ignore
    await wait(150);

    await Promise.race([
      dialog.locator('[role="combobox"]').first().waitFor({ state: 'visible', timeout: 3500 }).catch(()=>{}),
      dialog.locator('[role="switch"]').first().waitFor({ state: 'visible', timeout: 3500 }).catch(()=>{}),
    ]);

    // ---------- 3) Tìm combobox Language (sử dụng aria-labelledby) ----------
    async function findLanguageCombo() {
      const combos = dialog.locator('[role="combobox"][aria-labelledby]');
      const count = await combos.count().catch(()=>0);
      for (let i = 0; i < count; i++) {
        const cb = combos.nth(i);
        if (!(await cb.isVisible().catch(()=>false))) continue;
        const idAttr = await cb.getAttribute('aria-labelledby').catch(()=>null);
        if (!idAttr) continue;
        const ids = idAttr.trim().split(/\s+/);
        let labelText = '';
        for (const labId of ids) {
          const t = await dialog.locator(`#${labId}`).first().textContent().catch(()=> '') || '';
          labelText += ' ' + t;
        }
        const t = labelText.trim().toLowerCase();
        if (t.includes('language of the meeting') || t.includes('ngôn ngữ trong cuộc họp')) {
          return cb;
        }
      }
      // fallback cuối: combobox đầu tiên
      const any = dialog.locator('[role="combobox"]').first();
      if (await any.isVisible().catch(()=>false)) return any;
      return null;
    }

    const combo = await findLanguageCombo();
    if (!combo) throw new Error('Không tìm thấy combobox ngôn ngữ trong Settings.');

    // ---------- 4) Mở list ngôn ngữ (robust, không throw sai) ----------
    async function isListboxOpen() {
      const byRole = await page.locator('ul[role="listbox"], [role="listbox"][aria-label="Meeting language"]').first().isVisible().catch(()=>false);
      if (byRole) return true;
      // một số UI đóng/mở rất nhanh: coi aria-expanded của combobox
      const expanded = (await combo.getAttribute('aria-expanded').catch(()=>'')) === 'true';
      if (expanded) return true;
      // Hoặc đã có options render sẵn
      const hasOptions = await page.locator('li[role="option"]').first().isVisible().catch(()=>false);
      return hasOptions;
    }

    async function openListbox() {
      // bước 0: scroll + hover + click
      await combo.scrollIntoViewIfNeeded().catch(()=>{});
      await combo.hover().catch(()=>{});
      await combo.click().catch(()=>{});
      if (await isListboxOpen()) return true;

      // bước 1: focus + phím (Enter/Space/ArrowDown/Alt+ArrowDown)
      await combo.focus().catch(()=>{});
      for (const key of ['Enter','Space','ArrowDown']) {
        await page.keyboard.press(key).catch(()=>{});
        if (await isListboxOpen()) return true;
      }
      await page.keyboard.down('Alt').catch(()=>{});
      await page.keyboard.press('ArrowDown').catch(()=>{});
      await page.keyboard.up('Alt').catch(()=>{});
      if (await isListboxOpen()) return true;

      // bước 2: force click
      await combo.click({ force: true }).catch(()=>{});
      if (await isListboxOpen()) return true;

      // bước 3: click vùng chevron/mép phải
      const box = await combo.boundingBox().catch(()=>null);
      if (box) {
        const cx = box.x + Math.max(box.width - 12, box.width * 0.85);
        const cy = box.y + box.height / 2;
        await page.mouse.move(cx, cy); await wait(30);
        await page.mouse.down(); await page.mouse.up();
        if (await isListboxOpen()) return true;
      }

      // bước 4: dispatch native-like events
      await combo.evaluate((el) => {
        const ev = (t) => el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
        ev('pointerover'); ev('mouseover'); ev('pointerdown'); ev('mousedown'); ev('mouseup'); ev('pointerup'); ev('click');
      }).catch(()=>{});
      if (await isListboxOpen()) return true;

      // bước 5: dblclick
      await combo.dblclick().catch(()=>{});
      if (await isListboxOpen()) return true;

      // Nếu tới đây vẫn chưa detect mở, KHÔNG throw ngay — chuyển sang chọn "Vietnamese" bằng typeahead.
      return false; // báo về: không chắc mở, nhưng vẫn tiếp tục chọn bằng text
    }

    const maybeOpen = await openListbox();

    // ---------- 5) Chọn “Tiếng Việt (Việt Nam)” ----------
    async function pickVietnamese() {
      // Cách A: click trực tiếp option nếu thấy
      const VI_SEL = [
        'ul[role="listbox"] li[role="option"][aria-label*="Tiếng Việt (Việt Nam)"]',
        'ul[role="listbox"] li[role="option"][aria-label*="Tiếng Việt"]',
        'ul[role="listbox"] li[role="option"]:has-text("Tiếng Việt")',
        'ul[role="listbox"] li[role="option"][aria-label*="Vietnamese"]',
        'ul[role="listbox"] li[role="option"]:has-text("Vietnamese")',
        'ul[role="listbox"] li[role="option"][data-value="vi-VN"]',
      ].join(', ');
      const opt = page.locator(VI_SEL).first();
      if (await opt.isVisible().catch(()=>false)) {
        await opt.click({ timeout: 3000, force: true }).catch(()=>{});
        await wait(120);
        return true;
      }

      // Cách B: typeahead trong combobox (nhiều UI lọc theo gõ)
      await combo.focus().catch(()=>{});
      // xoá text cũ nếu có
      for (let i = 0; i < 6; i++) { try { await page.keyboard.press('Backspace'); } catch {} }
      // gõ tìm "vie"
      try { await page.keyboard.type('vie', { delay: 30 }); } catch {}
      await wait(200);
      // Enter để chọn suggestion đầu
      try { await page.keyboard.press('Enter'); await wait(120); return true; } catch {}

      // Cách C: gõ "Vietnamese" và Enter
      try {
        await combo.focus().catch(()=>{});
        for (let i = 0; i < 12; i++) { try { await page.keyboard.press('Backspace'); } catch {} }
        await page.keyboard.type('Vietnamese', { delay: 20 });
        await wait(200);
        await page.keyboard.press('Enter');
        await wait(120);
        return true;
      } catch {}

      return false;
    }

    const picked = await pickVietnamese();
    if (!picked) {
      // debug nhẹ
      try {
        const opts = await page.$$eval('li[role="option"]',
          els => els.map(e => (e.getAttribute('data-value') || 'na') + ' | ' + (e.getAttribute('aria-label') || e.textContent?.trim() || ''))
        );
        console.warn('[helper] Options hiện có:', opts);
      } catch {}
      throw new Error('Không chọn được Tiếng Việt.');
    }

    // ---------- 6) BẬT Live Captions ----------
    const closeBtn = dialog.locator('[data-mdc-dialog-action="close"]').first();
    if (await closeBtn.isVisible().catch(()=>false)) {
      await closeBtn.click().catch(()=>{});
    } else {
      try { await page.keyboard.press('Escape'); } catch {}
    }
    await wait(150);
    await ensureCaptionsViaShortcut(); // C hoặc Shift+C

    console.log('✅ Đã chọn ngôn ngữ Tiếng Việt và bật Live Captions (nếu có/khả dụng).');
  } catch (err) {
    console.error('⚠️ enableCaptionsVietnameseViaSettings error:', err.message || err);
    // KHÔNG đóng browser — để bạn nhìn trạng thái dở dang
    throw err;
  }
}

module.exports = { enableCaptionsVietnameseViaSettings };
