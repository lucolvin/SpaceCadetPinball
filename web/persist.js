// Saves for Space Cadet Pinball.
// - Everyone: the game's save folder (/libsdl, from SDL_GetPrefPath) lives in IndexedDB, so it survives a reload.
//   The upstream web build links IDBFS but never mounts it.
// - Signed in with GitHub (PocketBase, proxied at /api by this site's nginx): the save file syncs between
//   devices, and every new entry in the personal top 5 is posted to the shared leaderboard.
// The game itself only reads and writes imgui_pb.ini; this script works on that file.
(function () {
  var DIR = "/libsdl", INI = DIR + "/SpaceCadetPinball/imgui_pb.ini";
  var API = "/api/collections/", AUTH_KEY = "pinball.auth", OAUTH_KEY = "pinball.oauth";
  var auth = readJSON(localStorage, AUTH_KEY);
  var ready = false, busy = false, lastIni = null, known = null, saveId = null, uploadTimer = null;
  var status = "", githubOn = false;

  // ---- storage and API helpers ----
  function readJSON(store, key) {
    try { return JSON.parse(store.getItem(key)); } catch (e) { return null; }
  }
  function setAuth(a) {
    auth = a;
    try { a ? localStorage.setItem(AUTH_KEY, JSON.stringify(a)) : localStorage.removeItem(AUTH_KEY); } catch (e) {}
    render();
  }
  function api(method, path, body, keepalive) {
    var headers = { "Content-Type": "application/json" };
    if (auth) headers.Authorization = auth.token;
    return fetch(API + path, {
      method: method, headers: headers, keepalive: !!keepalive,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.message || "HTTP " + r.status); e.status = r.status; throw e; }
        return j;
      });
    });
  }
  function readIni() {
    try { return FS.readFile(INI, { encoding: "utf8" }); } catch (e) { return ""; }
  }
  function flushLocal() {
    if (!ready || busy) return;
    busy = true;
    FS.syncfs(false, function (err) {
      busy = false;
      if (err) console.warn("pinball: saving to IndexedDB failed", err);
    });
  }

  // ---- the high score table inside imgui_pb.ini ----
  // The game keeps "0.Name".."4.Score" plus a "Verification" checksum, and drops the table if it doesn't match.
  function iniGet(ini, key) {
    var m = ini.match(new RegExp("^" + key.replace(".", "\\.") + "=(.*)$", "m"));
    return m ? m[1] : null;
  }
  function iniSet(ini, key, val) {
    var re = new RegExp("^" + key.replace(".", "\\.") + "=.*$", "m");
    if (re.test(ini)) return ini.replace(re, function () { return key + "=" + val; });
    if (ini.indexOf("[Pinball][Settings]") < 0) ini = ini.replace(/\n*$/, "\n\n") + "[Pinball][Settings]\n";
    return ini.replace("[Pinball][Settings]\n", function (h) { return h + key + "=" + val + "\n"; });
  }
  function checksum(table) {  // same sum as high_score::read: name bytes as signed chars, plus scores, in 32 bits
    var sum = 0, enc = new TextEncoder();
    table.forEach(function (e) {
      enc.encode(e.name).forEach(function (b) { sum = (sum + ((b << 24) >> 24)) | 0; });
      sum = (sum + e.score) | 0;
    });
    return sum;
  }
  function emptyTable() {
    return [0, 1, 2, 3, 4].map(function () { return { name: "", score: -999 }; });
  }
  function parseTable(ini) {
    var t = [];
    for (var i = 0; i < 5; i++) {
      var s = parseInt(iniGet(ini, i + ".Score"), 10);
      t.push({ name: iniGet(ini, i + ".Name") || "", score: isNaN(s) ? -999 : s });
    }
    return String(checksum(t)) === iniGet(ini, "Verification") ? t : emptyTable();
  }
  function writeTable(ini, t) {
    t.forEach(function (e, i) { ini = iniSet(iniSet(ini, i + ".Name", e.name), i + ".Score", e.score); });
    return iniSet(ini, "Verification", checksum(t));
  }
  function key(e) { return e.score + "\u0000" + e.name; }
  function entries(t) { return t.filter(function (e) { return e.score > 0; }); }
  function mergeTables(a, b) {  // the best five of both, keeping duplicates only as often as either side has them
    var count = {}, out = [];
    [a, b].forEach(function (t) {
      var c = {};
      entries(t).forEach(function (e) {
        c[key(e)] = (c[key(e)] || 0) + 1;
        if (c[key(e)] > (count[key(e)] || 0)) { count[key(e)] = c[key(e)]; out.push(e); }
      });
    });
    out.sort(function (x, y) { return y.score - x.score; });
    out = out.slice(0, 5);
    while (out.length < 5) out.push({ name: "", score: -999 });
    return out;
  }
  function added(before, after) {  // entries in `after` that `before` doesn't have
    var c = {};
    entries(before).forEach(function (e) { c[key(e)] = (c[key(e)] || 0) + 1; });
    return entries(after).filter(function (e) { return c[key(e)] ? (c[key(e)]--, false) : true; });
  }

  // ---- PocketBase sync ----
  function submitScores(list) {
    list.forEach(function (e) {
      api("POST", "pinball_scores/records", { player: auth.record.id, name: e.name.slice(0, 31), score: e.score }, true)
        .catch(function (err) { console.warn("pinball: posting score failed", err); });
    });
  }
  function upload(keepalive) {
    clearTimeout(uploadTimer);
    if (!auth || lastIni === null) return Promise.resolve();
    var body = { player: auth.record.id, ini: lastIni };
    var req = saveId
      ? api("PATCH", "pinball_saves/records/" + saveId, { ini: lastIni }, keepalive)
      : api("POST", "pinball_saves/records", body, keepalive).catch(function (err) {
          if (err.status !== 400) throw err;  // another device created it first
          return fetchSave().then(function (s) { saveId = s && s.id; return api("PATCH", "pinball_saves/records/" + saveId, { ini: lastIni }); });
        });
    return req.then(function (r) { saveId = r.id; setStatus("saved"); })
      .catch(function (err) { setStatus("offline"); if (err.status === 401) setAuth(null); });
  }
  function fetchSave() {
    return api("GET", "pinball_saves/records?perPage=1&filter=" + encodeURIComponent("player='" + auth.record.id + "'"))
      .then(function (r) { return r.items[0] || null; });
  }
  function finishOAuth() {
    var q = new URLSearchParams(location.search);
    if (!q.get("code")) return Promise.resolve();
    var pending = readJSON(sessionStorage, OAUTH_KEY);
    sessionStorage.removeItem(OAUTH_KEY);
    history.replaceState(null, "", location.pathname);
    if (!pending || pending.state !== q.get("state")) return Promise.resolve();
    return api("POST", "pinball_players/auth-with-oauth2", {
      provider: "github", code: q.get("code"), codeVerifier: pending.codeVerifier, redirectURL: pending.redirect,
    }).then(function (r) { setAuth({ token: r.token, record: { id: r.record.id, name: r.record.name } }); })
      .catch(function (err) { console.warn("pinball: sign-in failed", err); });
  }
  function refreshAuth() {
    if (!auth) return Promise.resolve();
    return api("POST", "pinball_players/auth-refresh")
      .then(function (r) { setAuth({ token: r.token, record: { id: r.record.id, name: r.record.name } }); })
      .catch(function (err) { if (err.status === 401 || err.status === 404) setAuth(null); else throw err; });
  }
  // Before the game starts: bring the account's save in, merged with this browser's top 5.
  function restoreFromAccount() {
    if (!auth) return Promise.resolve();
    return fetchSave().then(function (remote) {
      var local = readIni();
      if (remote) {
        saveId = remote.id;
        var remoteTable = parseTable(remote.ini), merged = mergeTables(remoteTable, parseTable(local));
        var ini = writeTable(remote.ini, merged);
        FS.writeFile(INI, ini);
        submitScores(added(remoteTable, merged));  // top-5 scores this browser had that the account didn't
        if (ini !== remote.ini) { lastIni = ini; upload(); }
      } else if (local) {
        submitScores(entries(parseTable(local)));
        lastIni = local; upload();
      }
      setStatus("synced");
    });
  }
  function signIn() {
    api("GET", "pinball_players/auth-methods").then(function (m) {
      var p = (m.oauth2.providers || []).filter(function (x) { return x.name === "github"; })[0];
      if (!p) return;
      var redirect = location.origin + "/";
      sessionStorage.setItem(OAUTH_KEY, JSON.stringify({ state: p.state, codeVerifier: p.codeVerifier, redirect: redirect }));
      flushLocal();
      setTimeout(function () { location.href = p.authURL + encodeURIComponent(redirect); }, 300);
    });
  }
  function signOut() {
    upload(true);
    setAuth(null);
    saveId = null;
    setStatus("");
  }
  function setStatus(s) { status = s; render(); }

  // ---- start-up: runs before main(), which waits on the run dependency ----
  Module.preRun.push(function () {
    FS.mkdir(DIR);
    FS.mount(IDBFS, {}, DIR);
    addRunDependency("restore-saves");
    var done = false;
    function start() {
      if (done) return;
      done = true;
      lastIni = readIni();
      known = parseTable(lastIni);
      ready = true;
      flushLocal();
      removeRunDependency("restore-saves");
    }
    setTimeout(start, 10000);  // never hold the game hostage to the network
    FS.syncfs(true, function (err) {
      if (err) console.warn("pinball: restoring from IndexedDB failed", err);
      try { FS.mkdirTree(DIR + "/SpaceCadetPinball"); } catch (e) {}
      finishOAuth().then(refreshAuth).then(restoreFromAccount)
        .catch(function (err) { console.warn("pinball: account sync failed", err); setStatus("offline"); })
        .then(start);
    });
  });

  // ImGui rewrites imgui_pb.ini about 5s after a change. Pick it up, keep it locally, and send it on.
  setInterval(function () {
    if (!ready) return;
    var ini = readIni();
    if (ini === lastIni) return;
    lastIni = ini;
    flushLocal();
    var table = parseTable(ini);
    if (auth) {
      submitScores(added(known, table));
      clearTimeout(uploadTimer);
      uploadTimer = setTimeout(upload, 2000);
    }
    known = table;
  }, 3000);
  function onHide() { flushLocal(); if (uploadTimer) upload(true); }
  addEventListener("pagehide", onHide);
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") onHide(); });

  // ---- the corner panel and leaderboard ----
  var panel, board;
  function button(label, fn) {
    var b = document.createElement("button");
    b.textContent = label;
    b.tabIndex = -1;  // never take keyboard focus from the game (Space is the plunger)
    b.addEventListener("mousedown", function (e) { e.preventDefault(); });
    b.addEventListener("click", function (e) { e.preventDefault(); fn(); });
    return b;
  }
  function render() {
    if (!panel) return;
    panel.textContent = "";
    if (auth) {
      var who = document.createElement("span");
      who.className = "who";
      who.textContent = auth.record.name || "signed in";
      who.title = status ? "Save " + status : "";
      panel.appendChild(who);
    } else if (githubOn) {
      panel.appendChild(button("Sign in with GitHub", signIn));
    }
    panel.appendChild(button("Leaderboard", showBoard));
    if (auth) panel.appendChild(button("Sign out", signOut));
  }
  function showBoard() {
    board.hidden = false;
    var list = board.querySelector("ol");
    list.textContent = "Loading…";
    api("GET", "pinball_scores/records?sort=-score,created&perPage=25&expand=player&fields=name,score,created,expand.player.name")
      .then(function (r) {
        list.textContent = "";
        if (!r.items.length) list.textContent = "No scores yet.";
        r.items.forEach(function (s) {
          var li = document.createElement("li"), player = s.expand && s.expand.player ? s.expand.player.name : "?";
          var who = document.createElement("span"), pts = document.createElement("span");
          who.textContent = player + (s.name && s.name !== player ? " (" + s.name + ")" : "");
          pts.textContent = s.score.toLocaleString();
          pts.className = "pts";
          li.title = new Date(s.created.replace(" ", "T")).toLocaleString();
          li.append(who, pts);
          list.appendChild(li);
        });
      })
      .catch(function () { list.textContent = "Leaderboard unavailable."; });
  }
  function buildUI() {
    panel = document.createElement("div");
    panel.id = "pb-panel";
    board = document.createElement("div");
    board.id = "pb-board";
    board.hidden = true;
    var card = document.createElement("div"), h = document.createElement("h2");
    h.textContent = "Leaderboard";
    card.append(h, document.createElement("ol"), button("Close", function () { board.hidden = true; }));
    board.appendChild(card);
    board.addEventListener("mousedown", function (e) { if (e.target === board) board.hidden = true; });
    document.body.append(panel, board);
    render();
    api("GET", "pinball_players/auth-methods").then(function (m) {
      githubOn = (m.oauth2.providers || []).some(function (x) { return x.name === "github"; });
      render();
    }).catch(function () {});
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", buildUI);
  else buildUI();
})();
