
const YM = "https://www.call2all.co.il/ym/api";
let TOKEN = "", TOKEN_AT = 0;
const K = {
  idx: "calls:index",
  call: (id) => "call:" + id,
  ratings: (id) => "ratings:" + id,
  issues: "issues:list",
  jobs: "sync:jobs",
};

async function ymToken(env) {
  if (TOKEN && Date.now() - TOKEN_AT < 25 * 60e3) return TOKEN;
  const r = await fetch(`${YM}/Login?username=${encodeURIComponent(env.YEMOT_USERNAME)}&password=${encodeURIComponent(env.YEMOT_PASSWORD)}`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; voice-qa/1.0)" } });
  const j = await r.json();
  if (!j.token) throw new Error("login_failed");
  TOKEN = j.token; TOKEN_AT = Date.now();
  return TOKEN;
}
async function ymText(env, path) {
  const t = await ymToken(env);
  const r = await fetch(`${YM}/DownloadFile?token=${encodeURIComponent(t)}&path=${encodeURIComponent(path)}`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; voice-qa/1.0)" } });
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("json")) { const j = await r.json().catch(() => ({})); throw new Error(j.message || "download_failed"); }
  return await r.text();
}
function parseLine(line) {
  const out = {};
  for (const part of line.split("%")) { const i = part.indexOf("#"); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return out;
}
function d2iso(d, t) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d || ""), h = /^(\d{2}):(\d{2}):(\d{2})$/.exec(t || "");
  if (!m || !h) return null;
  return `${m[3]}-${m[2]}-${m[1]}T${h[1]}:${h[2]}:${h[3]}`;
}
const secs = (a, b) => (!a || !b) ? null : Math.round((new Date(b) - new Date(a)) / 1000);

async function buildMonth(env, ym, errors) {
  let fe = [], api = [], recs = [];
  try { fe = (await ymText(env, `ivr2:Log/LogFolderEnterExit-${ym}.ymgr`)).split("\n").filter(Boolean).map(parseLine); } catch (e) { errors.push("fe:" + ym + ":" + String(e.message||e).slice(0,80)); }
  try { api = (await ymText(env, "ivr2:Log/LogApi.ymgr")).split("\n").filter(Boolean).map(parseLine); } catch (e) { errors.push("api:" + String(e.message||e).slice(0,80)); }
  try { recs = (await ymText(env, "ivr2:3/r/record_log.ymgr")).split("\n").filter(Boolean).map(parseLine); } catch (e) { errors.push("reclog:" + String(e.message||e).slice(0,80)); }

  const recByPhone = {};
  for (const r of recs) {
    const at = d2iso(r.Date, r.Time); if (!at) continue;
    (recByPhone[r.Phone] = recByPhone[r.Phone] || []).push({ at, num: parseInt(r.FileNumber || "0", 10), sec: parseInt(r.TotalSeconds || "0", 10) });
  }
  for (const k in recByPhone) recByPhone[k].sort((a, b) => a.at < b.at ? -1 : 1);

  const calls = {};
  for (const r of fe) {
    if (!r.CallId) continue;
    const c = calls[r.CallId] = calls[r.CallId] || { call_id: r.CallId, phone: r.Phone, entries: [], start: null };
    if (r.Folder === "3") {
      const enter = d2iso(r.EnterDate, r.EnterTime), exit = d2iso(r.EnterDate, r.ExitTime);
      if (enter) c.entries.push({ enter, exit, sec: parseInt(r.TotalSeconds || r.TimeTotal || "0", 10) });
      if (enter && (!c.start || enter < c.start)) c.start = enter;
    }
  }
  const apiByCall = {};
  for (const a of api) {
    const m = /ApiCallId\^([0-9a-f]+)/.exec(a.ApiSend || ""); if (!m) continue;
    const at = d2iso(a.Date, a.Time); if (!at) continue;
    (apiByCall[m[1]] = apiByCall[m[1]] || []).push({ at, ext: a.ApiExtension || "3", ans: a.ApiAnswer || "" });
  }

  const out = [];
  for (const cid in calls) {
    const c = calls[cid];
    if (!c.entries.length) continue;
    c.entries.sort((a, b) => a.enter < b.enter ? -1 : 1);
    const last = c.entries[c.entries.length - 1];
    const apis = (apiByCall[cid] || []).sort((a, b) => a.at < b.at ? -1 : 1);
    const pool = (recByPhone[c.phone] || []).slice();
    const used = new Set();
    const turns = c.entries.map((e, i) => {
      let q = null, best = null;
      const lo = new Date(e.enter).getTime() - 5000, hi = new Date(e.exit || e.enter).getTime() + 120000;
      for (const r of pool) {
        if (used.has(r.num)) continue;
        const t = new Date(r.at).getTime();
        if (t >= lo && t <= hi && (!best || e.enter > best)) { best = e.enter; q = r; }
      }
      if (q) used.add(q.num);
      const hiA = new Date(new Date(e.exit || e.enter).getTime() + 10000).toISOString();
      const inTurn = apis.filter((a) => a.at >= e.enter && a.at <= hiA);
      const ans = inTurn[0] || null;
      const am = ans && /id_list_message\^f-([^&*]+)/.exec(ans.ans);
      const tail = q ? Math.round((new Date(q.at) - new Date(e.exit || e.enter)) / 1000) : null;
      return {
        seq: i + 1, enter_at: e.enter, exit_at: e.exit || null, duration_sec: e.sec,
        question_path: q ? `3/r/${String(q.num).padStart(3, "0")}.wav` : null,
        question_sec: q ? q.sec : null,
        answer_path: am ? am[1] : null,
        response_sec: ans ? secs(e.enter, ans.at) : null,
        api_calls: inTurn.length,
        confidence: !q ? "uncertain" : (tail !== null && tail <= 10 ? "certain" : tail <= 120 ? "probable" : "uncertain"),
        data_missing: (q && am) ? 0 : 1,
      };
    });
    out.push({
      call: {
        call_id: cid, phone: c.phone, start_at: c.start, end_at: last.exit || null,
        duration_sec: last.exit ? secs(c.start, last.exit) : 0,
        turns_count: turns.length, api_calls_count: apis.length,
        status: "new", source: "yemot", overall_rating: null,
      },
      turns,
      api_logs: apis.map((a) => {
        const am = /id_list_message\^f-([^&*]+)/.exec(a.ans);
        return { at: a.at, extension: a.ext, answer_type: a.ans.includes("id_list_message") ? "audio" : a.ans.includes("hangup") ? "hangup" : "other", audio_path: am ? am[1] : null };
      }),
    });
  }
  return out;
}

function monthsToScan(full) {
  const now = new Date(), out = [];
  const n = full ? 14 : 2;
  for (let i = 0; i < n; i++) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); }
  return out;
}

async function runSync(env, months) {
  const started = new Date().toISOString(), errors = [];
  let idx = [];
  try { idx = JSON.parse(await env.QA_DATA.get(K.idx) || "[]"); } catch (_) {}
  const known = new Set(idx);
  let added = 0, turnsAdded = 0;
  for (const ym of months) {
    const built = await buildMonth(env, ym, errors);
    for (const item of built) {
      if (known.has(item.call.call_id)) continue;
      await env.QA_DATA.put(K.call(item.call.call_id), JSON.stringify(item));
      known.add(item.call.call_id); idx.push(item.call.call_id); added++; turnsAdded += item.turns.length;
    }
  }
  idx.sort((a, b) => a < b ? 1 : -1);
  await env.QA_DATA.put(K.idx, JSON.stringify(idx));
  let jobs = [];
  try { jobs = JSON.parse(await env.QA_DATA.get(K.jobs) || "[]"); } catch (_) {}
  jobs.unshift({ started_at: started, finished_at: new Date().toISOString(), status: errors.length ? "partial" : "ok", months_scanned: months.join(","), calls_new: added, turns_new: turnsAdded, errors: errors.slice(0, 4).join(" | ") });
  await env.QA_DATA.put(K.jobs, JSON.stringify(jobs.slice(0, 20)));
  return { ok: true, months, calls_new: added, turns_new: turnsAdded, calls_total: idx.length, errors: errors.slice(0, 5) };
}

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" } });

async function listCalls(env, search) {
  let idx = [];
  try { idx = JSON.parse(await env.QA_DATA.get(K.idx) || "[]"); } catch (_) {}
  const out = [];
  for (const id of idx.slice(0, 400)) {
    if (search && !id.includes(search)) continue;
    const raw = await env.QA_DATA.get(K.call(id));
    if (!raw) continue;
    const c = JSON.parse(raw);
    const rt = JSON.parse(await env.QA_DATA.get(K.ratings(id)) || "[]");
    const active = rt.filter((r) => !r.superseded);
    c.call.avg_rating = active.length ? active.reduce((s, r) => s + r.score, 0) / active.length : null;
    out.push(c.call);
  }
  return out;
}

async function stats(env) {
  let idx = [];
  try { idx = JSON.parse(await env.QA_DATA.get(K.idx) || "[]"); } catch (_) {}
  let turns = 0, recs = 0, missing = 0, rated = 0, conf = { certain: 0, probable: 0, uncertain: 0 };
  const byDay = {};
  for (const id of idx) {
    const raw = await env.QA_DATA.get(K.call(id)); if (!raw) continue;
    const c = JSON.parse(raw);
    turns += c.turns.length;
    recs += c.turns.filter((t) => t.question_path).length;
    missing += c.turns.filter((t) => t.data_missing).length;
    c.turns.forEach((t) => { conf[t.confidence] = (conf[t.confidence] || 0) + 1; });
    const day = (c.call.start_at || "").slice(0, 10);
    if (day) byDay[day] = (byDay[day] || 0) + 1;
    const rt = JSON.parse(await env.QA_DATA.get(K.ratings(id)) || "[]");
    rated += rt.filter((r) => !r.superseded).length;
  }
  const days = Object.entries(byDay).sort((a, b) => a[0] < b[0] ? 1 : -1).slice(0, 21).map(([d, n]) => ({ d, n }));
  return { calls: idx.length, turns, recordings: recs, missing, ratings: rated, issues: 0, by_day: days, confidence: Object.entries(conf).map(([k, v]) => ({ confidence: k, n: v })) };
}

async function api(req, env, url) {
  const p = url.pathname;

  if (p === "/diag") {
    const out = { user: env.YEMOT_USERNAME || null, pass_len: (env.YEMOT_PASSWORD || "").length };
    try {
      const r = await fetch(`${YM}/Login?username=${encodeURIComponent(env.YEMOT_USERNAME)}&password=${encodeURIComponent(env.YEMOT_PASSWORD)}`, { headers: { "User-Agent": "Mozilla/5.0" } });
      out.status = r.status; out.body = (await r.text()).slice(0, 200);
    } catch (e) { out.err = String(e.message || e); }
    return json(out);
  }

  if (p === "/import" && req.method === "POST") {
    if (env.SYNC_KEY && (url.searchParams.get("key") || "") !== env.SYNC_KEY) return json({ error: "forbidden" }, 403);
    const body = await req.json();
    let idx = [];
    try { idx = JSON.parse(await env.QA_DATA.get(K.idx) || "[]"); } catch (_) {}
    const known = new Set(idx);
    let added = 0, skipped = 0, turns = 0;
    for (const item of (body.items || [])) {
      const id = item.call && item.call.call_id;
      if (!id) continue;
      if (known.has(id)) { skipped++; continue; }
      await env.QA_DATA.put(K.call(id), JSON.stringify({ call: item.call, turns: item.turns || [], api_logs: item.api_logs || [] }));
      known.add(id); idx.push(id); added++; turns += (item.turns || []).length;
    }
    idx.sort((a, b) => a < b ? 1 : -1);
    await env.QA_DATA.put(K.idx, JSON.stringify(idx));
    return json({ ok: true, added, skipped, turns, total: idx.length });
  }
  if (p === "/api/stats") return json(await stats(env));
  if (p === "/api/calls") return json({ calls: await listCalls(env, url.searchParams.get("search") || "") });
  if (p.startsWith("/api/calls/")) {
    const id = decodeURIComponent(p.slice("/api/calls/".length));
    const raw = await env.QA_DATA.get(K.call(id));
    if (!raw) return json({ error: "not_found" }, 404);
    const data = JSON.parse(raw);
    data.ratings = JSON.parse(await env.QA_DATA.get(K.ratings(id)) || "[]");
    return json(data);
  }
  if (p === "/api/ratings" && req.method === "POST") {
    const b = await req.json();
    if (!b.call_id || !b.turn_seq || !b.score) return json({ error: "missing" }, 400);
    let rt = [];
    try { rt = JSON.parse(await env.QA_DATA.get(K.ratings(b.call_id)) || "[]"); } catch (_) {}
    rt.forEach((r) => { if (r.turn_seq === b.turn_seq && !r.superseded) r.superseded = 1; });
    rt.push({ turn_seq: b.turn_seq, score: b.score, note: b.note || "", rated_at: new Date().toISOString(), superseded: 0 });
    await env.QA_DATA.put(K.ratings(b.call_id), JSON.stringify(rt));
    return json({ ok: true });
  }
  if (p === "/api/sync-jobs") {
    const jobs = JSON.parse(await env.QA_DATA.get(K.jobs) || "[]");
    return json({ jobs });
  }
  if (p === "/api/issues") return json({ issues: JSON.parse(await env.QA_DATA.get(K.issues) || "[]") });
  if (p === "/sync") {
    if (env.SYNC_KEY && (url.searchParams.get("key") || "") !== env.SYNC_KEY) return json({ error: "forbidden" }, 403);
    return json(await runSync(env, monthsToScan(url.searchParams.get("full") === "1")));
  }
  return json({ error: "not_found" }, 404);
}

async function audio(env, url) {
  const raw = (url.searchParams.get("path") || "").replace(/^ivr2:/, "").replace(/^\/+/, "");
  if (!/^(3|9)\/r\/[A-Za-z0-9_.-]+\.wav$/.test(raw)) return json({ available: false, reason: "invalid_path" }, 400);
  const t = await ymToken(env);
  const r = await fetch(`${YM}/DownloadFile?token=${encodeURIComponent(t)}&path=${encodeURIComponent("ivr2:" + raw)}`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; voice-qa/1.0)" } });
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("json") || ct.includes("text/")) return json({ available: false, reason: "file_not_found" }, 404);
  const buf = await r.arrayBuffer();
  if (buf.byteLength < 2048) return json({ available: false, reason: "empty" }, 404);
  return new Response(buf, { headers: { "Content-Type": "audio/wav", "Cache-Control": "private, max-age=300" } });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/audio") return await audio(env, url);
      if (url.pathname.startsWith("/api/") || url.pathname === "/sync" || url.pathname === "/diag" || url.pathname === "/import") return await api(req, env, url);
      return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    } catch (e) { return json({ error: String(e.message || e) }, 500); }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(runSync(env, monthsToScan(false))); },
};

const HTML = "<!doctype html>\n<html lang=\"he\" dir=\"rtl\"><head>\n<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>\u05d1\u05e7\u05e8\u05ea \u05d0\u05d9\u05db\u05d5\u05ea \u2013 \u05e2\u05d5\u05d6\u05e8 \u05e7\u05d5\u05dc\u05d9</title>\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link href=\"https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;600;800&display=swap\" rel=\"stylesheet\">\n<style>\n:root{--bg:#f6f7f9;--card:#fff;--ink:#12161f;--mute:#66707f;--line:#e4e8ee;--brand:#2b5cff;--ok:#0e9f6e;--warn:#d97706;--bad:#dc2626}\n*{box-sizing:border-box}\nbody{margin:0;font-family:Heebo,system-ui,sans-serif;background:var(--bg);color:var(--ink);font-size:15px}\nheader{background:#fff;border-bottom:1px solid var(--line);padding:14px 20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;position:sticky;top:0;z-index:5}\nh1{font-size:18px;margin:0;font-weight:800}\nnav{display:flex;gap:6px;margin-inline-start:auto;flex-wrap:wrap}\nnav button{border:1px solid var(--line);background:#fff;padding:8px 14px;border-radius:10px;cursor:pointer;font-family:inherit;font-size:14px}\nnav button.on{background:var(--brand);color:#fff;border-color:var(--brand)}\nmain{padding:20px;max-width:1180px;margin:0 auto}\n.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}\n.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}\n.kpi .n{font-size:28px;font-weight:800;line-height:1.1}\n.kpi .l{color:var(--mute);font-size:13px;margin-top:4px}\ntable{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden}\nth,td{padding:10px 12px;text-align:right;border-bottom:1px solid var(--line);font-size:14px}\nth{background:#fafbfc;font-weight:600;color:var(--mute);font-size:13px}\ntr:hover td{background:#f9fbff;cursor:pointer}\ninput,select,textarea{font-family:inherit;font-size:14px;padding:9px 11px;border:1px solid var(--line);border-radius:10px;background:#fff}\n.toolbar{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}\n.turn{background:#fff;border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:12px}\n.turn h4{margin:0 0 8px;font-size:15px}\n.meta{color:var(--mute);font-size:13px;display:flex;gap:14px;flex-wrap:wrap;margin-bottom:8px}\n.tag{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;background:#eef2ff;color:#3349a3}\n.tag.miss{background:#fff1f2;color:#b91c1c}\n.tag.certain{background:#ecfdf5;color:#047857}\n.tag.uncertain{background:#fff7ed;color:#b45309}\naudio{width:100%;margin-top:6px}\n.rate{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}\n.rate button{border:1px solid var(--line);background:#fff;padding:7px 11px;border-radius:9px;cursor:pointer;font-size:13px}\n.rate button.on{background:var(--brand);color:#fff;border-color:var(--brand)}\n.muted{color:var(--mute)}\n.pill{background:#f1f5f9;border-radius:8px;padding:6px 10px;font-size:13px;color:var(--mute)}\na{color:var(--brand)}\n</style></head><body>\n<header><h1>\u05d1\u05e7\u05e8\u05ea \u05d0\u05d9\u05db\u05d5\u05ea \u2013 \u05d4\u05e2\u05d5\u05d6\u05e8 \u05d4\u05e7\u05d5\u05dc\u05d9</h1>\n<nav><button data-t=\"dash\" class=\"on\">\u05dc\u05d5\u05d7 \u05d1\u05e7\u05e8\u05d4</button><button data-t=\"calls\">\u05e9\u05d9\u05d7\u05d5\u05ea</button><button data-t=\"issues\">\u05ea\u05e7\u05dc\u05d5\u05ea</button><button data-t=\"sync\">\u05e1\u05e0\u05db\u05e8\u05d5\u05df</button></nav></header>\n<main id=\"app\">\u05d8\u05d5\u05e2\u05df\u2026</main>\n<script>\nconst $=s=>document.querySelector(s), el=(h)=>{const d=document.createElement('div');d.innerHTML=h;return d.firstElementChild};\nconst fmt=s=>s?s.replace('T',' ').slice(0,16):'\u2014';\nconst esc=s=>String(s==null?'':s).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));\nconst RATE={1:'\u05de\u05d3\u05d5\u05d9\u05e7',2:'\u05d8\u05d5\u05d1, \u05d0\u05e4\u05e9\u05e8 \u05dc\u05e9\u05e4\u05e8',3:'\u05d7\u05dc\u05e7\u05d9',4:'\u05e9\u05d2\u05d5\u05d9'};\nlet tab='dash';\nasync function j(u,o){const r=await fetch(u,o);return r.json()}\nfunction nav(t){tab=t;document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('on',b.dataset.t===t));render()}\ndocument.querySelectorAll('nav button').forEach(b=>b.onclick=()=>nav(b.dataset.t));\nasync function render(){\n  const app=$('#app');\n  if(tab==='dash'){\n    const s=await j('/api/stats');\n    app.innerHTML=`<div class=\"grid\">\n      <div class=\"card kpi\"><div class=\"n\">${s.calls}</div><div class=\"l\">\u05e9\u05d9\u05d7\u05d5\u05ea</div></div>\n      <div class=\"card kpi\"><div class=\"n\">${s.turns}</div><div class=\"l\">\u05ea\u05d5\u05e8\u05d5\u05ea</div></div>\n      <div class=\"card kpi\"><div class=\"n\">${s.recordings}</div><div class=\"l\">\u05d4\u05e7\u05dc\u05d8\u05d5\u05ea \u05de\u05e7\u05d5\u05e9\u05e8\u05d5\u05ea</div></div>\n      <div class=\"card kpi\"><div class=\"n\">${s.missing}</div><div class=\"l\">\u05ea\u05d5\u05e8\u05d5\u05ea \u05e2\u05dd \u05e0\u05ea\u05d5\u05df \u05d7\u05e1\u05e8</div></div>\n      <div class=\"card kpi\"><div class=\"n\">${s.ratings}</div><div class=\"l\">\u05d3\u05d9\u05e8\u05d5\u05d2\u05d9\u05dd</div></div>\n      <div class=\"card kpi\"><div class=\"n\">${s.issues}</div><div class=\"l\">\u05ea\u05e7\u05dc\u05d5\u05ea \u05e4\u05ea\u05d5\u05d7\u05d5\u05ea</div></div>\n    </div>\n    <div class=\"card\" style=\"margin-top:16px\"><h3 style=\"margin:0 0 10px;font-size:15px\">\u05e9\u05d9\u05d7\u05d5\u05ea \u05dc\u05e4\u05d9 \u05d9\u05d5\u05dd</h3>\n      ${(s.by_day||[]).map(d=>`<div style=\"display:flex;align-items:center;gap:10px;margin:4px 0\"><span class=\"muted\" style=\"width:90px\">${d.d}</span><div style=\"height:10px;background:var(--brand);border-radius:5px;width:${Math.min(100,d.n*4)}%\"></div><span class=\"muted\">${d.n}</span></div>`).join('')||'<p class=\"muted\">\u05d0\u05d9\u05df \u05e0\u05ea\u05d5\u05e0\u05d9\u05dd</p>'}\n    </div>\n    <div class=\"card\" style=\"margin-top:16px\"><h3 style=\"margin:0 0 10px;font-size:15px\">\u05d5\u05d3\u05d0\u05d5\u05ea \u05e9\u05d9\u05d5\u05da \u05d4\u05e7\u05dc\u05d8\u05d5\u05ea</h3>\n      ${(s.confidence||[]).map(c=>`<span class=\"tag ${c.confidence}\">${c.confidence}: ${c.n}</span> `).join('')}\n    </div>`;\n  }\n  if(tab==='calls'){\n    app.innerHTML=`<div class=\"toolbar\"><input id=\"q\" placeholder=\"\u05d7\u05d9\u05e4\u05d5\u05e9 \u05dc\u05e4\u05d9 \u05de\u05d6\u05d4\u05d4 \u05d0\u05d5 \u05d8\u05dc\u05e4\u05d5\u05df\"><button class=\"pill\" id=\"go\">\u05e1\u05e0\u05df</button><span class=\"pill\" id=\"cnt\"></span></div><div id=\"list\"></div>`;\n    const load=async()=>{const s=$('#q').value.trim();const d=await j('/api/calls?limit=300&search='+encodeURIComponent(s));\n      $('#cnt').textContent=d.calls.length+' \u05e9\u05d9\u05d7\u05d5\u05ea';\n      $('#list').innerHTML='<table><thead><tr><th>\u05de\u05d5\u05e2\u05d3</th><th>\u05d8\u05dc\u05e4\u05d5\u05df</th><th>\u05ea\u05d5\u05e8\u05d5\u05ea</th><th>\u05de\u05e9\u05da</th><th>\u05d3\u05d9\u05e8\u05d5\u05d2</th><th>\u05de\u05d6\u05d4\u05d4</th></tr></thead><tbody>'+\n        d.calls.map(c=>`<tr data-id=\"${esc(c.call_id)}\"><td>${fmt(c.start_at)}</td><td>${esc(c.phone)}</td><td>${c.turns_count}</td><td>${c.duration_sec}s</td><td>${c.avg_rating?Number(c.avg_rating).toFixed(1):'\u2014'}</td><td class=\"muted\">${esc(c.call_id.slice(0,8))}</td></tr>`).join('')+'</tbody></table>';\n      document.querySelectorAll('#list tbody tr').forEach(tr=>tr.onclick=()=>openCall(tr.dataset.id));};\n    $('#go').onclick=load; $('#q').onkeydown=e=>{if(e.key==='Enter')load()}; await load();\n  }\n  if(tab==='issues'){const d=await j('/api/issues');\n    app.innerHTML='<div class=\"card\"><h3 style=\"margin-top:0\">\u05ea\u05e7\u05dc\u05d5\u05ea</h3>'+(d.issues.length?d.issues.map(i=>`<div class=\"turn\"><h4>${esc(i.title)}</h4><div class=\"meta\"><span class=\"tag\">${esc(i.status)}</span><span>\u05d7\u05d5\u05de\u05e8\u05d4 ${i.severity||'\u2014'}</span></div><p>${esc(i.description||'')}</p></div>`).join(''):'<p class=\"muted\">\u05e2\u05d5\u05d3 \u05d0\u05d9\u05df \u05ea\u05e7\u05dc\u05d5\u05ea. \u05d3\u05e8\u05d2 \u05ea\u05e9\u05d5\u05d1\u05d5\u05ea \u05d1\u05de\u05e1\u05da \u05d4\u05e9\u05d9\u05d7\u05d4 \u05d5\u05d4\u05df \u05d9\u05d5\u05e4\u05d9\u05e2\u05d5 \u05db\u05d0\u05df.</p>')+'</div>';}\n  if(tab==='sync'){const d=await j('/api/sync-jobs');\n    app.innerHTML='<div class=\"card\"><h3 style=\"margin-top:0\">\u05e8\u05d9\u05e6\u05d5\u05ea \u05e1\u05e0\u05db\u05e8\u05d5\u05df</h3>'+(d.jobs.length?`<table><thead><tr><th>\u05d4\u05ea\u05d7\u05dc\u05d4</th><th>\u05e1\u05d9\u05d5\u05dd</th><th>\u05e1\u05d8\u05d8\u05d5\u05e1</th><th>\u05d7\u05d5\u05d3\u05e9\u05d9\u05dd</th><th>\u05e9\u05d9\u05d7\u05d5\u05ea</th><th>\u05ea\u05d5\u05e8\u05d5\u05ea</th></tr></thead><tbody>${d.jobs.map(x=>`<tr><td>${fmt(x.started_at)}</td><td>${fmt(x.finished_at)}</td><td>${esc(x.status)}</td><td class=\"muted\">${esc(x.months_scanned)}</td><td>${x.calls_new}</td><td>${x.turns_new}</td></tr>`).join('')}</tbody></table>`:'<p class=\"muted\">\u05e2\u05d5\u05d3 \u05dc\u05d0 \u05e8\u05e6\u05d4 \u05e1\u05e0\u05db\u05e8\u05d5\u05df.</p>')+'</div>';}\n}\nasync function openCall(id){\n  const d=await j('/api/calls/'+encodeURIComponent(id));\n  const c=d.call;\n  const app=$('#app');\n  app.innerHTML=`<button class=\"pill\" id=\"back\">\u2192 \u05d7\u05d6\u05e8\u05d4 \u05dc\u05e8\u05e9\u05d9\u05de\u05d4</button>\n   <div class=\"card\" style=\"margin:12px 0\"><h3 style=\"margin:0 0 6px\">\u05e9\u05d9\u05d7\u05d4 ${esc(c.call_id.slice(0,10))}</h3>\n   <div class=\"meta\"><span>${fmt(c.start_at)}</span><span>\u05d8\u05dc\u05e4\u05d5\u05df ${esc(c.phone)}</span><span>${c.duration_sec} \u05e9\u05e0\u05d9\u05d5\u05ea</span><span>${c.turns_count} \u05ea\u05d5\u05e8\u05d5\u05ea</span><span>${c.api_calls_count} \u05e7\u05e8\u05d9\u05d0\u05d5\u05ea API</span></div></div>\n   <div id=\"turns\"></div>`;\n  $('#back').onclick=()=>nav('calls');\n  const box=$('#turns');\n  box.innerHTML=d.turns.map(t=>{\n    const cur=(d.ratings||[]).find(r=>r.turn_seq===t.seq&&!r.superseded);\n    return `<div class=\"turn\" data-seq=\"${t.seq}\">\n      <h4>\u05ea\u05d5\u05e8 ${t.seq} <span class=\"tag ${t.confidence}\">${t.confidence}</span> ${t.data_missing?'<span class=\"tag miss\">\u05e0\u05ea\u05d5\u05df \u05d7\u05e1\u05e8</span>':''}</h4>\n      <div class=\"meta\"><span>${fmt(t.enter_at)}</span><span>\u05de\u05e9\u05da ${t.duration_sec}s</span><span>\u05ea\u05d2\u05d5\u05d1\u05ea API ${t.response_sec==null?'\u2014':t.response_sec+'s'}</span><span>${t.api_calls} \u05e7\u05e8\u05d9\u05d0\u05d5\u05ea</span></div>\n      ${t.question_path?`<div class=\"muted\">\u05d4\u05e7\u05dc\u05d8\u05ea \u05d4\u05e9\u05d0\u05dc\u05d4: ${esc(t.question_path)}</div><audio controls preload=\"none\" src=\"/audio?path=${encodeURIComponent(t.question_path)}\"></audio>`:'<div class=\"muted\">\u05d0\u05d9\u05df \u05d4\u05e7\u05dc\u05d8\u05ea \u05e9\u05d0\u05dc\u05d4 \u05de\u05e7\u05d5\u05e9\u05e8\u05ea</div>'}\n      ${t.answer_path?`<div class=\"muted\" style=\"margin-top:8px\">\u05d0\u05d5\u05d3\u05d9\u05d5 \u05d4\u05ea\u05e9\u05d5\u05d1\u05d4: ${esc(t.answer_path)} \u2014 \u05d4\u05e7\u05d5\u05d1\u05e5 \u05e0\u05de\u05d7\u05e7 \u05de\u05d9\u05de\u05d5\u05ea, \u05dc\u05d0 \u05e0\u05d9\u05ea\u05df \u05dc\u05d4\u05e9\u05de\u05d9\u05e2</div>`:''}\n      <div class=\"rate\">${[1,2,3,4].map(k=>`<button data-k=\"${k}\" class=\"${cur&&cur.score===k?'on':''}\">${RATE[k]}</button>`).join('')}</div>\n      <textarea placeholder=\"\u05d4\u05e2\u05e8\u05d4 (\u05d0\u05d5\u05e4\u05e6\u05d9\u05d5\u05e0\u05dc\u05d9)\" style=\"width:100%;margin-top:8px\" rows=\"2\">${cur?esc(cur.note||''):''}</textarea>\n    </div>`}).join('');\n  box.querySelectorAll('.turn').forEach(tEl=>{\n    const seq=+tEl.dataset.seq, ta=tEl.querySelector('textarea');\n    tEl.querySelectorAll('.rate button').forEach(b=>b.onclick=async()=>{\n      tEl.querySelectorAll('.rate button').forEach(x=>x.classList.remove('on'));b.classList.add('on');\n      await fetch('/api/ratings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({call_id:c.call_id,turn_seq:seq,score:+b.dataset.k,note:ta.value})});\n    });\n  });\n}\nrender();\n</script></body></html>\n";
