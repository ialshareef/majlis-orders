/* ======================================================================
   Designer v2: محرر تصميم الغرفة (Canvas)
   - المقاسات المدخلة هي المقاسات الداخلية للغرفة (الجدار يُرسم للخارج)
   - الغرفة سلسلة جدران (طول + اتجاه) + فتحات (أبواب/شبابيك) على الجدران
   - القطع (كنب/إكسسوار) قابلة للتحريك والتدوير وتغيير الأبعاد، وتلتصق بالجدران
   - طريقتان لحساب الكنب على الجدران: بطول الجدار كامل (full) أو خصم الزوايا (deduct)
   - تكبير/تصغير وتحريك العرض (عجلة الفأرة + Ctrl، أو إصبعين على اللمس)
   - الوحدات: المتر. الإحداثيات: y للأسفل
   ====================================================================== */
(function (global) {
  'use strict';

  const rad = (d) => (d * Math.PI) / 180;
  const round = (v, n = 2) => Math.round(v * Math.pow(10, n)) / Math.pow(10, n);
  const snap = (v, step = 0.05) => Math.round(v / step) * step;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const norm360 = (a) => ((a % 360) + 360) % 360;
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

  const WALL_T = 0.2;       // سماكة الجدار المرسومة للخارج (متر)
  const WALL_LABEL_OFF = 0.95;   // إزاحة اسم الجدار خارج الغرفة حتى لا يحجب الباب/المشب
  const MIN_SIZE = 0.2;     // أصغر بُعد مسموح (متر)
  const COARSE = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const HANDLE_R = COARSE ? 11 : 7;
  const ROT_OFFSET = COARSE ? 40 : 30;
  // نفس خط الموقع: الكتابة داخل المخطط يجب ألا تبدو غريبة عن بقية الواجهة
  const FONT = "'IBM Plex Sans Arabic', 'Segoe UI', Tahoma, Arial, sans-serif";
  // لون التحديد: برونزي الهوية، ويُرسم فوق هالة بيضاء فيبقى واضحاً على أي لون قماش
  const SEL = '#A5642C';
  const SEL_ROT = '#5F7A45';

  class Designer {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.opts = opts; // { getItem(id), onChange(), onSelect(info|null), onWallDblClick(i) }
      this.state = Designer.emptyState();
      this.sel = null;          // {type:'piece',id} | {type:'wall',index} | {type:'opening',id}
      this.drag = null;
      this.pointers = new Map();
      this.interactive = true;  // false = عرض فقط (تكبير وتحريك بلا تعديل)
      this.autoFit = true;
      this._hist = [];          // سجل التراجع/الإعادة (لقطات JSON)
      this._histIdx = -1;
      this._lastTap = null;     // النقرة السابقة على جدار (لكشف اللمس المزدوج لوضع الكنب)
      this.view = { scale: 60, ox: 0, oy: 0 };
      this.cssW = 0; this.cssH = 0;
      this._bind();
      this.resize();
    }

    /* ======================= الحالة ======================= */
    static rectWalls(w, h) {
      return [{ len: w, angle: 0 }, { len: h, angle: 90 }, { len: w, angle: 180 }, { len: h, angle: 270 }];
    }
    static emptyState(w = 5, h = 4, cornerMode = 'deduct') {
      return { walls: Designer.rectWalls(w, h), openings: [], pieces: [], cornerMode, roomDims: { w, h } };
    }
    static normalizeState(s, defaults = {}) {
      const st = JSON.parse(JSON.stringify(s || {}));
      if (!Array.isArray(st.walls) || st.walls.length < 3) st.walls = Designer.rectWalls(5, 4);
      /* fixed محفوظ على الجدار نفسه: أطوال مستقلة يدوية.
         التصاميم القديمة بلا الحقل تعمل بلا أخطاء (fixed = غير معرّف). */
      st.walls = st.walls.map((w) => {
        const o = { len: Math.max(0.3, +w.len || 0.3), angle: norm360(+w.angle || 0) };
        if (w.fixed) o.fixed = true;
        /* off = انطلاقة مثبّتة (نتيجة تثبيت طرف عند تقصير جدار سابق).
           تُحفظ مع التصميم كي تبقى جهة التثبيت بعد إعادة الفتح. غائبة في
           التصاميم القديمة ⇒ لا أثر، والغرفة تبدأ من (0,0) كسابقاً. */
        if (w.off && Number.isFinite(+w.off.x) && Number.isFinite(+w.off.y)) {
          o.off = { x: round(+w.off.x, 4), y: round(+w.off.y, 4) };
        }
        return o;
      });
      /* roomDims = آخر مقاس أساسي للغرفة. غائبة في التصاميم القديمة ⇒ نستنتجها من
         الجدران غير المعدّلة (أو الافتراضي ٥×٤) بلا تغيير أي طول قائم. */
      if (st.roomDims && (+st.roomDims.w > 0) && (+st.roomDims.h > 0)) {
        st.roomDims = { w: +st.roomDims.w, h: +st.roomDims.h };
      } else {
        const horiz = st.walls.find((w) => Math.abs(Math.sin(rad(w.angle))) < 0.05);
        const vert = st.walls.find((w) => Math.abs(Math.cos(rad(w.angle))) < 0.05);
        st.roomDims = { w: horiz ? horiz.len : 5, h: vert ? vert.len : 4 };
      }
      st.openings = Array.isArray(st.openings) ? st.openings : [];
      st.pieces = Array.isArray(st.pieces) ? st.pieces : [];
      // حجوزات الزوايا (زاوية فاضية) ميزة أُزيلت: تُحذف من الطلبات القديمة عند فتحها
      // فتعود الجدران إلى أطوالها الكاملة بدل أن تبقى محجوزة بلا واجهة تُدير الحجز.
      delete st.cornerSpots;
      if (st.cornerMode !== 'full' && st.cornerMode !== 'deduct') st.cornerMode = defaults.cornerMode || 'deduct';
      return st;
    }

    setState(s, defaults) {
      this.state = Designer.normalizeState(s, defaults);
      this.sel = null;
      this.drag = null;
      this.autoFit = true;
      this.syncAttached();
      this.resetHistory();
      this.render();
    }

    /* ---------- التراجع والإعادة ---------- */
    resetHistory() {
      this._hist = [JSON.stringify(this.state)];
      this._histIdx = 0;
    }

    _pushHistory() {
      if (this._suspendHistory) return;
      const json = JSON.stringify(this.state);
      if (this._histIdx >= 0 && this._hist[this._histIdx] === json) return;
      this._hist = this._hist.slice(0, this._histIdx + 1);
      this._hist.push(json);
      if (this._hist.length > 80) this._hist.shift();
      this._histIdx = this._hist.length - 1;
    }

    canUndo() { return this._histIdx > 0; }
    canRedo() { return this._histIdx >= 0 && this._histIdx < this._hist.length - 1; }

    undo() { if (!this.canUndo()) return false; this._histIdx--; this._applyHistory(); return true; }
    redo() { if (!this.canRedo()) return false; this._histIdx++; this._applyHistory(); return true; }

    _applyHistory() {
      this.state = JSON.parse(this._hist[this._histIdx]);
      // إسقاط التحديد إن لم يعد موجوداً
      if (this.sel) {
        const s = this.sel;
        const gone = (s.type === 'piece' && !this.piece(s.id))
          || (s.type === 'opening' && !this.opening(s.id))
          || (s.type === 'wall' && s.index >= this.state.walls.length);
        if (gone) this.sel = null;
      }
      this.syncAttached();
      this.render();
      if (this.opts.onChange) this.opts.onChange();
      if (this.opts.onSelect) this.opts.onSelect(this.selectionInfo());
    }

    /** عرض فقط: يُسمح بالتكبير والتحريك دون تعديل */
    setInteractive(flag) {
      if (this.interactive === (flag !== false)) return;
      this.interactive = flag !== false;
      if (!this.interactive) { this.sel = null; this.drag = null; }
      this.canvas.style.cursor = 'default';
      this.render();
    }
    getState() { return JSON.parse(JSON.stringify(this.state)); }

    /* ======================= الهندسة ======================= */
    /** حساب هندسة الغرفة من مصفوفة جدران خام — مستخدم في geometry() وفي المعاينة
        (explainWallChange) بلا تعديل الحالة الفعلية.

        الجدران سلسلة متراكمة تبدأ من (0,0): طرف كل جدار هو طرف سابقه.
        لذلك لتثبيت طرف جدار معيّن نحتاج أحياناً إزاحة «سلسلة ما قبله» دون تغيير
        أطوالها — لذلك نتيح لكل جدار نقطة انطلاق مطلقة اختيارية (w.off).
        الغياب يعني السلوك القديم تماماً، فكل التصاميم المحفوظة تعمل بلا تغيير. */
    static geometryOf(state) {
      const pts = [{ x: 0, y: 0 }];
      const walls = [];
      let p = { x: 0, y: 0 };
      (state.walls || []).forEach((w, i) => {
        if (w.off) p = { x: +w.off.x, y: +w.off.y };       // انطلاقة مثبّتة (تثبيت طرف)
        const a = rad(w.angle);
        const dir = { x: Math.cos(a), y: Math.sin(a) };
        const q = { x: p.x + dir.x * w.len, y: p.y + dir.y * w.len };
        walls.push({ i, A: p, B: q, dir, len: w.len, angle: w.angle, mid: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 } });
        pts.push(q);
        p = q;
      });
      const last = pts[pts.length - 1];
      const gap = Math.hypot(last.x, last.y);
      const closed = gap < 0.05;
      const poly = closed ? pts.slice(0, -1) : pts;
      let area = 0;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        area += a.x * b.y - b.x * a.y;
      }
      area /= 2;
      const sgn = area >= 0 ? 1 : -1;
      walls.forEach((w) => {
        w.n = sgn > 0 ? { x: -w.dir.y, y: w.dir.x } : { x: w.dir.y, y: -w.dir.x }; // للداخل
        w.rot = sgn > 0 ? w.angle : norm360(w.angle + 180);
      });
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      pts.forEach((q) => { minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y); });
      return { pts, poly, walls, area, sgn, closed, gap, bb: { minX, minY, maxX, maxY } };
    }

    geometry() { return Designer.geometryOf(this.state); }

    corners(p) {
      const a = rad(p.rot || 0), c = Math.cos(a), s = Math.sin(a);
      const hw = p.w / 2, hh = p.h / 2;
      return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([lx, ly]) => ({ x: p.x + lx * c - ly * s, y: p.y + lx * s + ly * c }));
    }
    toLocal(p, pt) {
      const a = rad(p.rot || 0), c = Math.cos(a), s = Math.sin(a);
      const dx = pt.x - p.x, dy = pt.y - p.y;
      return { x: dx * c + dy * s, y: -dx * s + dy * c };
    }
    /** إحداثيات نقطة بالنسبة لجدار: t على طول الجدار، s للداخل */
    wallCoords(w, pt) {
      const dx = pt.x - w.A.x, dy = pt.y - w.A.y;
      return { t: dx * w.dir.x + dy * w.dir.y, s: dx * w.n.x + dy * w.n.y };
    }
    _projectOnWall(p, w) {
      let tmin = Infinity, tmax = -Infinity, smin = Infinity, smax = -Infinity;
      for (const c of this.corners(p)) {
        const { t, s } = this.wallCoords(w, c);
        tmin = Math.min(tmin, t); tmax = Math.max(tmax, t); smin = Math.min(smin, s); smax = Math.max(smax, s);
      }
      return { tmin, tmax, smin, smax };
    }

    /** داخل مضلّع الغرفة؟ (ray casting — للغرف المغلقة فقط) */
    static pointInPoly(pt, poly) {
      if (!poly || poly.length < 3) return true;
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      }
      return inside;
    }

    static polysOverlap(a, b) {
      for (const poly of [a, b]) {
        for (let i = 0; i < poly.length; i++) {
          const p1 = poly[i], p2 = poly[(i + 1) % poly.length];
          let nx = p2.y - p1.y, ny = p1.x - p2.x;
          const L = Math.hypot(nx, ny) || 1; nx /= L; ny /= L;
          let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
          a.forEach((p) => { const d = p.x * nx + p.y * ny; minA = Math.min(minA, d); maxA = Math.max(maxA, d); });
          b.forEach((p) => { const d = p.x * nx + p.y * ny; minB = Math.min(minB, d); maxB = Math.max(maxB, d); });
          if (maxA <= minB + 0.01 || maxB <= minA + 0.01) return false;
        }
      }
      return true;
    }

    /** محور محدد(axis-aligned bounding box) لمضلّع — يستخدم的区域 المحظورة للأبواب والمشاب. */
    static polyToRect(poly) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of poly) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      }
      return { minX, minY, maxX, maxY };
    }

    /** تقاطع مضلّع (كنبة بعد تدويرها) مع مستطيل محظور، بتسامح سنتيمتر واحد. */
    static polyHitsRect(poly, r, eps = 0.01) {
      const inside = (p) => p.x >= r.minX - eps && p.x <= r.maxX + eps && p.y >= r.minY - eps && p.y <= r.maxY + eps;
      if (poly.some(inside)) return true;                 // زاوية داخل المنطقة المحظورة
      const corners = [{ x: r.minX, y: r.minY }, { x: r.maxX, y: r.minY }, { x: r.maxX, y: r.maxY }, { x: r.minX, y: r.maxY }];
      for (let i = 0; i < 4; i++) if (inside(poly[i])) return true;
      return Designer.polysOverlap(poly, corners);        // حافة تقطع حافة
    }

    overlaps() {
      const ps = this.state.pieces;
      const bad = new Set();
      const full = this.state.cornerMode === 'full';
      for (let i = 0; i < ps.length; i++) {
        for (let j = i + 1; j < ps.length; j++) {
          const a = ps[i], b = ps[j];
          // المساحة الحرة علامة على الأرض لا قطعة أثاث: ما يقع فوقها ليس تداخلاً
          if (a.kind === 'free' || b.kind === 'free') continue;
          // الإكسسوارات (مخدات، مراكي...) توضع فوق الكنب بشكل طبيعي: لا يُعد ذلك تداخلاً
          if ((a.kind === 'acc') !== (b.kind === 'acc')) continue;
          // في وضع "طول الجدار كامل" يُسمح للقطع الملتصقة بجدارين مختلفين بمشاركة الزاوية
          if (full && a.kind === 'sofa' && b.kind === 'sofa' && a.wall != null && b.wall != null && a.wall !== b.wall) continue;
          // ذراعا كنب الزاوية يلتقيان عند الزاوية بحكم التصميم: ليس تداخلاً
          if (a.group && a.group === b.group) continue;
          if (Designer.polysOverlap(this.corners(a), this.corners(b))) { bad.add(a.id); bad.add(b.id); }
        }
      }
      return bad;
    }

    /* ======================= الجدران ======================= */
    _placeOnWall(p, w) {
      const half = Math.min(p.w / 2, w.len / 2);
      p.t = clamp(+p.t || 0, half, Math.max(half, w.len - half));
      p.x = round(w.A.x + w.dir.x * p.t + w.n.x * p.h / 2, 3);
      p.y = round(w.A.y + w.dir.y * p.t + w.n.y * p.h / 2, 3);
      p.rot = w.rot;
    }

    /** إعادة تموضع القطع والفتحات الملتصقة بالجدران بعد تغيّر الجدران */
    syncAttached(g = this.geometry()) {
      for (const p of this.state.pieces) {
        if (p.wall == null) continue;
        const w = g.walls[p.wall];
        if (!w) { delete p.wall; delete p.t; continue; }
        this._placeOnWall(p, w);
      }
      this.state.openings = this.state.openings.filter((o) => g.walls[o.wall]);
      /* الفتحات التي خرجت عن جدارها بسبب تقصيره: نُبلغ ولا نحذف ولا ننقل صامتاً.
         نُبلغ ولا نحذف ولا ننقل صامتاً. moved تحفظ ما نُقل اضطراراً في checkRoomHealth */
      const clipped = [];
      for (const o of this.state.openings) {
        const w = g.walls[o.wall];
        const prevT = o.t, prevW = o.w;
        o.w = Math.min(Math.max(0.3, +o.w || 0.9), w.len);
        o.t = clamp(+o.t || 0, o.w / 2, w.len - o.w / 2);
        if (Math.abs(o.t - prevT) > 0.01 || o.w !== prevW) {
          /* حركنا الفتحة إجباراً لتبقي داخل الجدار: نسجّلها كتحذير صريح
             («انقلها أو كبّر الجدار») ولا نعتبرها تعديلاً مقبولاً بصمت. */
          clipped.push({ id: o.id, type: o.type, wall: o.wall, fromT: prevT, toT: o.t });
        }
      }
      this._clippedOpenings = clipped;
    }

    setRect(w, h) {
      this.state.walls = Designer.rectWalls(Math.max(0.5, w), Math.max(0.5, h));
      // مقاس أساسي جديد: يزيل الاستقلال عن كل الجدران (أساسيات فقط)
      this.state.roomDims = { w: Math.max(0.5, w), h: Math.max(0.5, h) };
      this._warnOpeningOutOfWall = [];
      this.syncAttached();
      this.changed();
    }

    /** تغيير المقاس الأساسي للغرفة: يحدّث الجدران غير المعدّلة يدوياً فقط،
        ويحافظ على أطوال الجدران التي المستخدم استقلّها (fixed). */
    setRoomDims(w, h) {
      w = Math.max(0.5, round(+w || 0.5, 3));
      h = Math.max(0.5, round(+h || 0.5, 3));
      this.state.roomDims = { w, h };
      for (const wl of this.state.walls) {
        if (wl.fixed) continue;                       // طول مستقل: لا يُمَسّ
        const horiz = Math.abs(Math.sin(rad(wl.angle))) < 0.05;
        wl.len = horiz ? w : h;
      }
      this._warnOpeningOutOfWall = this._openingsOutOfWall();
      this.syncAttached();
      this.changed();
    }

    setWalls(walls) {
      this.state.walls = walls.map((w) => {
        const o = { len: Math.max(0.3, +w.len || 0.3), angle: norm360(+w.angle || 0) };
        if (w.fixed) o.fixed = true;                   // أطوال مستقلة محفوظة
        return o;
      });
      if (this.sel && this.sel.type === 'wall' && this.sel.index >= this.state.walls.length) this.sel = null;
      this.syncAttached();
      this.changed();
    }

    /* ======================= أطوال الجدران المستقلة =======================
       كل جدار يحمل طوله في walls[i].len أصلاً؛ الجديد هنا قاعدة «مستقل»:
       • walls[i].fixed = true  ⇐ المستخدم عدّل هذا الجدار يدوياً بنفسه.
       • roomDims = { w, h }   ⇐ آخر مقاس أساسي للغرفة (الافتراضي).
       عند تغيير المقاس الأساسي لاحقاً نحدّث الجدران غير المعدّلة فقط ونحافظ على
       المعدّلة. التصاميم القديمة بلا هذه الحقول تعمل بالقيم الافتراضية بلا أخطاء. */

    /** أطوال الجدران الافتراضية حسب المقاس الأساسي الحالي (وِرث الجدران المتقابلة). */
    defaultWallLens() {
      const dims = this.state.roomDims || null;
      const ws = this.state.walls || [];
      // نأخذ أول جدار ذي اتجاه أفقي وآخر ذي اتجاه رأسي كمرجع inherited
      const horiz = ws.find((w) => Math.abs(Math.sin(rad(w.angle))) < 0.05);
      const vert = ws.find((w) => Math.abs(Math.cos(rad(w.angle))) < 0.05);
      return {
        w: dims ? +dims.w : (horiz ? horiz.len : 5),
        h: dims ? +dims.h : (vert ? vert.len : 4),
      };
    }

    _ensureRoomDims() {
      if (!this.state.roomDims) {
        const d = this.defaultWallLens();
        this.state.roomDims = { w: round(d.w, 3), h: round(d.h, 3) };
      }
      return this.state.roomDims;
    }

    /** الطول الافتراضي لجدار واحد (يُستخدم في زر «إرجاع للافتراضي»). */
    wallDefaultLen(i) {
      const ws = this.state.walls[i];
      if (!ws) return 0;
      const d = this._ensureRoomDims();
      return Math.abs(Math.sin(rad(ws.angle))) < 0.05 ? d.w : d.h;
    }

    wallIsFixed(i) { return !!(this.state.walls[i] && this.state.walls[i].fixed); }

/* ============ تثبيت طرف عند تعديل طول جدار ============
        الجدران سلسلة متراكمة (طرف كل جدار = طرف سابقه)، فلتغيير طول جدار مع تثبيت
        طرفه الأول نحتاج إزاحة «سلسلة ما قبله» بنفس المتجه — دون تغيير أي طول أو
        زاوية. نسجّل انطلاقة كل جدار مُزاح في walls[j].off (إحداثيات مطلقة)،
        فيقرأها geometryOf. الغياب = السلوك القديم تماماً.

        anchor:
          'second' ⇒ الطرف الثاني (t=len) هو المتحرك ⇒ الطرف الأول مثبّت.
                     هذا هو السلوك التاريخي (تغيير len فقط) فاحتفظ به افتراضياً.
          'first'  ⇒ الطرف الأول (t=0) هو المتحرك ⇒ الطرف الثاني مثبّت.
          'even'   ⇒ الطرفان يتحرّكان بالتساوي. */
    static WALL_ANCHORS = ['second', 'first', 'even'];

    static normAnchor(a) { return Designer.WALL_ANCHORS.includes(a) ? a : 'second'; }

    /** إزاحة انطلاقة الجدران في النطاق [from..to] بمتجه (dx,dy) — بلا تغيير
        أطوالها ولا زواياها. الانطلاقات تُحسب من `base` إن وُجد، وإلا من الحالة
        الحالية. نمرّر الحالة الأصلية في وضع «even» حتى لا تتداخل الإزاحتان. */
    _shiftWallStarts(from, to, dx, dy, base) {
      if (to < from || (dx === 0 && dy === 0)) return;
      const g = base || this.geometry();
      const n = this.state.walls.length;
      for (let j = Math.max(0, from); j <= Math.min(to, n - 1); j++) {
        const a = g.walls[j];
        if (!a) continue;
        this.state.walls[j].off = { x: round(a.A.x + dx, 4), y: round(a.A.y + dy, 4) };
      }
    }

    /** هل هذا الجدار يحمل انطلاقة مثبّتة (نتيجة تثبيت طرف)؟ */
    wallHasOffset(i) { return !!(this.state.walls[i] && this.state.walls[i].off); }

    /** إلغاء التثبيت: يعيد السلسلة إلى الانطلاق من (0,0)其自然تها، بلا تغيير الأطوال. */
    clearWallOffsets() {
      for (const w of this.state.walls) delete w.off;
      this.syncAttached();
      this.changed();
    }

    /** هل الغرفة ما زالت تحمل انطلاقة مثبّتة من تثبيت طرف سابق؟ */
    hasAnyWallOffset() { return this.state.walls.some((w) => !!w.off); }

    /**
     * تعديل طول جدار مع تحديد جهة التحريك.
     * @param i       فهرس الجدار
     * @param len     الطول الجديد (م)
     * @param anchor  'first' | 'second' | 'even'
* ملاحظة: «الطرف الأول» = t=0 أي نقطة انطلاق الجدار، و«الطرف الثاني» = t=len.
     */
    setWallLengthAnchored(i, len, anchor = 'second') {
      const ws = this.state.walls;
      if (!ws[i]) return null;
      anchor = Designer.normAnchor(anchor);
      len = Math.max(0.3, round(+len || 0.3, 3));
      const before = this.geometry();
      const base = before;           // مرجع الانطلاقات الأصلي لكل الإزاحات
      const w0 = before.walls[i];
      if (!w0) return null;
      const oldLen = w0.len;
      const diff = round(len - oldLen, 6);
      if (Math.abs(diff) < 1e-9) return null;

      /* اتجاه الجدار الحقيقي في الرسم (لا افتراض أعلى/أسفل):
         dir من الطرف الأول (A) إلى الثاني (B). */
      const d = w0.dir;

      if (anchor === 'first') {
        /* الطرف الأول يتحرك والطرف الثاني مثبّت.
           من B' = B نحسب انطلاقة الجدار: A' = B - dir*len_new.
           الجدران قبله (وأصله) تُزاح بنفس متجه A حتى لا تنشأ فجوة. */
        const A2 = { x: w0.B.x - d.x * len, y: w0.B.y - d.y * len };
        this._shiftWallStarts(0, i - 1, A2.x - w0.A.x, A2.y - w0.A.y, base);
        this.state.walls[i].off = { x: round(A2.x, 4), y: round(A2.y, 4) };
      } else if (anchor === 'even') {
        /* الطرفان يتحرّكان: كل طرف ينزاح نصف الفرق باتجاه الداخل،
           A بـ +diff/2 و B بـ -diff/2 على محور الجدار.
           ما قبل الجدار (وداخل الجدار نفسه) يُزاح مع A، وما بعده يُزاح مع B.
           القياس يُؤخذ من الحالة الأصلية للطرفين معاً (base) لا من حالة جزئية.
           ملاحظة: الجدار i نفسه ينزاح مع A فقط — نمدّ النطاق الأول إلى i-1 حتى
           لا يُزاح مرتين، ثم يمتصّ إزاحة A عبر طول الجدار الجديد. */
        const h = diff / 2;
        /* مبناها من المعادلة نفسها:
           • A يتحرّك داخلاً بمقدار |diff|/2 ⇒ A' = A - dir*(diff/2)
             (diff سالب عند التقصير ⇒ A يتحرّك نحو B، صحيح).
           • B يتحرّك داخلاً ⇒ B' = B + dir*(diff/2)
             ⇒ ما بعد الجدار ينزاح بـ +dir*(diff/2).
           نُثبّت انطلاقة الجدار نفسه على A' (الجدران قبله تُزاح معها)، ثم نُزيح
           ما بعده على B' — فالطرفان يتحرّكان halves صحيحة دون تراكب. */
        const A2 = { x: w0.A.x - d.x * h, y: w0.A.y - d.y * h };
        const B2 = { x: w0.B.x + d.x * h, y: w0.B.y + d.y * h };
        this._shiftWallStarts(0, i - 1, A2.x - w0.A.x, A2.y - w0.A.y, base);
        this.state.walls[i].off = { x: round(A2.x, 4), y: round(A2.y, 4) };
        this._shiftWallStarts(i + 1, ws.length - 1, B2.x - w0.B.x, B2.y - w0.B.y, base);
      }
      /* anchor==='second': الطرف الأول مثبّت أصلاً ⇒ تغيير len وحده يحرّك B. */

      ws[i].len = len;
      ws[i].fixed = true;

      this._warnOpeningOutOfWall = this._openingsOutOfWall();
      this.syncAttached();
      this.changed();

      const after = this.geometry().walls[i];
      return {
        anchor,
        oldLen,
        newLen: len,
        from: { A: { x: w0.A.x, y: w0.A.y }, B: { x: w0.B.x, y: w0.B.y } },
        to: after ? { A: { x: after.A.x, y: after.A.y }, B: { x: after.B.x, y: after.B.y } } : null,
      };
    }

    /** تعديل طول جدار واحد فقط (مستقل). لا يمسّ الجدار المقابل مطلقاً.
        anchor يمرَّر إلى setWallLengthAnchored، فالقيمة الافتراضية 'second'
        هي السلوك التاريخي تماماً (تغيير len وحده). */
setWallLength(i, len, anchor = 'second', markFixed = true) {
      const r = this.setWallLengthAnchored(i, len, anchor);
      if (r && markFixed === false) delete this.state.walls[i].fixed;
      return r;
    }

    /** إرجاع جدار واحد إلى طوله الافتراضي ويزيل علامة الاستقلال. */
    resetWallLength(i) {
      const ws = this.state.walls[i];
      if (!ws) return;
      const base = this.wallDefaultLen(i);
      delete ws.fixed;
      ws.len = base;
      this._warnOpeningOutOfWall = this._openingsOutOfWall();
      this.syncAttached();
      this.changed();
    }

    /** الفتحات التي خرجت عن حدود جدارها بعد تقصيره (تُعرض تنبيهاً، لا تُحذف صامتاً). */
    _openingsOutOfWall() {
      const g = this.geometry();
      const bad = [];
      for (const o of this.state.openings) {
        const w = g.walls[o.wall];
        if (!w) continue;
        const t0 = o.t - o.w / 2, t1 = o.t + o.w / 2;
        if (t0 < 0.02 || t1 > w.len - 0.02) bad.push({ o, over: t0 < 0.02 ? 'start' : 'end', t0, t1, wallLen: w.len });
      }
      return bad;
    }

    /** فجوة الإغلاق الحالية + الفتحات التي خرجت عن جدارها (تنبيه لا حذف صامت). */
    roomGapInfo() {
      const g = this.geometry();
      return { closed: g.closed, gap: round(g.gap, 3), openingsOut: this._openingsOutOfWall() };
    }

    /* شرح التعارض الهندسي (يُعرض للمستخدم قبل أي تغيير صامت):
       تغيير طول جدار واحد في غرفة مستطيلة يفتح فجوة حتماً، لأن ضلعَي المستطيل
       المتقابلين متساويان بالضرورة. لذلك لا نعدّل الجدار المقابل ولا الزاوية
       صامتاً — نُبلغ المستخدم ونمنحه خيار الإغلاق الصريح.
       هذه الدالة تحسب ما سيتغير بالضبط قبل تطبيقه. */
    explainWallChange(i, len) {
      const ws = this.state.walls[i];
      if (!ws) return null;
      const before = { len: round(ws.len, 3), closed: this.geometry().closed };
      const trial = Object.assign({}, this.state, {
        walls: this.state.walls.map((w, j) => Object.assign({}, w, j === i ? { len: Math.max(0.3, +len || 0.3) } : {})),
      });
      const g = Designer.geometryOf(trial);
      const target = norm360(ws.angle + 180);
      const opp = this.state.walls.findIndex((w, j) => j !== i && angDiff(w.angle, target) < 0.5);
      return {
        before,
        after: { len: round(trial.walls[i].len, 3), closed: g.closed, gap: round(g.gap, 3) },
        oppositeWall: opp,
        oppositeLen: opp >= 0 ? round(this.state.walls[opp].len, 3) : null,
        unchanged: opp < 0 || Math.abs(this.state.walls[opp].len - before.len) < 1e-9,
      };
    }

    /** إغلاق الغرفة صراحةً بعد استقلال الأطوال: نضبط زاوية الجدار الأخير فقط
        (لا نغيّر أي طول) فيعود الشكل مغلقاً. يُرجع زاوية الجديد أو null. */
    closeRoom() {
      const ws = this.state.walls;
      if (ws.length < 3) return null;
      const last = ws.length - 1;
      // نُبقي أوائل الجدران ونحلّ زاوية الأخير ليقفل الشكل
      let ax = 0, ay = 0;
      for (let i = 0; i < last; i++) { ax += Math.cos(rad(ws[i].angle)) * ws[i].len; ay += Math.sin(rad(ws[i].angle)) * ws[i].len; }
      const target = Math.hypot(ax, ay);
      if (target < 0.3) return null;
      let a = Math.atan2(-ay, -ax) * 180 / Math.PI;
      ws[last].len = round(target, 3);
      ws[last].angle = norm360(a);
      this._warnOpeningOutOfWall = this._openingsOutOfWall();
      this.syncAttached();
      this.changed();
      return { angle: ws[last].angle, len: ws[last].len };
    }

    setWallAngle(i, angle) {
      if (!this.state.walls[i]) return;
      this.state.walls[i].angle = norm360(+angle || 0);
      this.syncAttached();
      this.changed();
    }

    /* ======================= فحص صلاحية التصميم قبل الحفظ =======================
       يمنع حفظ تصميم فيه تداخل كنبات أو كنبة تسد باباً/مشباً. لا تكتفى بالحدود
       الحمراء: القواعد نفسها المستعملة أثناء التعديل تُطبَّق هنا على كل القطع. */
    validateDesign() {
      const issues = [];
      // 1) تداخل بين القطع (نفس قاعدة canPlace المعتمدة أثناء السحب)
      const ps = this.state.pieces;
      for (let i = 0; i < ps.length; i++) {
        for (let j = i + 1; j < ps.length; j++) {
          const a = ps[i], b = ps[j];
          if (a.kind === 'free' || b.kind === 'free') continue;
          if ((a.kind === 'acc') !== (b.kind === 'acc')) continue;
          if (this.state.cornerMode === 'full' && a.kind === 'sofa' && b.kind === 'sofa'
            && a.wall != null && b.wall != null && a.wall !== b.wall) continue;
          if (a.group && a.group === b.group) continue;
          if (Designer.polysOverlap(this.corners(a), this.corners(b)))
            issues.push({ type: 'overlap', a: a.id, b: b.id });
        }
      }
      // 2) قطعة أمام فتحة مانعة (باب/مشب)
      for (const p of ps) {
        const hit = this.hitsOpening(p);
        if (hit) issues.push({ type: 'opening', piece: p.id, openingType: hit.type, openingId: hit.id });
      }
      return { ok: issues.length === 0, issues };
    }

    /** رسالة عربية موحّدة تصف التعارض بلا التباس. */
    static blockingMessage(reason) {
      if (reason === 'opening' || (reason && reason.why === 'opening'))
        return 'لا يمكن وضع الكنبة أمام الباب أو المشب — اختر موضعاً آخر.';
      if (reason === 'overlap' || (reason && reason.why === 'overlap'))
        return 'لا يمكن وضع الكنبة هنا — تتداخل مع قطعة أخرى.';
      return 'لا توجد مساحة صالحة لهذه القطعة — اختر موضعاً آخر.';
    }

    /* ======================= فحص شامل بعد أي تغيير في هندسة الغرفة =======================
       يُستدعى من الواجهات بعد تغيير أطوال الجدران: يعيد كل تعارض (تداخل قطعة،
       كنبة سدّت فتحة، فتحة خرجت عن جدارها، غرفة غير مغلقة) ليعرضه المستخدم
       ونمنع الحفظ — بدل نقل عنصر أو حذفه بصمت. */
    checkRoomHealth() {
      const d = this.validateDesign();
      const gi = this.roomGapInfo();
      const openingOut = gi.openingsOut.map((x) => ({
        id: x.o ? x.o.id : x.id,
        type: x.o ? x.o.type : x.type,
        wall: x.o ? x.o.wall : x.wall,
      }));
      const msgs = [];
      if (!gi.closed) msgs.push('الغرفة غير مغلقة — يوجد فجوة ' + gi.gap.toFixed(2) + ' م. اضغط «إغلاق الغرفة» أو عدّل الجدار الأخير.');
      /* فتحات نُقلت إجباراً لتبقي داخل جدار قُصِّر: نصرّح بذلك ونطلب المعالجة
         بدل اعتبار النقل الصامت تعديلاً مقبولاً. */
      (this._clippedOpenings || []).forEach((o) => {
        const name = o.type === 'mashab' ? 'المشب' : o.type === 'window' ? 'الشباك' : 'الباب';
        msgs.push(name + ' على الجدار ' + ((o.wall || 0) + 1) + ' خرج عن الجدار فنُقل تلقائياً من '
          + round(o.fromT, 2) + ' م إلى ' + round(o.toT, 2) + ' م — انقله بنفسك أو كبّر الجدار.');
      });
      const clippedIds = new Set((this._clippedOpenings || []).map((o) => o.id));
      openingOut.filter((o) => !clippedIds.has(o.id)).forEach((o) => {
        const name = o.type === 'mashab' ? 'المشب' : o.type === 'window' ? 'الشباك' : 'الباب';
        msgs.push(name + ' على الجدار ' + ((o.wall || 0) + 1) + ' خرج عن حدود الجدار بعد تقصيره — انقله أو كبّر الجدار.');
      });
      d.issues.forEach((i) => {
        if (i.type === 'opening') {
          const name = i.openingType === 'mashab' ? 'المشب' : i.openingType === 'window' ? 'الشباك' : 'الباب';
          msgs.push('كنبة تسدّ ' + name + ' — انقلها بعيداً عنه.');
        } else if (i.type === 'overlap') {
          msgs.push('تداخل بين قطعتين في التصميم.');
        }
      });
      return { ok: d.ok && gi.closed && openingOut.length === 0, issues: d.issues, gap: gi, messages: msgs };
    }

    addWall(len, angle) {
      const ws = this.state.walls;
      const last = ws[ws.length - 1];
      ws.push({
        len: Math.max(0.3, round(+len || 2, 3)),
        angle: angle != null ? norm360(+angle || 0) : norm360((last ? last.angle : 0) + 90),
      });
      this.syncAttached();
      this.changed();
      return ws.length - 1;
    }

    removeWall(i) {
      const ws = this.state.walls;
      if (ws.length <= 3 || !ws[i]) return false;
      const removedFixed = !!ws[i].fixed;
      ws.splice(i, 1);
      /* حذف جدار كان مرجعاً لطول أساسي: نعيد حساب القيمة الأساسية من
         الجدران الباقية حتى لا يشير roomDims إلى جدار محذوف. */
      if (removedFixed) {
        const horiz = ws.find((x) => Math.abs(Math.sin(rad(x.angle))) < 0.05);
        const vert = ws.find((x) => Math.abs(Math.cos(rad(x.angle))) < 0.05);
        if (horiz) this.state.roomDims = Object.assign({}, this.state.roomDims, { w: horiz.len });
        if (vert) this.state.roomDims = Object.assign({}, this.state.roomDims, { h: vert.len });
      }
      for (const p of this.state.pieces) {
        if (p.wall == null) continue;
        if (p.wall === i) { delete p.wall; delete p.t; } else if (p.wall > i) p.wall--;
      }
      this.state.openings = this.state.openings.filter((o) => o.wall !== i);
      for (const o of this.state.openings) if (o.wall > i) o.wall--;
      // كنب زاوية فقد أحد ضلعيه: يُحذف كاملاً بدل ترك ذراع معلّق
      const orphan = new Set(this.state.pieces.filter((p) => p.group && p.wall == null).map((p) => p.group));
      if (orphan.size) this.state.pieces = this.state.pieces.filter((p) => !p.group || !orphan.has(p.group));
      for (const p of this.state.pieces) if (p.group && p.corner != null && p.corner > i) p.corner--;
      if (this.sel && this.sel.type === 'wall') this.sel = null;
      this.syncAttached();
      this.changed();
      return true;
    }

    setCornerMode(mode) {
      this.state.cornerMode = mode === 'deduct' ? 'deduct' : 'full';
      this.changed();
    }

    /* ======================= الفتحات (أبواب/شبابيك) ======================= */
    addOpening(wallIndex, type = 'door') {
      const g = this.geometry();
      const w = g.walls[wallIndex];
      if (!w) return null;
      const width = Math.min(type === 'door' ? 0.9 : type === 'mashab' ? 1.0 : 1.2, w.len);
      // أول موضع حر على الجدار
      const occ = this.state.openings.filter((o) => o.wall === wallIndex).map((o) => [o.t - o.w / 2, o.t + o.w / 2]);
      const free = this._freeIntervals(w.len, occ, width).sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
      const t = free.length ? (free[0][0] + free[0][1]) / 2 : w.len / 2;
      const o = { id: uid(), wall: wallIndex, t: round(t, 3), w: width, type, blocks: type === 'door' || type === 'mashab', depth: type === 'mashab' ? 0.5 : 0 };
      this.state.openings.push(o);
      this.select({ type: 'opening', id: o.id });
      this.changed();
      return o;
    }

    opening(id) { return this.state.openings.find((o) => o.id === id) || null; }

    /** المسافة الحية من حافتي الفتحة لطرفي الجدار (بالمتر، من الحافة لا المركز).
        تُستخدم لرسم قراءات «← سم → [باب/مشب] ← سم →» أثناء السحب. */
    openingGaps(id) {
      const o = this.opening(id);
      if (!o) return null;
      const g = this.geometry();
      const w = g.walls[o.wall];
      if (!w) return null;
      const left = Math.max(0, round(o.t - o.w / 2, 3));
      const right = Math.max(0, round(w.len - (o.t + o.w / 2), 3));
      return { left, right, wallLen: round(w.len, 3) };
    }

    updateOpening(id, props) {
      const o = this.opening(id);
      if (!o) return;
      Object.assign(o, props);
      if (props.type) o.type = ['door', 'window', 'mashab'].includes(props.type) ? props.type : 'door';
      this.syncAttached();
      this.changed();
    }

    removeOpening(id) {
      this.state.openings = this.state.openings.filter((o) => o.id !== id);
      if (this.sel && this.sel.type === 'opening' && this.sel.id === id) this.sel = null;
      this.changed();
    }

    /* ======================= القطع ======================= */
    piece(id) { return this.state.pieces.find((p) => p.id === id) || null; }
    selectedPiece() { return this.sel && this.sel.type === 'piece' ? this.piece(this.sel.id) : null; }
    selectedWallIndex() { return this.sel && this.sel.type === 'wall' ? this.sel.index : -1; }
    selectedOpening() { return this.sel && this.sel.type === 'opening' ? this.opening(this.sel.id) : null; }

    /** معلومات التحديد الحالي (للوحة الخصائص) */
    selectionInfo() {
      if (!this.sel) return null;
      const g = this.geometry();
      if (this.sel.type === 'piece') { const p = this.selectedPiece(); return p ? { type: 'piece', piece: p } : null; }
      if (this.sel.type === 'wall') { const w = this.state.walls[this.sel.index]; return w ? { type: 'wall', index: this.sel.index, wall: w, geom: g.walls[this.sel.index] } : null; }
      if (this.sel.type === 'opening') { const o = this.selectedOpening(); return o ? { type: 'opening', opening: o, wallLen: g.walls[o.wall] ? g.walls[o.wall].len : 0 } : null; }
      return null;
    }

    /** موضع التحديد على الشاشة (بكسل CSS داخل الكانفس) لتموضع لوحة الخصائص */
    selectionScreenPos() {
      const info = this.selectionInfo();
      if (!info) return null;
      const g = this.geometry();
      if (info.type === 'piece') {
        const cs = this.corners(info.piece).map((c) => this.toScreen(c.x, c.y));
        const xs = cs.map((c) => c.x), ys = cs.map((c) => c.y);
        return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: Math.max(...ys), top: Math.min(...ys) };
      }
      if (info.type === 'wall') {
        const w = g.walls[info.index];
        const m = this.toScreen(w.mid.x - w.n.x * WALL_T / 2, w.mid.y - w.n.y * WALL_T / 2);
        return { x: m.x, y: m.y + 10, top: m.y - 10 };
      }
      if (info.type === 'opening') {
        const o = info.opening, w = g.walls[o.wall];
        const c = this.toScreen(w.A.x + w.dir.x * o.t - w.n.x * WALL_T / 2, w.A.y + w.dir.y * o.t - w.n.y * WALL_T / 2);
        return { x: c.x, y: c.y + 10, top: c.y - 10 };
      }
      return null;
    }

    /** موضع تسمية مقاس الجدار على الشاشة (بكسل CSS) لفتح التعديل المباشر فوقها في الجوال */
    wallLabelPos(i, v = this.view) {
      const g = this.geometry();
      const w = g.walls[i];
      if (!w) return null;
      const off = WALL_T + WALL_LABEL_OFF;
      return this.toScreen(w.mid.x - w.n.x * off, w.mid.y - w.n.y * off, v);
    }

    select(sel) {
      this.sel = sel;
      this.render();
      if (this.opts.onSelect) this.opts.onSelect(this.selectionInfo());
    }

    changed() {
      this._pushHistory();
      this.render();
      if (this.opts.onChange) this.opts.onChange();
    }

    addPiece(piece) {
      piece.id = piece.id || uid();
      piece.rot = norm360(piece.rot || 0);
      this.state.pieces.push(piece);
      this.select({ type: 'piece', id: piece.id });
      this.changed();
      return piece;
    }

    _freeIntervals(len, occupied, minLen = 0.3) {
      const occ = occupied.map(([a, b]) => [Math.max(0, a), Math.min(len, b)]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
      const free = [];
      let cur = 0;
      for (const [a, b] of occ) { if (a > cur + 0.01) free.push([cur, a]); cur = Math.max(cur, b); }
      if (cur < len - 0.01) free.push([cur, len]);
      return free.filter((f) => f[1] - f[0] >= minLen - 1e-9);
    }

    /** المسافات المشغولة على جدار (قطع + فتحات مانعة) */
    _occupied(wallIdx, depth, includeOtherWalls, excludeId) {
      const g = this.geometry();
      const w = g.walls[wallIdx];
      const occ = [];
      for (const p of this.state.pieces) {
        if (p.id === excludeId) continue;
        if (!includeOtherWalls && p.kind === 'sofa' && p.wall != null && p.wall !== wallIdx) continue;
        const r = this._projectOnWall(p, w);
        if (r.smin < depth - 0.02 && r.smax > 0.02 && r.tmax > 0.02 && r.tmin < w.len - 0.02) occ.push([r.tmin, r.tmax]);
      }
      for (const o of this.state.openings) if (o.wall === wallIdx && o.blocks) occ.push([o.t - o.w / 2, o.t + o.w / 2]);
      return occ;
    }

    /** إضافة قطعة كنب على جدار في أكبر مسافة حرة */
    /** تركيبة الكنب: { depth, ...حقول تُنسخ على القطعة } — الكنبة ليست صنفاً
        واحداً بل تركيب من خشب وقماش وإسفنج، فالمحرّك يستقبل الحقول كما هي. */
    _sofaSpec(spec) {
      const s = spec || {};
      const rest = {};
      Object.keys(s).forEach((k) => { if (k !== 'depth') rest[k] = s[k]; });
      return { depth: Math.max(0.2, +s.depth || 0.8), rest };
    }

addSofaOnWall(wallIndex, spec) {
      const g = this.geometry();
      const w = g.walls[wallIndex];
      if (!w || !spec) return null;
      const { depth, rest } = this._sofaSpec(spec);
      /* نبحث في كل الفترات الحرة (لا الأكبر فقط) ونختار أول فترة تُعطي كنبة
         صالحة هندسياً: الفترات المحسوبة على المحور قد تكون متجاور ة لمنطقة
         استخدام باب/مشب، فيمنعها الفحص الهندسي المشترك. */
      const occ = this._occupied(wallIndex, depth, this.state.cornerMode === 'deduct');
      const free = this._freeIntervals(w.len, occ, 0.3).sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
      if (!free.length) return null;
      for (const [t0, t1] of free) {
        const piece = Object.assign({ id: uid(), kind: 'sofa' }, rest, {
          w: round(t1 - t0, 2), h: depth, wall: wallIndex, t: round((t0 + t1) / 2, 3), x: 0, y: 0, rot: 0,
        });
        this._placeOnWall(piece, w);
        if (this.opts.noOverlap && !this.canPlace(piece, { skipOpenings: false })) continue;
        return this.addPiece(piece);
      }
      return null;
    }

    /** قطع كنب زاوية محفوظة من قبل، منتمية لمجموعة واحدة.
        إنشاء كنب الزاوية أُزيل مع تبويب الزوايا، لكن ما حُفظ في طلبات سابقة
        يبقى قطعاً على المخطط تُدار كأي كنبة، ويُجمع في سطر تسعير واحد. */
    groupPieces(group) { return this.state.pieces.filter((p) => p.group && p.group === group); }

    removeGroup(group) {
      const before = this.state.pieces.length;
      this.state.pieces = this.state.pieces.filter((p) => p.group !== group);
      if (this.state.pieces.length === before) return false;
      this.sel = null;
      this.changed();
      return true;
    }

    /** فرش كل الجدران: الأطول أولاً حتى يأخذ طوله كاملاً وتُخصم الزوايا من الجدران الأقصر (توزيع متناظر بلا تداخل) */
    fillAllWalls(spec) {
      const order = this.state.walls.map((w, i) => ({ i, len: w.len })).sort((a, b) => (b.len - a.len) || (a.i - b.i));
      let count = 0;
      const skipped = [];
      // خطوة واحدة في سجل التراجع مهما كان عدد القطع المضافة
      this._suspendHistory = true;
      try {
        for (const { i } of order) {
          if (this.addSofaOnWall(i, spec)) count++;
          else skipped.push(i);
        }
      }
      finally { this._suspendHistory = false; }
      if (count) this.changed();
      // تقرير لمن يريد عرضه: أي الجدران لم تتسع لكتبة كاملة
      this.lastFill = { added: count, skipped: skipped, total: order.length };
      return count;
    }

    addSofaFree(spec) {
      const g = this.geometry();
      const { depth, rest } = this._sofaSpec(spec);
      const cx = (g.bb.minX + g.bb.maxX) / 2, cy = (g.bb.minY + g.bb.maxY) / 2;
      return this.addPiece(Object.assign({ kind: 'sofa' }, rest, { x: cx, y: cy, w: Math.min(2, Math.max(0.5, (g.bb.maxX - g.bb.minX) * 0.4)), h: depth, rot: 0 }));
    }

    /** أقرب موضع في وسط الغرفة يتسع لمستطيل w×h دون أن يركب قطعة قائمة */
    _freeSpot(w, h) {
      const g = this.geometry();
      const cx0 = (g.bb.minX + g.bb.maxX) / 2, cy0 = (g.bb.minY + g.bb.maxY) / 2;
      const stepX = w + 0.15, stepY = h + 0.15;
      for (let ring = 0; ring <= 6; ring++) {
        for (let dy = -ring; dy <= ring; dy++) {
          for (let dx = -ring; dx <= ring; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
            const cand = { x: cx0 + dx * stepX, y: cy0 + dy * stepY, w, h, rot: 0 };
            const poly = this.corners(cand);
            if (!this.state.pieces.some((p) => Designer.polysOverlap(poly, this.corners(p)))) return { x: cand.x, y: cand.y };
          }
        }
      }
      return { x: cx0, y: cy0 };
    }

    addAccessory(item) {
      const w = +item.w || 0.5, h = +item.h || 0.5;
      const pos = this._freeSpot(w, h);
      return this.addPiece({ kind: 'acc', itemId: item.id, x: round(pos.x, 3), y: round(pos.y, 3), w, h, rot: 0, shape: item.shape || 'rect' });
    }

    /** مساحة حرة: مستطيل يُعلّم فراغاً في المجلس (ممر، طاولة، مدخل).
        لا صنف له ولا سعر — لا يدخل جدول التسعير ولا الفاتورة، ويُكتب في أمر
        التصنيع بمقاسه. مقاسه يُعدَّل من المفتّش بخلاف الإكسسوار المثبَّت من بطاقته. */
    addFreeSpace(w = 1.5, h = 1) {
      const ww = Math.max(0.2, +w || 1.5), hh = Math.max(0.2, +h || 1);
      const pos = this._freeSpot(ww, hh);
      return this.addPiece({ kind: 'free', x: round(pos.x, 3), y: round(pos.y, 3), w: ww, h: hh, rot: 0 });
    }

    /**
     * ضبط عدد قطع إكسسوار في التصميم إلى العدد المطلوب: يُضيف في الفراغ أو يحذف الأحدث.
     * تُستعمل من جدول التسعير ليُعكس تعديل الكمية على المخطط. خطوة واحدة في سجل التراجع.
     * تُعيد العدد بعد التنفيذ.
     */
    /* ضبط عدد قطع إكسسوار إلى العدد المطلوب — الموجود يبقى مكانه، والجديد
       يوزَّع في الفراغ (بلا تكديس فوق بعضه ولا خروج من الغرفة). يعيد العدد
       الموضوع فعلاً، فقد يكون أقل عند ضيق المساحة. */
    setAccessoryCount(item, count) {
      const n = Math.max(0, Math.round(+count || 0));
      const have = this.state.pieces.filter((p) => p.kind === 'acc' && p.itemId === item.id);
      const diff = n - have.length;
      if (!diff) return have.length;
      // دفعة واحدة في سجل التراجع مهما كان عدد القطع (الدفع المباشر لا يُطلق changed لكل قطعة)
      this._suspendHistory = true;
      try {
        if (diff > 0) {
          const w = Math.max(0.2, +item.w || 0.5), h = Math.max(0.2, +item.h || 0.5);
          const spots = this.findSpots(w, h, diff, 'acc');
          for (const s of spots) {
            this.state.pieces.push({ id: uid(), kind: 'acc', itemId: item.id, x: s.x, y: s.y, w, h, rot: 0, shape: item.shape || 'rect' });
          }
          this._placed = have.length + spots.length;
        } else {
          const drop = new Set(have.slice(diff).map((p) => p.id));
          this.state.pieces = this.state.pieces.filter((p) => !drop.has(p.id));
          if (this.sel && this.sel.type === 'piece' && drop.has(this.sel.id)) this.sel = null;
          this._placed = n;
        }
      } finally {
        this._suspendHistory = false;
      }
      // لا تُفتح لوحة الخصائص على قطعة أُضيفت من صفحة التسعير
      this.select(null);
      this.changed();
      const placed = this._placed != null ? this._placed : n;
      this._placed = null;
      return placed;
    }

    /** حذف جميع قطع الإكسسوار فقط — عملية واحدة في سجل التراجع.
        لا تمسّ الأثاث (kind==='sofa' أو 'free') ولا الغرفة ولا الأبواب والمشب. */
    deleteAllAccessoryPieces() {
      const before = this.state.pieces.length;
      const drop = new Set(this.state.pieces.filter((p) => p.kind === 'acc').map((p) => p.id));
      if (!drop.size) return 0;
      this.state.pieces = this.state.pieces.filter((p) => !drop.has(p.id));
      if (this.sel && this.sel.type === 'piece' && drop.has(this.sel.id)) this.sel = null;
      // إزالة المجموعات التي لم تعد تحوي قطعاً (حتى لا يبقى معرّف يتيم)
      const left = new Set(this.state.pieces.filter((p) => p.group).map((p) => p.group));
      for (const g of new Set([...this.state.pieces.map((p) => p.group)].filter((g) => g && !left.has(g)))) {
        this.state.pieces = this.state.pieces.filter((p) => p.group !== g);
      }
      this.select(null);
      this.changed();
      return before - this.state.pieces.length;
    }

    /** محاولة إلصاق قطعة كنب بأقرب جدار مطابق للاتجاه */
    /* انجذاب ذكي (للنسخة التجريبية عبر opts.smartSnap):
     يلتقط الجدار مرة واحدة ثم يسمح بالسحب الحر حتى يبتعد العنصر بما يتجاوز
     حدّ الفكّ (أوسع من حدّ الالتقاط)، فلا يقفز إلا عند جدار جديد.
     ولا يلتصق فوق فتحة مانعة. بلا الخيار: السلوك القديم حرفياً. */
  /** هل يُطبَّق على هذه القطعة منطق المحاذاة إلى الجدار؟
        المحاذاة خاصية حصرياً للكنب والجلسات: هي التي تُلصق الكنبة بالجدار
        وتحفظ واجهتها موازية له. الإكسسوار لا يُلصق ولا يقفز إلى الجدار أبداً،
        ولا عند بدء السحب ولا أثناءه ولا عند إنهائه ولا عند تدويره. */
  static wantsWallSnap(p) { return !!p && p.kind === 'sofa'; }

  _trySnapToWall(p, g = this.geometry(), tol = 0.25) {
      if (!Designer.wantsWallSnap(p)) { delete p.wall; delete p.t; return false; }
      const d = this.drag;
      if (this.opts.smartSnap && d && d.mode === 'move') {
        const rel = d.snapRel || (d.snapRel = {});
        const tolRel = tol * 2.4;
        let best = null, bestD = Infinity;
        for (const w of g.walls) {
          if (angDiff(p.rot, w.rot) > 10) continue;
          const { t, s } = this.wallCoords(w, { x: p.x, y: p.y });
          if (t < -0.3 || t > w.len + 0.3) continue;
          const ds = Math.abs(s - p.h / 2);
          /* الانجذاب الذكي: تلتصق القطعة مرة واحدة ثم تنفصل بتباعد واضح عن الجدار.
            الشرط held كان يكفي فيه بقاء t ثابتاً، فتبقى الكنبة ملتصقة للأبد ولا
            تتحرك مع السحب إطلاقاً. نضيف الآن شرط القرب: المتابعة ملتصقة فقط ما
            دامت القطعة قريبة من الجدار (ds < tol)، فتبتعد فتنفصل كما يقتضي السحب. */
          const held = rel[w.i] != null && ds < tol && Math.abs(rel[w.i] - t) <= tolRel;
          if (!held && ds >= tol) continue;
          if (ds >= bestD) continue;
          if (this._spansOpening({ wall: w.i, t: t, w: p.w }, w.i)) continue;
          bestD = ds; best = { w: w, t: t };
        }
        if (best) {
          p.wall = best.w.i; p.t = round(best.t, 3); this._placeOnWall(p, best.w);
          rel[best.w.i] = p.t;
          for (const k of Object.keys(rel)) if (+k !== best.w.i) delete rel[k];
          return true;
        }
        for (const k of Object.keys(rel)) delete rel[k];
        delete p.wall; delete p.t;
        return false;
      }
      let best = null, bestD = Infinity;
      for (const w of g.walls) {
        if (angDiff(p.rot, w.rot) > 10) continue;
        const { t, s } = this.wallCoords(w, { x: p.x, y: p.y });
        const ds = Math.abs(s - p.h / 2);
        if (ds < tol && t > -0.3 && t < w.len + 0.3 && ds < bestD) {
          /* لا يلتصق فوق فتحة مانعة (باب/مشب): الفحص الهندسي المشترك نفسه
             المستعمل في السحب والحقول — لا مقارنة أطراف على المحور. */
          if (this._spansOpening({ wall: w.i, t: t, w: p.w }, w.i)) continue;
          bestD = ds; best = { w: w, t: t };
        }
      }
      if (best) { p.wall = best.w.i; p.t = round(best.t, 3); this._placeOnWall(p, best.w); return true; }
      delete p.wall; delete p.t;
      return false;
    }

    updateSelected(props) {
      const p = this.selectedPiece();
      if (!p) return;
      // حالة قبل التعديل: تُستعاد إن استُبعد الموضع الجديد (منع التداخل)
      const prevProps = { w: p.w, h: p.h, rot: p.rot, x: p.x, y: p.y, wall: p.wall, t: p.t };
      const rotChanged = props.rot != null && norm360(+props.rot) !== p.rot;
      // مقاس الإكسسوار محكوم ببطاقة الصنف: يُقبل فقط مع تغيير الصنف نفسه
      if (!Designer.canResize(p) && props.itemId === undefined) { props = Object.assign({}, props); delete props.w; delete props.h; }
      Object.assign(p, props);
      p.w = Math.max(MIN_SIZE, +p.w || MIN_SIZE);
      p.h = Math.max(MIN_SIZE, +p.h || MIN_SIZE);
      p.rot = norm360(+p.rot || 0);
      const g = this.geometry();
      if (p.wall != null && !rotChanged) this._placeOnWall(p, g.walls[p.wall]);
      else this._trySnapToWall(p, g, 0.12);
      /* الحقول الرقمية مسار تعديل مباشر: يُفحص التداخل والباب/المشب هنا أيضاً (noOverlap) */
      if (this.opts.noOverlap) {
        const v = this.validatePlacement(p);
        if (!v.ok) {
          const safe = this._resolveOverlap(p);
          if (safe) {
            Object.assign(p, safe);
            if (safe.wall != null && g.walls[safe.wall]) this._placeOnWall(p, g.walls[safe.wall]);
          } else {
            Object.assign(p, prevProps);
            if (p.wall != null && g.walls[p.wall]) this._placeOnWall(p, g.walls[p.wall]);
          }
          /* نُبلّغ بسببه الحقيقي: أمام باب/مشب أم تداخل مع قطعة */
          const after = this.validatePlacement(p);
          const why = after.ok ? v.why : after.why;
          if (this.opts.onBlocked) this.opts.onBlocked(p, why, 'props');
        }
      }
      this.changed();
    }

    removeSelected() {
      if (!this.sel) return;
      if (this.sel.type === 'piece') {
        // كنب الزاوية قطعة واحدة: حذف أحد ذراعيه كان يترك الآخر معلّقاً بلا زاوية
        const p = this.piece(this.sel.id);
        const group = p && p.group;
        this.state.pieces = this.state.pieces.filter((q) => q.id !== this.sel.id && !(group && q.group === group));
        this.sel = null;
        if (this.opts.onSelect) this.opts.onSelect(null);
        this.changed();
      } else if (this.sel.type === 'opening') {
        this.removeOpening(this.sel.id);
        if (this.opts.onSelect) this.opts.onSelect(null);
      }
    }

    duplicateSelected() {
      const p = this.selectedPiece();
      if (!p) return;
      const q = Object.assign({}, p, { id: uid() });
      delete q.wall; delete q.t;
      // النسخة قطعة مستقلة: لو ورثت group لعُدّت ذراعاً ثالثاً لكنب الزاوية الأصلي
      // (تُحسب معه قطعة واحدة في الفاتورة، ويُتجاهل تداخلها معه)
      delete q.group; delete q.corner;
      q.x = p.x + 0.3; q.y = p.y + 0.3;
      this._clampToRoom(q, this.geometry());
      this.addPiece(q);
    }

    rotateSelected(deg) {
      const p = this.selectedPiece();
      if (!p) return;
      p.rot = norm360(p.rot + deg);
      this._trySnapToWall(p, this.geometry(), 0.12);
      this.changed();
      if (this.opts.onSelect) this.opts.onSelect(this.selectionInfo());
    }

    moveSelected(dx, dy) {
      const p = this.selectedPiece();
      if (!p) return;
      p.x = round(p.x + dx, 3); p.y = round(p.y + dy, 3);
      this._clampToRoom(p, this.geometry());
      this._trySnapToWall(p, this.geometry(), 0.12);
      this.changed();
    }

    splitSelected(n) {
      const p = this.selectedPiece();
      n = Math.floor(+n || 0);
      if (!p || n < 2) return;
      const a = rad(p.rot), c = Math.cos(a), s = Math.sin(a);
      // التقريب لكل قطعة كان يغيّر المجموع (3.2 ÷ 3 = 1.07 × 3 = 3.21 م) فيتغيّر السعر:
      // القطع متساوية بكسرين، والأخيرة تأخذ الباقي حتى يبقى الطول الكلي كما هو
      const exact = p.w / n;
      const segW = round(exact, 2);
      const created = [];
      for (let k = 0; k < n; k++) {
        const lx = -p.w / 2 + exact * (k + 0.5);
        const w = k === n - 1 ? round(p.w - segW * (n - 1), 2) : segW;
        const q = Object.assign({}, p, { id: uid(), w, x: round(p.x + lx * c, 3), y: round(p.y + lx * s, 3) });
        if (p.wall != null) q.t = round(p.t + lx, 3);
        created.push(q);
      }
      this.state.pieces = this.state.pieces.filter((q) => q.id !== p.id).concat(created);
      this.syncAttached();
      this.select({ type: 'piece', id: created[0].id });
      this.changed();
    }

    alignSelectedToWall(wallIndex = -1) {
      const p = this.selectedPiece();
      if (!p) return;
      const g = this.geometry();
      let best = null, bestD = Infinity;
      const cands = wallIndex >= 0 ? [g.walls[wallIndex]] : g.walls;
      for (const w of cands) {
        if (!w) continue;
        const d = distToSegment({ x: p.x, y: p.y }, w.A, w.B);
        if (d < bestD) { bestD = d; best = w; }
      }
      if (!best) return;
      const { t } = this.wallCoords(best, { x: p.x, y: p.y });
      p.wall = best.i; p.t = round(t, 3);
      this._placeOnWall(p, best);
      this.changed();
      if (this.opts.onSelect) this.opts.onSelect(this.selectionInfo());
    }

    /* ======================= العرض (تكبير/تحريك) ======================= */
    _fitView(W, H) {
      const g = this.geometry();
      const pad = WALL_T + WALL_LABEL_OFF + 0.3;
      const bw = Math.max(1, g.bb.maxX - g.bb.minX) + pad * 2;
      const bh = Math.max(1, g.bb.maxY - g.bb.minY) + pad * 2;
      const scale = Math.min(W / bw, H / bh);
      const ox = (W - (g.bb.maxX - g.bb.minX) * scale) / 2 - g.bb.minX * scale;
      const oy = (H - (g.bb.maxY - g.bb.minY) * scale) / 2 - g.bb.minY * scale;
      return { scale, ox, oy };
    }
    toScreen(x, y, v = this.view) { return { x: v.ox + x * v.scale, y: v.oy + y * v.scale }; }
    toRoom(sx, sy, v = this.view) { return { x: (sx - v.ox) / v.scale, y: (sy - v.oy) / v.scale }; }

    zoomAt(k, sx, sy) {
      this.autoFit = false;
      const v = this.view;
      const ns = clamp(v.scale * k, 6, 800);
      const kk = ns / v.scale;
      if (sx == null) { sx = this.cssW / 2; sy = this.cssH / 2; }
      v.ox = sx - (sx - v.ox) * kk;
      v.oy = sy - (sy - v.oy) * kk;
      v.scale = ns;
      this.render();
    }
    panBy(dx, dy) { this.autoFit = false; this.view.ox += dx; this.view.oy += dy; this.render(); }
    fitView() { this.autoFit = true; this.render(); }

    /* ======================= الأحداث ======================= */
    _bind() {
      const c = this.canvas;
      c.style.touchAction = 'none';
      // سحب قطعة/فتحة/مقبض: نمنع تمرير الصفحة بإصبع واحد (سلوك touch-action:none
      // وحده لا يكفي على أندرويد: يمرّ التمرير افتراضياً ما لم نُلغِه عند السحب).
      // السحب على الفراغ (pan) لا يُلغى — تمرير الصفحة هناك سلوك مقصود.
      const blockScroll = (e) => {
        const d = this.drag;
        if (!d) return;
        const edits = d.mode === 'move' || d.mode === 'opening' || d.mode === 'resizeW' ||
          d.mode === 'resizeH' || d.mode === 'rotate' || d.mode === 'pinch';
        if (edits && e.cancelable) e.preventDefault();
      };
      this._blockScroll = blockScroll;
      // مستمع واحد على document لكل صفحة: يُسجّل المصمم النشط فيُحجب التمرير
      // أثناء سحب قطعة فيه فقط (البوابة تُنشئ مصمماً جديداً في كل دخول).
      if (!Designer._scrollBlocker) {
        Designer._scrollBlocker = function (e) {
          const d = Designer._active && Designer._active.drag;
          if (!d) return;
          const edits = d.mode === 'move' || d.mode === 'opening' || d.mode === 'resizeW' ||
            d.mode === 'resizeH' || d.mode === 'rotate' || d.mode === 'pinch';
          if (edits && e.cancelable) e.preventDefault();
        };
        document.addEventListener('touchmove', Designer._scrollBlocker, { passive: false });
      }
      c.addEventListener('pointerdown', (e) => { Designer._active = this; this._down(e); });
      c.addEventListener('pointermove', (e) => { blockScroll(e); this._move(e); });
      c.addEventListener('pointerup', (e) => this._up(e));
      c.addEventListener('pointercancel', (e) => this._up(e));
      c.addEventListener('lostpointercapture', (e) => { this.pointers.delete(e.pointerId); });
      c.addEventListener('dblclick', (e) => this._dbl(e));
      c.addEventListener('wheel', (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        const { sx, sy } = this._pos(e);
        this.zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, sx, sy);
      }, { passive: false });
      c.addEventListener('contextmenu', (e) => e.preventDefault());
      if (typeof ResizeObserver !== 'undefined') {
        this._ro = new ResizeObserver(() => this.resize());
        this._ro.observe(c.parentElement || c);
      }
      // إعادة الرسم بعد تحميل الخط: وإلا بقيت كتابة المخطط بالخط الاحتياطي
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => this.render()).catch(() => {});
      }
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const rect = this.canvas.getBoundingClientRect();
      const W = Math.max(120, rect.width), H = Math.max(120, rect.height);
      if (Math.abs(W - this.cssW) < 0.5 && Math.abs(H - this.cssH) < 0.5 && this.canvas.width === Math.round(W * dpr)) return;
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
      this.cssW = W; this.cssH = H;
      this.render();
    }

    _pos(e) {
      const r = this.canvas.getBoundingClientRect();
      return { sx: e.clientX - r.left, sy: e.clientY - r.top };
    }

    _handles(p, v = this.view) {
      const a = rad(p.rot), c = Math.cos(a), s = Math.sin(a);
      const at = (lx, ly) => this.toScreen(p.x + lx * c - ly * s, p.y + lx * s + ly * c, v);
      const top = at(0, -p.h / 2);
      return { resizeW: at(p.w / 2, 0), resizeH: at(0, p.h / 2), rotate: { x: top.x + s * ROT_OFFSET, y: top.y - c * ROT_OFFSET }, top };
    }

    /**
     * الإكسسوار مقاسه من بطاقة الصنف ولا يُغيَّر في المخطط:
     * مقبضا التكبير لا يُرسمان له ولا يُلتقطان، ويبقى التدوير متاحاً.
     */
    static canResize(p) { return !!p && p.kind !== 'acc'; }

    _hitHandle(p, sx, sy, tol) {
      const hs = this._handles(p);
      let keys = Designer.canResize(p) ? ['rotate', 'resizeW', 'resizeH'] : ['rotate'];
      // العمق للكنبة يُغيَّر من الحقل الرقمي فقط (noDepthDrag): الطول والتدوير يبقيان
      if (this.opts.noDepthDrag && p.kind === 'sofa') keys = keys.filter((k) => k !== 'resizeH');
      for (const k of keys) {
        if (Math.hypot(hs[k].x - sx, hs[k].y - sy) <= tol) return k;
      }
      return null;
    }

    /** ترتيب الرسم: المساحات الحرة أرضيةً، ثم الأعمدة (إنشائية تحت الأثاث)، ثم الكنب، ثم الإكسسوارات فوقه */
    _drawOrder() {
      const ps = this.state.pieces;
      return ps.filter((p) => p.kind === 'free')
        .concat(ps.filter((p) => p.kind === 'column'))
        .concat(ps.filter((p) => p.kind !== 'free' && p.kind !== 'acc' && p.kind !== 'column'))
        .concat(ps.filter((p) => p.kind === 'acc'));
    }

    /** الأعمدة: عناصر إنشائية داخل الغرفة — يمنع أي أثاث فوقها */
    addColumn(w = 0.6, h = 0.6) {
      const g = this.geometry();
      const ww = Math.max(0.2, +w || 0.6), hh = Math.max(0.2, +h || 0.6);
      const cx = (g.bb.minX + g.bb.maxX) / 2, cy = (g.bb.minY + g.bb.maxY) / 2;
      const p = { kind: 'column', x: round(cx, 3), y: round(cy, 3), w: ww, h: hh, rot: 0 };
      this._clampToRoom(p, g);
      return this.addPiece(p);
    }

    overlapsColumn(p, excludeId = null) {
      if (!p) return false;
      const me = this.corners(p);
      return this.state.pieces.some((c) => c.kind === 'column' && c.id !== excludeId && Designer.polysOverlap(me, this.corners(c)));
    }

    /** إبقاء مركز القطعة داخل مستطيل الغرفة (لا تخرج من اللوحة بصمت) */
    /* حدود الغرفة تراعي الحجم والاتجاه الفعليين للقطعة: تقييد المركز وحده
     يسمح لقطعة كبيرة أو مُدارة أن تخرج عن المخطط. */
  _halfExtent(p) {
      const c = Math.abs(Math.cos(rad(p.rot || 0))), sn = Math.abs(Math.sin(rad(p.rot || 0)));
      return { hx: (c * p.w + sn * p.h) / 2, hy: (sn * p.w + c * p.h) / 2 };
  }

  /** يعيد الموضع داخل حدود الغرفة اعتماداً على نصف امتداد القطعة الفعلي */
  _clampPieceToRoom(p, g = this.geometry(), margin = 0.02) {
      const bb = g.bb;
      const { hx, hy } = this._halfExtent(p);
      const loX = bb.minX + hx + margin, hiX = bb.maxX - hx - margin;
      const loY = bb.minY + hy + margin, hiY = bb.maxY - hy - margin;
      p.x = round(hiX < loX ? (bb.minX + bb.maxX) / 2 : clamp(p.x, loX, hiX), 3);
      p.y = round(hiY < loY ? (bb.minY + bb.maxY) / 2 : clamp(p.y, loY, hiY), 3);
      return p;
  }

  /** هل تمتد القطعة على هذا الجدار فوق فتحة مانعة (باب/مشب)؟
      rely على الفحص الهندسي المشترك hitsOpening لا على مقارنة أطراف على المحور. */
  _spansOpening(p, wallIndex) {
      if (p.wall == null || p.wall !== wallIndex) return false;
      const t0 = p.t - p.w / 2, t1 = p.t + p.w / 2;
      return this.state.openings.some((o) => o.blocks && o.wall === p.wall
        && t0 < o.t + o.w / 2 - 0.01 && t1 > o.t - o.w / 2 + 0.01);
  }

  /* ======================= منع وضع الأثاث أمام الباب/المشب =======================
     منطقة محظورة واحدة مشتركة تُستدعى من كل مسارات تعديل الأثاث (السحب، التدوير،
     تغيير الطول/العمق، الحقول الرقمية، التوزيع التلقائي) ومن الحفظ.
     تُبنى هندسياً على الجدار الفعلي: بعرض الفتحة الحقيقي + مساحة الاستخدام أمامها،
     ولا تعتمد على اسم الجدار ولا على اتجاهه المخزّن (تُشتق من الوضع الفعلي
     المرسوم). الفحص بزوايا القطعة بعد التدوير فيحسب الكنبة المدوّرة بدقّة، وكما
     يحسب قطعة غير ملتصقة بجدار إطلاقاً. */

  /** عمق الاستخدام أمام الفتحة (م)، محسوب هندسياً لا عشوائياً:
        • الباب: عرض الورقة ينفتح للداخل + ممر خروج ⇒ 0.9م (مطابق لمنطقة الحجز
          القائمة أصلاً في findSpots حتى لا تتناقض القاعدتان).
        • المشب: بروز الموقد (o.depth) + مساحة وقوف لاستخدامه ⇒ 0.4م فوق البروز. */
  static OPENING_USE_DEPTH(o) {
    if (o.type === 'mashab') return Math.max(0.6, (+o.depth || 0.5) + 0.4);
    return 0.9;
  }

  /** المستطيل المحظور في إحداثيات العالم لفتحة واحدة (يشمل مساحة استخدامها). */
  openingBlockRect(o, g) {
      const w = (g || this.geometry()).walls[o.wall];
      if (!w) return null;
      const use = Designer.OPENING_USE_DEPTH(o);
      const pad = 0.15;                       // لا نمنع الاقتراب أكثر مما يلزم
      const t0 = o.t - o.w / 2 - pad, t1 = o.t + o.w / 2 + pad;
      const s0 = -0.05, s1 = use;             // من خارج الجدار إلى عمق الاستخدام
      const P = (t, s) => ({ x: w.A.x + w.dir.x * t + w.n.x * s, y: w.A.y + w.dir.y * t + w.n.y * s });
      const quad = [P(t0, s0), P(t1, s0), P(t1, s1), P(t0, s1)];
      return { rect: Designer.polyToRect(quad), wall: o.wall, id: o.id, type: o.type, w: o.w };
  }

  /** كل مناطق الأبواب/المشاب المانعة كـ AABBs (مساحة استخدام + فتحة). */
  openingBlockRects(g) {
      const gg = g || this.geometry();
      const out = [];
      for (const o of this.state.openings) {
        if (!o || o.blocks === false) continue;
        if (!gg.walls[o.wall]) continue;
        const b = this.openingBlockRect(o, gg);
        if (b) out.push(b);
      }
      return out;
  }

  /** هل تتقاطع قطعة (بأي زاوية تدوير) مع منطقة فتحة مانعة؟
      يُرجع معرّف الفتحة المتعارضة أو null. لا يستثني إلا المساحة الحرة (أرضية). */
  hitsOpening(p, g) {
      if (!p || p.kind === 'free') return null;
      const mine = this.corners(p);
      for (const b of this.openingBlockRects(g)) {
        if (Designer.polyHitsRect(mine, b.rect)) return b;
      }
      return null;
  }

  /** فحص صلاحية كامل لوضع: أمام فتحة مانعة ثم تداخل مع قطعة أخرى.
      الترتيب مقصود: الفتحة تُفحص أولاً لأن canPlace تفحصها أيضاً ضمنياً،
      فبدون هذا الترتيب يُنسَب رفضُ الفتحة إلى تداخل قطعة. */
  validatePlacement(p, opts = {}) {
      if (!opts.skipOpenings) {
          const hit = this.hitsOpening(p, opts.geom);
          if (hit) return { ok: false, why: 'opening', opening: hit };
      }
      if (!this.canPlace(p, opts)) return { ok: false, why: 'overlap' };
      return { ok: true };
  }

  /* منع التداخل هندسياً: هل يمكن وضع القطعة candidate في مكانها؟
     الفحص بزوايا القطعة بعد التدوير (corners) لا بنقطة مركزها ولا بمستطيل غير مطابق،
     فالتدوير ٩٠° محسوب فعلاً. نتجاهل القطع المجانية (أرضية) لأنها ليست أثاثاً،
     ونسمح بتراكب الإكسسوار فوق الكنب كالمعتاد (وسائد).
     opts.skipOpenings: لتخطي مناطق الباب/المشب (يُستخدم عند بناء مناطق الفتحات نفسها). */
  canPlace(cand, opts = {}) {
      const mine = this.corners(cand);
      const myKind = cand.kind || 'sofa';
      /* منع الوضع أمام الباب/المشب: نفس الفحص الهندسي المشترك في كل المسارات.
         نتخطى الفحص إن كانت القطعة نفسها جزءاً من منطقة الفتحة (لا يحدث حالياً)
         أو طُلب التخطي صراحة. */
      if (!opts.skipOpenings) {
          const blocked = this.hitsOpening(cand, opts.geom);
          if (blocked) return false;
      }
      for (const q of this.state.pieces) {
        if (q.id === cand.id) continue;
        // المساحة الحرة إطار أرضي: ما يوضع فوقها ليس تداخلاً
        if (q.kind === 'free') continue;
        // الإكسسوار فوق أثاث (والعكس) تصرّف طبيعي: وسائد وطاولات صغيرة
        if ((q.kind === 'acc') !== (myKind === 'acc')) continue;
        // معاً في وضع «طول الجدار كامل»: زوايا الجدارات تتشارك عمداً
        if (this.state.cornerMode === 'full' && myKind === 'sofa' && q.kind === 'sofa'
          && cand.wall != null && q.wall != null && cand.wall !== q.wall) continue;
        // ذراعا كنب الزاوية يلتقيان عمداً
        if (cand.group && cand.group === q.group) continue;
        if (opts.ignore && opts.ignore.includes(q.id)) continue;
        if (Designer.polysOverlap(mine, this.corners(q))) return false;
      }
      return true;
  }

  /** يمنع التداخل: يرفض الموضع أو يبحث عن أقرب موضع صالح ضمن نصف قطر
      متدرّج. يعيد { x, y, rot, wall, t } صالحاً أو null إن لم يوجد.
      المحاولة تشمل الالتصاق بالجدار (المسار الذي يسلكه المستخدم عادةً: يسحب
      الكنبة حتى تلامس جداراً)، لأن البحث الحر في وسط الغرفة قد يفشل على
      كنبة عريضة في غرفة ضيقة بينما الموضع الجداري صالح تماماً. */
  _resolveOverlap(cand, opts = {}) {
      if (this.canPlace(cand, opts)) return cand;
      const g = opts.geom || this.geometry();
      const base = Object.assign({}, cand);
      // 1) الالتصاق بالجدار أولاً: خاص بالكنب والجلسات فقط.
      //    الإكسسوار مستثنى بالكامل: لو دخل هنا لقفز إلى الجدار عند أول تعارض،
      //    وهو ما يجعله يهرب من الإصبع ويصعب سحبه بحرية.
      if (Designer.wantsWallSnap(base)) {
        for (const w of g.walls) {
            if (angDiff(base.rot || 0, w.rot) > 10) continue;
            const half = base.w / 2;
            for (let k = 0; k <= 8; k++) {
                const tt = Math.min(Math.max(half + 0.02 + k * (w.len - half * 2 - 0.04) / 8, half), w.len - half);
                const t = Object.assign({}, base, { wall: w.i, t: round(tt, 3) });
                this._placeOnWall(t, w);
                if (this.canPlace(t, opts)) {
                    return Object.assign({}, base, { x: t.x, y: t.y, wall: w.i, t: t.t, rot: w.rot });
                }
            }
        }
      }
      const steps = [0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3];
      for (const rad of steps) {
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          const t = Object.assign({}, base, {
            x: round(base.x + Math.cos(a) * rad, 3),
            y: round(base.y + Math.sin(a) * rad, 3),
            wall: null, t: undefined
          });
          this._clampPieceToRoom(t, g);
          if (this.canPlace(t, opts)) {
            return Object.assign({}, base, { x: t.x, y: t.y, wall: null, t: undefined });
          }
        }
      }
      return null;
  }

  _clampToRoom(p, g = this.geometry(), margin = 0.05) {
      const bb = g.bb;
      p.x = round(clamp(p.x, bb.minX + margin, Math.max(bb.minX + margin, bb.maxX - margin)), 3);
      p.y = round(clamp(p.y, bb.minY + margin, Math.max(bb.minY + margin, bb.maxY - margin)), 3);
      return p;
    }

    /** شبكة مواضع حرة داخل الغرفة: تتجنب الأعمدة والجدران والقطع.
        kind='acc' يُسمح له فوق الكنب (وسائد طبيعية) لا فوق الأعمدة.
        يعيد حتى n موضعاً — قد يكون أقل إن ضاقت المساحة، ولا يخرج شيء أبداً. */
    findSpots(w, h, n, kind = '') {
      const g = this.geometry();
      const bb = g.bb;
      const closed = !!g.closed;
      const step = Math.max(0.15, Math.min(w, h) / 2);
      const cands = [];
      for (let x = bb.minX + w / 2; x <= bb.maxX - w / 2 + 1e-9; x += step) {
        for (let y = bb.minY + h / 2; y <= bb.maxY - h / 2 + 1e-9; y += step) {
          cands.push({ x: round(x, 3), y: round(y, 3) });
        }
      }
      const cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
      cands.sort((a, b) => (Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy)));
      /* مناطق الفتحات المانعة (باب/مشب): نفس دالة التحقق المشتركة المستعملة في السحب
         والحقول والتوزيع — لا حساب منفصل يخالف القاعدة. */
      const blocks = this.openingBlockRects(g);
      const blockHit = (corners) => blocks.some((b) => Designer.polyHitsRect(corners, b.rect));
      const out = [];
      const taken = [];
      const m = 0.06; // تسامح ملامسة الجدار: المركز داخل المضلع والزوايا ضمن الحدود +6سم
      for (const c of cands) {
        if (out.length >= n) break;
        const trial = { x: c.x, y: c.y, w, h, rot: 0 };
        const corners = this.corners(trial);
        if (closed) {
          if (!Designer.pointInPoly({ x: c.x, y: c.y }, g.poly)) continue;
          if (!corners.every((pt) => pt.x >= bb.minX - m && pt.x <= bb.maxX + m && pt.y >= bb.minY - m && pt.y <= bb.maxY + m)) continue;
        }
        if (this.overlapsColumn(trial)) continue;
        if (blockHit(corners)) continue;
        const hit = this.state.pieces.concat(taken).some((p) => {
          if (p.kind === 'free') return false;
          if (kind === 'acc' && p.kind === 'sofa') return false; // الوسائد فوق الكنب طبيعية
          return Designer.polysOverlap(corners, this.corners(p));
        });
        if (hit) continue;
        taken.push(trial);
        out.push({ x: c.x, y: c.y });
      }
      return out;
    }

    _hitPiece(pt, slop = 0) {
      const ps = this._drawOrder();
      for (let i = ps.length - 1; i >= 0; i--) {
        const l = this.toLocal(ps[i], pt);
        if (Math.abs(l.x) <= ps[i].w / 2 + slop && Math.abs(l.y) <= ps[i].h / 2 + slop) return ps[i];
      }
      return null;
    }

    _hitOpening(pt, slopPx = 6) {
      const g = this.geometry();
      const slop = slopPx / this.view.scale;
      for (const o of this.state.openings) {
        const w = g.walls[o.wall];
        if (!w) continue;
        const { t, s } = this.wallCoords(w, pt);
        if (t >= o.t - o.w / 2 - slop && t <= o.t + o.w / 2 + slop && s <= 0.12 + slop && s >= -WALL_T - slop) return o;
      }
      return null;
    }

    _hitWall(sx, sy, tolPx = 10) {
      const g = this.geometry();
      const pt = this.toRoom(sx, sy);
      let best = -1, bestD = Infinity;
      const tol = tolPx / this.view.scale;
      g.walls.forEach((w) => {
        const { t, s } = this.wallCoords(w, pt);
        if (t < -tol || t > w.len + tol) return;
        // داخل حزام الجدار (المرسوم للخارج) أو قريب من خطه الداخلي
        const d = s > 0 ? s : (s < -WALL_T ? -WALL_T - s : 0);
        if (d < tol && d < bestD) { bestD = d; best = w.i; }
      });
      return best;
    }

    _down(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const { sx, sy } = this._pos(e);
      const touch = e.pointerType === 'touch';
      e.preventDefault();
      try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      this.pointers.set(e.pointerId, { x: sx, y: sy });

      if (this.pointers.size === 2) {
        const pts = [...this.pointers.values()];
        this.drag = { mode: 'pinch', dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1, mid: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } };
        this._lastTap = null;
        return;
      }
      if (this.pointers.size > 2) return;

      // وضع العرض فقط: السحب يحرّك المشهد ولا يعدّل شيئاً
      if (!this.interactive) { this.drag = { mode: 'tap', sx, sy, touch, viewOnly: true, last: { x: sx, y: sy } }; return; }
      const tol = touch ? 24 : HANDLE_R + 5;
      const pt = this.toRoom(sx, sy);
      const selP = this.selectedPiece();
      if (selP) {
        const h = this._hitHandle(selP, sx, sy, tol);
        if (h) { this._lastTap = null; this.drag = { mode: h, id: selP.id, orig: Object.assign({}, selP), moved: false }; return; }
      }
      const p = this._hitPiece(pt, touch ? 4 / this.view.scale : 0);
      if (p) {
        this._lastTap = null;
        this.sel = { type: 'piece', id: p.id };
        this.drag = { mode: 'move', id: p.id, off: { x: p.x - pt.x, y: p.y - pt.y }, orig: Object.assign({}, p), moved: false };
        this.render();
        if (this.opts.onSelect) this.opts.onSelect(this.selectionInfo());
        return;
      }
      const o = this._hitOpening(pt, touch ? 12 : 6);
      if (o) {
        this._lastTap = null;
        this.sel = { type: 'opening', id: o.id };
        this.drag = { mode: 'opening', id: o.id, moved: false };
        this.render();
        if (this.opts.onSelect) this.opts.onSelect(this.selectionInfo());
        return;
      }
      this.drag = { mode: 'tap', sx, sy, touch, last: { x: sx, y: sy } };
    }

    /* تطبيق قاعدة منع الوضع بعد أي تعديل: تداخل قطعة أو سدّ باب/مشب.
       near = true ⇒ نبحث عن أقرب موضع صالح (سحب)، غير ذلك ⇒ نرجع للأصل فقط. */
    _enforcePlacement(p, prev, opts = {}) {
      const g = opts.g || this.geometry();
      const v = this.validatePlacement(p, { geom: g });
      if (v.ok) return true;
      const why = v.why;
      let resolved = false;
      if (opts.near) {
        const safe = this._resolveOverlap(p);
        if (safe) {
          p.x = safe.x; p.y = safe.y;
          if (safe.wall == null) { delete p.wall; delete p.t; }
          else if (g.walls[safe.wall]) this._placeOnWall(p, g.walls[safe.wall]);
          resolved = true;
        }
      }
      if (!resolved) Object.assign(p, prev);
      // سبب الرفض النهائي بعد محاولة النقل: قد يبقى عند الموضع الجديد
      const now = this.validatePlacement(p, { geom: g });
      if (this.opts.onBlocked) this.opts.onBlocked(p, now.ok ? why : now.why, opts.mode || 'move');
      return false;
    }
    _move(e) {
      const { sx, sy } = this._pos(e);
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: sx, y: sy });
      const d = this.drag;
      if (!d) {
        if (e.pointerType === 'mouse') this._updateCursor(sx, sy);
        return;
      }
      if (d.mode === 'pinch') {
        const pts = [...this.pointers.values()];
        if (pts.length < 2) return;
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
        this.zoomAt(dist / d.dist, mid.x, mid.y);
        this.panBy(mid.x - d.mid.x, mid.y - d.mid.y);
        d.dist = dist; d.mid = mid;
        return;
      }
      if (d.mode === 'tap') {
        if (Math.hypot(sx - d.sx, sy - d.sy) > (d.touch ? 10 : 5)) { d.mode = 'pan'; d.last = { x: sx, y: sy }; d.lastC = { x: e.clientX, y: e.clientY }; }
        return;
      }
      if (d.mode === 'pan') {
        // باللمس: السحب على الفراغ يمرّر الصفحة بإصبع واحد كما يتوقع المستخدم.
        // يُقاس الفارق بإحداثيات المؤشر الخام لا بموضع المخطط: فالصفحة تتحرك
        // والمخطط ينزلق تحتها، فيرجف الفارق المحسوب من إحداثيات المخطط.
        if (d.touch) {
          window.scrollBy(d.lastC.x - e.clientX, d.lastC.y - e.clientY);
          d.lastC = { x: e.clientX, y: e.clientY };
        } else {
          this.panBy(sx - d.last.x, sy - d.last.y);
          d.last = { x: sx, y: sy };
        }
        return;
      }
      const pt = this.toRoom(sx, sy);
      const g = this.geometry();
      if (d.mode === 'opening') {
        const o = this.opening(d.id);
        const w = o && g.walls[o.wall];
        if (!w) return;
        const { t } = this.wallCoords(w, pt);
        o.t = round(clamp(snap(t), o.w / 2, w.len - o.w / 2), 3);
        d.moved = true;
        this.render();
        if (this.opts.onSelect) this.opts.onSelect(this.selectionInfo());
        return;
      }
      const p = this.piece(d.id);
      if (!p) return;
      // نلتقط الموضع مرة واحدة عند بدء السحب لنرجع إليه إن استُبعد موضع جديد
      if (d.prev == null) d.prev = { x: p.x, y: p.y, rot: p.rot, w: p.w, h: p.h, wall: p.wall, t: p.t };
      const o = d.orig;
      const a = rad(o.rot), c = Math.cos(a), s = Math.sin(a);
      if (d.mode === 'move') {
        p.x = round(snap(pt.x + d.off.x), 3);
        p.y = round(snap(pt.y + d.off.y), 3);
        // حدود تراعي الحجم والاتجاه (boundAware) أو تقييد المركز كسابقتها
        if (this.opts.boundAware) this._clampPieceToRoom(p, g);
        else this._clampToRoom(p, g);
        this._trySnapToWall(p, g);
        // بعد الانجذاب قد تتجاوز زوايا القطعة المدارة الحدّ: نصحّحها
        if (this.opts.boundAware && p.wall == null) this._clampPieceToRoom(p, g);
        /* منع التداخل وأمام الباب/المشب هندسياً: أقرب موضع صالح أو رجوع للأصل.
           نُبلّغ بسببه الحقيقي (تداخل قطعة أم أمام فتحة) عبر onBlocked. */
        if (this.opts.noOverlap) this._enforcePlacement(p, d.prev || {}, { near: true, g, mode: 'move' });
      } else if (d.mode === 'resizeW') {
        const l = this.toLocal(o, pt);
        let nw = Math.max(MIN_SIZE, round(snap(l.x + o.w / 2), 2));
        if (p.wall != null && g.walls[p.wall]) {
          const w = g.walls[p.wall];
          const t0 = o.t - o.w / 2;
          nw = clamp(nw, MIN_SIZE, Math.max(MIN_SIZE, round(w.len - t0, 2)));
          p.w = nw; p.t = round(t0 + nw / 2, 3);
          this._placeOnWall(p, w);
        } else {
          const dd = (nw - o.w) / 2;
          p.w = nw; p.x = round(o.x + c * dd, 3); p.y = round(o.y + s * dd, 3);
        }
        if (this.opts.noOverlap) this._enforcePlacement(p, d.prev || {}, { g, mode: 'resizeW' });
      } else if (d.mode === 'resizeH') {
        const l = this.toLocal(o, pt);
        const nh = Math.max(MIN_SIZE, round(snap(l.y + o.h / 2), 2));
        if (p.wall != null && g.walls[p.wall]) { p.h = nh; this._placeOnWall(p, g.walls[p.wall]); }
        else { const dd = (nh - o.h) / 2; p.h = nh; p.x = round(o.x - s * dd, 3); p.y = round(o.y + c * dd, 3); }
        if (this.opts.noOverlap) this._enforcePlacement(p, d.prev || {}, { g, mode: 'resizeH' });
      } else if (d.mode === 'rotate') {
        const cs = this.toScreen(o.x, o.y);
        let ang = (Math.atan2(sy - cs.y, sx - cs.x) * 180) / Math.PI + 90;
        if (!e.shiftKey) ang = Math.round(ang / 15) * 15;
        if (this.opts.noDepthDrag && p.kind === 'sofa') { d.mode = 'move'; p.x = o.x; p.y = o.y; this._trySnapToWall(p, g); }
        else {
          p.rot = norm360(ang);
          p.x = o.x; p.y = o.y;
          this._trySnapToWall(p, g, 0.12);
          if (this.opts.noOverlap) this._enforcePlacement(p, d.prev || {}, { g });
        }
      }
      d.moved = true;
      this.render();
      if (this.opts.onSelect) this.opts.onSelect(this.selectionInfo());
    }

    _up(e) {
      this.pointers.delete(e.pointerId);
      try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      const d = this.drag;
      if (!d) return;
      if (d.mode === 'pinch') { if (this.pointers.size < 2) this.drag = null; return; }
      this.drag = null;
      if (d.mode === 'tap') {
        if (d.viewOnly) return;
        const { sx, sy } = this._pos(e);
        const pt = this.toRoom(sx, sy);
        const o = this._hitOpening(pt, d.touch ? 12 : 6);
        if (o) { this._lastTap = null; this.select({ type: 'opening', id: o.id }); return; }
        const wi = this._hitWall(sx, sy, d.touch ? 18 : 10);
        // على اللمس لا يوجد حدث dblclick: نكشف اللمس المزدوج على الجدار بأنفسنا لوضع الكنب
        if (wi >= 0 && d.touch) {
          const now = Date.now();
          const last = this._lastTap;
          const isDouble = last && last.wall === wi && (now - last.time) < 350 && Math.hypot(last.x - sx, last.y - sy) < 40;
          if (isDouble) {
            this._lastTap = null;
            if (this.opts.onWallDblClick) this.opts.onWallDblClick(wi);
            return;
          }
          this._lastTap = { time: now, x: sx, y: sy, wall: wi };
        } else if (wi < 0) {
          this._lastTap = null;
        }
        this.select(wi >= 0 ? { type: 'wall', index: wi } : null);
        return;
      }
      if (d.mode === 'pan') return;
      // منع الإفلات فوق عمود أو خارج الغرفة: يُعاد العنصر لمكانه ولا يُفقد بصمت
      // (سبب الارتداد يُحسب قبل الإرجاع — بعده لا يعود هناك تداخل)
      if (d.moved && d.mode === 'move') {
        const mp = this.piece(d.id);
        if (mp) {
          const gg = this.geometry();
          const hitCol = this.overlapsColumn(mp);
          const outside = gg.closed && !Designer.pointInPoly({ x: mp.x, y: mp.y }, gg.poly);
          if (hitCol || outside) {
            mp.x = d.orig.x; mp.y = d.orig.y;
            if (this.opts.onRevert) { try { this.opts.onRevert(hitCol ? 'column' : 'outside'); } catch (_) { /* noop */ } }
          }
        }
      }
      if (d.moved) this.changed();
    }

    _dbl(e) {
      if (!this.interactive) return;
      const { sx, sy } = this._pos(e);
      const pt = this.toRoom(sx, sy);
      if (this._hitPiece(pt) || this._hitOpening(pt)) return;
      const wi = this._hitWall(sx, sy);
      if (wi >= 0 && this.opts.onWallDblClick) this.opts.onWallDblClick(wi);
    }

    _updateCursor(sx, sy) {
      if (!this.interactive) { this.canvas.style.cursor = 'default'; return; }
      const selP = this.selectedPiece();
      let cursor = 'default';
      const h = selP && this._hitHandle(selP, sx, sy, HANDLE_R + 5);
      const pt = this.toRoom(sx, sy);
      if (h) cursor = h === 'rotate' ? 'grab' : (h === 'resizeW' ? 'ew-resize' : 'ns-resize');
      else if (this._hitPiece(pt)) cursor = 'move';
      else if (this._hitOpening(pt)) cursor = 'ew-resize';
      else if (this._hitWall(sx, sy) >= 0) cursor = 'pointer';
      this.canvas.style.cursor = cursor;
    }

    /* ======================= الرسم ======================= */
    render() {
      if (!this.cssW) return;
      if (this.autoFit) this.view = this._fitView(this.cssW, this.cssH);
      const dpr = window.devicePixelRatio || 1;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this._draw(this.ctx, this.view, this.cssW, this.cssH, { export: false });
      if (this.opts.onRender) this.opts.onRender();
    }

    /** صورة التصميم للتصدير */
    toImage(W = 1600, H = 1000) {
      const off = document.createElement('canvas');
      off.width = W; off.height = H;
      const ctx = off.getContext('2d');
      const v = this._fitView(W, H);
      this._draw(ctx, v, W, H, { export: true });
      return off.toDataURL('image/png');
    }

    /** نسبة أبعاد الغرفة (عرض/ارتفاع) لاختيار حجم صورة التصدير */
    aspect() {
      const g = this.geometry();
      const pad = WALL_T + WALL_LABEL_OFF + 0.3;
      return (g.bb.maxX - g.bb.minX + pad * 2) / (g.bb.maxY - g.bb.minY + pad * 2);
    }

    /** المدى المرسوم للقطعة (يُقتطع في الزوايا التي تملكها قطعة أقدم في وضع طول الجدار كامل) */
    _visualSpan(p, g, idx) {
      const full = { lx0: -p.w / 2, lx1: p.w / 2 };
      if (p.kind !== 'sofa' || p.wall == null || this.state.cornerMode !== 'full') return full;
      const w = g.walls[p.wall];
      if (!w) return full;
      let a = p.t - p.w / 2, b = p.t + p.w / 2;
      this.state.pieces.forEach((q, qi) => {
        if (q === p || qi > idx || q.kind !== 'sofa' || q.wall == null || q.wall === p.wall) return;
        const r = this._projectOnWall(q, w);
        if (!(r.smin < p.h - 0.02 && r.smax > 0.02)) return;
        if (r.tmin <= a + 0.02 && r.tmax > a) a = Math.min(b, r.tmax);
        if (r.tmax >= b - 0.02 && r.tmin < b) b = Math.max(a, r.tmin);
      });
      return { lx0: a - p.t, lx1: b - p.t };
    }

    /* ---------- أشكال الأثاث والإكسسوارات ----------
     الاسم داخل مساحة صغيرة غير مقروء، فيُستبدل برسم رمزي (طبق/سجادة/مخدّة/table).
     الاسم والكمية يبقيان في لوحة المعلومات وعند التحديد (opts.pieceArt). */
  _pieceArt(ctx, p, pw, ph, fs, k) {
      const shape = String(p.shape || p.art || p.itemId || '');
      const r = Math.min(pw, ph) * 0.28;
      ctx.lineWidth = Math.max(1, 1.1 * k);
      ctx.strokeStyle = 'rgba(255,255,255,0.92)';
      ctx.fillStyle = 'rgba(255,255,255,0.30)';
      if (/tray|plate|صحن|طبق/i.test(shape)) {
        const R2 = Math.min(pw, ph) * 0.30;
        ctx.beginPath(); ctx.arc(0, 0, R2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.arc(0, 0, R2 * 0.5, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-R2 * 0.95, 0); ctx.lineTo(-R2 * 1.4, 0);
        ctx.moveTo(R2 * 0.95, 0); ctx.lineTo(R2 * 1.4, 0);
        ctx.stroke();
      } else if (/rug|carpet|سجادة/i.test(shape)) {
        ctx.strokeRect(-pw / 2 + 2, -ph / 2 + 2, pw - 4, ph - 4);
        const n2 = Math.max(2, Math.min(8, Math.floor(ph / (4 * k))));
        ctx.beginPath();
        for (let i = 1; i < n2; i++) { const yy = -ph / 2 + (ph / n2) * i; ctx.moveTo(-pw / 2 + 3, yy); ctx.lineTo(pw / 2 - 3, yy); }
        ctx.stroke();
      } else if (/pillow|cushion|وسادة|مخدة/i.test(shape)) {
        roundRect(ctx, -pw / 2 + 2, -ph / 2 + 2, pw - 4, ph - 4, r); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-pw / 2 + 5, 0);
        ctx.quadraticCurveTo(0, fs * 0.28, pw / 2 - 5, 0); ctx.stroke();
      } else if (/table|طاولة|مكتب/i.test(shape)) {
        roundRect(ctx, -pw / 2 + 3, -ph / 2 + 3, pw - 6, ph - 6, r); ctx.fill(); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-pw / 2 + 3, -ph / 2 + 3); ctx.lineTo(pw / 2 - 3, ph / 2 - 3);
        ctx.moveTo(pw / 2 - 3, -ph / 2 + 3); ctx.lineTo(-pw / 2 + 3, ph / 2 - 3);
        ctx.stroke();
      } else if (/majlis|كرسي|مركى/i.test(shape)) {
        roundRect(ctx, -pw / 2 + 2, -ph / 2 + 2, pw - 4, ph * 0.6, r); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.rect(-pw / 2 + 2, -ph / 2 + 2, pw - 4, ph * 0.2); ctx.stroke();
      } else {
        const R3 = Math.min(pw, ph) * 0.3;
        ctx.beginPath(); ctx.arc(0, 0, R3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
  }

  /* ---------- طبقة القياسات العلوية ----------
     تُرسم فوق كل القطع (opts.dimsOnTop) بتسمية ذات خلفية بيضاء،
     فلا يحجبها أثاث يُسحب فوقها، وتبقى المقاسات الحقيقية كما هي. */
  _drawDimsTop(ctx, v, W, opt) {
      const g = this.geometry();
      const S = v.scale;
      const P = (x, y) => this.toScreen(x, y, v);
      const k = opt.export ? Math.max(1.8, W / 720) : 1;
      const fs = Math.max(9 * k, Math.min(13 * k, S * 0.34));
      ctx.save();
      for (const w of g.walls) {
        const lp = { x: (P(w.A.x, w.A.y).x + P(w.B.x, w.B.y).x) / 2, y: (P(w.A.x, w.A.y).y + P(w.B.x, w.B.y).y) / 2 };
        const off = Math.max(16, 24 * S);
        const num = round(w.len, 2) + ' م';
        ctx.font = `700 ${fs}px ${FONT}`;
        const tw = ctx.measureText(num).width;
        const y = lp.y + off;
        ctx.fillStyle = 'rgba(255,255,255,0.93)';
        roundRect(ctx, lp.x - tw / 2 - 5, y - fs * 0.85, tw + 10, fs * 1.45, 3);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = '#2A2622';
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(num, lp.x, y - fs * 0.78);
      }
      ctx.restore();
  }

  /* ---------- طبقة أرقام المقاسات العلوية ----------
     تُرسم بعد كل القطع (opts.pieceLabelsOnTop): حين يوضع إكسسوار فوق
     كنبة تحجب خطوط القياس، تبقى الأرقام مقروءة بتسمية داكنة على شارة فاتحة.
     الشارة تُرسم خلف النص وحده — لا تُغطّي الرسمة بأكملها. */
  _drawPieceLabelsTop(ctx, v, W, opt) {
      const S = v.scale;
      const k = opt.export ? Math.max(1.8, W / 720) : 1;
      const fs = Math.max(9 * k, Math.min(13 * k, S * 0.2));
      ctx.save();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `700 ${fs}px ${FONT}`;
      for (const p of this._drawOrder()) {
        /* أبعاد الكنبات والجلسات فقط. الإكسسوار يُبقى اسمه ووظيفته ولا يُرسم له
           قياس: طلب المستخدم أن لا تظهر أبعاد الإكسسوارات بلا حاجة صريحة. */
        if (p.kind !== 'sofa') continue;
        const span = this._visualSpan(p, this.geometry(), this.state.pieces.indexOf(p));
        const cen = this.toScreen(p.x, p.y, v);
        const ph = p.h * S;
        const pw = Math.max(0, (span.lx1 - span.lx0) * S);
        const txt = round(p.w, 2) + ' × ' + round(p.h, 2) + ' م';
        const useShort = ctx.measureText(txt).width > pw - 4;
        const label = useShort ? round(p.w, 2) + ' م' : txt;
        if (pw < fs * 1.6 || ph < fs * 0.7) continue;
        ctx.save();
        ctx.translate(cen.x, cen.y);
        ctx.rotate(rad(p.rot));
        const cx = p.kind === 'sofa' ? ((span.lx0 + span.lx1) / 2) * S : 0;
        ctx.translate(cx, 0);
        const flip = p.rot > 90 && p.rot < 270;
        if (flip) ctx.rotate(Math.PI);
        const tw = ctx.measureText(label).width;
        // شارة خلف النص فقط: خلفية معتمة خفيفة تُبقي الرقم مقروءاً فوق أي لون
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        roundRect(ctx, -tw / 2 - 4, -fs * 0.62, tw + 8, fs * 1.24, 3);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.14)'; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = '#2A2622';
        ctx.fillText(label, 0, 0);
        ctx.restore();
      }
      ctx.restore();
  }

  /* ---------- طبقة قياسات الفتحات (باب/مشب) ----------
     المسافة من بداية الجدار إلى بداية الفتحة، ومن نهاية الفتحة إلى نهاية الجدار.
     تُرسم في طبقة مستقلة فوق الكنبات والإكسسوارات والقياسات الأخرى فلا يخفيها
     أي عنصر، وتظهر عند التحديد وبعد انتهاء السحب معاً، وتُحدَّث لحظياً مع
     تحريك الفتحة أو تغيير عرضها أو تغيير طول الجدار. تعمل في التصدير أيضاً. */
  _drawOpeningDimsTop(ctx, v, W, opt) {
      const g = this.geometry();
      const S = v.scale;
      const P = (x, y) => this.toScreen(x, y, v);
      const k = opt.export ? Math.max(1.8, W / 720) : 1;
      const fs = Math.max(9 * k, Math.min(13 * k, S * 0.2));
      const sel = this.sel && this.sel.type === 'opening' ? this.sel.id : null;
      const dragging = this.drag && this.drag.mode === 'opening' ? this.drag.id : null;
      ctx.save();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const o of this.state.openings) {
        if (o.type !== 'door' && o.type !== 'mashab') continue;
        if (opt.export && o.id !== sel && o.id !== dragging) continue;   // في PDF: المحدد فقط
        const w = g.walls[o.wall];
        if (!w) continue;
        const gaps = this.openingGaps(o.id);
        if (!gaps) continue;
        const t0 = o.t - o.w / 2, t1 = o.t + o.w / 2;
        const sIn = 0.34;                     // خط القياس داخل الغرفة أمتار
        const pt = (t, s) => P(w.A.x + w.dir.x * t + w.n.x * s, w.A.y + w.dir.y * t + w.n.y * s);
        const aStart = pt(0, sIn), aOpen0 = pt(t0, sIn);
        const bOpen1 = pt(t1, sIn), bEnd = pt(w.len, sIn);
        ctx.strokeStyle = o.id === sel ? SEL : '#8A7A66';
        ctx.lineWidth = Math.max(1, 1.2 * k);
        ctx.setLineDash([4 * k, 3 * k]);
        for (const seg of [[aStart, aOpen0], [bOpen1, bEnd]]) {
          ctx.beginPath();
          ctx.moveTo(seg[0].x, seg[0].y);
          ctx.lineTo(seg[1].x, seg[1].y);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        /* أطراف القيم (الواسط): خط صغير عمودي يجعل المسافة مقروءة كقياس لا كنقطة */
        for (const e of [aStart, aOpen0, bOpen1, bEnd]) {
          ctx.beginPath();
          ctx.moveTo(e.x, e.y - fs * 0.5);
          ctx.lineTo(e.x, e.y + fs * 0.5);
          ctx.stroke();
        }
        const cm = (v) => Math.round(v * 100) + ' سم';
        const mStart = { x: (aStart.x + aOpen0.x) / 2, y: (aStart.y + aOpen0.y) / 2 - fs * 1.5 };
        const mEnd = { x: (bOpen1.x + bEnd.x) / 2, y: (bOpen1.y + bEnd.y) / 2 - fs * 1.5 };
        // الأرقام فوق الطبقة بلا تراكب: إن تبادلت نزيح أحدها لأسفل
        const near = Math.hypot(mStart.x - mEnd.x, mStart.y - mEnd.y) < fs * 5;
        if (near) mStart.y -= fs * 1.6;
        for (const [m, v] of [[mStart, gaps.left], [mEnd, gaps.right]]) {
          if (v <= 0.001) continue;              // لا نرسم قياساً صفرياً بلا معنى
          const txt = cm(v);
          ctx.font = `700 ${fs}px ${FONT}`;
          const tw = ctx.measureText(txt).width;
          ctx.fillStyle = o.id === sel ? 'rgba(165,100,44,.95)' : 'rgba(42,38,34,.88)';
          roundRect(ctx, m.x - tw / 2 - 5, m.y - fs * 0.85, tw + 10, fs * 1.7, 3);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.fillText(txt, m.x, m.y);
        }
      }
      ctx.restore();
  }

  _draw(ctx, v, W, H, opt) {
      const g = this.geometry();
      const getItem = this.opts.getItem || (() => null);
      const bad = opt.export ? new Set() : this.overlaps();
      const S = v.scale;
      const P = (x, y) => this.toScreen(x, y, v);
      // معامل تكبير النصوص في صورة التصدير (الصورة عالية الدقة تُطبع بحجم صغير)
      const k = opt.export ? Math.max(1.8, W / 720) : 1;

      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);

      // شبكة كل 0.5 م
      const step = 0.5 * S;
      if (step > 7) {
        ctx.strokeStyle = opt.export ? '#f2f2f2' : '#EFEBE4';
        ctx.lineWidth = 1;
        const startX = ((v.ox % step) + step) % step, startY = ((v.oy % step) + step) % step;
        ctx.beginPath();
        for (let x = startX; x < W; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
        for (let y = startY; y < H; y += step) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
        ctx.stroke();
        if (S > 40) {
          ctx.strokeStyle = opt.export ? '#e8e8e8' : '#E5DFD5';
          ctx.beginPath();
          const startX2 = ((v.ox % (step * 2)) + step * 2) % (step * 2), startY2 = ((v.oy % (step * 2)) + step * 2) % (step * 2);
          for (let x = startX2; x < W; x += step * 2) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
          for (let y = startY2; y < H; y += step * 2) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
          ctx.stroke();
        }
      }

      // الأرضية والجدران (السماكة للخارج، الخط الداخلي = المقاس المدخل)
      const wallColor = '#3B3530';
      const floorColor = '#faf6ee';
      if (g.closed && g.poly.length >= 3) {
        const path = new Path2D();
        g.poly.forEach((p, i) => { const s = P(p.x, p.y); i ? path.lineTo(s.x, s.y) : path.moveTo(s.x, s.y); });
        path.closePath();
        ctx.save();
        ctx.lineJoin = 'miter';
        ctx.miterLimit = 10;
        ctx.lineWidth = 2 * WALL_T * S;
        ctx.strokeStyle = wallColor;
        ctx.stroke(path);
        ctx.fillStyle = floorColor;
        ctx.fill(path);
        ctx.restore();
      } else {
        // غرفة غير مغلقة: نرسم الجدران كأشرطة مستقلة
        g.walls.forEach((w) => {
          const q = [P(w.A.x, w.A.y), P(w.B.x, w.B.y), P(w.B.x - w.n.x * WALL_T, w.B.y - w.n.y * WALL_T), P(w.A.x - w.n.x * WALL_T, w.A.y - w.n.y * WALL_T)];
          ctx.fillStyle = wallColor;
          ctx.beginPath(); q.forEach((s, i) => (i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y))); ctx.closePath(); ctx.fill();
        });
      }

      // الجدار المحدد
      const selWall = !opt.export && this.sel && this.sel.type === 'wall' ? this.sel.index : -1;
      if (selWall >= 0 && g.walls[selWall]) {
        const w = g.walls[selWall];
        const q = [P(w.A.x, w.A.y), P(w.B.x, w.B.y), P(w.B.x - w.n.x * WALL_T, w.B.y - w.n.y * WALL_T), P(w.A.x - w.n.x * WALL_T, w.A.y - w.n.y * WALL_T)];
        ctx.fillStyle = SEL;
        ctx.beginPath(); q.forEach((s, i) => (i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y))); ctx.closePath(); ctx.fill();
      }

      // الفتحات
      for (const o of this.state.openings) {
        const w = g.walls[o.wall];
        if (!w) continue;
        const t0 = o.t - o.w / 2, t1 = o.t + o.w / 2;
        const pA = { x: w.A.x + w.dir.x * t0, y: w.A.y + w.dir.y * t0 };
        const pB = { x: w.A.x + w.dir.x * t1, y: w.A.y + w.dir.y * t1 };
        const out = { x: -w.n.x * WALL_T, y: -w.n.y * WALL_T };
        const isSel = !opt.export && this.sel && this.sel.type === 'opening' && this.sel.id === o.id;
        // فتحة في الجدار
        const q = [P(pA.x, pA.y), P(pB.x, pB.y), P(pB.x + out.x, pB.y + out.y), P(pA.x + out.x, pA.y + out.y)];
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); q.forEach((s, i) => (i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y))); ctx.closePath(); ctx.fill();
        ctx.save();
        ctx.lineWidth = Math.max(1.2 * k, 0.03 * S);
        ctx.strokeStyle = isSel ? SEL : (o.type === 'door' ? '#8a5a2b' : '#5A7B8E');
        if (o.type === 'door') {
          // ضلفة الباب تفتح للداخل + قوس الفتح
          const hinge = pA;
          const leafEnd = { x: hinge.x + w.n.x * o.w, y: hinge.y + w.n.y * o.w };
          const h = P(hinge.x, hinge.y), le = P(leafEnd.x, leafEnd.y);
          ctx.beginPath(); ctx.moveTo(h.x, h.y); ctx.lineTo(le.x, le.y); ctx.stroke();
          const a0 = Math.atan2(le.y - h.y, le.x - h.x), pb = P(pB.x, pB.y), a1 = Math.atan2(pb.y - h.y, pb.x - h.x);
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          let d = a1 - a0; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
          ctx.arc(h.x, h.y, o.w * S, a0, a1, d < 0);
          ctx.stroke();
          ctx.setLineDash([]);
          // عتبة
          ctx.strokeStyle = isSel ? SEL : '#BDB5A9';
          ctx.beginPath(); ctx.moveTo(q[0].x, q[0].y); ctx.lineTo(q[1].x, q[1].y); ctx.stroke();
        } else if (o.type === 'mashab') {
          // مشب (مدفأة): بلوكات مستطيلة حمراء بزوايا مائلة (مشطوفة) بارزة داخل الغرفة
          const d = w.dir, n = w.n;
          const hearth = Math.max(0.15, +o.depth || 0.5);   // عمق الموقد داخل الغرفة (م)
          const ch = 0.14;         // حجم الشطف للزوايا المائلة
          const fw = o.w * 0.55;   // عرض فتحة النار
          const fd = hearth * 0.5; // عمق فتحة النار
          // رؤوس القاعدة المشطوفة (اتجاه عقارب الساعة)
          const pts = [
            q[0],
            q[1],
            P(pB.x + n.x * (hearth - ch), pB.y + n.y * (hearth - ch)),
            P(pB.x + n.x * hearth - d.x * ch, pB.y + n.y * hearth - d.y * ch),
            P(pA.x + n.x * hearth + d.x * ch, pA.y + n.y * hearth + d.y * ch),
            P(pA.x + n.x * (hearth - ch), pA.y + n.y * (hearth - ch)),
          ];
          // القاعدة الحمراء
          ctx.fillStyle = '#C0392B';
          ctx.beginPath(); pts.forEach((s, i) => (i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y))); ctx.closePath(); ctx.fill();
          ctx.strokeStyle = isSel ? SEL : '#7E2C2A';
          ctx.lineWidth = Math.max(1 * k, 0.03 * S);
          ctx.stroke();
          // خطوط البلوكات (طوب أحمر): أفقي في منتصف العمق وعمودي في منتصف العرض
          ctx.strokeStyle = isSel ? SEL : '#8E3330';
          ctx.lineWidth = Math.max(1 * k, 0.03 * S);
          ctx.beginPath();
          ctx.moveTo(P(pA.x + n.x * (hearth * 0.5), pA.y + n.y * (hearth * 0.5)).x, P(pA.x + n.x * (hearth * 0.5), pA.y + n.y * (hearth * 0.5)).y);
          ctx.lineTo(P(pB.x + n.x * (hearth * 0.5), pB.y + n.y * (hearth * 0.5)).x, P(pB.x + n.x * (hearth * 0.5), pB.y + n.y * (hearth * 0.5)).y);
          ctx.moveTo(P(pA.x + d.x * (o.w / 2), pA.y + d.y * (o.w / 2)).x, P(pA.x + d.x * (o.w / 2), pA.y + d.y * (o.w / 2)).y);
          ctx.lineTo(P(pA.x + d.x * (o.w / 2) + n.x * hearth, pA.y + d.y * (o.w / 2) + n.y * hearth).x, P(pA.x + d.x * (o.w / 2) + n.x * hearth, pA.y + d.y * (o.w / 2) + n.y * hearth).y);
          ctx.stroke();
          // فتحة النار (داكنة) قرب الجدار
          const dx0 = (o.w - fw) / 2, dx1 = (o.w + fw) / 2;
          const fA = P(pA.x + d.x * dx0, pA.y + d.y * dx0);
          const fB = P(pA.x + d.x * dx1, pA.y + d.y * dx1);
          const fC = P(pA.x + d.x * dx1 + n.x * fd, pA.y + d.y * dx1 + n.y * fd);
          const fD = P(pA.x + d.x * dx0 + n.x * fd, pA.y + d.y * dx0 + n.y * fd);
          ctx.fillStyle = '#2A211B';
          ctx.beginPath(); ctx.moveTo(fA.x, fA.y); ctx.lineTo(fB.x, fB.y); ctx.lineTo(fC.x, fC.y); ctx.lineTo(fD.x, fD.y); ctx.closePath(); ctx.fill();
          // لهب في المنتصف
          ctx.fillStyle = '#F5A623';
          ctx.beginPath(); ctx.arc((fA.x + fC.x) / 2, (fA.y + fC.y) / 2, Math.max(2 * k, 0.06 * S), 0, Math.PI * 2); ctx.fill();
          // خط منقط للداخل (يمنع الكنب)
          ctx.strokeStyle = isSel ? SEL : '#C05621';
          ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(q[0].x, q[0].y); ctx.lineTo(q[1].x, q[1].y); ctx.stroke(); ctx.setLineDash([]);
        } else {
          // شباك: خطان للزجاج داخل حزام الجدار
          ctx.strokeStyle = isSel ? SEL : '#858B8C';
          ctx.beginPath(); ctx.moveTo(q[0].x, q[0].y); ctx.lineTo(q[1].x, q[1].y); ctx.moveTo(q[3].x, q[3].y); ctx.lineTo(q[2].x, q[2].y); ctx.stroke();
          ctx.strokeStyle = isSel ? SEL : '#5A7B8E';
          ctx.lineWidth = Math.max(1.5 * k, 0.05 * S);
          const m0 = P(pA.x + out.x / 2, pA.y + out.y / 2), m1 = P(pB.x + out.x / 2, pB.y + out.y / 2);
          ctx.beginPath(); ctx.moveTo(m0.x, m0.y); ctx.lineTo(m1.x, m1.y); ctx.stroke();
          if (o.blocks) { // شباك يمنع الكنب: خط منقط للداخل
            ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
            const c0 = P(pA.x, pA.y), c1 = P(pB.x, pB.y);
            ctx.beginPath(); ctx.moveTo(c0.x, c0.y); ctx.lineTo(c1.x, c1.y); ctx.stroke(); ctx.setLineDash([]);
          }
        }
        // تسمية (عند التحديد فقط، داخل الغرفة لتجنب تسميات الجدران)
        if (isSel) {
          const lab = (o.type === 'door' ? 'باب' : o.type === 'mashab' ? 'مشب' : 'شباك') + ' ' + round(o.w, 2) + ' م';
          const inset = o.type === 'door' ? o.w + 0.25 : 0.3;
          const lp = P(w.A.x + w.dir.x * o.t + w.n.x * inset, w.A.y + w.dir.y * o.t + w.n.y * inset);
          const fs = Math.max(10, Math.min(13, S * 0.2));
          ctx.font = `700 ${fs}px ${FONT}`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          const tw = ctx.measureText(lab).width + 12;
          ctx.fillStyle = SEL;
          roundRect(ctx, lp.x - tw / 2, lp.y - fs * 0.8, tw, fs * 1.6, 2); ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.fillText(lab, lp.x, lp.y);
        }
        /* قياسات المسافة إلى طرفَي الجدار تُرسم في طبقة منفصلة (_drawOpeningDimsTop)
           فوق كل العناصر وتعمل أثناء السحب وبعده — لا تُكرَّر هنا. */
        ctx.restore();
      }

      // تسميات الجدران (خارج الجدار) — الطول الحقيقي لكل جدار + علامة «مستقل»
      g.walls.forEach((w) => {
        const off = WALL_T + WALL_LABEL_OFF;
        const lp = P(w.mid.x - w.n.x * off, w.mid.y - w.n.y * off);
        const fs = Math.max(11 * k, Math.min(15 * k, S * 0.22));
        ctx.font = `700 ${fs}px ${FONT}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const txt = `${round(w.len, 2)} م`;
        const fixed = this.state.walls[w.i] && this.state.walls[w.i].fixed;
        const num = `جدار ${w.i + 1}` + (fixed ? ' • مستقل' : '');
        const tw = ctx.measureText(txt).width, nw = ctx.measureText(num).width;
        const bw = Math.max(tw, nw) + 14 * k, bh = fs * 2.3;
        ctx.fillStyle = w.i === selWall ? SEL : 'rgba(255,255,255,0.94)';
        roundRect(ctx, lp.x - bw / 2, lp.y - bh / 2, bw, bh, 2 * k); ctx.fill();
        if (w.i !== selWall) { ctx.strokeStyle = fixed ? '#A5642C' : '#E2DBD0'; ctx.lineWidth = k; ctx.stroke(); }
        ctx.fillStyle = w.i === selWall ? '#fff' : '#2A2622';
        ctx.font = `700 ${fs}px ${FONT}`;
        ctx.fillText(txt, lp.x, lp.y - fs * 0.5);
        ctx.fillStyle = w.i === selWall ? 'rgba(255,255,255,0.85)' : (fixed ? '#A5642C' : '#7A6F63');
        ctx.font = `${fs * 0.78}px ${FONT}`;
        ctx.fillText(num, lp.x, lp.y + fs * 0.6);
      });

      // القطع (الكنب أولاً ثم الإكسسوارات فوقه)
      this._drawOrder().forEach((p) => {
        const idx = this.state.pieces.indexOf(p);
        // الكنبة تركيب من عدة أصناف لا صنف واحد، فاسمها ولونها يأتيان من التطبيق
        const item = (this.opts.pieceStyle && this.opts.pieceStyle(p)) || getItem(p.itemId) || {};
        const isSel = !opt.export && this.sel && this.sel.type === 'piece' && this.sel.id === p.id;
        const isBad = bad.has(p.id);
        const color = item.color || (p.kind === 'sofa' ? '#8b5a2b' : '#7f8c8d');
        // لون فاتح يمنح كل نوع جلسة تمييزاً داخل المخطط (opts.pieceTint)
        const light = this.opts.pieceTint && item.light ? item.light : shade(color, 22);
        const span = this._visualSpan(p, g, idx);
        const cen = P(p.x, p.y);

        ctx.save();
        ctx.translate(cen.x, cen.y);
        ctx.rotate(rad(p.rot));
        const ph = p.h * S;
        const x0 = span.lx0 * S, x1 = span.lx1 * S, pw = Math.max(0, x1 - x0);

        if (p.kind === 'free') {
          // المساحة الحرة قيد على الأرض لا قطعة: إطار متقطّع وتعبئة شفافة حتى
          // يُقرأ ما تحتها، وتبقى مميّزة عن الأثاث في الطباعة بالأبيض والأسود.
          ctx.fillStyle = 'rgba(90, 116, 134, .10)';
          roundRect(ctx, -pw / 2, -ph / 2, pw, ph, Math.min(5, pw / 5, ph / 5)); ctx.fill();
          ctx.setLineDash([6 * k, 4 * k]);
          ctx.lineWidth = Math.max(1.2 * k, 0.02 * S);
          ctx.strokeStyle = '#5A7486';
          ctx.stroke();
          ctx.setLineDash([]);
        } else if (p.kind === 'sofa') {
          if (this.opts.pieceTint && item.light) {
            // شريط رفيع بلون النوع أعلى الكنبة: يميّز الجلسة بلا تغطية القماش
            const barH = Math.max(2, Math.min(6, ph * 0.14));
            ctx.fillStyle = light;
            roundRect(ctx, x0, -ph / 2, pw, barH, Math.min(6, pw / 6, barH / 2));
            ctx.fill();
          }
          ctx.shadowColor = 'rgba(0,0,0,0.18)'; ctx.shadowBlur = Math.max(2, 0.06 * S); ctx.shadowOffsetY = Math.max(1, 0.02 * S);
          ctx.fillStyle = color;
          roundRect(ctx, x0, -ph / 2, pw, ph, Math.min(6, pw / 6, ph / 6));
          ctx.fill();
          ctx.shadowColor = 'transparent';
          ctx.strokeStyle = shade(color, -30); ctx.lineWidth = 1.2; ctx.stroke();
          // المسند على جهة الجدار
          const back = Math.min(ph * 0.3, 0.22 * S);
          ctx.fillStyle = shade(color, -22);
          roundRect(ctx, x0 + 1, -ph / 2 + 1, pw - 2, back, 3); ctx.fill();
          // المقاعد
          const seatLen = 0.8 * S;
          if (seatLen > 10 && pw > seatLen * 1.2) {
            const n = Math.max(1, Math.round(pw / seatLen));
            ctx.strokeStyle = 'rgba(255,255,255,0.32)'; ctx.lineWidth = 1;
            for (let k = 1; k < n; k++) {
              const x = x0 + (pw / n) * k;
              ctx.beginPath(); ctx.moveTo(x, -ph / 2 + back + 2); ctx.lineTo(x, ph / 2 - 2); ctx.stroke();
            }
            // وسائد المقاعد
            ctx.fillStyle = 'rgba(255,255,255,0.08)';
            for (let k = 0; k < n; k++) {
              const x = x0 + (pw / n) * k + 3;
              roundRect(ctx, x, -ph / 2 + back + 3, pw / n - 6, ph - back - 6, 3); ctx.fill();
            }
          }
        } else if (p.kind === 'column') {
          // العامود: كتلة إنشائية مخططة لا تُبنى فوقها قطع
          ctx.fillStyle = '#9aa0a6';
          roundRect(ctx, -pw / 2, -ph / 2, pw, ph, Math.min(4, pw / 6, ph / 6)); ctx.fill();
          ctx.strokeStyle = '#5f6368'; ctx.lineWidth = Math.max(1.2 * k, 0.02 * S); ctx.stroke();
          ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1;
          const step = Math.max(4, pw / 6);
          for (let lx = -pw / 2 + step; lx < pw / 2; lx += step) {
            ctx.beginPath(); ctx.moveTo(lx, -ph / 2); ctx.lineTo(lx, ph / 2); ctx.stroke();
          }
        } else {
          ctx.shadowColor = 'rgba(0,0,0,0.15)'; ctx.shadowBlur = Math.max(2, 0.05 * S);
          ctx.fillStyle = color;
          if ((p.shape || item.shape) === 'circle') {
            ctx.beginPath(); ctx.ellipse(0, 0, pw / 2, ph / 2, 0, 0, Math.PI * 2); ctx.fill();
            ctx.shadowColor = 'transparent'; ctx.strokeStyle = shade(color, -30); ctx.lineWidth = 1.2; ctx.stroke();
          } else {
            roundRect(ctx, -pw / 2, -ph / 2, pw, ph, Math.min(5, pw / 5, ph / 5)); ctx.fill();
            ctx.shadowColor = 'transparent'; ctx.strokeStyle = shade(color, -30); ctx.lineWidth = 1.2; ctx.stroke();
          }
        }

        // النص
        const cx = p.kind === 'sofa' ? (x0 + x1) / 2 : 0;
        ctx.translate(cx, 0);
        const flip = p.rot > 90 && p.rot < 270;
        if (flip) ctx.rotate(Math.PI);
        // نص المساحة الحرة داكن بلا ظل: تعبئتها فاتحة شفافة فالأبيض يختفي عليها
        const isFree = p.kind === 'free';
        ctx.fillStyle = isFree ? '#3F5666' : '#fff';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const fs = Math.max(9 * k, Math.min(13 * k, S * 0.2, ph * 0.36));
        ctx.font = `700 ${fs}px ${FONT}`;
        if (!isFree) { ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 3 * k; }
        // الكنب: الطول × العمق
        const dims = `${round(p.w, 2)} × ${round(p.h, 2)} م`;
        const label = p.kind === 'sofa' ? dims : p.kind === 'column' ? 'عامود' : (item.name || 'إكسسوار');
        const maxW = Math.max(pw, ph) - 6;
        if (isFree) {
          // الاسم والمقاس معاً: المقاس هو ما يُعدَّل فيها، فلا يُخفى
          if (ph > fs * 2.4 && pw > fs * 3) {
            ctx.fillText(fitText(ctx, 'مساحة حرة', maxW), 0, -fs * 0.62);
            ctx.font = `${fs * 0.92}px ${FONT}`;
            ctx.fillText(fitText(ctx, dims, maxW), 0, fs * 0.66);
          } else if (pw > fs * 1.5) {
            ctx.fillText(fitText(ctx, dims, maxW), 0, 0);
          }
        } else if (p.kind === 'sofa') {
          // تظهر المواصفة على المخطط فقط عند تخصيصها لهذه القطعة بخلاف افتراضي الصنف
          const extra = this.opts.pieceSpecLabel ? (this.opts.pieceSpecLabel(p) || '') : '';
          const nm = fitText(ctx, (item.name || 'كنب') + (extra ? ` • ${extra}` : ''), maxW);
          const back = Math.min(ph * 0.3, 0.22 * S);
          const dimsLabel = ctx.measureText(dims).width <= maxW ? dims : `${round(p.w, 2)} م`;
          if (ph > fs * 2.6 && pw > fs * 3) {
            ctx.fillText(nm, 0, (flip ? -1 : 1) * back * 0.35 - fs * 0.6);
            ctx.fillText(dimsLabel, 0, (flip ? -1 : 1) * back * 0.35 + fs * 0.65);
          } else if (pw > fs * 2) {
            ctx.fillText(dimsLabel, 0, (flip ? -1 : 1) * back * 0.3);
          }
        } else if (pw > fs * 1.5 && !(this.opts.pieceArt && p.kind === 'acc')) {
          ctx.fillText(fitText(ctx, label, maxW), 0, 0);
        }
        // شكل رمزي للإكسسوار بدل اسمه داخل مساحة صغيرة (الاسم يبقى في اللوحة)
        if (this.opts.pieceArt && p.kind === 'acc') this._pieceArt(ctx, p, pw, ph, fs, k);
        ctx.restore();

        // تحديد / تداخل
        if (isBad || isSel) {
          const cs = this.corners(p).map((c) => P(c.x, c.y));
          ctx.save();
          ctx.beginPath(); cs.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y))); ctx.closePath();
          ctx.lineWidth = 2;
          if (isBad) { ctx.strokeStyle = '#C8412F'; ctx.setLineDash([]); ctx.stroke(); }
          if (isSel) {
            // هالة بيضاء تحت خط التحديد: يبقى ظاهراً فوق الأقمشة الداكنة والفاتحة معاً
            ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 5; ctx.setLineDash([]); ctx.stroke();
            ctx.strokeStyle = SEL; ctx.lineWidth = 2.2; ctx.setLineDash([6, 4]); ctx.stroke();
          }
          ctx.restore();
        }
        if (isSel) {
          const hs = this._handles(p, v);
          ctx.save();
          ctx.strokeStyle = SEL; ctx.lineWidth = 1.5; ctx.setLineDash([]);
          ctx.beginPath(); ctx.moveTo(hs.top.x, hs.top.y); ctx.lineTo(hs.rotate.x, hs.rotate.y); ctx.stroke();
          if (Designer.canResize(p)) drawHandle(ctx, hs.resizeW, SEL, '↔');
          // مقبض العمق مخفي للكنبة: يُضبط من الحقل الرقمي في اللوحة
          if (Designer.canResize(p) && !(this.opts.noDepthDrag && p.kind === 'sofa')) drawHandle(ctx, hs.resizeH, SEL, '↕');
          drawHandle(ctx, hs.rotate, SEL_ROT, '↻');
          ctx.restore();
        }
      });

      // طبقة القياس فوق القطع: تبقى الأرقام واضحة مهما جرت قطعة فوقها
      if (this.opts.dimsOnTop) this._drawDimsTop(ctx, v, W, opt);
      // طبقة أرقام مقاسات القطع فوق كل الرسومات (مركى/طاولة فوق كنبة لا تحجبها)
      if (this.opts.pieceLabelsOnTop) this._drawPieceLabelsTop(ctx, v, W, opt);
      // طبقة قياسات الباب/المشب: خط قياس وأرقام من طرفي الجدار إلى الفتحة.
      // في طبقة مستقلة فوق كل شيء — لا يخفيها كنبة ولا إكسسوار ولا قياس آخر.
      if (this.opts.dimsOnTop) this._drawOpeningDimsTop(ctx, v, W, opt);

      if (!g.closed && !opt.export) {
        ctx.fillStyle = '#A23B2C';
        ctx.font = `12px ${FONT}`;
        ctx.textAlign = 'right'; ctx.textBaseline = 'top';
        ctx.fillText(`⚠ الجدران غير مغلقة (فجوة ${round(g.gap, 2)} م)`, W - 10, 8);
      }
      if (opt.export) {
        ctx.fillStyle = '#9aa0a6';
        ctx.font = `${11 * k}px ${FONT}`;
        ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        ctx.fillText('المقاسات الداخلية بالمتر', 14, H - 10);
      }
    }
  }

  /* ---------- أدوات مساعدة ---------- */
  function distToSegment(Pt, A, B) {
    const dx = B.x - A.x, dy = B.y - A.y;
    const L2 = dx * dx + dy * dy;
    let t = L2 ? ((Pt.x - A.x) * dx + (Pt.y - A.y) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(Pt.x - (A.x + t * dx), Pt.y - (A.y + t * dy));
  }
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function drawHandle(ctx, p, color, glyph) {
    ctx.beginPath(); ctx.arc(p.x, p.y, HANDLE_R, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = color; ctx.stroke();
    if (glyph && HANDLE_R >= 9) {
      ctx.fillStyle = color; ctx.font = `${HANDLE_R * 1.3}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(glyph, p.x, p.y + 1);
    }
  }
  function fitText(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }
  function shade(hex, pct) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (!m) return hex;
    const f = (c) => Math.max(0, Math.min(255, Math.round(parseInt(c, 16) + (pct / 100) * 255)));
    return `rgb(${f(m[1])},${f(m[2])},${f(m[3])})`;
  }

  Designer.util = { rad, round, snap, uid, norm360, clamp };
  Designer.WALL_T = WALL_T;
  global.Designer = Designer;
})(window);
