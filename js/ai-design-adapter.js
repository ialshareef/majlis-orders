/* طبقة المواصفات ← أوامر المحرك (بدون DOM، قابلة للاختبار في Node عبر vm).
   العقد: { roomW, roomH, seating, depth, door, window, tv, mashab,
            sofaWalls, fabric, foam, accessories:[{name,qty}], notes }
   الجدران: 0 أسفل(طول) 1 يمين(عرض) 2 أعلى(طول) 3 يسار(عرض). */
(function (root) {
  'use strict';

  var LIMITS = {
    room: [0.5, 30],
    doorW: [0.6, 2.5],
    windowW: [0.4, 4],
    tvW: [0.8, 4],
    mashabW: [0.6, 2.5],
    dist: [0, 30],
    depth: [0.3, 1.5],
    accQty: [1, 99],
    accMax: 12
  };
  var SEATING = ['floor', 'sofa', 'arabic', 'raised'];
  var SEATING_LABEL = { floor: 'أرضي', sofa: 'كنب', arabic: 'عربي', raised: 'مرتفع' };
  var WALL_LABEL = ['أسفل (طول)', 'يمين (عرض)', 'أعلى (طول)', 'يسار (عرض)'];
  var TYPE_LABEL = { door: 'باب', window: 'نافذة', mashab: 'مشب', tv: 'تلفاز' };
  var OPENING_W = { door: LIMITS.doorW, window: LIMITS.windowW, tv: LIMITS.tvW, mashab: LIMITS.mashabW };

  function toNum(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (v == null) return null;
    var s = String(v).trim();
    if (!s) return null;
    s = s.replace(/[\u0660-\u0669]/g, function (c) { return String(c.charCodeAt(0) - 0x0660); })
         .replace(/[\u06F0-\u06F9]/g, function (c) { return String(c.charCodeAt(0) - 0x06F0); })
         .replace(/\u066B/g, '.').replace(/\u066C/g, '').replace(/\u060C/g, '')
         .replace(/\s+/g, '');
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  function str(v, max) {
    if (v == null) return '';
    return String(v).trim().slice(0, max || 120);
  }

  function normWall(v) {
    var n = toNum(v);
    if (n == null || n !== Math.floor(n) || n < 0 || n > 3) return null;
    return n;
  }

  function normSide(v) { return v === 'end' ? 'end' : 'start'; }

  function normOpening(raw, type) {
    if (!raw || typeof raw !== 'object') return null;
    var o = { type: type, wall: normWall(raw.wall), w: toNum(raw.w), distFromCorner: toNum(raw.distFromCorner), side: normSide(raw.side) };
    if (o.w == null) o.w = OPENING_W[type][0];
    var lim = OPENING_W[type];
    o.w = clamp(o.w, lim[0], lim[1]);
    if (o.distFromCorner == null) o.distFromCorner = null;
    else o.distFromCorner = clamp(o.distFromCorner, LIMITS.dist[0], LIMITS.dist[1]);
    if (type === 'door') {
      o.swing = raw.swing === 'out' ? 'out' : 'in';
      o.hinge = raw.hinge === 'left' ? 'left' : 'right';
    }
    return o;
  }

  function validateSpec(raw) {
    var issues = [];
    if (!raw || typeof raw !== 'object') return { ok: false, issues: ['المواصفات غير صالحة'], spec: null };
    var spec = {};
    var rw = toNum(raw.roomW), rh = toNum(raw.roomH);
    if (rw != null) spec.roomW = clamp(rw, LIMITS.room[0], LIMITS.room[1]);
    if (rh != null) spec.roomH = clamp(rh, LIMITS.room[0], LIMITS.room[1]);
    if (rw != null && (rw < LIMITS.room[0] || rw > LIMITS.room[1])) issues.push('مقاس الطول خارج النطاق المدعوم (0.5–30 م)');
    if (rh != null && (rh < LIMITS.room[0] || rh > LIMITS.room[1])) issues.push('مقاس العرض خارج النطاق المدعوم (0.5–30 م)');
    var seat = SEATING.indexOf(String(raw.seating || '')) >= 0 ? String(raw.seating) : null;
    if (seat) spec.seating = seat;
    else if (raw.seating != null && raw.seating !== '') issues.push('نوع الجلسة غير معروف — القيم المدعومة: أرضي/كنب/عربي/مرتفع');
    var depth = toNum(raw.depth);
    if (depth != null) spec.depth = clamp(depth, LIMITS.depth[0], LIMITS.depth[1]);
    ['door', 'window', 'tv', 'mashab'].forEach(function (t) {
      var o = normOpening(raw[t], t);
      if (o && o.wall != null) spec[t] = o;
      else if (raw[t] != null && typeof raw[t] === 'object') issues.push('بيانات ' + TYPE_LABEL[t] + ' غير مكتملة (الجدار مطلوب 0–3)');
    });
    if (raw.sofaWalls != null) {
      if (Array.isArray(raw.sofaWalls)) {
        var walls = [];
        raw.sofaWalls.forEach(function (x) {
          var wi = normWall(x);
          if (wi != null && walls.indexOf(wi) < 0) walls.push(wi);
        });
        spec.sofaWalls = walls;
      } else issues.push('قائمة جدران الكنب غير صالحة');
    }
    var fabric = str(raw.fabric, 60);
    if (fabric) spec.fabric = fabric;
    var foam = str(raw.foam, 60);
    if (foam) spec.foam = foam;
    if (Array.isArray(raw.accessories)) {
      var acc = [];
      raw.accessories.forEach(function (a) {
        if (!a || typeof a !== 'object') return;
        var name = str(a.name, 60);
        if (!name) return;
        if (acc.length >= LIMITS.accMax) { issues.push('عدد الإكسسوارات كبير — الحد الأقصى ' + LIMITS.accMax); return; }
        var q = toNum(a.qty);
        acc.push({ name: name, qty: clamp(q == null ? 1 : q, LIMITS.accQty[0], LIMITS.accQty[1]) });
      });
      spec.accessories = acc;
    }
    var notes = str(raw.notes, 400);
    if (notes) spec.notes = notes;
    return { ok: true, issues: issues, spec: spec };
  }

  function specReady(spec) {
    if (!spec || spec.roomW == null || spec.roomH == null) return false;
    return !!(spec.door || spec.window || spec.tv || spec.mashab ||
      (spec.sofaWalls && spec.sofaWalls.length) || (spec.accessories && spec.accessories.length));
  }

  function wallLenOf(spec, wall) { return (wall % 2 === 0) ? spec.roomW : spec.roomH; }

  function openingT(spec, o) {
    var len = wallLenOf(spec, o.wall);
    var half = o.w / 2;
    var t;
    if (o.distFromCorner == null) t = len / 2;
    else if (o.side === 'end') t = len - o.distFromCorner - half;
    else t = o.distFromCorner + half;
    return clamp(t, half, Math.max(half, len - half));
  }

  function matchByName(items, name, category) {
    var n = String(name || '').trim().toLowerCase();
    if (!n) return null;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (category && it.category !== category) continue;
      if (String(it.name || '').trim().toLowerCase() === n) return it;
    }
    return null;
  }

  function buildOps(spec, opts) {
    var ops = [], issues = [], warnings = [];
    var catalog = (opts && Array.isArray(opts.catalog)) ? opts.catalog : [];
    var fabricItem = spec.fabric ? matchByName(catalog, spec.fabric, 'fabric') : null;
    var foamItem = spec.foam ? matchByName(catalog, spec.foam, 'foam') : null;
    if (spec.fabric && !fabricItem) warnings.push('لم أجد قماشاً باسم «' + spec.fabric + '» — سأستخدم اللون الافتراضي');
    if (spec.foam && !foamItem) warnings.push('لم أجد إسفنجاً باسم «' + spec.foam + '» — سأستخدم الافتراضي');
    var fabricId = fabricItem ? fabricItem.id : null;
    var foamId = foamItem ? foamItem.id : null;
    var seatSpec = { seating: spec.seating || 'arabic', depth: spec.depth != null ? spec.depth : 0.8 };
    if (fabricId) seatSpec.fabricId = fabricId;
    if (foamId) seatSpec.foamId = foamId;
    ops.push({ op: 'setRoom', w: spec.roomW, h: spec.roomH });
    ['door', 'window', 'tv', 'mashab'].forEach(function (type) {
      var o = spec[type];
      if (!o) return;
      var len = wallLenOf(spec, o.wall);
      var w = o.w;
      if (w > len) {
        warnings.push(TYPE_LABEL[type] + ' أعرض من الجدار — قُصّ إلى ' + round2(len - 0.02) + ' م');
        w = Math.max(0.3, len - 0.02);
      }
      var oo = { op: 'addOpening', type: type, wall: o.wall, w: round2(w) };
      oo.t = round2(openingT(spec, { wall: o.wall, w: w, distFromCorner: o.distFromCorner, side: o.side }));
      if (type === 'door') { oo.swing = o.swing || 'in'; oo.hinge = o.hinge || 'right'; }
      ops.push(oo);
    });
    var walls = spec.sofaWalls && spec.sofaWalls.length ? spec.sofaWalls.slice() : [0, 1, 2, 3];
    if (walls.length) ops.push({ op: 'fillWalls', walls: walls, seating: seatSpec.seating, depth: seatSpec.depth, fabricId: fabricId, foamId: foamId });
    (spec.accessories || []).forEach(function (a) {
      var item = matchByName(catalog, a.name, 'acc');
      if (!item) {
        var any = matchByName(catalog, a.name, null);
        if (any && any.category !== 'acc') warnings.push('«' + a.name + '» ليس إكسسواراً — تم تجاهله');
        else issues.push('صنف غير متوفر: ' + a.name);
        return;
      }
      ops.push({ op: 'setAccessory', item: item, qty: a.qty });
    });
    return { ops: ops, issues: issues, warnings: warnings };
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  function applyOps(dz, built) {
    var applied = [], failed = [], warnings = (built.warnings || []).slice();
    var issues = (built.issues || []).slice();
    (built.ops || []).forEach(function (op) {
      try {
        if (op.op === 'setRoom') { dz.setRect(op.w, op.h); applied.push('room'); }
        else if (op.op === 'addOpening') {
          var o = dz.addOpening(op.wall, op.type);
          if (!o) { failed.push(TYPE_LABEL[op.type] + ' على ' + WALL_LABEL[op.wall]); return; }
          var props = { w: op.w, t: op.t };
          if (op.type === 'door') { props.swing = op.swing; props.hinge = op.hinge; }
          dz.updateOpening(o.id, props);
          applied.push(op.type);
        } else if (op.op === 'fillWalls') {
          var count = 0;
          op.walls.forEach(function (wi) {
            var spec = { seating: op.seating, depth: op.depth };
            if (op.fabricId) spec.fabricId = op.fabricId;
            if (op.foamId) spec.foamId = op.foamId;
            if (dz.addSofaOnWall(wi, spec)) count++;
            else failed.push('كنبة على ' + WALL_LABEL[wi]);
          });
          if (count) applied.push('sofas:' + count);
        } else if (op.op === 'setAccessory') {
          var r = dz.setAccessoryCount(op.item, op.qty);
          if (r === false || r === 0) { failed.push('إكسسوار: ' + op.item.name); return; }
          applied.push('acc:' + op.item.name);
        }
      } catch (e) {
        failed.push(op.op);
      }
    });
    var valid = dz.validateDesign();
    if (!valid.ok) {
      (valid.issues || []).forEach(function (x) {
        var msg = (dz.constructor && dz.constructor.blockingMessage) ? dz.constructor.blockingMessage(x.reason) : x.reason;
        issues.push(String(msg || x.reason || 'تعارض في التصميم'));
      });
    }
    var health = null;
    try { health = dz.checkRoomHealth ? dz.checkRoomHealth() : null; } catch (e2) { health = null; }
    return {
      ok: valid.ok && !issues.length,
      applied: applied,
      failed: failed,
      issues: issues,
      warnings: warnings,
      valid: valid,
      health: health,
      state: dz.getState()
    };
  }

  function specSummary(spec) {
    var out = [];
    if (!spec) return out;
    if (spec.roomW != null && spec.roomH != null) out.push({ k: 'المقاس', v: spec.roomW + ' × ' + spec.roomH + ' م' });
    if (spec.seating) out.push({ k: 'نوع الجلسة', v: SEATING_LABEL[spec.seating] || spec.seating });
    if (spec.depth != null) out.push({ k: 'عمق الكنب', v: spec.depth + ' م' });
    ['door', 'window', 'tv', 'mashab'].forEach(function (t) {
      var o = spec[t];
      if (!o) return;
      var bits = [TYPE_LABEL[t], 'عرض ' + o.w + ' م', 'الجدار ' + WALL_LABEL[o.wall]];
      if (o.distFromCorner != null) bits.push((o.side === 'end' ? 'من نهاية الجدار' : 'من بداية الجدار') + ' ' + o.distFromCorner + ' م');
      if (t === 'door' && (o.swing || o.hinge)) bits.push('فتح ' + (o.swing === 'out' ? 'للخارج' : 'للداخل') + '، مفصلات ' + (o.hinge === 'left' ? 'يسار' : 'يمين'));
      out.push({ k: bits[0], v: bits.slice(1).join('، ') });
    });
    if (spec.sofaWalls && spec.sofaWalls.length) out.push({ k: 'كنب على', v: spec.sofaWalls.map(function (w) { return WALL_LABEL[w]; }).join('، ') });
    else if (spec.sofaWalls && !spec.sofaWalls.length) out.push({ k: 'كنب على', v: 'لا يوجد' });
    if (spec.fabric) out.push({ k: 'القماش', v: spec.fabric });
    if (spec.foam) out.push({ k: 'الإسفنج', v: spec.foam });
    (spec.accessories || []).forEach(function (a) { out.push({ k: 'إكسسوار', v: a.name + (a.qty > 1 ? ' × ' + a.qty : '') }); });
    if (spec.notes) out.push({ k: 'ملاحظات', v: spec.notes });
    return out;
  }

  root.AiDesignAdapter = {
    LIMITS: LIMITS,
    SEATING: SEATING,
    SEATING_LABEL: SEATING_LABEL,
    WALL_LABEL: WALL_LABEL,
    TYPE_LABEL: TYPE_LABEL,
    toNum: toNum,
    clamp: clamp,
    validateSpec: validateSpec,
    specReady: specReady,
    buildOps: buildOps,
    applyOps: applyOps,
    specSummary: specSummary,
    openingT: openingT
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
