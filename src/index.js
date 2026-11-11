// Call flow demo: voice call result -> CRM (GHL) with idempotency and per-agency routing.
// Modes are picked from secrets. No secret = simulated mode, clearly labeled.
// Browser visitors get a session-scoped sandbox so their runs do not mix.

const AGENCIES = {
  // Dialed number -> agency. 555-01xx numbers are reserved test numbers.
  "+15550100001": { key: "agency_a", name: "Agency A", color: "#2563eb" },
  "+15550100002": { key: "agency_b", name: "Agency B", color: "#16a34a" },
};

const WEBHOOK_SESSION = "_webhooks";
const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;

const LIMITS = {
  events: { max: 30, windowMs: 60_000 },
  reset: { max: 10, windowMs: 60_000 },
  state: { max: 90, windowMs: 60_000 },
  webhooks: { max: 120, windowMs: 60_000 },
};

const CAP = {
  eventsPerSession: 80,
  contactsPerSession: 80,
  logPerSession: 200,
  eventsGlobal: 2000,
  contactsGlobal: 2000,
};

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-vapi-secret, x-demo-session",
  "access-control-allow-methods": "GET,POST",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });

const now = () => new Date().toISOString();

function normPhone(p) {
  if (!p) return "";
  const d = String(p).replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return d;
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return d;
}

function clientIp(req) {
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function readSession(req) {
  const raw = req.headers.get("x-demo-session") || new URL(req.url).searchParams.get("session") || "";
  const s = String(raw).trim();
  return SESSION_RE.test(s) ? s : null;
}

function ghlMode(env, agencyKey) {
  const k = agencyKey.toUpperCase();
  return env[`GHL_TOKEN_${k}`] && env[`GHL_LOCATION_${k}`] ? "live" : "simulated";
}

function config(env) {
  const voice = env.VAPI_PUBLIC_KEY && env.VAPI_ASSISTANT_ID ? "vapi" : "simulated";
  return {
    voice,
    vapiPublicKey: voice === "vapi" ? env.VAPI_PUBLIC_KEY : null,
    vapiAssistantId: voice === "vapi" ? env.VAPI_ASSISTANT_ID : null,
    agencies: Object.entries(AGENCIES).map(([num, a]) => ({
      number: num, key: a.key, name: a.name, color: a.color, crm: ghlMode(env, a.key),
    })),
  };
}

async function rateLimit(env, key, { max, windowMs }) {
  const t = Date.now();
  const row = await env.DB.prepare("SELECT window_start, count FROM rate_limits WHERE key=?").bind(key).first();
  if (!row || t - row.window_start >= windowMs) {
    await env.DB.prepare(
      "INSERT INTO rate_limits (key, window_start, count) VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start, count=1"
    ).bind(key, t).run();
    return { ok: true };
  }
  if (row.count >= max) return { ok: false };
  await env.DB.prepare("UPDATE rate_limits SET count = count + 1 WHERE key=?").bind(key).run();
  return { ok: true };
}

async function addLog(env, session, call_id, agency, kind, detail) {
  await env.DB.prepare("INSERT INTO log (session_id, ts, call_id, agency, kind, detail) VALUES (?,?,?,?,?,?)")
    .bind(session, now(), call_id, agency, kind, typeof detail === "string" ? detail : JSON.stringify(detail))
    .run();
  // Keep the log short per session.
  await env.DB.prepare(
    "DELETE FROM log WHERE session_id=? AND id NOT IN (SELECT id FROM log WHERE session_id=? ORDER BY id DESC LIMIT ?)"
  ).bind(session, session, CAP.logPerSession).run();
}

async function count(env, sql, ...binds) {
  const row = await env.DB.prepare(sql).bind(...binds).first();
  return row?.n || 0;
}

async function overCap(env, session, isNewContact) {
  const [sessEvents, sessContacts, globEvents, globContacts] = await Promise.all([
    count(env, "SELECT COUNT(*) AS n FROM events WHERE session_id=?", session),
    count(env, "SELECT COUNT(*) AS n FROM contacts WHERE session_id=?", session),
    count(env, "SELECT COUNT(*) AS n FROM events"),
    count(env, "SELECT COUNT(*) AS n FROM contacts"),
  ]);
  if (sessEvents >= CAP.eventsPerSession) return "This sandbox is full (80 calls). Press Clear my demo data and try again.";
  if (isNewContact && sessContacts >= CAP.contactsPerSession) return "This sandbox is full (80 contacts). Press Clear my demo data and try again.";
  if (globEvents >= CAP.eventsGlobal || globContacts >= CAP.contactsGlobal) return "The demo is at capacity right now. Try again in a bit.";
  return null;
}

// ---- CRM layer: same steps in both modes. Live mode calls the GHL API v2. ----
async function ghl(env, agencyKey, method, path, body) {
  const k = agencyKey.toUpperCase();
  const res = await fetch("https://services.leadconnectorhq.com" + path, {
    method,
    headers: {
      Authorization: `Bearer ${env[`GHL_TOKEN_${k}`]}`,
      Version: "2021-07-28",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

async function pushToCrm(env, ev, agency, session) {
  const mode = ghlMode(env, agency.key);
  const tags = ["ai-call", agency.key, ev.outcome === "callback" ? "text-back-queued" : "call-handled"];
  const note = `AI call ${ev.call_id} (${agency.name}, line ${ev.dialed}). Outcome: ${ev.outcome}. ${ev.summary || ""}`.trim();
  const textBody = `Hi ${ev.caller_name || "there"}, thanks for calling ${agency.name}. We got your message and will call you back shortly.`;
  const steps = [];

  if (mode === "live") {
    const loc = env[`GHL_LOCATION_${agency.key.toUpperCase()}`];
    const up = await ghl(env, agency.key, "POST", "/contacts/upsert", {
      locationId: loc, phone: ev.caller_phone, firstName: ev.caller_name || undefined, source: "call-flow-demo",
    });
    const cid = up.contact?.id;
    steps.push({ step: up.new ? "contact created" : "contact updated", contactId: cid });
    await ghl(env, agency.key, "POST", `/contacts/${cid}/tags`, { tags });
    steps.push({ step: "tags added", tags });
    await ghl(env, agency.key, "POST", `/contacts/${cid}/notes`, { body: note });
    steps.push({ step: "note added" });
    if (ev.outcome === "callback") steps.push({ step: "text-back queued", via: "tag text-back-queued starts the GHL workflow", text: textBody });
  }

  // Local mirror. In simulated mode this is the CRM. In live mode it is the visible log.
  const existing = await env.DB.prepare("SELECT id, tags FROM contacts WHERE session_id=? AND agency=? AND phone=?")
    .bind(session, agency.key, ev.caller_phone).first();
  if (existing) {
    const merged = Array.from(new Set([...(existing.tags || "").split(",").filter(Boolean), ...tags]));
    await env.DB.prepare("UPDATE contacts SET name=COALESCE(?,name), tags=?, notes=notes+1, calls=calls+1, updated_at=? WHERE id=?")
      .bind(ev.caller_name || null, merged.join(","), now(), existing.id).run();
    if (mode === "simulated") steps.push({ step: "contact updated", contactId: existing.id });
  } else {
    const id = "c_" + crypto.randomUUID().slice(0, 8);
    await env.DB.prepare("INSERT INTO contacts (id, session_id, agency, phone, name, tags, notes, calls, created_at, updated_at) VALUES (?,?,?,?,?,?,1,1,?,?)")
      .bind(id, session, agency.key, ev.caller_phone, ev.caller_name || null, tags.join(","), now(), now()).run();
    if (mode === "simulated") steps.push({ step: "contact created", contactId: id });
  }
  if (mode === "simulated") {
    steps.push({ step: "tags added", tags });
    steps.push({ step: "note added", note });
    if (ev.outcome === "callback") steps.push({ step: "text-back queued", text: textBody });
  }
  return { mode, steps, texts: ev.outcome === "callback" ? 1 : 0 };
}

// ---- Core: one function for every source (browser, Vapi, Telnyx). ----
async function handleCallEvent(env, ev, session) {
  ev.dialed = normPhone(ev.dialed);
  ev.caller_phone = normPhone(ev.caller_phone);
  if (!ev.call_id) return json({ status: "rejected", reason: "missing call_id" }, 400);
  const agency = AGENCIES[ev.dialed];
  if (!agency) {
    await addLog(env, session, ev.call_id, null, "rejected", `Unknown dialed number ${ev.dialed}`);
    return json({ status: "rejected", reason: `No agency owns ${ev.dialed}` }, 422);
  }
  if (!ev.caller_phone) return json({ status: "rejected", reason: "missing caller phone" }, 400);

  // Cap only applies to a new call ID. A duplicate of an existing ID must still be recorded as skipped.
  const already = await env.DB.prepare("SELECT call_id FROM events WHERE session_id=? AND call_id=?")
    .bind(session, ev.call_id).first();
  if (!already) {
    const existingContact = await env.DB.prepare("SELECT id FROM contacts WHERE session_id=? AND agency=? AND phone=?")
      .bind(session, agency.key, ev.caller_phone).first();
    const cap = await overCap(env, session, !existingContact);
    if (cap) return json({ status: "rejected", reason: cap }, 429);
  }

  // Idempotency: (session, call ID) is the primary key. The insert is atomic, so two copies
  // that arrive at the same moment still produce one row.
  const ins = await env.DB.prepare(
    "INSERT INTO events (session_id, call_id, source, agency, dialed, caller_phone, caller_name, outcome, summary, duration_sec, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id, call_id) DO NOTHING"
  ).bind(session, ev.call_id, ev.source, agency.key, ev.dialed, ev.caller_phone, ev.caller_name || null,
    ev.outcome || "handled", ev.summary || "", Math.round(ev.duration_sec || 0), now()).run();

  if (!ins.meta.changes) {
    await env.DB.prepare("UPDATE events SET dup_count = dup_count + 1 WHERE session_id=? AND call_id=?").bind(session, ev.call_id).run();
    await addLog(env, session, ev.call_id, agency.key, "duplicate", "Same call ID seen again. Skipped. No new contact, note or text.");
    // 200 so the sender (Vapi, Telnyx) stops retrying.
    return json({ status: "duplicate", call_id: ev.call_id, agency: agency.name, action: "skipped" });
  }

  await addLog(env, session, ev.call_id, agency.key, "routed", `Dialed ${ev.dialed} -> ${agency.name}`);
  try {
    const crm = await pushToCrm(env, ev, agency, session);
    await env.DB.prepare("UPDATE events SET texts_queued=? WHERE session_id=? AND call_id=?").bind(crm.texts, session, ev.call_id).run();
    for (const s of crm.steps) await addLog(env, session, ev.call_id, agency.key, `crm:${crm.mode}`, s);
    return json({ status: "processed", call_id: ev.call_id, agency: agency.name, crm });
  } catch (e) {
    // Let the sender retry: remove the claim so a retry can succeed.
    await env.DB.prepare("DELETE FROM events WHERE session_id=? AND call_id=?").bind(session, ev.call_id).run();
    await addLog(env, session, ev.call_id, agency.key, "error", String(e.message || e));
    return json({ status: "error", error: String(e.message || e) }, 502);
  }
}

function fromVapi(body) {
  const m = body.message || body;
  if (m.type && m.type !== "end-of-call-report") return null;
  const call = m.call || {};
  const meta = call.metadata || m.metadata || {};
  const sd = m.analysis?.structuredData || {};
  return {
    source: "vapi",
    call_id: call.id,
    dialed: m.phoneNumber?.number || call.phoneNumber?.number || meta.dialed,
    caller_phone: m.customer?.number || call.customer?.number || sd.callback_number || meta.caller_phone,
    caller_name: sd.caller_name || m.customer?.name || call.customer?.name || meta.caller_name,
    outcome: sd.wants_callback === false ? "handled" : "callback",
    summary: m.analysis?.summary || m.summary || "",
    duration_sec: m.durationSeconds || 0,
  };
}

function fromTelnyx(body) {
  const d = body.data || {};
  if (d.event_type !== "call.hangup") return null;
  const p = d.payload || {};
  return {
    source: "telnyx",
    call_id: p.call_session_id || p.call_control_id,
    dialed: p.to,
    caller_phone: p.from,
    outcome: "callback",
    summary: `Telnyx call ended (${p.hangup_cause || "hangup"}).`,
    duration_sec: p.start_time && p.end_time ? (Date.parse(p.end_time) - Date.parse(p.start_time)) / 1000 : 0,
  };
}

async function state(env, session) {
  const [events, contacts, log, billing] = await Promise.all([
    env.DB.prepare("SELECT * FROM events WHERE session_id=? ORDER BY created_at DESC LIMIT 50").bind(session).all(),
    env.DB.prepare("SELECT * FROM contacts WHERE session_id=? ORDER BY updated_at DESC LIMIT 50").bind(session).all(),
    env.DB.prepare("SELECT * FROM log WHERE session_id=? ORDER BY id DESC LIMIT 30").bind(session).all(),
    env.DB.prepare(
      "SELECT agency, COUNT(*) AS calls, COALESCE(SUM(duration_sec),0) AS seconds, COALESCE(SUM(texts_queued),0) AS texts, COALESCE(SUM(dup_count),0) AS duplicates_blocked FROM events WHERE session_id=? GROUP BY agency"
    ).bind(session).all(),
  ]);
  return { session, config: config(env), events: events.results, contacts: contacts.results, log: log.results, billing: billing.results };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    if (p === "/api/config") return json(config(env));

    if (p === "/api/state") {
      const session = readSession(req);
      if (!session) return json({ error: "missing or invalid x-demo-session" }, 400);
      const lim = await rateLimit(env, `state:${clientIp(req)}:${session}`, LIMITS.state);
      if (!lim.ok) return json({ error: "Too many requests. Wait a minute and try again." }, 429);
      return json(await state(env, session));
    }

    if (p === "/api/events" && req.method === "POST") {
      const session = readSession(req);
      if (!session) return json({ error: "missing or invalid x-demo-session" }, 400);
      const lim = await rateLimit(env, `events:${clientIp(req)}:${session}`, LIMITS.events);
      if (!lim.ok) return json({ error: "Too many requests. Wait a minute and try again." }, 429);
      const b = await req.json().catch(() => ({}));
      return handleCallEvent(env, { ...b, source: b.source === "test" ? "test" : "browser-sim" }, session);
    }

    if (p === "/webhooks/vapi" && req.method === "POST") {
      const lim = await rateLimit(env, `webhooks:${clientIp(req)}`, LIMITS.webhooks);
      if (!lim.ok) return json({ error: "Too many requests. Wait a minute and try again." }, 429);
      if (env.VAPI_WEBHOOK_SECRET && req.headers.get("x-vapi-secret") !== env.VAPI_WEBHOOK_SECRET)
        return json({ error: "bad secret" }, 401);
      const ev = fromVapi(await req.json().catch(() => ({})));
      if (!ev) return json({ status: "ignored" });
      return handleCallEvent(env, ev, WEBHOOK_SESSION);
    }

    if (p === "/webhooks/telnyx" && req.method === "POST") {
      const lim = await rateLimit(env, `webhooks:${clientIp(req)}`, LIMITS.webhooks);
      if (!lim.ok) return json({ error: "Too many requests. Wait a minute and try again." }, 429);
      const ev = fromTelnyx(await req.json().catch(() => ({})));
      if (!ev) return json({ status: "ignored" });
      return handleCallEvent(env, ev, WEBHOOK_SESSION);
    }

    if (p === "/api/reset" && req.method === "POST") {
      const session = readSession(req);
      if (!session) return json({ error: "missing or invalid x-demo-session" }, 400);
      const lim = await rateLimit(env, `reset:${clientIp(req)}:${session}`, LIMITS.reset);
      if (!lim.ok) return json({ error: "Too many requests. Wait a minute and try again." }, 429);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM events WHERE session_id=?").bind(session),
        env.DB.prepare("DELETE FROM contacts WHERE session_id=?").bind(session),
        env.DB.prepare("DELETE FROM log WHERE session_id=?").bind(session),
      ]);
      return json({ status: "reset", session });
    }

    if (p.startsWith("/api/") || p.startsWith("/webhooks/")) return json({ error: "not found" }, 404);
    return env.ASSETS.fetch(req);
  },
};
