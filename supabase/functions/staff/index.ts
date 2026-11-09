const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

let createClient;

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}

// Invalid parameter, bad text and numeric overflow all come from client input.
function isInputError(error) {
  return ["22023", "22P02", "22003"].includes(error?.code);
}

// Same rule as public.registration_name_key, so staff find a person the way the public lookup does.
export function nameKey(value) {
  return value.normalize("NFKC").toLowerCase().replaceAll(/[\s​-‍⁠﻿]/g, "");
}

// staff_assert_actor raises 42501 when the caller lost access mid-session
// (deactivated or demoted, or must_change_password set before login).
function lostAccess(error) {
  return error?.code === "42501";
}
const lostAccessResponse = () => response({ error: "帳號權限已變更，請重新登入" }, 403);

// Same status codes as the public registration function.
function mealResponse(error) {
  if (error?.message?.includes("MEAL_IDENTITY_REQUIRED")) return response({ error: "請選擇用餐身分" }, 400);
  if (error?.message?.includes("INVALID_MEAL_IDENTITY")) return response({ error: "請檢查用餐身分" }, 400);
  if (error?.message?.includes("AUDIENCE_RESTRICTED")) {
    return response({ error: "有活動不符合報名對象，請確認開家、接機與活動選擇" }, 400);
  }
  return null;
}

// Left out (or null) means no answer; code syntax is checked here; the database checks existence and eligibility.
export function validMealIdentity(value) {
  return value === undefined || value === null || (typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(value));
}

// Same rule as the public registration function: left out, null or false is not a child (a saved
// registration keeps what it has when left out); a child needs a parent name of 1～20 characters.
export function validChild(isChild, parentName) {
  if (isChild === undefined || isChild === null || isChild === false) return true;
  if (isChild !== true || typeof parentName !== "string") return false;
  const length = Array.from(parentName.trim()).length;
  return length >= 1 && length <= 20;
}
const parentNameMessage = "請填寫家長姓名（20 字以內）";

// 親子: the active children ({ serial_no, full_name }) naming each active, non-child row as their
// parent (same district and name key). Children only ever show their own parent's name.
export function childrenByParent(rows, children) {
  for (const row of rows) {
    if (row.record_status !== "active" || row.is_child) continue;
    row.children = children.filter((child) => child.district_id === row.district_id
      && child.parent_name_key === row.name_key)
      .map((child) => ({ serial_no: child.serial_no, full_name: child.full_name }));
  }
  return rows;
}

// The registration list's 區 filter: left out (or null) means every district.
export function validDistrictFilter(value) {
  return value === undefined || value === null || (Number.isSafeInteger(value) && value > 0);
}

function projectKey(name, fallback) {
  try {
    return JSON.parse(Deno.env.get(name) ?? "{}").default ?? Deno.env.get(fallback);
  } catch {
    return null;
  }
}

// Auth hashes with bcrypt, which accepts at most 72 bytes; a Chinese character takes 3.
export function validPassword(value) {
  return typeof value === "string" && value.length >= 12 && new TextEncoder().encode(value).length <= 72;
}

const passwordRuleMessage = "密碼須至少 12 字元，且不超過 72 bytes（一個中文字約佔 3 bytes）";
const weakPasswordMessage = "這組密碼不符合安全規則（可能過於常見或曾外洩），請換一組";

// Supabase Auth refuses some passwords by its own policy; the admin must pick another, not retry.
// Only this code: other 422 errors have other causes and must be logged, not shown as a weak password.
export function isWeakPassword(error) {
  return error?.code === "weak_password";
}

// UUIDs arrive in any letter case (isUuid accepts both), so compare them case-insensitively.
export function sameUser(left, right) {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

export function validUsername(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{2,30}$/.test(value);
}

function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function handler(request) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return response({ error: "METHOD_NOT_ALLOWED" }, 405);

  const token = request.headers.get("Authorization")?.match(/^Bearer (\S+)$/)?.[1];
  if (!token) return response({ error: "請先登入" }, 401);

  const url = Deno.env.get("SUPABASE_URL");
  const publishableKey = projectKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");
  const secretKey = projectKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !publishableKey || !secretKey) {
    console.error("Missing staff function configuration");
    return response({ error: "服務暫時無法使用" }, 503);
  }

  const auth = createClient(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const database = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: userError } = await auth.auth.getUser(token);
  if (userError || !userData.user) return response({ error: "請重新登入" }, 401);

  const { data: profile, error: profileError } = await database.from("staff_profiles")
    .select("auth_user_id,username,display_name,role,is_active,must_change_password")
    .eq("auth_user_id", userData.user.id).single();
  if (profileError || !profile?.is_active) return response({ error: "沒有操作權限" }, 403);

  let body;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 64_000) return response({ error: "REQUEST_TOO_LARGE" }, 413);
    body = JSON.parse(raw);
  } catch {
    return response({ error: "INVALID_REQUEST" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return response({ error: "INVALID_REQUEST" }, 400);

  if (body.action === "me") return response({ profile });
  if (body.action === "change_password") {
    if (typeof body.current_password !== "string" || !body.current_password) return response({ error: "請輸入目前密碼" }, 400);
    if (!validPassword(body.password)) return response({ error: passwordRuleMessage }, 400);
    if (body.password === body.current_password) return response({ error: "新密碼不可與目前密碼相同" }, 400);
    // Per-user limit: Auth's own sign-in limit counts the shared Edge Function IP, not this caller.
    // The slot is reserved atomically before checking, so parallel guesses cannot exceed it.
    const { data: allowed, error: attemptError } = await database.rpc("staff_reserve_password_attempt", {
      p_actor: profile.auth_user_id,
    });
    if (attemptError) {
      if (lostAccess(attemptError)) return lostAccessResponse();
      console.error("Failed to reserve password verification attempt", attemptError);
      return response({ error: "密碼更新失敗" }, 503);
    }
    if (allowed !== true) return response({ error: "嘗試次數過多，請 15 分鐘後再試" }, 429);
    // A stolen session alone must not be enough to take over the account.
    const { error: verifyError } = await auth.auth.signInWithPassword({
      email: `${profile.username}@accounts.invalid`, password: body.current_password,
    });
    if (verifyError) {
      if (verifyError.code === "invalid_credentials") return response({ error: "目前密碼不正確" }, 403);
      console.error("Failed to verify current staff password", verifyError);
      return response({ error: "密碼更新失敗" }, 503);
    }
    const { error: passwordError } = await database.auth.admin.updateUserById(profile.auth_user_id, { password: body.password });
    if (passwordError) {
      if (isWeakPassword(passwordError)) return response({ error: weakPasswordMessage }, 400);
      console.error("Failed to change staff password", passwordError);
      return response({ error: "密碼更新失敗" }, 503);
    }
    const { error: finishError } = await database.rpc("staff_finish_password_change", { p_actor: profile.auth_user_id });
    if (finishError) {
      console.error("Failed to finish staff password change", finishError);
      return response({ error: "密碼已變更，請重新登入並完成驗證" }, 503);
    }
    return response({ success: true });
  }

  if (profile.must_change_password) return response({ error: "請先更改初始密碼" }, 403);

  if (body.action === "list_registrations") {
    const page = Number(body.page);
    if (!Number.isInteger(page) || page < 0 || page > 10000) return response({ error: "INVALID_REQUEST" }, 400);
    // before_serial pages by key, so rows inserted during a full export cannot shift or duplicate pages.
    const beforeSerial = body.before_serial === undefined ? null : Number(body.before_serial);
    if (beforeSerial !== null && (!Number.isSafeInteger(beforeSerial) || beforeSerial < 1)) {
      return response({ error: "INVALID_REQUEST" }, 400);
    }
    if (!validDistrictFilter(body.district_id)) return response({ error: "INVALID_REQUEST" }, 400);
    // The 兒童 filter: left out lists everyone, true lists children only.
    if (body.children_only !== undefined && body.children_only !== true) return response({ error: "INVALID_REQUEST" }, 400);
    let query = database.from("registrations")
      .select("id,serial_no,full_name,district_id,record_status,import_status,created_at,updated_at,registration_choices(activity_id,attending),meal_identity,is_child,parent_name,name_key,registration_hosting(status,guest_type,guest_count),registration_pickup(status,count)",
        beforeSerial === null ? { count: "exact" } : undefined)
      .order("serial_no", { ascending: false });
    // 10 rows a page, matching REGISTRATIONS_PER_PAGE in site/admin/staff.js.
    query = beforeSerial === null ? query.range(page * 10, page * 10 + 9)
      : query.lt("serial_no", beforeSerial).limit(500);
    if (body.search) {
      if (typeof body.search !== "string" || body.search.length > 100) return response({ error: "INVALID_REQUEST" }, 400);
      // More than 15 digits loses precision in Number, so treat it as a name search instead.
      query = /^\d{1,15}$/.test(body.search) ? query.eq("serial_no", Number(body.search))
        : query.ilike("name_key", `%${nameKey(body.search).replaceAll(/[%*,()]/g, "").replaceAll(/[\\_]/g, "\\$&")}%`);
    }
    if (body.district_id != null) query = query.eq("district_id", body.district_id);
    if (body.children_only) query = query.eq("is_child", true);
    const { data, count, error } = await query;
    if (error) {
      console.error("Failed to list registrations", error);
      return response({ error: "名單載入失敗" }, 503);
    }
    // Only the 10-row list shows 親子; one indexed lookup covers the page. The export pages skip it.
    const parents = beforeSerial === null ? data.filter((row) => row.record_status === "active" && !row.is_child)
      .map((row) => ({ district_id: row.district_id, name_key: row.name_key })) : [];
    if (parents.length) {
      const { data: children, error: childrenError } = await database.rpc("registration_children", { p_parents: parents });
      if (childrenError) {
        console.error("Failed to list registration children", childrenError);
        return response({ error: "名單載入失敗" }, 503);
      }
      // The lookup gives serial numbers only; the record view lists the children by name too.
      if (children.length) {
        const { data: names, error: namesError } = await database.from("registrations")
          .select("serial_no,full_name").in("serial_no", children.map((child) => child.serial_no));
        if (namesError) {
          console.error("Failed to name registration children", namesError);
          return response({ error: "名單載入失敗" }, 503);
        }
        const nameOf = new Map(names.map((item) => [item.serial_no, item.full_name]));
        for (const child of children) child.full_name = nameOf.get(child.serial_no) ?? "";
      }
      childrenByParent(data, children);
    }
    return response({ registrations: data, count });
  }

  if (body.action === "list_reference") {
    const [settings, districts, activities, program, identities] = await Promise.all([
      database.from("site_settings").select("event_name,venue,address,event_note,registration_deadline_at,is_registration_open,is_lookup_open,is_hosting_open,hosting_description,is_pickup_open,pickup_description").single(),
      database.from("districts").select("id,name,sort_order").order("sort_order"),
      database.from("activities").select("id,category,title,starts_at,starts_at_has_time,ends_at,ends_at_has_time,venue,address,map_url,description,fee_amount,student_fee_amount,activity_identity_prices(identity_code,fee_amount),cost_amount,audience,audience_note,is_published,sort_order").order("sort_order"),
      database.from("program_items").select("id,event_date,start_time,end_time,title,note,sort_order,is_visible").order("sort_order"),
      database.from("registration_identities").select("code,name,is_active,public_selectable").order("sort_order"),
    ]);
    if ([settings, districts, activities, program, identities].some((item) => item.error)) {
      console.error("Failed to load staff reference data", [settings, districts, activities, program, identities].map((item) => item.error));
      return response({ error: "後台資料載入失敗" }, 503);
    }
    return response({ settings: settings.data, districts: districts.data, activities: activities.data, program: program.data, identities: identities.data });
  }

  if (["save_registration", "set_import_status", "void_registration"].includes(body.action)) {
    if (!isUuid(body.registration_id)) return response({ error: "INVALID_REQUEST" }, 400);
    if (!validMealIdentity(body.meal_identity)) return response({ error: "請檢查用餐身分" }, 400);
    if (!validChild(body.is_child, body.parent_name)) return response({ error: parentNameMessage }, 400);
    const operation = {
      save_registration: ["staff_update_registration_with_pickup", {
        p_registration_id: body.registration_id, p_full_name: body.full_name,
        p_district_id: body.district_id, p_choices: body.choices, p_hosting: body.hosting ?? null,
        p_meal_identity: body.meal_identity ?? null, p_pickup: body.pickup ?? null,
        // Left out keeps the stored child fields, so an older back-office page cannot clear them.
        p_is_child: typeof body.is_child === "boolean" ? body.is_child : null,
        p_parent_name: body.is_child === true ? body.parent_name : null,
      }],
      set_import_status: ["staff_set_import_status", {
        p_registration_id: body.registration_id, p_status: body.status,
      }],
      void_registration: ["staff_void_registration", {
        p_registration_id: body.registration_id, p_reason: body.reason,
      }],
    }[body.action];
    const { data, error } = await database.rpc(operation[0], { p_actor: profile.auth_user_id, ...operation[1] });
    if (error) {
      if (lostAccess(error)) return lostAccessResponse();
      const mealError = mealResponse(error);
      if (mealError) return mealError;
      if (error.message?.includes("ALREADY_VOID")) return response({ error: "此紀錄已作廢" }, 409);
      if (error.message?.includes("NAME_TAKEN")) return response({ error: "此姓名與區已有有效登記" }, 409);
      if (error.message?.includes("INVALID_HOSTING")) return response({ error: "請檢查開家接待內容" }, 400);
      if (error.message?.includes("INVALID_PICKUP")) return response({ error: "請檢查接機接待內容" }, 400);
      if (error.message?.includes("INVALID_PARENT_NAME")) return response({ error: parentNameMessage }, 400);
      if (error.message?.includes("INVALID_VOID_REASON")) return response({ error: "請填寫作廢原因（200 字以內）" }, 400);
      if (isInputError(error)) return response({ error: "請檢查資料與活動選擇" }, 400);
      console.error("Failed staff registration operation", error);
      return response({ error: "登記資料更新失敗" }, 503);
    }
    if (!data) return response({ error: "找不到登記紀錄" }, 404);
    return response({ success: true });
  }

  if (body.action === "create_registration") {
    if (!isUuid(body.create_request_id)) return response({ error: "INVALID_REQUEST" }, 400);
    if (!validMealIdentity(body.meal_identity)) return response({ error: "請檢查用餐身分" }, 400);
    if (!validChild(body.is_child, body.parent_name)) return response({ error: parentNameMessage }, 400);
    const { data, error } = await database.rpc("staff_create_registration_with_pickup", {
      p_actor: profile.auth_user_id, p_request_id: body.create_request_id,
      p_full_name: body.full_name, p_district_id: body.district_id, p_choices: body.choices,
      p_hosting: body.hosting ?? null, p_meal_identity: body.meal_identity ?? null, p_pickup: body.pickup ?? null,
      p_is_child: body.is_child === true, p_parent_name: body.is_child === true ? body.parent_name : null,
    });
    if (!error && data?.length === 1) return response({ serial_no: data[0].serial_no }, 201);
    if (error?.message?.includes("DUPLICATE_REQUEST")) return response({ error: "此協助登記已建立，請重新整理名單確認" }, 409);
    if (error?.message?.includes("NAME_TAKEN")) return response({ error: "此姓名與區已有有效登記" }, 409);
    if (lostAccess(error)) return lostAccessResponse();
    const mealError = mealResponse(error);
    if (mealError) return mealError;
    if (error?.message?.includes("HOSTING_REQUIRED")) {
      return response({ error: "開家接待調查已開放，請回答開家接待後再建立協助登記；看不到接待欄位時請重新整理頁面", code: "HOSTING_REQUIRED" }, 409);
    }
    if (error?.message?.includes("PICKUP_REQUIRED")) {
      return response({ error: "接機接待調查已開放，請回答是否可以接機後再建立協助登記", code: "PICKUP_REQUIRED" }, 409);
    }
    if (error?.message?.includes("INVALID_HOSTING")) return response({ error: "請檢查開家接待內容" }, 400);
    if (error?.message?.includes("INVALID_PICKUP")) return response({ error: "請檢查接機接待內容" }, 400);
    if (error?.message?.includes("INVALID_PARENT_NAME")) return response({ error: parentNameMessage }, 400);
    if (isInputError(error)) return response({ error: "請檢查登記資料" }, 400);
    console.error("Failed to create staff registration", error);
    return response({ error: "協助登記失敗，請稍後再試" }, 503);
  }

  if (profile.role !== "admin") return response({ error: "沒有操作權限" }, 403);

  if (body.action === "reorder_activities") {
    const ids = body.activity_ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500
      || !ids.every((id) => Number.isSafeInteger(id) && id > 0) || new Set(ids).size !== ids.length) {
      return response({ error: "INVALID_REQUEST" }, 400);
    }
    const { error } = await database.rpc("staff_reorder_activities", {
      p_actor: profile.auth_user_id, p_activity_ids: ids,
    });
    if (error) {
      if (lostAccess(error)) return lostAccessResponse();
      if (isInputError(error)) return response({ error: "活動清單已有變動，請重新整理後再排序" }, 409);
      console.error("Failed to reorder activities", error);
      return response({ error: "排序儲存失敗" }, 503);
    }
    return response({ success: true });
  }

  if (body.action === "save_reference") {
    // Districts are fixed: renaming one would break the name + district lookup of existing registrations.
    if (!["settings", "hosting", "activity", "program", "identity", "delete_identity"].includes(body.kind)
      || !body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
      return response({ error: "INVALID_REQUEST" }, 400);
    }
    const { data, error } = await database.rpc(body.kind === "hosting" ? "staff_save_reception_settings" : "staff_save_reference", {
      p_actor: profile.auth_user_id, p_kind: body.kind, p_data: body.data,
    });
    if (error) {
      if (lostAccess(error)) return lostAccessResponse();
      // 23503: a registration took the identity between the check and the delete.
      if (error.message?.includes("IDENTITY_IN_USE") || (body.kind === "delete_identity" && error.code === "23503")) {
        return response({ error: "身分已使用或為系統保留，請改為停用" }, 400);
      }
      // An identity deleted while the activity form was open.
      if (error.code === "23503") return response({ error: "有身分已不存在，請重新整理頁面" }, 409);
      if (error.code === "23505") return response({ error: "名稱已存在" }, 409);
      if (error.message?.includes("ACTIVITY_AUDIENCE_CYCLE")) {
        return response({ error: "報名對象不能設定為活動本身，也不能形成活動之間的循環條件" }, 400);
      }
      if (error.message?.includes("ACTIVITY_AUDIENCE_NOT_FOUND")) {
        return response({ error: "報名對象指定的活動不存在，請重新整理頁面" }, 400);
      }
      // Settings also fail on check, not-null and bad date/time input.
      if (isInputError(error) || ["23514", "23502", "22007", "22008"].includes(error.code)) {
        return response({ error: "請檢查設定內容" }, 400);
      }
      console.error("Failed to save reference data", error);
      return response({ error: "設定儲存失敗" }, 503);
    }
    return response({ saved: data });
  }

  if (body.action === "list_staff") {
    const { data, error } = await database.from("staff_profiles")
      .select("auth_user_id,username,display_name,role,is_active,must_change_password,created_at")
      .order("created_at");
    if (error) {
      console.error("Failed to list staff", error);
      return response({ error: "帳號載入失敗" }, 503);
    }
    return response({ staff: data });
  }

  if (body.action === "create_staff") {
    const username = String(body.username ?? "").toLowerCase();
    const displayName = String(body.display_name ?? "").trim();
    if (!validUsername(username) || !displayName || displayName.length > 100 || !["admin", "staff"].includes(body.role)) {
      return response({ error: "請檢查帳號資料" }, 400);
    }
    // The admin sets the password and hands it over privately; the person need not change it.
    if (!validPassword(body.password)) return response({ error: passwordRuleMessage }, 400);
    const { data: existing, error: existingError } = await database.from("staff_profiles")
      .select("auth_user_id").eq("username", username).maybeSingle();
    if (existingError) {
      console.error("Failed to check staff username", existingError);
      return response({ error: "帳號建立失敗" }, 503);
    }
    if (existing) return response({ error: "帳號名稱已被使用" }, 409);
    const { data: created, error: createError } = await database.auth.admin.createUser({
      email: `${username}@accounts.invalid`, password: body.password, email_confirm: true,
    });
    if (createError?.code === "email_exists") {
      // Recheck: another admin may have just created the same name, which is not a leftover.
      const { data: raced } = await database.from("staff_profiles")
        .select("auth_user_id").eq("username", username).maybeSingle();
      if (raced) return response({ error: "帳號名稱已被使用" }, 409);
      console.error("Auth user exists without staff profile", username);
      return response({ error: "帳號名稱已被使用；若名單中沒有此帳號，請聯絡維護人員清除" }, 409);
    }
    if (isWeakPassword(createError)) return response({ error: weakPasswordMessage }, 400);
    if (createError || !created.user) {
      console.error("Failed to create Auth user", createError);
      return response({ error: "帳號建立失敗" }, 503);
    }
    const { error: profileCreateError } = await database.rpc("staff_create_profile", {
      p_actor: profile.auth_user_id,
      p_user_id: created.user.id,
      p_username: username,
      p_display_name: displayName,
      p_role: body.role,
      p_district_id: null,
    });
    if (profileCreateError) {
      console.error("Failed to create staff profile", profileCreateError);
      const { error: rollbackError } = await database.auth.admin.deleteUser(created.user.id);
      if (rollbackError) {
        console.error("Failed to roll back Auth user; manual cleanup needed", created.user.id, rollbackError);
        return response({ error: "帳號建立失敗，且需由維護人員清除未完成的帳號" }, 503);
      }
      if (lostAccess(profileCreateError)) return lostAccessResponse();
      return response({ error: "帳號建立失敗" }, 503);
    }
    return response({ success: true }, 201);
  }

  if (body.action === "set_staff_password") {
    if (!isUuid(body.user_id)) return response({ error: "INVALID_REQUEST" }, 400);
    // Changing one's own password goes through change_password, which checks the current one.
    if (sameUser(body.user_id, profile.auth_user_id)) {
      return response({ error: "自己的密碼請用「更改密碼」修改" }, 400);
    }
    if (!validPassword(body.password)) return response({ error: passwordRuleMessage }, 400);
    // 1. The database checks the caller is an admin and the target is someone else. Its only change
    //    is marking an admin target to change the password, which is safe even if nothing follows.
    const { error: checkError } = await database.rpc("staff_check_password_set", {
      p_actor: profile.auth_user_id, p_user_id: body.user_id,
    });
    if (checkError) {
      if (lostAccess(checkError)) return lostAccessResponse();
      if (checkError.message?.includes("SELF_PASSWORD_SET")) return response({ error: "自己的密碼請用「更改密碼」修改" }, 400);
      if (checkError.message?.includes("STAFF_NOT_FOUND")) return response({ error: "找不到帳號" }, 404);
      console.error("Failed to check a staff password change", checkError);
      return response({ error: "密碼設定失敗" }, 503);
    }
    // 2. The password changes. A refused password leaves no logout and no audit of a change.
    const { error: setError } = await database.auth.admin.updateUserById(body.user_id, { password: body.password });
    if (setError) {
      if (isWeakPassword(setError)) return response({ error: weakPasswordMessage }, 400);
      console.error("Failed to set staff password", setError);
      return response({ error: "密碼設定失敗，請稍後再試" }, 503);
    }
    // 3. Old logins end and the change is audited. Setting the same password again repeats this.
    const { data: mustChange, error: markError } = await database.rpc("staff_mark_password_set", {
      p_actor: profile.auth_user_id, p_user_id: body.user_id,
    });
    if (markError) {
      if (lostAccess(markError)) return lostAccessResponse();
      console.error("Failed to end logins after setting a password", markError);
      return response({ error: "密碼已設定，但無法確認舊登入已失效，請再設定一次" }, 503);
    }
    return response({ success: true, must_change_password: mustChange === true });
  }

  if (body.action === "update_staff") {
    if (!isUuid(body.user_id)) return response({ error: "INVALID_REQUEST" }, 400);
    const username = String(body.username ?? "").toLowerCase();
    const displayName = String(body.display_name ?? "").trim();
    if (!validUsername(username) || !displayName || displayName.length > 100) {
      return response({ error: "請檢查帳號資料" }, 400);
    }
    const currentUsername = async () => {
      const { data, error } = await database.from("staff_profiles")
        .select("username").eq("auth_user_id", body.user_id).maybeSingle();
      if (error) throw error;
      return data?.username;
    };
    let before;
    try {
      before = await currentUsername();
    } catch (error) {
      console.error("Failed to load staff profile", error);
      return response({ error: "帳號更新失敗" }, 503);
    }
    if (before === undefined) return response({ error: "找不到帳號" }, 404);
    // The Auth login is username@accounts.invalid, so a new name changes it too.
    const renamed = before !== username;
    if (renamed) {
      const { error: emailError } = await database.auth.admin.updateUserById(body.user_id, {
        email: `${username}@accounts.invalid`, email_confirm: true,
      });
      if (emailError?.code === "email_exists") {
        const { data: owner, error: ownerError } = await database.from("staff_profiles")
          .select("auth_user_id").eq("username", username).maybeSingle();
        if (ownerError) {
          console.error("Failed to check staff username", ownerError);
          return response({ error: "帳號更新失敗" }, 503);
        }
        if (owner) return response({ error: "帳號名稱已被使用" }, 409);
        console.error("Auth user exists without staff profile", username);
        return response({ error: "帳號名稱已被使用；若名單中沒有此帳號，請聯絡維護人員清除" }, 409);
      }
      if (emailError) {
        console.error("Failed to rename Auth user", emailError);
        return response({ error: "帳號更新失敗" }, 503);
      }
    }
    const { error } = await database.rpc("staff_update_profile", {
      p_actor: profile.auth_user_id, p_user_id: body.user_id, p_username: username, p_display_name: displayName,
    });
    // The profile decides. Every save (not only a rename) compares the Auth login with the name the
    // profile holds now and fixes it if they differ, so saving again repairs a sync that failed or
    // lost a race with another admin's rename.
    {
      try {
        const settled = await currentUsername();
        const { data: authUser, error: authError } = await database.auth.admin.getUserById(body.user_id);
        if (authError) throw authError;
        if (settled && authUser.user?.email !== `${settled}@accounts.invalid`) {
          const { error: syncError } = await database.auth.admin.updateUserById(body.user_id, {
            email: `${settled}@accounts.invalid`, email_confirm: true,
          });
          if (syncError) throw syncError;
        }
      } catch (syncError) {
        console.error("Auth login may not match the staff profile; manual check needed", body.user_id, syncError);
        return response({ error: "帳號更新結果無法確認，請重新整理名單；若登入失敗請聯絡維護人員" }, 503);
      }
    }
    if (error) {
      if (lostAccess(error)) return lostAccessResponse();
      if (error.message?.includes("USERNAME_TAKEN")) return response({ error: "帳號名稱已被使用" }, 409);
      if (error.message?.includes("STAFF_NOT_FOUND")) return response({ error: "找不到帳號" }, 404);
      if (isInputError(error)) return response({ error: "請檢查帳號資料" }, 400);
      console.error("Failed to update staff profile", error);
      return response({ error: "帳號更新失敗" }, 503);
    }
    return response({ success: true });
  }

  if (body.action === "set_staff_active") {
    if (!isUuid(body.user_id) || typeof body.is_active !== "boolean") {
      return response({ error: "INVALID_REQUEST" }, 400);
    }
    const { error } = await database.rpc("staff_set_active", {
      p_actor: profile.auth_user_id, p_user_id: body.user_id, p_is_active: body.is_active,
    });
    if (error) {
      if (lostAccess(error)) return lostAccessResponse();
      if (error.message.includes("LAST_ACTIVE_ADMIN")) return response({ error: "不能停用最後一位管理員" }, 409);
      if (error.message.includes("STAFF_NOT_FOUND")) return response({ error: "找不到帳號" }, 404);
      console.error("Failed to change staff active state", error);
      return response({ error: "帳號狀態更新失敗" }, 503);
    }
    return response({ success: true });
  }

  return response({ error: "INVALID_ACTION" }, 400);
}

if (typeof Deno !== "undefined") {
  ({ createClient } = await import("npm:@supabase/supabase-js@2.118.0"));
  Deno.serve(handler);
}
