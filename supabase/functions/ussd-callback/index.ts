// Citizen-facing USSD menu — Africa's Talking callback.
//
// - Receives a form-urlencoded POST from Africa's Talking.
// - Returns text/plain starting with CON (continue) or END (terminate).
// - Anti-spoofing: every request must carry the shared secret header
//   `x-ussd-secret`, whose value lives in the AT_USSD_SECRET secret
//   (the same value is configured in the Africa's Talking callback).
// - Uses the Supabase service-role client to read petitions/actions and
//   write signatures/action_joins, and sends an SMS confirmation after a
//   successful sign/join. The USSD response never blocks on SMS.
//
// Menu (driven by the accumulated `text` field, split on "*"):
//   (empty) / 0  -> welcome
//   1            -> active petitions (4/page, "9. More")
//   1*<n>        -> petition detail
//   1*<n>*1      -> sign (dedup via unique index + pre-check)
//   2            -> upcoming active actions (4/page, "9. More")
//   2*<n>        -> action detail
//   2*<n>*1      -> join (dedup)
//   3            -> my status (recent signatures + joins)
//   anything else-> re-prompt the current screen; never crash.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const PAGE_SIZE = 4;
const AT_SMS_URL = "https://api.africastalking.com/version1/messaging";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-ussd-secret, apikey",
  "Access-Control-Max-Age": "86400",
};

interface UssdContext {
  parts: string[];
  phone: string;
  sessionId: string;
}

// ---------- response helpers ----------

function plain(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS_HEADERS },
  });
}

function con(...lines: string[]): Response {
  return plain("CON " + lines.join("\n"));
}

function end(...lines: string[]): Response {
  return plain("END " + lines.join("\n"));
}

// ---------- small utils ----------

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Normalise a phone number to the +254... form used across the DB. */
function normalizeKenyaPhone(raw: string): string {
  const p = (raw || "").trim().replace(/\s+/g, "");
  if (!p) return "";
  if (p.startsWith("+254")) return p;
  if (p.startsWith("254")) return "+" + p;
  if (p.startsWith("0")) return "+254" + p.slice(1);
  return "+254" + p;
}

function truncate(s: string, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "\u2026" : s;
}

function formatNumber(n: number | null | undefined): string {
  if (n == null) return "Open";
  return n.toLocaleString("en-US");
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function formatDate(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00Z");
  return `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`;
}

function formatTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${String(m).padStart(2, "0")} ${period}`;
}

// Parse the navigation segments that follow the top-level branch.
//   rest = []                    -> list, page 0
//   rest = ["9", ...]            -> paginate: each leading "9" advances the page
//   rest = [..., "<1..4>"]       -> detail
//   rest = [..., "<1..4>", "1"]  -> confirm (sign/join)
//   rest = [..., "<1..4>", "0"]  -> back to welcome
//   anything else                -> invalid (re-prompt the list)
type Nav =
  | { action: "list"; page: number; item: -1 }
  | { action: "detail"; page: number; item: number }
  | { action: "confirm"; page: number; item: number }
  | { action: "welcome"; page: number; item: number }
  | { action: "invalid"; page: number; item: number };

function parseNav(rest: string[]): Nav {
  let page = 0;
  let i = 0;
  while (i < rest.length && rest[i] === "9") {
    page++;
    i++;
  }
  if (i >= rest.length) return { action: "list", page, item: -1 };
  const item = Number(rest[i]);
  if (!Number.isInteger(item) || item < 1 || item > PAGE_SIZE) {
    return { action: "invalid", page, item };
  }
  const next = rest[i + 1];
  if (next === undefined) return { action: "detail", page, item };
  if (next === "1") return { action: "confirm", page, item };
  if (next === "0") return { action: "welcome", page, item };
  return { action: "invalid", page, item };
}

// ---------- SMS (outgoing, non-blocking) ----------

async function sendConfirmationSms(to: string, message: string): Promise<void> {
  const apiKey = Deno.env.get("AT_API_KEY");
  const username = Deno.env.get("AT_USERNAME");
  const from = Deno.env.get("AT_SENDER_ID");
  if (!apiKey || !username) {
    console.error("ussd-callback: AT SMS credentials missing (AT_API_KEY / AT_USERNAME).");
    return;
  }
  const body = new URLSearchParams({ username, to, message });
  if (from) body.set("from", from);
  try {
    const res = await fetch(AT_SMS_URL, {
      method: "POST",
      headers: {
        apiKey,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error(`ussd-callback: SMS failed (${res.status}): ${errText}`);
    }
  } catch (err) {
    console.error("ussd-callback: SMS send threw", err);
  }
}

// ---------- screens ----------

function welcomeScreen(): Response {
  return con(
    "Welcome to Citizen Actions.",
    "1. Sign a petition",
    "2. Join an action",
    "3. My status",
  );
}

async function listPetitions(supabase: SupabaseClient, page: number): Promise<Response> {
  const from = page * PAGE_SIZE;
  // fetch PAGE_SIZE + 1 rows to detect whether "9. More" should show
  const { data, error } = await supabase
    .from("petitions")
    .select("id, title")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .range(from, from + PAGE_SIZE);
  if (error) throw error;
  const rows = (data ?? []).slice(0, PAGE_SIZE);
  const hasMore = (data ?? []).length > PAGE_SIZE;

  if (rows.length === 0) {
    return page > 0
      ? con("No more petitions.", "0. Back to menu")
      : con("No active petitions right now.", "0. Back to menu");
  }
  const lines = ["Petitions:"];
  rows.forEach((r, idx) => lines.push(`${idx + 1}. ${truncate(r.title, 26)}`));
  if (hasMore) lines.push("9. More");
  lines.push("0. Back to menu");
  return con(...lines);
}

async function getPetitionAt(
  supabase: SupabaseClient,
  page: number,
  item: number,
): Promise<{ id: string; title: string; target_signatures: number | null } | null> {
  const from = page * PAGE_SIZE;
  const { data, error } = await supabase
    .from("petitions")
    .select("id, title, target_signatures")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);
  if (error) throw error;
  return (data ?? [])[item - 1] ?? null;
}

async function handlePetitions(supabase: SupabaseClient, ctx: UssdContext): Promise<Response> {
  const nav = parseNav(ctx.parts.slice(1));
  if (nav.action === "welcome") return welcomeScreen();
  if (nav.action === "invalid") return listPetitions(supabase, nav.page);
  if (nav.action === "list") return listPetitions(supabase, nav.page);

  const petition = await getPetitionAt(supabase, nav.page, nav.item);
  if (!petition) return listPetitions(supabase, nav.page);

  if (nav.action === "detail") {
    return con(
      petition.title,
      `Target: ${formatNumber(petition.target_signatures)}`,
      "Reply 1 to sign, 0 for menu.",
    );
  }

  // confirm -> sign (write-once: pre-check + unique index)
  const existing = await supabase
    .from("signatures")
    .select("id")
    .eq("petition_id", petition.id)
    .eq("phone_number", ctx.phone)
    .maybeSingle();
  if (existing.data) {
    return end(`You already signed "${petition.title}".`);
  }
  const { error: insertError } = await supabase.from("signatures").insert({
    petition_id: petition.id,
    phone_number: ctx.phone,
    session_id: ctx.sessionId,
  });
  if (insertError) {
    if (insertError.code === "23505") {
      return end(`You already signed "${petition.title}".`);
    }
    throw insertError;
  }

  sendConfirmationSms(
    ctx.phone,
    `You signed the petition "${petition.title}". Thank you for making your voice count!`,
  );
  return end(`Thank you! You signed "${petition.title}".`);
}

async function listActions(supabase: SupabaseClient, page: number): Promise<Response> {
  const from = page * PAGE_SIZE;
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("actions")
    .select("id, title, event_date, event_time, venue")
    .eq("status", "active")
    .gte("event_date", today)
    .order("event_date", { ascending: true })
    .order("event_time", { ascending: true })
    .range(from, from + PAGE_SIZE);
  if (error) throw error;
  const rows = (data ?? []).slice(0, PAGE_SIZE);
  const hasMore = (data ?? []).length > PAGE_SIZE;

  if (rows.length === 0) {
    return page > 0
      ? con("No more actions.", "0. Back to menu")
      : con("No upcoming actions right now.", "0. Back to menu");
  }
  const lines = ["Actions:"];
  rows.forEach((r, idx) => lines.push(`${idx + 1}. ${truncate(r.title, 24)}`));
  if (hasMore) lines.push("9. More");
  lines.push("0. Back to menu");
  return con(...lines);
}

async function getActionAt(
  supabase: SupabaseClient,
  page: number,
  item: number,
): Promise<{ id: string; title: string; event_date: string; event_time: string; venue: string } | null> {
  const from = page * PAGE_SIZE;
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("actions")
    .select("id, title, event_date, event_time, venue")
    .eq("status", "active")
    .gte("event_date", today)
    .order("event_date", { ascending: true })
    .order("event_time", { ascending: true })
    .range(from, from + PAGE_SIZE - 1);
  if (error) throw error;
  return (data ?? [])[item - 1] ?? null;
}

async function handleActions(supabase: SupabaseClient, ctx: UssdContext): Promise<Response> {
  const nav = parseNav(ctx.parts.slice(1));
  if (nav.action === "welcome") return welcomeScreen();
  if (nav.action === "invalid") return listActions(supabase, nav.page);
  if (nav.action === "list") return listActions(supabase, nav.page);

  const action = await getActionAt(supabase, nav.page, nav.item);
  if (!action) return listActions(supabase, nav.page);

  if (nav.action === "detail") {
    return con(
      action.title,
      `${formatDate(action.event_date)}, ${formatTime(action.event_time)}`,
      truncate(action.venue, 32),
      "Reply 1 to join, 0 for menu.",
    );
  }

  // confirm -> join (write-once: pre-check + unique index)
  const existing = await supabase
    .from("action_joins")
    .select("id")
    .eq("action_id", action.id)
    .eq("phone_number", ctx.phone)
    .maybeSingle();
  if (existing.data) {
    return end(`You already joined "${action.title}".`);
  }
  const { error: insertError } = await supabase.from("action_joins").insert({
    action_id: action.id,
    phone_number: ctx.phone,
    session_id: ctx.sessionId,
  });
  if (insertError) {
    if (insertError.code === "23505") {
      return end(`You already joined "${action.title}".`);
    }
    throw insertError;
  }

  sendConfirmationSms(
    ctx.phone,
    `You joined "${action.title}" on ${formatDate(action.event_date)} at ${formatTime(action.event_time)}, ${action.venue}. See you there!`,
  );
  return end("You're in! SMS sent with details.");
}

async function handleStatus(supabase: SupabaseClient, ctx: UssdContext): Promise<Response> {
  const [sigs, joins] = await Promise.all([
    supabase
      .from("signatures")
      .select("petitions(title)")
      .eq("phone_number", ctx.phone)
      .order("created_at", { ascending: false })
      .limit(3),
    supabase
      .from("action_joins")
      .select("actions(title)")
      .eq("phone_number", ctx.phone)
      .order("created_at", { ascending: false })
      .limit(3),
  ]);
  if (sigs.error) throw sigs.error;
  if (joins.error) throw joins.error;

  const signed = (sigs.data ?? [])
    .map((s) => s.petitions?.title)
    .filter((t): t is string => Boolean(t));
  const joined = (joins.data ?? [])
    .map((j) => j.actions?.title)
    .filter((t): t is string => Boolean(t));

  return end(
    signed.length
      ? `You signed: ${signed.join(", ")}.`
      : "You have not signed any petition yet.",
    joined.length
      ? `You joined: ${joined.join(", ")}.`
      : "You have not joined any action yet.",
  );
}

async function route(supabase: SupabaseClient, ctx: UssdContext): Promise<Response> {
  const top = ctx.parts[0] ?? "";
  switch (top) {
    case "":
    case "0":
      return welcomeScreen();
    case "1":
      return handlePetitions(supabase, ctx);
    case "2":
      return handleActions(supabase, ctx);
    case "3":
      return handleStatus(supabase, ctx);
    default:
      return welcomeScreen();
  }
}

// ---------- entry ----------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return plain("Method not allowed", 405);
  }

  // Anti-spoofing: fail closed unless the shared secret header is present and correct.
  const expectedSecret = Deno.env.get("AT_USSD_SECRET");
  if (!expectedSecret) {
    console.error("ussd-callback: AT_USSD_SECRET is not configured; refusing callbacks.");
    return plain("Unauthorized", 401);
  }
  const providedSecret = req.headers.get("x-ussd-secret") ?? "";
  if (!constantTimeEqual(providedSecret, expectedSecret)) {
    console.warn("ussd-callback: rejected callback with missing/invalid x-ussd-secret.");
    return plain("Unauthorized", 401);
  }

  const params = new URLSearchParams(await req.text());
  const ctx: UssdContext = {
    parts: (params.get("text") ?? "").split("*").filter((s) => s.length > 0),
    phone: normalizeKenyaPhone(params.get("phoneNumber") ?? ""),
    sessionId: params.get("sessionId") ?? "",
  };

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  try {
    return await route(supabase, ctx);
  } catch (err) {
    console.error("ussd-callback: unexpected error", err);
    return con("Sorry, something went wrong. Please try again.");
  }
});
