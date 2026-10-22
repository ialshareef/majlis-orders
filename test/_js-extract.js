/* استخراج تعريفات JS من مصادر المشروع لتشغيلها كما هي في المِسبار
   — ماسح رموز مُصغَّر يتعامل مع: نصوص ' " ` (بما فيها ${})، تعليقات،
   وتعبيرات regex (تمييزها عن القسمة بالحرف السابق) — لأن دوال الإنتاج
   تحتوي replace(/^https?:\/\//i …) التي تكسر الماسح البسيط.
   كلاسيكي (window.JSExtract) + متوافق مع Node CJS (module.exports). */
(function (g) {
  function isRegexStart(src, i) {
    var k = i - 1;
    while (k >= 0 && /\s/.test(src[k])) k--;
    if (k < 0) return true;
    var c = src[k];
    if ('(=,:![{;&|?+*%^~<>-'.indexOf(c) >= 0) return true;
    return /(?:return|typeof|in|of|new|case|do|else|yield|await)$/.test(src.slice(Math.max(0, k - 8), k + 1));
  }
  function skipString(src, i, q) {
    i++;
    while (i < src.length) {
      var c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === q) return i + 1;
      if (c === '\n' && q !== '`') return i;
      i++;
    }
    return i;
  }
  function skipTemplate(src, i) {
    i++;
    while (i < src.length) {
      var c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') return i + 1;
      if (c === '$' && src[i + 1] === '{') {
        var d = 1; i += 2;
        while (i < src.length && d > 0) {
          var x = src[i];
          if (x === '\\') { i += 2; continue; }
          if (x === "'" || x === '"') { i = skipString(src, i, x); continue; }
          if (x === '{') d++;
          else if (x === '}') d--;
          i++;
        }
        continue;
      }
      i++;
    }
    return i;
  }
  function skipRegex(src, i) {
    i++;
    var inClass = false;
    while (i < src.length) {
      var c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) return i + 1;
      else if (c === '\n') return i;
      i++;
    }
    return i;
  }
  /* يمشي من start ويعيد فهرس نهاية التعبير: ';' بعمق صفري (mode semi)
     أو '}' المطابقة لـ open (mode brace). */
  function walk(src, start, mode, open) {
    var depth = 0, i = start;
    while (i < src.length) {
      var c = src[i], p = src[i + 1];
      if (c === '/' && p === '/') { var nl = src.indexOf('\n', i); if (nl < 0) return -1; i = nl; continue; }
      if (c === '/' && p === '*') { var e = src.indexOf('*/', i); if (e < 0) return -1; i = e + 2; continue; }
      if (c === "'" || c === '"') { i = skipString(src, i, c); continue; }
      if (c === '`') { i = skipTemplate(src, i); continue; }
      if (c === '/' && isRegexStart(src, i)) { i = skipRegex(src, i); continue; }
      if (c === '{' || c === '(' || c === '[') { depth++; }
      else if (c === '}' || c === ')' || c === ']') {
        depth--;
        if (mode === 'brace' && depth === 0) return i;  // '{'افتتاحية تساوت بمطابقتها
        if (depth < 0) return -1;
      }
      else if (c === ';' && depth === 0 && mode === 'semi') return i;
      i++;
    }
    return -1;
  }
  function extractFn(src, name) {
    var start = src.indexOf('function ' + name + '(');
    if (start < 0) return null;
    if (start >= 6 && src.slice(start - 6, start) === 'async ') start -= 6;   // حفظ async
    var open = src.indexOf('{', start);
    if (open < 0) return null;
    var end = walk(src, open, 'brace');
    return end < 0 ? null : src.slice(start, end + 1);
  }
  function extractAssign(src, name) {
    var re = new RegExp('(?:const|var|let)\\s+' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*');
    var m = re.exec(src);
    if (!m) return null;
    var start = m.index + m[0].length;
    var end = walk(src, start, 'semi');
    return end < 0 ? null : src.slice(start, end).trim();
  }
  var api = { extractFn: extractFn, extractAssign: extractAssign };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  g.JSExtract = api;
})(typeof window !== 'undefined' ? window : globalThis);
