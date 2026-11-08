const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

const encoder = new TextEncoder();
const notFoundMessage = "查無登記資料，請確認姓名寫法與區和登記時相同";
const lookupClosedMessage = "查詢功能暫停中，請稍後再試";
const invalidHostingMessage = "請檢查開家接待內容";
// The page branches on `code`, never on the message text, so the wording can change freely.
const hostingClosed = { error: "開家接待調查已關閉", code: "HOSTING_CLOSED" };
// A page loaded before this release has no hosting fields; its users can only act on "reload".
const hostingRequired = { error: "開家接待調查已開放，請回答開家接待；看不到接待欄位時請重新整理頁面", code: "HOSTING_REQUIRED" };
const pickupClosed = { error: "接機接待調查已關閉", code: "PICKUP_CLOSED" };
const pickupRequired = { error: "接機接待調查已開放，請回答是否可以接機；看不到接機欄位時請重新整理頁面", code: "PICKUP_REQUIRED" };

// The page shows the hosting fields when the switch opened after it loaded; the reply carries the
// description too, which the admin may have written meanwhile. It is public text, like GET returns.
async function hostingRequiredResponse(database) {
  try {
    const { data, error } = await database.from("site_settings").select("hosting_description").single();
    // Without a successful read the field is left out, so the page keeps the description it has.
    if (!error && data) return response({ ...hostingRequired, hosting_description: data.hosting_description }, 409);
  } catch (error) {
    console.error("Failed to read hosting description", error);
  }
  return response(hostingRequired, 409);
}
async function pickupRequiredResponse(database) {
  const { data } = await database.from("site_settings").select("pickup_description").single();
  return response({ ...pickupRequired, pickup_description: data?.pickup_description }, 409);
}
// A page loaded before an admin changed prices or audiences can miss the question or show an
// activity as open; reloading shows the current form. These stay 400: the lookup page treats a 409
// on update as "this registration can no longer be changed" and leaves the edit form.
function mealResponse(error) {
  if (error?.message?.includes("MEAL_IDENTITY_REQUIRED")) {
    return response({ error: "請選擇用餐身分；看不到這一題時請重新整理頁面" }, 400);
  }
  if (error?.message?.includes("INVALID_MEAL_IDENTITY")) return response({ error: "請檢查用餐身分" }, 400);
  if (error?.message?.includes("AUDIENCE_RESTRICTED")) {
    return response({ error: "有活動不符合報名對象，請確認開家、接機與活動選擇；畫面不符時請重新整理頁面" }, 400);
  }
  return null;
}
let createClient;

// Left out (or null) means no answer; anything else must be one of the two codes.
export function validMealIdentity(value) {
  return value === undefined || value === null || value === "general" || value === "student";
}

// Left out, null or false: not a child (a saved registration keeps what it has when left out).
// A child needs a parent name of 1～20 characters after trimming, counted like the database's length().
export function validChild(isChild, parentName) {
  if (isChild === undefined || isChild === null || isChild === false) return true;
  if (isChild !== true || typeof parentName !== "string") return false;
  const length = Array.from(parentName.trim()).length;
  return length >= 1 && length <= 20;
}
const parentNameMessage = "請填寫家長姓名（20 字以內）";

export function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// The first X-Forwarded-For hop is the client. Requests without it share one bucket, so they
// are still limited rather than skipped.
export function clientIp(request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
}

// The imported key is reused across requests; it is re-imported only if the secret changes.
let hmacKey;
let hmacSecret;

// Only an HMAC of the IP made with a server-only key is stored, never the IP itself.
export async function sourceKey(ip, key) {
  if (hmacSecret !== key) {
    hmacKey = await crypto.subtle.importKey("raw", encoder.encode(key),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    hmacSecret = key;
  }
  const signature = await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(ip));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function projectSecret() {
  try {
    return JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}").default
      ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  } catch {
    return null;
  }
}

// Invalid parameter, bad text and numeric overflow all come from client input.
function isInputError(error) {
  return ["22023", "22P02", "22003"].includes(error?.code);
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

export async function handler(request) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (!["GET", "POST"].includes(request.method)) return response({ error: "METHOD_NOT_ALLOWED" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const secretKey = projectSecret();
  const rateLimitKey = Deno.env.get("RATE_LIMIT_KEY");
  if (!url || !secretKey || !rateLimitKey || rateLimitKey.length < 32) {
    console.error("Missing required Edge Function secrets");
    return response({ error: "服務暫時無法使用" }, 503);
  }

  const database = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (request.method === "GET") {
    const [settings, districts, activities, program] = await Promise.all([
      database.from("site_settings").select("event_name,venue,address,event_note,registration_deadline_at,is_registration_open,is_hosting_open,hosting_description,is_pickup_open,pickup_description").single(),
      database.from("districts").select("id,name").order("sort_order"),
      database.from("activities").select("id,category,title,starts_at,starts_at_has_time,ends_at,ends_at_has_time,venue,address,map_url,description,fee_amount,student_fee_amount,audience,audience_note").eq("is_published", true).order("sort_order"),
      database.from("program_items").select("event_date,start_time,end_time,title,note").eq("is_visible", true).order("sort_order"),
    ]);
    const failed = [settings, districts, activities, program].find((result) => result.error);
    if (failed?.error) {
      console.error(failed.error.message);
      return response({ error: "無法載入登記資料" }, 503);
    }
    return response({ settings: settings.data, districts: districts.data, activities: activities.data, program: program.data });
  }

  let body;
  try {
    const rawBody = await request.text();
    if (encoder.encode(rawBody).byteLength > 64_000) {
      return response({ error: "REQUEST_TOO_LARGE" }, 413);
    }
    body = JSON.parse(rawBody);
  } catch {
    return response({ error: "INVALID_REQUEST" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return response({ error: "INVALID_REQUEST" }, 400);
  }

  const action = body.action;
  if (!["create", "query", "update"].includes(String(action))) {
    return response({ error: "INVALID_ACTION" }, 400);
  }

  // Every public write or lookup counts, success or not: name and district are guessable,
  // so successful lookups are what an enumeration attempt looks like.
  const { data: allowed, error: limitError } = await database.rpc("consume_public_request", {
    p_source_key: await sourceKey(clientIp(request), rateLimitKey),
  });
  if (limitError) {
    console.error("Failed to check public request limit", limitError);
    return response({ error: "服務暫時無法使用" }, 503);
  }
  if (allowed !== true) return response({ error: "操作次數過多，請稍後再試" }, 429);
  if (!validMealIdentity(body.meal_identity)) return response({ error: "請檢查用餐身分" }, 400);
  if (!validChild(body.is_child, body.parent_name)) return response({ error: parentNameMessage }, 400);

  if (action === "create") {
    // shortcut: Turnstile stays disabled for launch; verify body.turnstile_token here when enabled.
    const startedAt = Number(body.started_at);
    if (body.website || !Number.isFinite(startedAt) || Date.now() - startedAt < 3_000 || Date.now() - startedAt > 86_400_000) {
      return response({ error: "INVALID_REQUEST" }, 400);
    }
    if (!isUuid(body.create_request_id)) return response({ error: "INVALID_REQUEST" }, 400);
    const { error } = await database.rpc("create_registration_with_pickup", {
      p_request_id: body.create_request_id,
      p_full_name: body.full_name,
      p_district_id: body.district_id,
      p_choices: body.choices,
      p_hosting: body.hosting ?? null,
      p_pickup: body.pickup ?? null,
      p_meal_identity: body.meal_identity ?? null,
      p_is_child: body.is_child === true,
      p_parent_name: body.is_child === true ? body.parent_name : null,
    });
    if (!error) return response({ success: true }, 201);
    const mealError = mealResponse(error);
    if (mealError) return mealError;
    if (error.message.includes("NAME_TAKEN")) {
      return response({ error: "此姓名與區已經登記過，如需查看或修改，請使用「查詢或修改登記」" }, 409);
    }
    if (error.message.includes("DUPLICATE_REQUEST")) return response({ error: "DUPLICATE_REQUEST" }, 409);
    if (error.message.includes("CREATE_RATE_LIMITED")) return response({ error: "登記暫時忙碌，請稍後再試" }, 429);
    if (error.message.includes("REGISTRATION_CLOSED")) return response({ error: "登記目前未開放" }, 409);
    if (error.message.includes("HOSTING_CLOSED")) return response(hostingClosed, 409);
    if (error.message.includes("HOSTING_REQUIRED")) return hostingRequiredResponse(database);
    if (error.message.includes("PICKUP_CLOSED")) return response(pickupClosed, 409);
    if (error.message.includes("PICKUP_REQUIRED")) return pickupRequiredResponse(database);
    if (error.message.includes("INVALID_PICKUP")) return response({ error: "請檢查接機接待內容" }, 400);
    if (error.message.includes("INVALID_HOSTING")) return response({ error: invalidHostingMessage }, 400);
    if (error.message.includes("INVALID_PARENT_NAME")) return response({ error: parentNameMessage }, 400);
    if (isInputError(error)) return response({ error: "請檢查登記資料" }, 400);
    console.error(error.message);
    return response({ error: "登記失敗，請稍後再試" }, 500);
  }

  // Only a number or a digits-only string; Number() would turn true, false, null and "" into 0 or 1.
  const districtId = typeof body.district_id === "number" || /^\d+$/.test(String(body.district_id ?? ""))
    ? Number(body.district_id) : NaN;
  // Count characters, not UTF-16 units, to match the database's length() on names with emoji or rare CJK.
  if (typeof body.full_name !== "string" || !body.full_name.trim() || Array.from(body.full_name.trim()).length > 100
    || !Number.isSafeInteger(districtId)) {
    return response({ error: "請輸入姓名並選擇區" }, 400);
  }

  if (action === "query") {
    const { data, error } = await database.rpc("get_registration", {
      p_full_name: body.full_name, p_district_id: districtId,
    });
    if (error?.message.includes("LOOKUP_CLOSED")) return response({ error: lookupClosedMessage }, 503);
    if (isInputError(error)) return response({ error: "請輸入姓名並選擇區" }, 400);
    if (error) {
      console.error("Failed to query registration", error);
      return response({ error: "服務暫時無法使用" }, 503);
    }
    if (data?.length !== 1) return response({ error: notFoundMessage }, 404);
    const pickup = await database.rpc("get_registration_pickup", {
      p_full_name: body.full_name, p_district_id: districtId,
    });
    if (pickup.error?.message.includes("LOOKUP_CLOSED")) return response({ error: lookupClosedMessage }, 503);
    if (pickup.error) {
      console.error("Failed to query registration pickup", pickup.error);
      return response({ error: "服務暫時無法使用" }, 503);
    }
    const child = await database.rpc("get_registration_child", {
      p_full_name: body.full_name, p_district_id: districtId,
    });
    if (child.error?.message.includes("LOOKUP_CLOSED")) return response({ error: lookupClosedMessage }, 503);
    if (child.error) {
      console.error("Failed to query registration child fields", child.error);
      return response({ error: "服務暫時無法使用" }, 503);
    }
    return response({ ...data[0], pickup: pickup.data, is_child: child.data?.is_child === true,
      parent_name: child.data?.parent_name ?? null });
  }

  const { data, error } = await database.rpc("update_registration_with_pickup", {
    p_full_name: body.full_name,
    p_district_id: districtId,
    p_choices: body.choices,
    p_hosting: body.hosting ?? null,
    p_pickup: body.pickup ?? null,
    p_meal_identity: body.meal_identity ?? null,
    // Left out keeps the stored child fields, so a page from before this release cannot clear them.
    p_is_child: typeof body.is_child === "boolean" ? body.is_child : null,
    p_parent_name: body.is_child === true ? body.parent_name : null,
  });
  const mealError = mealResponse(error);
  if (mealError) return mealError;
  if (error?.message.includes("REGISTRATION_CLOSED")) return response({ error: "登記已截止，資料只能查看" }, 409);
  if (error?.message.includes("LOOKUP_CLOSED")) return response({ error: lookupClosedMessage }, 503);
  if (error?.message.includes("HOSTING_CLOSED")) return response(hostingClosed, 409);
  if (error?.message.includes("HOSTING_REQUIRED")) return hostingRequiredResponse(database);
  if (error?.message.includes("PICKUP_CLOSED")) return response(pickupClosed, 409);
  if (error?.message.includes("PICKUP_REQUIRED")) return pickupRequiredResponse(database);
  if (error?.message.includes("INVALID_PICKUP")) return response({ error: "請檢查接機接待內容" }, 400);
  if (error?.message.includes("INVALID_HOSTING")) return response({ error: invalidHostingMessage }, 400);
  if (error?.message.includes("INVALID_PARENT_NAME")) return response({ error: parentNameMessage }, 400);
  if (isInputError(error)) return response({ error: "請檢查登記資料" }, 400);
  if (error) {
    console.error("Failed to update registration", error);
    return response({ error: "服務暫時無法使用" }, 503);
  }
  if (data !== true) return response({ error: notFoundMessage }, 404);
  return response({ success: true });
}

if (typeof Deno !== "undefined") {
  ({ createClient } = await import("npm:@supabase/supabase-js@2.118.0"));
  Deno.serve(handler);
}
