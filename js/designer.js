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
      return { walls: Designer.rectWalls(w, h), openings: [], pieces: [], cornerMode };
    }
    static normalizeState(s, defaults = {}) {
      const st = JSON.parse(JSON.stringify(s || {}));
      if (!Array.isArray(st.walls) || st.walls.length < 3) st.walls = Designer.rectWalls(5, 4);
      st.walls = st.walls.map((w) => ({ len: Math.max(0.3, +w.len || 0.3), angle: norm360(+w.angle || 0) }));
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
    geometry() {
      const pts = [{ x: 0, y: 0 }];
      const walls = [];
      let p = { x: 0, y: 0 };
      this.state.walls.forEach((w, i) => {
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
      for (const o of this.state.openings) {
        const w = g.walls[o.wall];
        o.w = Math.min(Math.max(0.3, +o.w || 0.9), w.len);
        o.t = clamp(+o.t || 0, o.w / 2, w.len - o.w / 2);
      }
    }

    setRect(w, h) {
      this.state.walls = Designer.rectWalls(Math.max(0.5, w), Math.max(0.5, h));
      this.syncAttached();
      this.changed();
    }

    setWalls(walls) {
      this.state.walls = walls.map((w) => ({ len: Math.max(0.3, +w.len || 0.3), angle: norm360(+w.angle || 0) }));
      if (this.sel && this.sel.type === 'wall' && this.sel.index >= this.state.walls.length) this.sel = null;
      this.syncAttached();
      this.changed();
    }

    /** تعديل طول جدار مع المحافظة على إغلاق الغرفة (يُعدَّل الجدار المقابل تلقائياً) */
    setWallLength(i, len, keepClosed = true) {
      const ws = this.state.walls;
      if (!ws[i]) return;
      len = Math.max(0.3, round(+len || 0.3, 3));
      const delta = len - ws[i].len;
      if (Math.abs(delta) < 1e-9) return;
      const wasClosed = this.geometry().closed;
      ws[i].len = len;
      if (keepClosed && wasClosed) {
        const target = norm360(ws[i].angle + 180);
        const cands = ws.map((w, j) => ({ w, j }))
          .filter(({ w, j }) => j !== i && angDiff(w.angle, target) < 0.5 && w.len + delta >= 0.3)
          .sort((a, b) => b.w.len - a.w.len);
        if (cands.length) cands[0].w.len = round(cands[0].w.len + delta, 3);
      }
      this.syncAttached();
      this.changed();
    }

    setWallAngle(i, angle) {
      if (!this.state.walls[i]) return;
      this.state.walls[i].angle = norm360(+angle || 0);
      this.syncAttached();
      this.changed();
    }

    addWall() {
      const ws = this.state.walls;
      const last = ws[ws.length - 1];
      ws.push({ len: 2, angle: norm360((last ? last.angle : 0) + 90) });
      this.syncAttached();
      this.changed();
      return ws.length - 1;
    }

    removeWall(i) {
      const ws = this.state.walls;
      if (ws.length <= 3 || !ws[i]) return false;
      ws.splice(i, 1);
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
      const width = Math.min(type === 'door' ? 0.9 : 1.2, w.len);
      // أول موضع حر على الجدار
      const occ = this.state.openings.filter((o) => o.wall === wallIndex).map((o) => [o.t - o.w / 2, o.t + o.w / 2]);
      const free = this._freeIntervals(w.len, occ, width).sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
      const t = free.length ? (free[0][0] + free[0][1]) / 2 : w.len / 2;
      const o = { id: uid(), wall: wallIndex, t: round(t, 3), w: width, type, blocks: type === 'door' };
      this.state.openings.push(o);
      this.select({ type: 'opening', id: o.id });
      this.changed();
      return o;
    }

    opening(id) { return this.state.openings.find((o) => o.id === id) || null; }

    updateOpening(id, props) {
      const o = this.opening(id);
      if (!o) return;
      Object.assign(o, props);
      if (props.type) o.type = props.type === 'window' ? 'window' : 'door';
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
      const occ = this._occupied(wallIndex, depth, this.state.cornerMode === 'deduct');
      const free = this._freeIntervals(w.len, occ, 0.3).sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
      if (!free.length) return null;
      const [t0, t1] = free[0];
      const piece = Object.assign({ id: uid(), kind: 'sofa' }, rest, { w: round(t1 - t0, 2), h: depth, wall: wallIndex, t: round((t0 + t1) / 2, 3), x: 0, y: 0, rot: 0 });
      this._placeOnWall(piece, w);
      return this.addPiece(piece);
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
      // خطوة واحدة في سجل التراجع مهما كان عدد القطع المضافة
      this._suspendHistory = true;
      try { for (const { i } of order) if (this.addSofaOnWall(i, spec)) count++; }
      finally { this._suspendHistory = false; }
      if (count) this.changed();
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
    setAccessoryCount(item, count) {
      const n = Math.max(0, Math.round(+count || 0));
      const have = this.state.pieces.filter((p) => p.kind === 'acc' && p.itemId === item.id);
      const diff = n - have.length;
      if (!diff) return have.length;
      // إضافة كل قطعة تُطلق changed() فتُعيد رسم الطلب كله: تُعطَّل حتى تكتمل العملية
      const onChange = this.opts.onChange;
      this._suspendHistory = true;
      this.opts.onChange = null;
      try {
        if (diff > 0) for (let i = 0; i < diff; i++) this.addAccessory(item);
        else {
          const drop = new Set(have.slice(diff).map((p) => p.id));
          this.state.pieces = this.state.pieces.filter((p) => !drop.has(p.id));
          if (this.sel && this.sel.type === 'piece' && drop.has(this.sel.id)) this.sel = null;
        }
      } finally {
        this._suspendHistory = false;
        this.opts.onChange = onChange;
      }
      // لا تُفتح لوحة الخصائص على قطعة أُضيفت من صفحة التسعير
      this.select(null);
      this.changed();
      return n;
    }

    /** محاولة إلصاق قطعة كنب بأقرب جدار مطابق للاتجاه */
    _trySnapToWall(p, g = this.geometry(), tol = 0.25) {
      if (p.kind !== 'sofa') { delete p.wall; delete p.t; return false; }
      let best = null, bestD = Infinity;
      for (const w of g.walls) {
        if (angDiff(p.rot, w.rot) > 10) continue;
        const { t, s } = this.wallCoords(w, { x: p.x, y: p.y });
        const ds = Math.abs(s - p.h / 2);
        if (ds < tol && t > -0.3 && t < w.len + 0.3 && ds < bestD) { bestD = ds; best = { w, t }; }
      }
      if (best) { p.wall = best.w.i; p.t = round(best.t, 3); this._placeOnWall(p, best.w); return true; }
      delete p.wall; delete p.t;
      return false;
    }

    updateSelected(props) {
      const p = this.selectedPiece();
      if (!p) return;
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
      const pad = WALL_T + 0.75;
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
      c.addEventListener('pointerdown', (e) => this._down(e));
      c.addEventListener('pointermove', (e) => this._move(e));
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
      const keys = Designer.canResize(p) ? ['rotate', 'resizeW', 'resizeH'] : ['rotate'];
      for (const k of keys) {
        if (Math.hypot(hs[k].x - sx, hs[k].y - sy) <= tol) return k;
      }
      return null;
    }

    /** ترتيب الرسم: المساحات الحرة أرضيةً، ثم الكنب، ثم الإكسسوارات فوقه */
    _drawOrder() {
      const ps = this.state.pieces;
      return ps.filter((p) => p.kind === 'free')
        .concat(ps.filter((p) => p.kind !== 'free' && p.kind !== 'acc'))
        .concat(ps.filter((p) => p.kind === 'acc'));
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
      if (this.scrollTouch && e.pointerType === 'touch') return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      const { sx, sy } = this._pos(e);
      try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      this.pointers.set(e.pointerId, { x: sx, y: sy });

      if (this.pointers.size === 2) {
        const pts = [...this.pointers.values()];
        this.drag = { mode: 'pinch', dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1, mid: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } };
        return;
      }
      if (this.pointers.size > 2) return;

      const touch = e.pointerType === 'touch';
      // وضع العرض فقط: السحب يحرّك المشهد ولا يعدّل شيئاً
      if (!this.interactive) { this.drag = { mode: 'tap', sx, sy, touch, viewOnly: true, last: { x: sx, y: sy } }; return; }
      const tol = touch ? 24 : HANDLE_R + 5;
      const pt = this.toRoom(sx, sy);
      const selP = this.selectedPiece();
      if (selP) {
        const h = this._hitHandle(selP, sx, sy, tol);
        if (h) { this.drag = { mode: h, id: selP.id, orig: Object.assign({}, selP), moved: false }; return; }
      }
      const p = this._hitPiece(pt, touch ? 4 / this.view.scale : 0);
      if (p) {
        this.sel = { type: 'piece', id: p.id };
        this.drag = { mode: 'move', id: p.id, off: { x: p.x - pt.x, y: p.y - pt.y }, orig: Object.assign({}, p), moved: false };
        this.render();
        if (this.opts.onSelect) this.opts.onSelect(this.selectionInfo());
        return;
      }
      const o = this._hitOpening(pt, touch ? 12 : 6);
      if (o) {
        this.sel = { type: 'opening', id: o.id };
        this.drag = { mode: 'opening', id: o.id, moved: false };
        this.render();
        if (this.opts.onSelect) this.opts.onSelect(this.selectionInfo());
        return;
      }
      this.drag = { mode: 'tap', sx, sy, touch, last: { x: sx, y: sy } };
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
        if (Math.hypot(sx - d.sx, sy - d.sy) > (d.touch ? 10 : 5)) { d.mode = 'pan'; d.last = { x: sx, y: sy }; }
        return;
      }
      if (d.mode === 'pan') {
        this.panBy(sx - d.last.x, sy - d.last.y);
        d.last = { x: sx, y: sy };
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
      const o = d.orig;
      const a = rad(o.rot), c = Math.cos(a), s = Math.sin(a);
      if (d.mode === 'move') {
        p.x = round(snap(pt.x + d.off.x), 3);
        p.y = round(snap(pt.y + d.off.y), 3);
        this._trySnapToWall(p, g);
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
      } else if (d.mode === 'resizeH') {
        const l = this.toLocal(o, pt);
        const nh = Math.max(MIN_SIZE, round(snap(l.y + o.h / 2), 2));
        if (p.wall != null && g.walls[p.wall]) { p.h = nh; this._placeOnWall(p, g.walls[p.wall]); }
        else { const dd = (nh - o.h) / 2; p.h = nh; p.x = round(o.x - s * dd, 3); p.y = round(o.y + c * dd, 3); }
      } else if (d.mode === 'rotate') {
        const cs = this.toScreen(o.x, o.y);
        let ang = (Math.atan2(sy - cs.y, sx - cs.x) * 180) / Math.PI + 90;
        if (!e.shiftKey) ang = Math.round(ang / 15) * 15;
        p.rot = norm360(ang);
        p.x = o.x; p.y = o.y;
        this._trySnapToWall(p, g, 0.12);
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
        if (o) { this.select({ type: 'opening', id: o.id }); return; }
        const wi = this._hitWall(sx, sy, d.touch ? 18 : 10);
        this.select(wi >= 0 ? { type: 'wall', index: wi } : null);
        return;
      }
      if (d.mode === 'pan') return;
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
      const pad = WALL_T + 0.75;
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
          const lab = (o.type === 'door' ? 'باب' : 'شباك') + ' ' + round(o.w, 2) + ' م';
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
        ctx.restore();
      }

      // تسميات الجدران (خارج الجدار)
      g.walls.forEach((w) => {
        const off = WALL_T + 0.45;
        const lp = P(w.mid.x - w.n.x * off, w.mid.y - w.n.y * off);
        const fs = Math.max(11 * k, Math.min(15 * k, S * 0.22));
        ctx.font = `700 ${fs}px ${FONT}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const txt = `${round(w.len, 2)} م`;
        const num = `جدار ${w.i + 1}`;
        const tw = ctx.measureText(txt).width, nw = ctx.measureText(num).width;
        const bw = Math.max(tw, nw) + 14 * k, bh = fs * 2.3;
        ctx.fillStyle = w.i === selWall ? SEL : 'rgba(255,255,255,0.94)';
        roundRect(ctx, lp.x - bw / 2, lp.y - bh / 2, bw, bh, 2 * k); ctx.fill();
        if (w.i !== selWall) { ctx.strokeStyle = '#E2DBD0'; ctx.lineWidth = k; ctx.stroke(); }
        ctx.fillStyle = w.i === selWall ? '#fff' : '#2A2622';
        ctx.font = `700 ${fs}px ${FONT}`;
        ctx.fillText(txt, lp.x, lp.y - fs * 0.5);
        ctx.fillStyle = w.i === selWall ? 'rgba(255,255,255,0.85)' : '#7A6F63';
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
        const label = p.kind === 'sofa' ? dims : (item.name || 'إكسسوار');
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
        } else if (pw > fs * 1.5) {
          ctx.fillText(fitText(ctx, label, maxW), 0, 0);
        }
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
          if (Designer.canResize(p)) {
            drawHandle(ctx, hs.resizeW, SEL, '↔');
            drawHandle(ctx, hs.resizeH, SEL, '↕');
          }
          drawHandle(ctx, hs.rotate, SEL_ROT, '↻');
          ctx.restore();
        }
      });

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
