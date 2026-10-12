/* Preview mode, for checking Polaris's screens without a Lark login.
   Loaded by index.html only on localhost with ?preview (see its <head>).

   Polaris runs unchanged, but every call to the connection service is answered
   here from tests/.preview-fixture.json, a read-only snapshot of the test tables
   (make it with the Node live check's loader). Pushes and ignores are simulated
   in this tab's memory: NOTHING is sent to Lark. A badge says so on screen.
   Use a separate tab: this puts a fake login in the tab's sessionStorage. */
(function () {
  "use strict";
  var realFetch = window.fetch.bind(window);
  var fx = null;
  var fixture = function () {
    return fx || (fx = realFetch("tests/.preview-fixture.json?v=" + Date.now()).then(function (r) { return r.json(); }));
  };
  sessionStorage.setItem("polaris.token", JSON.stringify({
    access_token: "preview-only", scope: "bitable:app", expires_at: Date.now() + 95 * 60000,
  }));
  sessionStorage.setItem("polaris.user", JSON.stringify({ name: "Preview Mode", avatar: "", email: "" }));

  var seq = 0;
  var reply = function (obj, ms) {
    return new Promise(function (res) {
      setTimeout(function () {
        res(new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } }));
      }, ms === undefined ? 250 : ms);
    });
  };
  var keyOf = function (f, tbl) {
    return Object.keys(f.tables).find(function (k) { return f.tables[k] === tbl; });
  };
  var person = function (f, id) {
    for (var k in f.records) {
      for (var r of f.records[k]) {
        for (var name in r.fields) {
          var v = r.fields[name];
          if (Array.isArray(v)) { var hit = v.find(function (u) { return u && u.id === id && u.name; }); if (hit) return hit; }
        }
      }
    }
    return { id: id, name: id };
  };
  // Lark stores what's written in its read format: text as segments, people with names.
  var toRead = function (f, key, fields) {
    var out = {};
    for (var name in fields) {
      var v = fields[name];
      var def = (f.fields[key] || []).find(function (x) { return x.field_name === name; });
      var type = def ? def.type : 0;
      if (type === 1 && typeof v === "string") out[name] = [{ type: "text", text: v }];
      else if (type === 11 && Array.isArray(v)) out[name] = v.map(function (u) { return person(f, u.id); });
      else out[name] = v;
    }
    return out;
  };

  window.fetch = async function (input, init) {
    var url = typeof input === "string" ? input : input.url;
    if (/onrender\.com\/?$/.test(url) || /:\d+\/$/.test(url) && !/127\.0\.0\.1:9123/.test(url)) {
      return reply({ service: "lark-cors-proxy (preview)" }, 120);
    }
    var m = url.match(/\/proxy\?url=([^&]+)/);
    if (!m) return realFetch(input, init);
    var target = decodeURIComponent(m[1]);
    var method = (init && init.method) || "GET";
    var body = init && init.body ? JSON.parse(init.body) : {};
    var f = await fixture();
    if (/\/authen\/v1\/authorize/.test(target)) return new Response("<html>preview</html>", { status: 200 });
    if (/\/authen\/v1\/user_info/.test(target)) return reply({ code: 0, data: { name: "Preview Mode" } });
    var t = target.match(/\/tables\/(tbl[A-Za-z0-9]+)\/(fields|records)(\/[a-z_]+)?/);
    if (!t) return reply({ code: 99999, msg: "preview mode: no answer for " + target });
    var key = keyOf(f, t[1]);
    if (!key) {   // a table the snapshot doesn't have (e.g. ANDON, which the Node tools can't open): empty
      key = "missing:" + t[1];
      f.tables[key] = t[1]; f.fields[key] = []; f.records[key] = [];
    }
    var recs = f.records[key];
    if (t[2] === "fields") return reply({ code: 0, data: { items: f.fields[key], has_more: false } });
    var op = t[3] || "";
    if (op === "/search") {
      var names = body.field_names;
      var items = recs.map(function (r) {
        var fl = {};
        for (var n in r.fields) if (!names || names.indexOf(n) >= 0) fl[n] = r.fields[n];
        return { record_id: r.record_id, fields: fl };
      });
      return reply({ code: 0, data: { items: items, has_more: false, total: items.length } }, 350);
    }
    if (op === "/batch_get") {
      return reply({ code: 0, data: { records: recs.filter(function (r) { return body.record_ids.indexOf(r.record_id) >= 0; }) } });
    }
    if (op === "/batch_update" && method === "POST") {
      var changed = body.records.map(function (u) {
        var r = recs.find(function (x) { return x.record_id === u.record_id; });
        Object.assign(r.fields, toRead(f, key, u.fields));
        return r;
      });
      return reply({ code: 0, data: { records: changed } }, 400);
    }
    if (op === "" && method === "POST") {
      var rec = { record_id: "recPreview" + (++seq) + Date.now().toString(36), fields: toRead(f, key, body.fields) };
      recs.push(rec);
      return reply({ code: 0, data: { record: rec } }, 500);
    }
    return reply({ code: 99999, msg: "preview mode: unsupported " + method + " " + target });
  };

  document.addEventListener("DOMContentLoaded", function () {
    var b = document.createElement("div");
    b.textContent = "Preview mode: snapshot data, nothing is sent to Lark";
    b.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:200;padding:6px 12px;border-radius:999px;" +
      "background:#B42318;color:#fff;font:700 12px/1.4 sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);pointer-events:none";
    document.body.appendChild(b);
  });
})();
