// Call flow demo: voice call result -> CRM (GHL) with idempotency and per-agency routing.
// Modes are picked from secrets. No secret = simulated mode, clearly labeled.

const AGENCIES = {
  // Dialed number -> agency. 555-01xx numbers are reserved test numbers.
  "+15550100001": { key: "agency_a", name: "Agency A", color: "#2563eb" },
  "+15550100002": { key: "agency_b", name: "Agency B", color: "#16a34a" },
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
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

async function addLog(env, call_id, agency, kind, detail) {
  await env.DB.prepare("INSERT INTO log (ts, call_id, agency, kind, detail) VALUES (?,?,?,?,?)")
    .bind(now(), call_id, agency, kind, typeof detail === "string" ? detail : JSON.stringify(detail))
    .run();
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

async function pushToCrm(env, ev, agency) {
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
  const existing = await env.DB.prepare("SELECT id, tags FROM contacts WHERE agency=? AND phone=?")
    .bind(agency.key, ev.caller_phone).first();
  if (existing) {
    const merged = Array.from(new Set([...(existing.tags || "").split(",").filter(Boolean), ...tags]));
    await env.DB.prepare("UPDATE contacts SET name=COALESCE(?,name), tags=?, notes=notes+1, calls=calls+1, updated_at=? WHERE id=?")
      .bind(ev.caller_name || null, merged.join(","), now(), existing.id).run();
    if (mode === "simulated") steps.push({ step: "contact updated", contactId: existing.id });
  } else {
    const id = "c_" + crypto.randomUUID().slice(0, 8);
    await env.DB.prepare("INSERT INTO contacts (id, agency, phone, name, tags, notes, calls, created_at, updated_at) VALUES (?,?,?,?,?,1,1,?,?)")
      .bind(id, agency.key, ev.caller_phone, ev.caller_name || null, tags.join(","), now(), now()).run();
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
async function handleCallEvent(env, ev) {
  ev.dialed = normPhone(ev.dialed);
  ev.caller_phone = normPhone(ev.caller_phone);
  if (!ev.call_id) return json({ status: "rejected", reason: "missing call_id" }, 400);
  const agency = AGENCIES[ev.dialed];
  if (!agency) {
    await addLog(env, ev.call_id, null, "rejected", `Unknown dialed number ${ev.dialed}`);
    return json({ status: "rejected", reason: `No agency owns ${ev.dialed}` }, 422);
  }
  if (!ev.caller_phone) return json({ status: "rejected", reason: "missing caller phone" }, 400);

  // Idempotency: the call ID is the primary key. The insert is atomic, so two copies
  // that arrive at the same moment still produce one row.
  const ins = await env.DB.prepare(
    "INSERT INTO events (call_id, source, agency, dialed, caller_phone, caller_name, outcome, summary, duration_sec, created_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(call_id) DO NOTHING"
  ).bind(ev.call_id, ev.source, agency.key, ev.dialed, ev.caller_phone, ev.caller_name || null,
    ev.outcome || "handled", ev.summary || "", Math.round(ev.duration_sec || 0), now()).run();

  if (!ins.meta.changes) {
    await env.DB.prepare("UPDATE events SET dup_count = dup_count + 1 WHERE call_id=?").bind(ev.call_id).run();
    await addLog(env, ev.call_id, agency.key, "duplicate", "Same call ID seen again. Skipped. No new contact, note or text.");
    // 200 so the sender (Vapi, Telnyx) stops retrying.
    return json({ status: "duplicate", call_id: ev.call_id, agency: agency.name, action: "skipped" });
  }

  await addLog(env, ev.call_id, agency.key, "routed", `Dialed ${ev.dialed} -> ${agency.name}`);
  try {
    const crm = await pushToCrm(env, ev, agency);
    await env.DB.prepare("UPDATE events SET texts_queued=? WHERE call_id=?").bind(crm.texts, ev.call_id).run();
    for (const s of crm.steps) await addLog(env, ev.call_id, agency.key, `crm:${crm.mode}`, s);
    return json({ status: "processed", call_id: ev.call_id, agency: agency.name, crm });
  } catch (e) {
    // Let the sender retry: remove the claim so a retry can succeed.
    await env.DB.prepare("DELETE FROM events WHERE call_id=?").bind(ev.call_id).run();
    await addLog(env, ev.call_id, agency.key, "error", String(e.message || e));
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

async function state(env) {
  const [events, contacts, log, billing] = await Promise.all([
    env.DB.prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT 50").all(),
    env.DB.prepare("SELECT * FROM contacts ORDER BY updated_at DESC LIMIT 50").all(),
    env.DB.prepare("SELECT * FROM log ORDER BY id DESC LIMIT 30").all(),
    env.DB.prepare(
      "SELECT agency, COUNT(*) AS calls, COALESCE(SUM(duration_sec),0) AS seconds, COALESCE(SUM(texts_queued),0) AS texts, COALESCE(SUM(dup_count),0) AS duplicates_blocked FROM events GROUP BY agency"
    ).all(),
  ]);
  return { config: config(env), events: events.results, contacts: contacts.results, log: log.results, billing: billing.results };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (req.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, x-vapi-secret", "access-control-allow-methods": "GET,POST" } });

    if (p === "/api/config") return json(config(env));
    if (p === "/api/state") return json(await state(env));

    if (p === "/api/events" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      return handleCallEvent(env, { ...b, source: b.source === "test" ? "test" : "browser-sim" });
    }

    if (p === "/webhooks/vapi" && req.method === "POST") {
      if (env.VAPI_WEBHOOK_SECRET && req.headers.get("x-vapi-secret") !== env.VAPI_WEBHOOK_SECRET)
        return json({ error: "bad secret" }, 401);
      const ev = fromVapi(await req.json().catch(() => ({})));
      if (!ev) return json({ status: "ignored" });
      return handleCallEvent(env, ev);
    }

    if (p === "/webhooks/telnyx" && req.method === "POST") {
      const ev = fromTelnyx(await req.json().catch(() => ({})));
      if (!ev) return json({ status: "ignored" });
      return handleCallEvent(env, ev);
    }

    if (p === "/api/reset" && req.method === "POST") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM events"),
        env.DB.prepare("DELETE FROM contacts"),
        env.DB.prepare("DELETE FROM log"),
      ]);
      return json({ status: "reset" });
    }

    if (p.startsWith("/api/") || p.startsWith("/webhooks/")) return json({ error: "not found" }, 404);
    return env.ASSETS.fetch(req);
  },
};
