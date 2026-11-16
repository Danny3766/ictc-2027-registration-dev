-- 正式站發布：依檔名順序串接 supabase/migrations 在 202611070001 之後的 14 支 migration（202611090001～202611150001），包成單一交易。
-- 只在已套用 baseline_202611060003.sql 與 202611070001 的正式專案執行一次；測試專案已逐支套用，不得執行。
-- 不含正式站已套用的 202611070001。
-- 內容與逐支執行相同，只移除各檔自己的 begin; 與 commit;。任何一段失敗，整份回滾，正式資料維持原樣。
-- 執行前依 docs/正式環境setup.md 9-3 關閉登記；執行後依序部署 registration、staff Edge Function，再合併 develop → main。
-- 來源檔與 SHA-256（git 內存的 LF 內容，可用 git show HEAD:<檔案> | sha256sum 核對）：
--   202611090001_child_registration.sql  bc416dadcceb622b27dac36bc20904678f0b87fd1b959f4cac6f1271395389b5
--   202611090002_registration_identities.sql  9e22a05b3f354024674dc482cc4e1b22575cfd852e5f05f5afac0558edd59046
--   202611090003_independent_identity_prices.sql  33333ccd24f656f2a2407bfcf73238d985a86fa31a5d4f0a6f41ba003b6da416
--   202611100001_child_type.sql  af86da70181dbb9a66b607d35dbf6754ac9c36ec3d6cd20220d72778f3aa2794
--   202611100002_unified_identity.sql  cf7ad37fa3fc6abbbbe6daad3eb1bff996bab85b96b9b814ba6f89b5a6a30a2f
--   202611100003_identity_badges.sql  63b6ba2fcb2767746d3b287da2c62b68d1043c1b7675c4aee6b888fcc7ef43df
--   202611100004_hosting_general_only.sql  af73cd642b868309121a81f5a109ddb29548b91ba66f879253c7e21727018412
--   202611110001_staff_performance.sql  7c976c3cf238126e3036c988f23a990d1aa51461cc4a34a6883324b7249e4e1a
--   202611110002_conference_import_status.sql  7ce3df15759a19cad6fa2d4c2521a502fdb3e97b9f574474d20c95ee7227ccbb
--   202611110003_survey_identities.sql  440e01480bd6b27621d77d9360391b97432a1bb590b22d3771a6a8cf2bc3aa87
--   202611110004_identity_reorder.sql  9c97935b5c93a2c74a5c7cd35a3205533d03bea02d730d54c0e8c5c8f90a4738
--   202611130001_student_statistics_identity.sql  e44a44cab82da6df55ce8f81be08b8bfb4a3d76cac0ee44789c66a3562b86598
--   202611140001_student_identity_reserved.sql  eb6c073939f0b57b44e8ff07b8ae3d07695526a0e9cad4894713bfc75b5c8275
--   202611150001_identity_change_survey_no.sql  925731fae12dcc73b8e25450258186d040658cea5f257d2a297bf4b9ba7ea6e9

begin;

-- ===== 202611090001_child_registration.sql =====

-- 2026-11-09: 兒童報名. Decisions are in docs/需求討論與決策紀錄.md, section "2026-11-09 兒童報名".
-- Apply first, then deploy the registration and staff Edge Functions, then the site. Registration
-- can stay open throughout: an older Edge Function or page sends no child fields, so a new
-- registration is not a child and a saved one keeps what it has.
--   * registrations.is_child and parent_name (1～20 characters, required for a child only).
--     parent_name_key follows registration_name_key, so the back office finds the parent the way the
--     public lookup finds a person: same district, active registration, case and spaces ignored.
--   * A child answers neither 開家接待 nor 接機接待; both are stored as 否 whatever the switches say,
--     and a child is outside the hosting and pickup audiences (an activity: prerequisite still holds).
--   * The *_with_pickup wrappers take p_is_child and p_parent_name. On update, a request without
--     p_is_child keeps the stored child fields. Like meal_identity, a change to the child fields alone
--     needs no re-import; the 否 answers it brings do, like any hosting or pickup change.

alter table public.registrations
  add column is_child boolean not null default false,
  add column parent_name text,
  add column parent_name_key text generated always as
    (case when parent_name is null then null else public.registration_name_key(parent_name) end) stored,
  add constraint registrations_child_parent_name check (case when is_child
    then parent_name = btrim(parent_name) and length(parent_name) between 1 and 20
      and public.registration_name_key(parent_name) <> ''
    else parent_name is null end);

-- The back office looks up a page's parents by district and name; only active children count.
create index registrations_active_child_parent on public.registrations (district_id, parent_name_key)
  where record_status = 'active' and is_child;

-- The parent name to store: null when not a child, otherwise the trimmed name or INVALID_PARENT_NAME.
create function public.registration_parent_name(p_is_child boolean, p_parent_name text)
returns text language plpgsql immutable security invoker set search_path = '' as $$
begin
  if not coalesce(p_is_child, false) then return null; end if;
  if coalesce(length(btrim(p_parent_name)), 0) not between 1 and 20
    or public.registration_name_key(p_parent_name) = '' then
    raise exception using errcode = '22023', message = 'INVALID_PARENT_NAME';
  end if;
  return btrim(p_parent_name);
end;
$$;

-- The inner RPCs check audiences without knowing the registration is a child, so the wrappers mark a
-- child's save with this transaction-local setting and clear it when they finish.
create function public.registration_saving_child()
returns boolean language sql stable security invoker set search_path = '' as $$
  select coalesce(current_setting('registration.saving_child', true), '') = 'on';
$$;

-- Same as 202611050006, except a child is outside the hosting audience.
create or replace function public.registration_audience_valid(p_choices jsonb, p_hosting jsonb)
returns boolean language sql stable security invoker set search_path = '' as $$
  select public.registration_saving_child() or not exists (
    select 1 from jsonb_array_elements(p_choices) choice
    join public.activities activity on activity.id = (choice->>'activity_id')::bigint
    where activity.audience = 'hosting' and (choice->>'attending')::boolean
      and coalesce(p_hosting->>'status', '') not in ('hosting', 'family_registered')
  );
$$;

-- Same as 202611060002, except a child is outside the hosting and pickup audiences.
create or replace function public.registration_audience_valid(p_choices jsonb, p_hosting jsonb, p_pickup jsonb)
returns boolean language sql stable security invoker set search_path = '' as $$
  select not exists (
    select 1 from jsonb_array_elements(p_choices) choice
    join public.activities activity on activity.id = (choice->>'activity_id')::bigint
    where (choice->>'attending')::boolean and (
      (activity.audience = 'hosting' and not public.registration_saving_child()
        and coalesce(p_hosting->>'status', '') not in ('hosting', 'family_registered'))
      or (activity.audience = 'pickup' and not public.registration_saving_child()
        and coalesce(p_pickup->>'status', '') <> 'yes')
      or (activity.audience like 'activity:%' and not exists (
        select 1 from public.activities prerequisite
        join jsonb_array_elements(p_choices) required_choice
          on (required_choice->>'activity_id')::bigint = prerequisite.id
        where prerequisite.id = nullif(substring(activity.audience from 10), '')::bigint
          and prerequisite.is_published and (required_choice->>'attending')::boolean
      ))
    )
  );
$$;

-- Stores 否 for both surveys on a child's registration; true when either answer changed.
create function public.registration_child_answers_put(p_registration_id uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  v_hosting jsonb := public.registration_hosting_value('{"status": "not_hosting"}');
  v_pickup jsonb := public.registration_pickup_value('{"status": "no", "count": 0}');
  v_changed boolean := false;
begin
  if public.registration_hosting_get(p_registration_id) is distinct from v_hosting then
    perform public.registration_hosting_put(p_registration_id, v_hosting);
    v_changed := true;
  end if;
  if public.registration_pickup_get(p_registration_id) is distinct from v_pickup then
    perform public.registration_pickup_put(p_registration_id, v_pickup);
    v_changed := true;
  end if;
  return v_changed;
end;
$$;

-- Saves the child fields, and for a child the 否 answers, after an inner RPC saved the rest.
-- p_before is the registration as it was before that RPC. The audit's hosting and pickup are as this
-- function found and left them; a hosting answer the inner RPC changed is in its own audit.
create function public.registration_child_save(
  p_actor_type text, p_actor uuid, p_registration_id uuid, p_before public.registrations,
  p_is_child boolean, p_parent_name text
) returns void language plpgsql security invoker set search_path = '' as $$
declare v_hosting jsonb; v_pickup jsonb; v_fields_changed boolean; v_answers_changed boolean := false;
begin
  v_hosting := public.registration_hosting_get(p_registration_id);
  v_pickup := public.registration_pickup_get(p_registration_id);
  v_fields_changed := (p_before.is_child, p_before.parent_name) is distinct from (p_is_child, p_parent_name);
  if p_is_child then v_answers_changed := public.registration_child_answers_put(p_registration_id); end if;
  if not v_fields_changed and not v_answers_changed then return; end if;
  update public.registrations set is_child = p_is_child, parent_name = p_parent_name, updated_at = now(),
    import_status = case when v_answers_changed and import_status = 'imported' then 'reimport_needed'
      else import_status end
  where id = p_registration_id;
  insert into public.audit_events (actor_type, actor_user_id, action, target_type, target_id, before_data, after_data)
  values (p_actor_type, p_actor, 'registration.child_updated', 'registration', p_registration_id,
    jsonb_build_object('is_child', p_before.is_child, 'parent_name', p_before.parent_name,
      'hosting', v_hosting, 'pickup', v_pickup),
    jsonb_build_object('is_child', p_is_child, 'parent_name', p_parent_name,
      'hosting', public.registration_hosting_get(p_registration_id),
      'pickup', public.registration_pickup_get(p_registration_id)));
end;
$$;

-- New parameters change the signatures, so these are dropped and recreated (create or replace would
-- add overloads) and granted again below.
drop function public.create_registration_with_pickup(uuid, text, integer, jsonb, jsonb, text, jsonb);
drop function public.update_registration_with_pickup(text, integer, jsonb, jsonb, text, jsonb);
drop function public.staff_create_registration_with_pickup(uuid, uuid, text, integer, jsonb, jsonb, text, jsonb);
drop function public.staff_update_registration_with_pickup(uuid, uuid, text, integer, jsonb, jsonb, text, jsonb);

-- Same as 202611060002, plus the child fields. The inner RPC refuses a hosting answer while the
-- survey is closed and requires one while it is open, so a child sends 否 only while it is open.
create function public.create_registration_with_pickup(
  p_request_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_is_child boolean default false, p_parent_name text default null
) returns table (registration_id uuid, serial_no bigint)
language plpgsql security invoker set search_path = '' as $$
declare v_pickup jsonb; v_id uuid; v_serial bigint; v_open boolean; v_child boolean := coalesce(p_is_child, false);
  v_before public.registrations;
begin
  if v_child then
    perform set_config('registration.saving_child', 'on', true);
    p_hosting := case when (select is_hosting_open from public.site_settings where id)
      then '{"status": "not_hosting"}'::jsonb end;
  end if;
  select c.registration_id, c.serial_no into v_id, v_serial
  from public.create_registration(p_request_id, p_full_name, p_district_id, p_choices, p_hosting, p_meal_identity) c;
  if v_child then
    select * into v_before from public.registrations where id = v_id;
    perform public.registration_child_save('public', null, v_id, v_before, true,
      public.registration_parent_name(true, p_parent_name));
  else
    v_pickup := public.registration_pickup_value(p_pickup);
    select is_pickup_open into v_open from public.site_settings where id;
    if not v_open and v_pickup is not null then
      raise exception using errcode = 'P0001', message = 'PICKUP_CLOSED';
    end if;
    if v_open and v_pickup is null then
      raise exception using errcode = 'P0001', message = 'PICKUP_REQUIRED';
    end if;
    if v_pickup is not null then
      perform public.registration_pickup_put(v_id, v_pickup);
      insert into public.audit_events (actor_type, action, target_type, target_id, after_data)
      values ('public', 'registration.pickup_updated', 'registration', v_id, jsonb_build_object('pickup', v_pickup));
    end if;
  end if;
  if not public.registration_audience_valid(p_choices, public.registration_hosting_get(v_id),
    public.registration_pickup_get(v_id)) then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  perform set_config('registration.saving_child', '', true);
  return query select v_id, v_serial;
end;
$$;

-- Same as 202611060002, plus the child fields. p_is_child null (an older page or Edge Function)
-- keeps the stored child fields. The row is locked first so they cannot change under this save.
create function public.update_registration_with_pickup(
  p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_is_child boolean default null, p_parent_name text default null
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_id uuid; v_before jsonb; v_after jsonb; v_open boolean; v_registration public.registrations;
  v_child boolean;
begin
  select * into v_registration from public.registrations
  where district_id = p_district_id and name_key = public.registration_name_key(p_full_name)
    and record_status = 'active'
  for update;
  v_child := coalesce(p_is_child, v_registration.is_child, false);
  if v_child then
    perform set_config('registration.saving_child', 'on', true);
    p_hosting := case when (select is_hosting_open from public.site_settings where id)
      then '{"status": "not_hosting"}'::jsonb end;
  end if;
  if not public.update_registration(p_full_name, p_district_id, p_choices, p_hosting, p_meal_identity) then
    perform set_config('registration.saving_child', '', true);
    return false;
  end if;
  v_id := v_registration.id;
  if v_child then
    perform public.registration_child_save('public', null, v_id, v_registration, true,
      case when p_is_child is null then v_registration.parent_name
        else public.registration_parent_name(true, p_parent_name) end);
  else
    perform public.registration_child_save('public', null, v_id, v_registration, false, null);
    select is_pickup_open into v_open from public.site_settings where id;
    v_before := public.registration_pickup_get(v_id);
    v_after := public.registration_pickup_value(p_pickup);
    if not v_open and v_after is not null and v_after is distinct from v_before then
      raise exception using errcode = 'P0001', message = 'PICKUP_CLOSED';
    end if;
    if v_open and coalesce(v_after, v_before) is null then
      raise exception using errcode = 'P0001', message = 'PICKUP_REQUIRED';
    end if;
    if v_open and v_after is not null and v_after is distinct from v_before then
      perform public.registration_pickup_put(v_id, v_after);
      update public.registrations set updated_at = now(),
        import_status = case when import_status = 'imported' then 'reimport_needed' else import_status end
      where id = v_id;
      insert into public.audit_events (actor_type, action, target_type, target_id, before_data, after_data)
      values ('public', 'registration.pickup_updated', 'registration', v_id,
        jsonb_build_object('pickup', v_before), jsonb_build_object('pickup', v_after));
    end if;
  end if;
  if not public.registration_audience_valid(p_choices, public.registration_hosting_get(v_id),
    public.registration_pickup_get(v_id)) then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  perform set_config('registration.saving_child', '', true);
  return true;
end;
$$;

-- Same as 202611060002, plus the child fields. Staff answer hosting whether or not it is open.
create function public.staff_create_registration_with_pickup(
  p_actor uuid, p_request_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_is_child boolean default false, p_parent_name text default null
) returns table (registration_id uuid, serial_no bigint)
language plpgsql security invoker set search_path = '' as $$
declare v_pickup jsonb; v_id uuid; v_serial bigint; v_child boolean := coalesce(p_is_child, false);
  v_before public.registrations;
begin
  if v_child then
    perform set_config('registration.saving_child', 'on', true);
    p_hosting := '{"status": "not_hosting"}';
  end if;
  select c.registration_id, c.serial_no into v_id, v_serial
  from public.staff_create_registration(p_actor, p_request_id, p_full_name,
    p_district_id, p_choices, p_hosting, p_meal_identity) c;
  if v_child then
    select * into v_before from public.registrations where id = v_id;
    perform public.registration_child_save('staff', p_actor, v_id, v_before, true,
      public.registration_parent_name(true, p_parent_name));
  else
    v_pickup := public.registration_pickup_value(p_pickup);
    if v_pickup is null and coalesce((select is_pickup_open from public.site_settings where id), false) then
      raise exception using errcode = 'P0001', message = 'PICKUP_REQUIRED';
    end if;
    if v_pickup is not null then
      perform public.registration_pickup_put(v_id, v_pickup);
      insert into public.audit_events (actor_type, actor_user_id, action, target_type, target_id, after_data)
      values ('staff', p_actor, 'registration.pickup_updated', 'registration', v_id, jsonb_build_object('pickup', v_pickup));
    end if;
  end if;
  if not public.registration_audience_valid(p_choices, public.registration_hosting_get(v_id),
    public.registration_pickup_get(v_id)) then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  perform set_config('registration.saving_child', '', true);
  return query select v_id, v_serial;
end;
$$;

-- Same as 202611060002, plus the child fields; p_is_child null keeps the stored ones.
create function public.staff_update_registration_with_pickup(
  p_actor uuid, p_registration_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_is_child boolean default null, p_parent_name text default null
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_before jsonb; v_after jsonb; v_registration public.registrations; v_child boolean;
begin
  select * into v_registration from public.registrations
  where id = p_registration_id and record_status = 'active' for update;
  v_child := coalesce(p_is_child, v_registration.is_child, false);
  if v_child then
    perform set_config('registration.saving_child', 'on', true);
    p_hosting := '{"status": "not_hosting"}';
  end if;
  if not public.staff_update_registration(p_actor, p_registration_id, p_full_name,
    p_district_id, p_choices, p_hosting, p_meal_identity) then
    perform set_config('registration.saving_child', '', true);
    return false;
  end if;
  if v_child then
    perform public.registration_child_save('staff', p_actor, p_registration_id, v_registration, true,
      case when p_is_child is null then v_registration.parent_name
        else public.registration_parent_name(true, p_parent_name) end);
  else
    perform public.registration_child_save('staff', p_actor, p_registration_id, v_registration, false, null);
    v_before := public.registration_pickup_get(p_registration_id);
    v_after := public.registration_pickup_value(p_pickup);
    if v_after is not null and v_after is distinct from v_before then
      perform public.registration_pickup_put(p_registration_id, v_after);
      update public.registrations set updated_at = now(),
        import_status = case when import_status = 'imported' then 'reimport_needed' else import_status end
      where id = p_registration_id;
      insert into public.audit_events (actor_type, actor_user_id, action, target_type, target_id, before_data, after_data)
      values ('staff', p_actor, 'registration.pickup_updated', 'registration', p_registration_id,
        jsonb_build_object('pickup', v_before), jsonb_build_object('pickup', v_after));
    end if;
  end if;
  if not public.registration_audience_valid(p_choices, public.registration_hosting_get(p_registration_id),
    public.registration_pickup_get(p_registration_id)) then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  perform set_config('registration.saving_child', '', true);
  return true;
end;
$$;

-- The public lookup's child fields, beside get_registration and get_registration_pickup.
create function public.get_registration_child(p_full_name text, p_district_id integer)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_child jsonb;
begin
  if not exists (select 1 from public.site_settings where id and is_lookup_open) then
    raise exception using errcode = 'P0001', message = 'LOOKUP_CLOSED';
  end if;
  select jsonb_build_object('is_child', r.is_child, 'parent_name', r.parent_name) into v_child
  from public.registrations r
  where r.district_id = p_district_id and r.name_key = public.registration_name_key(p_full_name)
    and r.record_status = 'active';
  return v_child;
end;
$$;

-- The active children whose parent name matches one of p_parents ([{district_id, name_key}]),
-- for the back office's 親子 column. Uses registrations_active_child_parent.
create function public.registration_children(p_parents jsonb)
returns table (district_id integer, parent_name_key text, serial_no bigint)
language sql stable security invoker set search_path = '' as $$
  select child.district_id, child.parent_name_key, child.serial_no
  from jsonb_to_recordset(p_parents) parent(district_id integer, name_key text)
  join public.registrations child on child.district_id = parent.district_id
    and child.parent_name_key = parent.name_key
  where child.record_status = 'active' and child.is_child
  order by child.serial_no;
$$;

revoke execute on function public.registration_parent_name(boolean, text), public.registration_saving_child(),
  public.registration_child_answers_put(uuid),
  public.registration_child_save(text, uuid, uuid, public.registrations, boolean, text),
  public.create_registration_with_pickup(uuid, text, integer, jsonb, jsonb, text, jsonb, boolean, text),
  public.update_registration_with_pickup(text, integer, jsonb, jsonb, text, jsonb, boolean, text),
  public.staff_create_registration_with_pickup(uuid, uuid, text, integer, jsonb, jsonb, text, jsonb, boolean, text),
  public.staff_update_registration_with_pickup(uuid, uuid, text, integer, jsonb, jsonb, text, jsonb, boolean, text),
  public.get_registration_child(text, integer), public.registration_children(jsonb)
  from public, anon, authenticated;
grant execute on function public.registration_parent_name(boolean, text), public.registration_saving_child(),
  public.registration_child_answers_put(uuid),
  public.registration_child_save(text, uuid, uuid, public.registrations, boolean, text),
  public.create_registration_with_pickup(uuid, text, integer, jsonb, jsonb, text, jsonb, boolean, text),
  public.update_registration_with_pickup(text, integer, jsonb, jsonb, text, jsonb, boolean, text),
  public.staff_create_registration_with_pickup(uuid, uuid, text, integer, jsonb, jsonb, text, jsonb, boolean, text),
  public.staff_update_registration_with_pickup(uuid, uuid, text, integer, jsonb, jsonb, text, jsonb, boolean, text),
  public.get_registration_child(text, integer), public.registration_children(jsonb)
  to service_role;


-- ===== 202611090002_registration_identities.sql =====

-- 2026-11-09: 用餐身分管理. Rules are in docs/用餐身分管理.md.
-- Apply after 202611090001, during the maintenance window of docs/正式環境setup.md 9-3 (registration
-- closed): an older page asks for the identity only on student-priced meals, and this requires one on
-- every attended published meal. Then deploy the registration and staff Edge Functions, then the site.
--   * registration_identities: stable codes with an editable name. general and child are reserved;
--     child is stored for every child and never chosen by an adult. An identity not public_selectable
--     is set only by staff (the staff wrappers turn on registration.staff_identity).
--   * activity_identity_prices: a price per activity and identity; a missing one is unset (the general
--     price is activities.fee_amount; 202611090003 lets each be set alone). The student prices move here; the staff page still sends student_fee_amount with the
--     student price, so the column stays in step for older readers.
--   * Every save stores an identity from now on. Existing children become child; a registration
--     without one keeps it empty, since the older page never asked.

create table public.registration_identities (
  code text primary key check (code ~ '^[a-z][a-z0-9_-]{0,63}$'),
  name text not null unique check (name = btrim(name) and length(name) between 1 and 30),
  is_active boolean not null default true,
  public_selectable boolean not null default true,
  sort_order integer not null default 0,
  constraint registration_identities_reserved check (code not in ('general', 'child') or (is_active and public_selectable))
);
insert into public.registration_identities (code, name, sort_order)
values ('general', '一般', 0), ('student', '學生', 1), ('child', '兒童', 2);

create table public.activity_identity_prices (
  activity_id bigint references public.activities (id) on delete cascade,
  identity_code text references public.registration_identities (code) on delete cascade
    check (identity_code <> 'general'),
  fee_amount integer not null check (fee_amount >= 0),
  primary key (activity_id, identity_code)
);
insert into public.activity_identity_prices (activity_id, identity_code, fee_amount)
select id, 'student', student_fee_amount from public.activities where student_fee_amount is not null;

alter table public.registration_identities enable row level security;
alter table public.activity_identity_prices enable row level security;
revoke all on public.registration_identities, public.activity_identity_prices from anon, authenticated;
grant all on public.registration_identities, public.activity_identity_prices to service_role;

alter table public.registrations drop constraint registrations_meal_identity;
update public.registrations set meal_identity = 'child' where is_child;
alter table public.registrations add constraint registrations_meal_identity_fk
  foreign key (meal_identity) references public.registration_identities (code);

-- The identity to store: child while saving a child; otherwise the one sent, else p_stored, else
-- general. Attending a published meal with neither sent nor stored is MEAL_IDENTITY_REQUIRED. A new
-- choice must be active, and public_selectable unless staff save it; the stored one is always kept.
create or replace function public.registration_meal_identity(p_choices jsonb, p_identity text, p_stored text default null)
returns text language plpgsql security invoker set search_path = '' as $$
declare v_child boolean := public.registration_saving_child(); v_code text; v_identity public.registration_identities;
begin
  if v_child then
    v_code := 'child';
  else
    if p_identity is null and p_stored is null and exists (
      select 1 from jsonb_array_elements(p_choices) choice
      join public.activities activity on activity.id = (choice->>'activity_id')::bigint
      where activity.is_published and activity.category = 'meal' and (choice->>'attending')::boolean
    ) then
      raise exception using errcode = 'P0001', message = 'MEAL_IDENTITY_REQUIRED';
    end if;
    -- A former child's stored identity falls back to general.
    v_code := coalesce(p_identity, nullif(p_stored, 'child'), 'general');
    if v_code = 'child' then
      raise exception using errcode = '22023', message = 'INVALID_MEAL_IDENTITY';
    end if;
  end if;
  select * into v_identity from public.registration_identities where code = v_code for share;
  if not found or (v_code is distinct from p_stored and (not v_identity.is_active
      or (not v_identity.public_selectable
        and coalesce(current_setting('registration.staff_identity', true), '') <> 'on'))) then
    raise exception using errcode = '22023', message = 'INVALID_MEAL_IDENTITY';
  end if;
  return v_code;
end;
$$;

-- The activity part stays in the renamed function; this adds the identity kinds and the activity's
-- identity_prices (an activity saved without the key, from an older page, keeps its prices).
alter function public.staff_save_reference(uuid, text, jsonb) rename to staff_save_reference_before_identities;
create function public.staff_save_reference(p_actor uuid, p_kind text, p_data jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_before jsonb; v_after jsonb; v_prices jsonb; v_code text; v_activity bigint;
begin
  perform public.staff_assert_actor(p_actor, true);
  if p_kind in ('identity', 'delete_identity') then
    v_code := nullif(p_data->>'code', '');
    if v_code is not null then
      select to_jsonb(i) into v_before from public.registration_identities i where code = v_code for update;
      if v_before is null then
        raise exception using errcode = '22023', message = 'REFERENCE_NOT_FOUND';
      end if;
    end if;
    if p_kind = 'delete_identity' then
      if v_code is null or v_code in ('general', 'child')
        or exists (select 1 from public.registrations where meal_identity = v_code) then
        raise exception using errcode = '22023', message = 'IDENTITY_IN_USE';
      end if;
      delete from public.registration_identities where code = v_code;
      insert into public.audit_events (actor_type, actor_user_id, action, target_type, before_data)
      values ('admin', p_actor, 'reference.deleted', 'identity', v_before);
      return v_before;
    end if;
    if v_code is null then
      insert into public.registration_identities (code, name, is_active, public_selectable, sort_order)
      values ('identity_' || replace(gen_random_uuid()::text, '-', ''), btrim(p_data->>'name'),
        (p_data->>'is_active')::boolean, (p_data->>'public_selectable')::boolean,
        (select coalesce(max(sort_order), 0) + 1 from public.registration_identities))
      returning to_jsonb(registration_identities.*) into v_after;
    else
      update public.registration_identities set name = btrim(p_data->>'name'),
        is_active = (p_data->>'is_active')::boolean, public_selectable = (p_data->>'public_selectable')::boolean
      where code = v_code returning to_jsonb(registration_identities.*) into v_after;
    end if;
    if v_before is distinct from v_after then
      insert into public.audit_events (actor_type, actor_user_id, action, target_type, before_data, after_data)
      values ('admin', p_actor, 'reference.saved', 'identity', v_before, v_after);
    end if;
    return v_after;
  end if;

  v_after := public.staff_save_reference_before_identities(p_actor, p_kind, p_data);
  if p_kind = 'activity' and p_data ? 'identity_prices' then
    if jsonb_typeof(p_data->'identity_prices') <> 'array' then
      raise exception using errcode = '22023', message = 'INVALID_REFERENCE_DATA';
    end if;
    v_activity := (v_after->>'id')::bigint;
    select coalesce(jsonb_agg(jsonb_build_object('identity_code', identity_code, 'fee_amount', fee_amount)
      order by identity_code), '[]'::jsonb) into v_before
    from public.activity_identity_prices where activity_id = v_activity;
    delete from public.activity_identity_prices where activity_id = v_activity;
    insert into public.activity_identity_prices (activity_id, identity_code, fee_amount)
    select v_activity, price->>'identity_code', (price->>'fee_amount')::integer
    from jsonb_array_elements(p_data->'identity_prices') price;
    select coalesce(jsonb_agg(jsonb_build_object('identity_code', identity_code, 'fee_amount', fee_amount)
      order by identity_code), '[]'::jsonb) into v_prices
    from public.activity_identity_prices where activity_id = v_activity;
    if v_before is distinct from v_prices then
      insert into public.audit_events (actor_type, actor_user_id, action, target_type, before_data, after_data)
      values ('admin', p_actor, 'reference.saved', 'activity_identity_prices',
        jsonb_build_object('activity_id', v_activity, 'identity_prices', v_before),
        jsonb_build_object('activity_id', v_activity, 'identity_prices', v_prices));
    end if;
  end if;
  return v_after;
end;
$$;
revoke all on function public.staff_save_reference(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.staff_save_reference(uuid, text, jsonb) to service_role;

-- Same as 202611090001, plus registration.staff_identity, so staff may set an identity that is not
-- public_selectable.
create or replace function public.staff_create_registration_with_pickup(
  p_actor uuid, p_request_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_is_child boolean default false, p_parent_name text default null
) returns table (registration_id uuid, serial_no bigint)
language plpgsql security invoker set search_path = '' as $$
declare v_pickup jsonb; v_id uuid; v_serial bigint; v_child boolean := coalesce(p_is_child, false);
  v_before public.registrations;
begin
  perform public.staff_assert_actor(p_actor, false);
  perform set_config('registration.staff_identity', 'on', true);
  if v_child then
    perform set_config('registration.saving_child', 'on', true);
    p_hosting := '{"status": "not_hosting"}';
  end if;
  select c.registration_id, c.serial_no into v_id, v_serial
  from public.staff_create_registration(p_actor, p_request_id, p_full_name,
    p_district_id, p_choices, p_hosting, p_meal_identity) c;
  if v_child then
    select * into v_before from public.registrations where id = v_id;
    perform public.registration_child_save('staff', p_actor, v_id, v_before, true,
      public.registration_parent_name(true, p_parent_name));
  else
    v_pickup := public.registration_pickup_value(p_pickup);
    if v_pickup is null and coalesce((select is_pickup_open from public.site_settings where id), false) then
      raise exception using errcode = 'P0001', message = 'PICKUP_REQUIRED';
    end if;
    if v_pickup is not null then
      perform public.registration_pickup_put(v_id, v_pickup);
      insert into public.audit_events (actor_type, actor_user_id, action, target_type, target_id, after_data)
      values ('staff', p_actor, 'registration.pickup_updated', 'registration', v_id, jsonb_build_object('pickup', v_pickup));
    end if;
  end if;
  if not public.registration_audience_valid(p_choices, public.registration_hosting_get(v_id),
    public.registration_pickup_get(v_id)) then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  perform set_config('registration.staff_identity', '', true);
  perform set_config('registration.saving_child', '', true);
  return query select v_id, v_serial;
end;
$$;

-- Same as 202611090001, plus registration.staff_identity.
create or replace function public.staff_update_registration_with_pickup(
  p_actor uuid, p_registration_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_is_child boolean default null, p_parent_name text default null
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_before jsonb; v_after jsonb; v_registration public.registrations; v_child boolean;
begin
  perform public.staff_assert_actor(p_actor, false);
  perform set_config('registration.staff_identity', 'on', true);
  select * into v_registration from public.registrations
  where id = p_registration_id and record_status = 'active' for update;
  v_child := coalesce(p_is_child, v_registration.is_child, false);
  if v_child then
    perform set_config('registration.saving_child', 'on', true);
    p_hosting := '{"status": "not_hosting"}';
  end if;
  if not public.staff_update_registration(p_actor, p_registration_id, p_full_name,
    p_district_id, p_choices, p_hosting, p_meal_identity) then
    perform set_config('registration.staff_identity', '', true);
    perform set_config('registration.saving_child', '', true);
    return false;
  end if;
  if v_child then
    perform public.registration_child_save('staff', p_actor, p_registration_id, v_registration, true,
      case when p_is_child is null then v_registration.parent_name
        else public.registration_parent_name(true, p_parent_name) end);
  else
    perform public.registration_child_save('staff', p_actor, p_registration_id, v_registration, false, null);
    v_before := public.registration_pickup_get(p_registration_id);
    v_after := public.registration_pickup_value(p_pickup);
    if v_after is not null and v_after is distinct from v_before then
      perform public.registration_pickup_put(p_registration_id, v_after);
      update public.registrations set updated_at = now(),
        import_status = case when import_status = 'imported' then 'reimport_needed' else import_status end
      where id = p_registration_id;
      insert into public.audit_events (actor_type, actor_user_id, action, target_type, target_id, before_data, after_data)
      values ('staff', p_actor, 'registration.pickup_updated', 'registration', p_registration_id,
        jsonb_build_object('pickup', v_before), jsonb_build_object('pickup', v_after));
    end if;
  end if;
  if not public.registration_audience_valid(p_choices, public.registration_hosting_get(p_registration_id),
    public.registration_pickup_get(p_registration_id)) then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  perform set_config('registration.staff_identity', '', true);
  perform set_config('registration.saving_child', '', true);
  return true;
end;
$$;


-- ===== 202611090003_independent_identity_prices.sql =====

-- 2026-11-09: 各身分價格獨立. Rules are in docs/用餐身分管理.md, section "空白價格與合計".
-- Apply right after 202611090002; no Edge Function change. Every identity is priced on its own: a blank
-- price is unset, never the general price, so a student price no longer needs a general one.
alter table public.activities drop constraint if exists activities_student_fee_needs_fee;

-- ===== 202611100001_child_type.sql =====

-- Child types: apply after 202611090003 with registration closed.
-- Then deploy registration/staff Edge Functions and the site together.
alter table public.registrations add column child_type text;
update public.registrations set child_type = 'elementary' where is_child;
alter table public.registrations add constraint registrations_child_type check
  (child_type in ('preschool', 'elementary') and is_child = (child_type is not null));
alter table public.registration_identities drop constraint registration_identities_reserved;
alter table public.registration_identities add constraint registration_identities_reserved check
  (code not in ('general','child','preschool') or (is_active and public_selectable));
update public.registration_identities set name = '兒童（國小）' where code = 'child';
insert into public.registration_identities(code,name,sort_order) values ('preschool','兒童（學齡前）',3);
create function public.registration_identity_delete_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.code in ('general','child','preschool') then
    raise exception using errcode = '22023', message = 'IDENTITY_IN_USE';
  end if;
  return old;
end;
$$;
create trigger registration_identity_delete_guard before delete on public.registration_identities
for each row execute function public.registration_identity_delete_guard();
create function public.registration_child_type(p_type text) returns text
language plpgsql immutable set search_path = '' as $$
begin
  if p_type is not null and p_type not in ('','preschool','elementary') then
    raise exception using errcode = '22023', message = 'INVALID_CHILD_TYPE';
  end if;
  return nullif(p_type,'');
end;
$$;
create or replace function public.registration_saving_child() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(current_setting('registration.saving_child',true),'') <> '';
$$;
create or replace function public.registration_meal_identity(p_choices jsonb, p_identity text, p_stored text default null)
returns text language plpgsql security invoker set search_path = '' as $$
declare v_child boolean := public.registration_saving_child(); v_code text; v_identity public.registration_identities;
begin
  if v_child then
    v_code := case when current_setting('registration.saving_child',true) = 'preschool' then 'preschool' else 'child' end;
  else
    if p_identity is null and p_stored is null and exists (
      select 1 from jsonb_array_elements(p_choices) choice
      join public.activities activity on activity.id = (choice->>'activity_id')::bigint
      where activity.is_published and activity.category = 'meal' and (choice->>'attending')::boolean
    ) then
      raise exception using errcode = 'P0001', message = 'MEAL_IDENTITY_REQUIRED';
    end if;
    -- A former child's stored identity falls back to general.
    v_code := coalesce(p_identity, case when p_stored not in ('child','preschool') then p_stored end, 'general');
    if v_code in ('child','preschool') then
      raise exception using errcode = '22023', message = 'INVALID_MEAL_IDENTITY';
    end if;
  end if;
  select * into v_identity from public.registration_identities where code = v_code for share;
  if not found or (v_code is distinct from p_stored and (not v_identity.is_active
      or (not v_identity.public_selectable
        and coalesce(current_setting('registration.staff_identity', true), '') <> 'on'))) then
    raise exception using errcode = '22023', message = 'INVALID_MEAL_IDENTITY';
  end if;
  return v_code;
end;
$$;
drop function public.registration_child_save(text,uuid,uuid,public.registrations,boolean,text);
create function public.registration_child_save(
  p_actor_type text, p_actor uuid, p_registration_id uuid, p_before public.registrations,
  p_child_type text, p_parent_name text
) returns void language plpgsql security invoker set search_path = '' as $$
declare v_is_child boolean := p_child_type is not null; v_hosting jsonb; v_pickup jsonb; v_fields_changed boolean; v_answers_changed boolean := false;
begin
  v_hosting := public.registration_hosting_get(p_registration_id);
  v_pickup := public.registration_pickup_get(p_registration_id);
  v_fields_changed := (p_before.child_type, p_before.parent_name) is distinct from (p_child_type, p_parent_name);
  if v_is_child then v_answers_changed := public.registration_child_answers_put(p_registration_id); end if;
  if not v_fields_changed and not v_answers_changed then return; end if;
  update public.registrations set child_type = p_child_type, is_child = v_is_child, parent_name = p_parent_name, updated_at = now(),
    import_status = case when (v_answers_changed or p_before.child_type is distinct from p_child_type) and import_status = 'imported' then 'reimport_needed'
      else import_status end
  where id = p_registration_id;
  insert into public.audit_events (actor_type, actor_user_id, action, target_type, target_id, before_data, after_data)
  values (p_actor_type, p_actor, 'registration.child_updated', 'registration', p_registration_id,
    jsonb_build_object('child_type', p_before.child_type, 'is_child', p_before.is_child, 'parent_name', p_before.parent_name,
      'hosting', v_hosting, 'pickup', v_pickup),
    jsonb_build_object('child_type', p_child_type, 'is_child', v_is_child, 'parent_name', p_parent_name,
      'hosting', public.registration_hosting_get(p_registration_id),
      'pickup', public.registration_pickup_get(p_registration_id)));
end;
$$;
drop function public.create_registration_with_pickup(uuid,text,integer,jsonb,jsonb,text,jsonb,boolean,text);
create function public.create_registration_with_pickup(
  p_request_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_child_type text default '', p_parent_name text default null
) returns table (registration_id uuid, serial_no bigint)
language plpgsql security invoker set search_path = '' as $$
declare v_pickup jsonb; v_id uuid; v_serial bigint; v_open boolean; v_type text := public.registration_child_type(p_child_type); v_child boolean := v_type is not null;
  v_before public.registrations;
begin
  if v_child then
    perform set_config('registration.saving_child', v_type, true);
    p_hosting := case when (select is_hosting_open from public.site_settings where id)
      then '{"status": "not_hosting"}'::jsonb end;
  end if;
  select c.registration_id, c.serial_no into v_id, v_serial
  from public.create_registration(p_request_id, p_full_name, p_district_id, p_choices, p_hosting, p_meal_identity) c;
  if v_child then
    select * into v_before from public.registrations where id = v_id;
    perform public.registration_child_save('public', null, v_id, v_before, v_type,
      public.registration_parent_name(true, p_parent_name));
  else
    v_pickup := public.registration_pickup_value(p_pickup);
    select is_pickup_open into v_open from public.site_settings where id;
    if not v_open and v_pickup is not null then
      raise exception using errcode = 'P0001', message = 'PICKUP_CLOSED';
    end if;
    if v_open and v_pickup is null then
      raise exception using errcode = 'P0001', message = 'PICKUP_REQUIRED';
    end if;
    if v_pickup is not null then
      perform public.registration_pickup_put(v_id, v_pickup);
      insert into public.audit_events (actor_type, action, target_type, target_id, after_data)
      values ('public', 'registration.pickup_updated', 'registration', v_id, jsonb_build_object('pickup', v_pickup));
    end if;
  end if;
  if not public.registration_audience_valid(p_choices, public.registration_hosting_get(v_id),
    public.registration_pickup_get(v_id)) then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  perform set_config('registration.saving_child', '', true);
  return query select v_id, v_serial;
end;
$$;
revoke all on function public.create_registration_with_pickup(uuid,text,integer,jsonb,jsonb,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.create_registration_with_pickup(uuid,text,integer,jsonb,jsonb,text,jsonb,text,text) to service_role;
drop function public.update_registration_with_pickup(text,integer,jsonb,jsonb,text,jsonb,boolean,text);
create function public.update_registration_with_pickup(
  p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_child_type text default null, p_parent_name text default null
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_id uuid; v_before jsonb; v_after jsonb; v_open boolean; v_registration public.registrations;
  v_child boolean; v_type text;
begin
  select * into v_registration from public.registrations
  where district_id = p_district_id and name_key = public.registration_name_key(p_full_name)
    and record_status = 'active'
  for update;
  v_type := public.registration_child_type(coalesce(p_child_type, v_registration.child_type));
  v_child := v_type is not null;
  if v_child then
    perform set_config('registration.saving_child', v_type, true);
    p_hosting := case when (select is_hosting_open from public.site_settings where id)
      then '{"status": "not_hosting"}'::jsonb end;
  end if;
  if not public.update_registration(p_full_name, p_district_id, p_choices, p_hosting, p_meal_identity) then
    perform set_config('registration.saving_child', '', true);
    return false;
  end if;
  v_id := v_registration.id;
  if v_child then
    perform public.registration_child_save('public', null, v_id, v_registration, v_type,
      case when p_child_type is null then v_registration.parent_name
        else public.registration_parent_name(true, p_parent_name) end);
  else
    perform public.registration_child_save('public', null, v_id, v_registration, null, null);
    select is_pickup_open into v_open from public.site_settings where id;
    v_before := public.registration_pickup_get(v_id);
    v_after := public.registration_pickup_value(p_pickup);
    if not v_open and v_after is not null and v_after is distinct from v_before then
      raise exception using errcode = 'P0001', message = 'PICKUP_CLOSED';
    end if;
    if v_open and coalesce(v_after, v_before) is null then
      raise exception using errcode = 'P0001', message = 'PICKUP_REQUIRED';
    end if;
    if v_open and v_after is not null and v_after is distinct from v_before then
      perform public.registration_pickup_put(v_id, v_after);
      update public.registrations set updated_at = now(),
        import_status = case when import_status = 'imported' then 'reimport_needed' else import_status end
      where id = v_id;
      insert into public.audit_events (actor_type, action, target_type, target_id, before_data, after_data)
      values ('public', 'registration.pickup_updated', 'registration', v_id,
        jsonb_build_object('pickup', v_before), jsonb_build_object('pickup', v_after));
    end if;
  end if;
  if not public.registration_audience_valid(p_choices, public.registration_hosting_get(v_id),
    public.registration_pickup_get(v_id)) then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  perform set_config('registration.saving_child', '', true);
  return true;
end;
$$;
revoke all on function public.update_registration_with_pickup(text,integer,jsonb,jsonb,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.update_registration_with_pickup(text,integer,jsonb,jsonb,text,jsonb,text,text) to service_role;
drop function public.staff_create_registration_with_pickup(uuid,uuid,text,integer,jsonb,jsonb,text,jsonb,boolean,text);
create function public.staff_create_registration_with_pickup(
  p_actor uuid, p_request_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_child_type text default '', p_parent_name text default null
) returns table (registration_id uuid, serial_no bigint)
language plpgsql security invoker set search_path = '' as $$
declare v_pickup jsonb; v_id uuid; v_serial bigint; v_type text := public.registration_child_type(p_child_type); v_child boolean := v_type is not null;
  v_before public.registrations;
begin
  perform public.staff_assert_actor(p_actor, false);
  perform set_config('registration.staff_identity', 'on', true);
  if v_child then
    perform set_config('registration.saving_child', v_type, true);
    p_hosting := '{"status": "not_hosting"}';
  end if;
  select c.registration_id, c.serial_no into v_id, v_serial
  from public.staff_create_registration(p_actor, p_request_id, p_full_name,
    p_district_id, p_choices, p_hosting, p_meal_identity) c;
  if v_child then
    select * into v_before from public.registrations where id = v_id;
    perform public.registration_child_save('staff', p_actor, v_id, v_before, v_type,
      public.registration_parent_name(true, p_parent_name));
  else
    v_pickup := public.registration_pickup_value(p_pickup);
    if v_pickup is null and coalesce((select is_pickup_open from public.site_settings where id), false) then
      raise exception using errcode = 'P0001', message = 'PICKUP_REQUIRED';
    end if;
    if v_pickup is not null then
      perform public.registration_pickup_put(v_id, v_pickup);
      insert into public.audit_events (actor_type, actor_user_id, action, target_type, target_id, after_data)
      values ('staff', p_actor, 'registration.pickup_updated', 'registration', v_id, jsonb_build_object('pickup', v_pickup));
    end if;
  end if;
  if not public.registration_audience_valid(p_choices, public.registration_hosting_get(v_id),
    public.registration_pickup_get(v_id)) then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  perform set_config('registration.staff_identity', '', true);
  perform set_config('registration.saving_child', '', true);
  return query select v_id, v_serial;
end;
$$;
revoke all on function public.staff_create_registration_with_pickup(uuid,uuid,text,integer,jsonb,jsonb,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.staff_create_registration_with_pickup(uuid,uuid,text,integer,jsonb,jsonb,text,jsonb,text,text) to service_role;
drop function public.staff_update_registration_with_pickup(uuid,uuid,text,integer,jsonb,jsonb,text,jsonb,boolean,text);
create function public.staff_update_registration_with_pickup(
  p_actor uuid, p_registration_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_child_type text default null, p_parent_name text default null
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_before jsonb; v_after jsonb; v_registration public.registrations; v_child boolean; v_type text;
begin
  perform public.staff_assert_actor(p_actor, false);
  perform set_config('registration.staff_identity', 'on', true);
  select * into v_registration from public.registrations
  where id = p_registration_id and record_status = 'active' for update;
  v_type := public.registration_child_type(coalesce(p_child_type, v_registration.child_type));
  v_child := v_type is not null;
  if v_child then
    perform set_config('registration.saving_child', v_type, true);
    p_hosting := '{"status": "not_hosting"}';
  end if;
  if not public.staff_update_registration(p_actor, p_registration_id, p_full_name,
    p_district_id, p_choices, p_hosting, p_meal_identity) then
    perform set_config('registration.staff_identity', '', true);
    perform set_config('registration.saving_child', '', true);
    return false;
  end if;
  if v_child then
    perform public.registration_child_save('staff', p_actor, p_registration_id, v_registration, v_type,
      case when p_child_type is null then v_registration.parent_name
        else public.registration_parent_name(true, p_parent_name) end);
  else
    perform public.registration_child_save('staff', p_actor, p_registration_id, v_registration, null, null);
    v_before := public.registration_pickup_get(p_registration_id);
    v_after := public.registration_pickup_value(p_pickup);
    if v_after is not null and v_after is distinct from v_before then
      perform public.registration_pickup_put(p_registration_id, v_after);
      update public.registrations set updated_at = now(),
        import_status = case when import_status = 'imported' then 'reimport_needed' else import_status end
      where id = p_registration_id;
      insert into public.audit_events (actor_type, actor_user_id, action, target_type, target_id, before_data, after_data)
      values ('staff', p_actor, 'registration.pickup_updated', 'registration', p_registration_id,
        jsonb_build_object('pickup', v_before), jsonb_build_object('pickup', v_after));
    end if;
  end if;
  if not public.registration_audience_valid(p_choices, public.registration_hosting_get(p_registration_id),
    public.registration_pickup_get(p_registration_id)) then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  perform set_config('registration.staff_identity', '', true);
  perform set_config('registration.saving_child', '', true);
  return true;
end;
$$;
revoke all on function public.staff_update_registration_with_pickup(uuid,uuid,text,integer,jsonb,jsonb,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.staff_update_registration_with_pickup(uuid,uuid,text,integer,jsonb,jsonb,text,jsonb,text,text) to service_role;
create or replace function public.get_registration_child(p_full_name text, p_district_id integer)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_child jsonb;
begin
  if not exists (select 1 from public.site_settings where id and is_lookup_open) then
    raise exception using errcode = 'P0001', message = 'LOOKUP_CLOSED';
  end if;
  select jsonb_build_object('child_type', r.child_type, 'is_child', r.is_child, 'parent_name', r.parent_name) into v_child
  from public.registrations r
  where r.district_id = p_district_id and r.name_key = public.registration_name_key(p_full_name)
    and r.record_status = 'active';
  return v_child;
end;
$$;
revoke all on function public.registration_child_type(text), public.registration_identity_delete_guard(), public.registration_child_save(text,uuid,uuid,public.registrations,text,text) from public,anon,authenticated;
grant execute on function public.registration_child_type(text), public.registration_child_save(text,uuid,uuid,public.registrations,text,text) to service_role;
create or replace function public.staff_save_reference(p_actor uuid, p_kind text, p_data jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_before jsonb; v_after jsonb; v_prices jsonb; v_code text; v_activity bigint;
begin
  perform public.staff_assert_actor(p_actor, true);
  if p_kind in ('identity', 'delete_identity') then
    v_code := nullif(p_data->>'code', '');
    if v_code is not null then
      select to_jsonb(i) into v_before from public.registration_identities i where code = v_code for update;
      if v_before is null then
        raise exception using errcode = '22023', message = 'REFERENCE_NOT_FOUND';
      end if;
    end if;
    if p_kind = 'delete_identity' then
      if v_code is null
        or exists (select 1 from public.registrations where meal_identity = v_code) then
        raise exception using errcode = '22023', message = 'IDENTITY_IN_USE';
      end if;
      delete from public.registration_identities where code = v_code;
      insert into public.audit_events (actor_type, actor_user_id, action, target_type, before_data)
      values ('admin', p_actor, 'reference.deleted', 'identity', v_before);
      return v_before;
    end if;
    if v_code is null then
      insert into public.registration_identities (code, name, is_active, public_selectable, sort_order)
      values ('identity_' || replace(gen_random_uuid()::text, '-', ''), btrim(p_data->>'name'),
        (p_data->>'is_active')::boolean, (p_data->>'public_selectable')::boolean,
        (select coalesce(max(sort_order), 0) + 1 from public.registration_identities))
      returning to_jsonb(registration_identities.*) into v_after;
    else
      update public.registration_identities set name = btrim(p_data->>'name'),
        is_active = (p_data->>'is_active')::boolean, public_selectable = (p_data->>'public_selectable')::boolean
      where code = v_code returning to_jsonb(registration_identities.*) into v_after;
    end if;
    if v_before is distinct from v_after then
      insert into public.audit_events (actor_type, actor_user_id, action, target_type, before_data, after_data)
      values ('admin', p_actor, 'reference.saved', 'identity', v_before, v_after);
    end if;
    return v_after;
  end if;

  v_after := public.staff_save_reference_before_identities(p_actor, p_kind, p_data);
  if p_kind = 'activity' and p_data ? 'identity_prices' then
    if jsonb_typeof(p_data->'identity_prices') <> 'array' then
      raise exception using errcode = '22023', message = 'INVALID_REFERENCE_DATA';
    end if;
    v_activity := (v_after->>'id')::bigint;
    select coalesce(jsonb_agg(jsonb_build_object('identity_code', identity_code, 'fee_amount', fee_amount)
      order by identity_code), '[]'::jsonb) into v_before
    from public.activity_identity_prices where activity_id = v_activity;
    delete from public.activity_identity_prices where activity_id = v_activity;
    insert into public.activity_identity_prices (activity_id, identity_code, fee_amount)
    select v_activity, price->>'identity_code', (price->>'fee_amount')::integer
    from jsonb_array_elements(p_data->'identity_prices') price;
    select coalesce(jsonb_agg(jsonb_build_object('identity_code', identity_code, 'fee_amount', fee_amount)
      order by identity_code), '[]'::jsonb) into v_prices
    from public.activity_identity_prices where activity_id = v_activity;
    if v_before is distinct from v_prices then
      insert into public.audit_events (actor_type, actor_user_id, action, target_type, before_data, after_data)
      values ('admin', p_actor, 'reference.saved', 'activity_identity_prices',
        jsonb_build_object('activity_id', v_activity, 'identity_prices', v_before),
        jsonb_build_object('activity_id', v_activity, 'identity_prices', v_prices));
    end if;
  end if;
  return v_after;
end;
$$;

-- ===== 202611100002_unified_identity.sql =====

-- Unified identity selection; apply with registration closed, then deploy both Edge Functions and site.
create or replace function public.registration_meal_identity(p_choices jsonb, p_identity text, p_stored text default null)
returns text language plpgsql security invoker set search_path = '' as $$
declare v_child boolean := public.registration_saving_child(); v_code text; v_identity public.registration_identities;
begin
  if v_child then
    v_code := case when current_setting('registration.saving_child',true) = 'preschool' then 'preschool' else 'child' end;
  else
    if p_identity is null and p_stored is null then
      raise exception using errcode = 'P0001', message = 'MEAL_IDENTITY_REQUIRED';
    end if;
    -- A former child's stored identity falls back to general.
    v_code := coalesce(p_identity, case when p_stored not in ('child','preschool') then p_stored end, 'general');
    if v_code in ('child','preschool') then
      raise exception using errcode = '22023', message = 'INVALID_MEAL_IDENTITY';
    end if;
  end if;
  select * into v_identity from public.registration_identities where code = v_code for share;
  if not found or (v_code is distinct from p_stored and (not v_identity.is_active
      or (not v_identity.public_selectable
        and coalesce(current_setting('registration.staff_identity', true), '') <> 'on'))) then
    raise exception using errcode = '22023', message = 'INVALID_MEAL_IDENTITY';
  end if;
  return v_code;
end;
$$;
create or replace function public.create_registration_with_pickup(
  p_request_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_child_type text default '', p_parent_name text default null
) returns table (registration_id uuid, serial_no bigint)
language plpgsql security invoker set search_path = '' as $$
declare v_pickup jsonb; v_id uuid; v_serial bigint; v_open boolean; v_type text; v_child boolean;
  v_before public.registrations;
begin
  -- A new registration must choose an identity; it alone decides the child type.
  if p_meal_identity is null then
    raise exception using errcode = 'P0001', message = 'MEAL_IDENTITY_REQUIRED';
  end if;
  v_type := case p_meal_identity when 'preschool' then 'preschool' when 'child' then 'elementary' end;
  v_child := v_type is not null;
  if v_child then
    perform set_config('registration.saving_child', v_type, true);
    p_hosting := case when (select is_hosting_open from public.site_settings where id)
      then '{"status": "not_hosting"}'::jsonb end;
  end if;
  select c.registration_id, c.serial_no into v_id, v_serial
  from public.create_registration(p_request_id, p_full_name, p_district_id, p_choices, p_hosting, p_meal_identity) c;
  if v_child then
    select * into v_before from public.registrations where id = v_id;
    perform public.registration_child_save('public', null, v_id, v_before, v_type,
      public.registration_parent_name(true, p_parent_name));
  else
    v_pickup := public.registration_pickup_value(p_pickup);
    select is_pickup_open into v_open from public.site_settings where id;
    if not v_open and v_pickup is not null then
      raise exception using errcode = 'P0001', message = 'PICKUP_CLOSED';
    end if;
    if v_open and v_pickup is null then
      raise exception using errcode = 'P0001', message = 'PICKUP_REQUIRED';
    end if;
    if v_pickup is not null then
      perform public.registration_pickup_put(v_id, v_pickup);
      insert into public.audit_events (actor_type, action, target_type, target_id, after_data)
      values ('public', 'registration.pickup_updated', 'registration', v_id, jsonb_build_object('pickup', v_pickup));
    end if;
  end if;
  if not public.registration_audience_valid(p_choices, public.registration_hosting_get(v_id),
    public.registration_pickup_get(v_id)) then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  perform set_config('registration.saving_child', '', true);
  return query select v_id, v_serial;
end;
$$;
create or replace function public.update_registration_with_pickup(
  p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_child_type text default null, p_parent_name text default null
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_id uuid; v_before jsonb; v_after jsonb; v_open boolean; v_registration public.registrations;
  v_child boolean; v_type text;
begin
  -- An identity sent decides the child type; an older page sends none and keeps the stored one.
  if p_meal_identity is not null then
    p_child_type := case p_meal_identity when 'preschool' then 'preschool' when 'child' then 'elementary' else '' end;
  end if;
  select * into v_registration from public.registrations
  where district_id = p_district_id and name_key = public.registration_name_key(p_full_name)
    and record_status = 'active'
  for update;
  v_type := public.registration_child_type(coalesce(p_child_type, v_registration.child_type));
  v_child := v_type is not null;
  if v_child then
    perform set_config('registration.saving_child', v_type, true);
    p_hosting := case when (select is_hosting_open from public.site_settings where id)
      then '{"status": "not_hosting"}'::jsonb end;
  end if;
  if not public.update_registration(p_full_name, p_district_id, p_choices, p_hosting, p_meal_identity) then
    perform set_config('registration.saving_child', '', true);
    return false;
  end if;
  v_id := v_registration.id;
  if v_child then
    perform public.registration_child_save('public', null, v_id, v_registration, v_type,
      case when p_child_type is null then v_registration.parent_name
        else public.registration_parent_name(true, p_parent_name) end);
  else
    perform public.registration_child_save('public', null, v_id, v_registration, null, null);
    select is_pickup_open into v_open from public.site_settings where id;
    v_before := public.registration_pickup_get(v_id);
    v_after := public.registration_pickup_value(p_pickup);
    if not v_open and v_after is not null and v_after is distinct from v_before then
      raise exception using errcode = 'P0001', message = 'PICKUP_CLOSED';
    end if;
    if v_open and coalesce(v_after, v_before) is null then
      raise exception using errcode = 'P0001', message = 'PICKUP_REQUIRED';
    end if;
    if v_open and v_after is not null and v_after is distinct from v_before then
      perform public.registration_pickup_put(v_id, v_after);
      update public.registrations set updated_at = now(),
        import_status = case when import_status = 'imported' then 'reimport_needed' else import_status end
      where id = v_id;
      insert into public.audit_events (actor_type, action, target_type, target_id, before_data, after_data)
      values ('public', 'registration.pickup_updated', 'registration', v_id,
        jsonb_build_object('pickup', v_before), jsonb_build_object('pickup', v_after));
    end if;
  end if;
  if not public.registration_audience_valid(p_choices, public.registration_hosting_get(v_id),
    public.registration_pickup_get(v_id)) then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  perform set_config('registration.saving_child', '', true);
  return true;
end;
$$;
create or replace function public.staff_create_registration_with_pickup(
  p_actor uuid, p_request_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_child_type text default '', p_parent_name text default null
) returns table (registration_id uuid, serial_no bigint)
language plpgsql security invoker set search_path = '' as $$
declare v_pickup jsonb; v_id uuid; v_serial bigint; v_type text; v_child boolean;
  v_before public.registrations;
begin
  perform public.staff_assert_actor(p_actor, false);
  -- A new registration must choose an identity; it alone decides the child type.
  if p_meal_identity is null then
    raise exception using errcode = 'P0001', message = 'MEAL_IDENTITY_REQUIRED';
  end if;
  v_type := case p_meal_identity when 'preschool' then 'preschool' when 'child' then 'elementary' end;
  v_child := v_type is not null;
  perform set_config('registration.staff_identity', 'on', true);
  if v_child then
    perform set_config('registration.saving_child', v_type, true);
    p_hosting := '{"status": "not_hosting"}';
  end if;
  select c.registration_id, c.serial_no into v_id, v_serial
  from public.staff_create_registration(p_actor, p_request_id, p_full_name,
    p_district_id, p_choices, p_hosting, p_meal_identity) c;
  if v_child then
    select * into v_before from public.registrations where id = v_id;
    perform public.registration_child_save('staff', p_actor, v_id, v_before, v_type,
      public.registration_parent_name(true, p_parent_name));
  else
    v_pickup := public.registration_pickup_value(p_pickup);
    if v_pickup is null and coalesce((select is_pickup_open from public.site_settings where id), false) then
      raise exception using errcode = 'P0001', message = 'PICKUP_REQUIRED';
    end if;
    if v_pickup is not null then
      perform public.registration_pickup_put(v_id, v_pickup);
      insert into public.audit_events (actor_type, actor_user_id, action, target_type, target_id, after_data)
      values ('staff', p_actor, 'registration.pickup_updated', 'registration', v_id, jsonb_build_object('pickup', v_pickup));
    end if;
  end if;
  if not public.registration_audience_valid(p_choices, public.registration_hosting_get(v_id),
    public.registration_pickup_get(v_id)) then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  perform set_config('registration.staff_identity', '', true);
  perform set_config('registration.saving_child', '', true);
  return query select v_id, v_serial;
end;
$$;
create or replace function public.staff_update_registration_with_pickup(
  p_actor uuid, p_registration_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_child_type text default null, p_parent_name text default null
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_before jsonb; v_after jsonb; v_registration public.registrations; v_child boolean; v_type text;
begin
  perform public.staff_assert_actor(p_actor, false);
  -- An identity sent decides the child type; an older page sends none and keeps the stored one.
  if p_meal_identity is not null then
    p_child_type := case p_meal_identity when 'preschool' then 'preschool' when 'child' then 'elementary' else '' end;
  end if;
  perform set_config('registration.staff_identity', 'on', true);
  select * into v_registration from public.registrations
  where id = p_registration_id and record_status = 'active' for update;
  v_type := public.registration_child_type(coalesce(p_child_type, v_registration.child_type));
  v_child := v_type is not null;
  if v_child then
    perform set_config('registration.saving_child', v_type, true);
    p_hosting := '{"status": "not_hosting"}';
  end if;
  if not public.staff_update_registration(p_actor, p_registration_id, p_full_name,
    p_district_id, p_choices, p_hosting, p_meal_identity) then
    perform set_config('registration.staff_identity', '', true);
    perform set_config('registration.saving_child', '', true);
    return false;
  end if;
  if v_child then
    perform public.registration_child_save('staff', p_actor, p_registration_id, v_registration, v_type,
      case when p_child_type is null then v_registration.parent_name
        else public.registration_parent_name(true, p_parent_name) end);
  else
    perform public.registration_child_save('staff', p_actor, p_registration_id, v_registration, null, null);
    v_before := public.registration_pickup_get(p_registration_id);
    v_after := public.registration_pickup_value(p_pickup);
    if v_after is not null and v_after is distinct from v_before then
      perform public.registration_pickup_put(p_registration_id, v_after);
      update public.registrations set updated_at = now(),
        import_status = case when import_status = 'imported' then 'reimport_needed' else import_status end
      where id = p_registration_id;
      insert into public.audit_events (actor_type, actor_user_id, action, target_type, target_id, before_data, after_data)
      values ('staff', p_actor, 'registration.pickup_updated', 'registration', p_registration_id,
        jsonb_build_object('pickup', v_before), jsonb_build_object('pickup', v_after));
    end if;
  end if;
  if not public.registration_audience_valid(p_choices, public.registration_hosting_get(p_registration_id),
    public.registration_pickup_get(p_registration_id)) then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  perform set_config('registration.staff_identity', '', true);
  perform set_config('registration.saving_child', '', true);
  return true;
end;
$$;
create function public.registration_used_identity_codes() returns setof text
language sql stable security invoker set search_path = '' as $$
  select distinct meal_identity from public.registrations;
$$;
revoke all on function public.registration_used_identity_codes() from public, anon, authenticated;
grant execute on function public.registration_used_identity_codes() to service_role;

-- ===== 202611100003_identity_badges.sql =====

-- Apply migration, deploy staff Edge Function, then deploy the site.
alter table public.registration_identities
  add column show_badge boolean not null default false,
  add column badge_color text not null default '#e1effe'
    check (badge_color ~ '^#[0-9a-fA-F]{6}$');
update public.registration_identities
set show_badge = true,
  badge_color = case code when 'preschool' then '#fce4ec' when 'student' then '#eee5fa' else '#e1effe' end
where code in ('child', 'preschool', 'student');

create or replace function public.staff_save_reference(p_actor uuid, p_kind text, p_data jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_before jsonb; v_after jsonb; v_prices jsonb; v_code text; v_activity bigint;
begin
  perform public.staff_assert_actor(p_actor, true);
  if p_kind in ('identity', 'delete_identity') then
    v_code := nullif(p_data->>'code', '');
    if v_code is not null then
      select to_jsonb(i) into v_before from public.registration_identities i where code = v_code for update;
      if v_before is null then
        raise exception using errcode = '22023', message = 'REFERENCE_NOT_FOUND';
      end if;
    end if;
    if p_kind = 'delete_identity' then
      if v_code is null
        or exists (select 1 from public.registrations where meal_identity = v_code) then
        raise exception using errcode = '22023', message = 'IDENTITY_IN_USE';
      end if;
      delete from public.registration_identities where code = v_code;
      insert into public.audit_events (actor_type, actor_user_id, action, target_type, before_data)
      values ('admin', p_actor, 'reference.deleted', 'identity', v_before);
      return v_before;
    end if;
    if v_code is null then
      insert into public.registration_identities (code, name, is_active, public_selectable, show_badge, badge_color, sort_order)
      values ('identity_' || replace(gen_random_uuid()::text, '-', ''), btrim(p_data->>'name'),
        (p_data->>'is_active')::boolean, (p_data->>'public_selectable')::boolean,
        coalesce((p_data->>'show_badge')::boolean, false), coalesce(p_data->>'badge_color', '#e1effe'),
        (select coalesce(max(sort_order), 0) + 1 from public.registration_identities))
      returning to_jsonb(registration_identities.*) into v_after;
    else
      update public.registration_identities set name = btrim(p_data->>'name'),
        is_active = (p_data->>'is_active')::boolean, public_selectable = (p_data->>'public_selectable')::boolean,
        show_badge = case when p_data ? 'show_badge' then (p_data->>'show_badge')::boolean else show_badge end,
        badge_color = case when p_data ? 'badge_color' then p_data->>'badge_color' else badge_color end
      where code = v_code returning to_jsonb(registration_identities.*) into v_after;
    end if;
    if v_before is distinct from v_after then
      insert into public.audit_events (actor_type, actor_user_id, action, target_type, before_data, after_data)
      values ('admin', p_actor, 'reference.saved', 'identity', v_before, v_after);
    end if;
    return v_after;
  end if;

  v_after := public.staff_save_reference_before_identities(p_actor, p_kind, p_data);
  if p_kind = 'activity' and p_data ? 'identity_prices' then
    if jsonb_typeof(p_data->'identity_prices') <> 'array' then
      raise exception using errcode = '22023', message = 'INVALID_REFERENCE_DATA';
    end if;
    v_activity := (v_after->>'id')::bigint;
    select coalesce(jsonb_agg(jsonb_build_object('identity_code', identity_code, 'fee_amount', fee_amount)
      order by identity_code), '[]'::jsonb) into v_before
    from public.activity_identity_prices where activity_id = v_activity;
    delete from public.activity_identity_prices where activity_id = v_activity;
    insert into public.activity_identity_prices (activity_id, identity_code, fee_amount)
    select v_activity, price->>'identity_code', (price->>'fee_amount')::integer
    from jsonb_array_elements(p_data->'identity_prices') price;
    select coalesce(jsonb_agg(jsonb_build_object('identity_code', identity_code, 'fee_amount', fee_amount)
      order by identity_code), '[]'::jsonb) into v_prices
    from public.activity_identity_prices where activity_id = v_activity;
    if v_before is distinct from v_prices then
      insert into public.audit_events (actor_type, actor_user_id, action, target_type, before_data, after_data)
      values ('admin', p_actor, 'reference.saved', 'activity_identity_prices',
        jsonb_build_object('activity_id', v_activity, 'identity_prices', v_before),
        jsonb_build_object('activity_id', v_activity, 'identity_prices', v_prices));
    end if;
  end if;
  return v_after;
end;
$$;


-- ===== 202611100004_hosting_general_only.sql =====

-- 2026-11-10: only 一般 (code general) answers 開家接待 and 接機接待. Decisions are in
-- docs/需求討論與決策紀錄.md, section "接待題限一般身分、提醒區塊與查詢結果版面".
-- Apply with registration closed, then deploy the site.
--   * Students and custom identities answer neither survey, like children: both are stored as 否,
--     and they are outside the hosting and pickup audiences (an activity: prerequisite still holds).
--   * A registration without an identity (from before the unified identity) is left as it is.
--   * Existing registrations keep their answers; this migration does not rewrite them.

-- Set by the wrappers below while saving a non-general, non-child registration.
create function public.registration_skipping_hosting()
returns boolean language sql stable security invoker set search_path = '' as $$
  select public.registration_saving_child()
    or coalesce(current_setting('registration.skip_hosting', true), '') = 'on';
$$;

-- Same as 202611090001, except any identity that skips the surveys is outside the hosting audience.
create or replace function public.registration_audience_valid(p_choices jsonb, p_hosting jsonb)
returns boolean language sql stable security invoker set search_path = '' as $$
  select public.registration_skipping_hosting() or not exists (
    select 1 from jsonb_array_elements(p_choices) choice
    join public.activities activity on activity.id = (choice->>'activity_id')::bigint
    where activity.audience = 'hosting' and (choice->>'attending')::boolean
      and coalesce(p_hosting->>'status', '') not in ('hosting', 'family_registered')
  );
$$;

-- Same as 202611090001, except any identity that skips the surveys is outside both audiences.
create or replace function public.registration_audience_valid(p_choices jsonb, p_hosting jsonb, p_pickup jsonb)
returns boolean language sql stable security invoker set search_path = '' as $$
  select not exists (
    select 1 from jsonb_array_elements(p_choices) choice
    join public.activities activity on activity.id = (choice->>'activity_id')::bigint
    where (choice->>'attending')::boolean and (
      (activity.audience = 'hosting' and not public.registration_skipping_hosting()
        and coalesce(p_hosting->>'status', '') not in ('hosting', 'family_registered'))
      or (activity.audience = 'pickup' and not public.registration_skipping_hosting()
        and coalesce(p_pickup->>'status', '') <> 'yes')
      or (activity.audience like 'activity:%' and not exists (
        select 1 from public.activities prerequisite
        join jsonb_array_elements(p_choices) required_choice
          on (required_choice->>'activity_id')::bigint = prerequisite.id
        where prerequisite.id = nullif(substring(activity.audience from 10), '')::bigint
          and prerequisite.is_published and (required_choice->>'attending')::boolean
      ))
    )
  );
$$;

-- Same as 202611100001, plus p_answers_off: a non-child that skips the surveys also gets the 否 answers.
drop function public.registration_child_save(text,uuid,uuid,public.registrations,text,text);
create function public.registration_child_save(
  p_actor_type text, p_actor uuid, p_registration_id uuid, p_before public.registrations,
  p_child_type text, p_parent_name text, p_answers_off boolean default false
) returns void language plpgsql security invoker set search_path = '' as $$
declare v_is_child boolean := p_child_type is not null; v_hosting jsonb; v_pickup jsonb; v_fields_changed boolean; v_answers_changed boolean := false;
begin
  v_hosting := public.registration_hosting_get(p_registration_id);
  v_pickup := public.registration_pickup_get(p_registration_id);
  v_fields_changed := (p_before.child_type, p_before.parent_name) is distinct from (p_child_type, p_parent_name);
  if v_is_child or p_answers_off then v_answers_changed := public.registration_child_answers_put(p_registration_id); end if;
  if not v_fields_changed and not v_answers_changed then return; end if;
  update public.registrations set child_type = p_child_type, is_child = v_is_child, parent_name = p_parent_name, updated_at = now(),
    import_status = case when (v_answers_changed or p_before.child_type is distinct from p_child_type) and import_status = 'imported' then 'reimport_needed'
      else import_status end
  where id = p_registration_id;
  insert into public.audit_events (actor_type, actor_user_id, action, target_type, target_id, before_data, after_data)
  values (p_actor_type, p_actor, 'registration.child_updated', 'registration', p_registration_id,
    jsonb_build_object('child_type', p_before.child_type, 'is_child', p_before.is_child, 'parent_name', p_before.parent_name,
      'hosting', v_hosting, 'pickup', v_pickup),
    jsonb_build_object('child_type', p_child_type, 'is_child', v_is_child, 'parent_name', p_parent_name,
      'hosting', public.registration_hosting_get(p_registration_id),
      'pickup', public.registration_pickup_get(p_registration_id)));
end;
$$;

-- Same as 202611100002, except a non-general identity skips both surveys like a child.
create or replace function public.create_registration_with_pickup(
  p_request_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_child_type text default '', p_parent_name text default null
) returns table (registration_id uuid, serial_no bigint)
language plpgsql security invoker set search_path = '' as $$
declare v_pickup jsonb; v_id uuid; v_serial bigint; v_open boolean; v_type text; v_child boolean; v_skip boolean;
  v_before public.registrations;
begin
  -- A new registration must choose an identity; it alone decides the child type.
  if p_meal_identity is null then
    raise exception using errcode = 'P0001', message = 'MEAL_IDENTITY_REQUIRED';
  end if;
  v_type := case p_meal_identity when 'preschool' then 'preschool' when 'child' then 'elementary' end;
  v_child := v_type is not null;
  v_skip := not v_child and p_meal_identity <> 'general';
  if v_child then
    perform set_config('registration.saving_child', v_type, true);
  elsif v_skip then
    perform set_config('registration.skip_hosting', 'on', true);
  end if;
  if v_child or v_skip then
    p_hosting := case when (select is_hosting_open from public.site_settings where id)
      then '{"status": "not_hosting"}'::jsonb end;
  end if;
  select c.registration_id, c.serial_no into v_id, v_serial
  from public.create_registration(p_request_id, p_full_name, p_district_id, p_choices, p_hosting, p_meal_identity) c;
  if v_child or v_skip then
    select * into v_before from public.registrations where id = v_id;
    perform public.registration_child_save('public', null, v_id, v_before, v_type,
      case when v_child then public.registration_parent_name(true, p_parent_name) end, v_skip);
  else
    v_pickup := public.registration_pickup_value(p_pickup);
    select is_pickup_open into v_open from public.site_settings where id;
    if not v_open and v_pickup is not null then
      raise exception using errcode = 'P0001', message = 'PICKUP_CLOSED';
    end if;
    if v_open and v_pickup is null then
      raise exception using errcode = 'P0001', message = 'PICKUP_REQUIRED';
    end if;
    if v_pickup is not null then
      perform public.registration_pickup_put(v_id, v_pickup);
      insert into public.audit_events (actor_type, action, target_type, target_id, after_data)
      values ('public', 'registration.pickup_updated', 'registration', v_id, jsonb_build_object('pickup', v_pickup));
    end if;
  end if;
  if not public.registration_audience_valid(p_choices, public.registration_hosting_get(v_id),
    public.registration_pickup_get(v_id)) then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  perform set_config('registration.saving_child', '', true);
  perform set_config('registration.skip_hosting', '', true);
  return query select v_id, v_serial;
end;
$$;

-- Same as 202611100002, except a non-general identity skips both surveys like a child. A stored
-- identity counts when the page sends none; a registration without one is left as it is.
create or replace function public.update_registration_with_pickup(
  p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_child_type text default null, p_parent_name text default null
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_id uuid; v_before jsonb; v_after jsonb; v_open boolean; v_registration public.registrations;
  v_child boolean; v_type text; v_skip boolean;
begin
  -- An identity sent decides the child type; an older page sends none and keeps the stored one.
  if p_meal_identity is not null then
    p_child_type := case p_meal_identity when 'preschool' then 'preschool' when 'child' then 'elementary' else '' end;
  end if;
  select * into v_registration from public.registrations
  where district_id = p_district_id and name_key = public.registration_name_key(p_full_name)
    and record_status = 'active'
  for update;
  v_type := public.registration_child_type(coalesce(p_child_type, v_registration.child_type));
  v_child := v_type is not null;
  v_skip := not v_child and coalesce(p_meal_identity, v_registration.meal_identity, 'general') <> 'general';
  if v_child then
    perform set_config('registration.saving_child', v_type, true);
  elsif v_skip then
    perform set_config('registration.skip_hosting', 'on', true);
  end if;
  if v_child or v_skip then
    p_hosting := case when (select is_hosting_open from public.site_settings where id)
      then '{"status": "not_hosting"}'::jsonb end;
  end if;
  if not public.update_registration(p_full_name, p_district_id, p_choices, p_hosting, p_meal_identity) then
    perform set_config('registration.saving_child', '', true);
    perform set_config('registration.skip_hosting', '', true);
    return false;
  end if;
  v_id := v_registration.id;
  if v_child then
    perform public.registration_child_save('public', null, v_id, v_registration, v_type,
      case when p_child_type is null then v_registration.parent_name
        else public.registration_parent_name(true, p_parent_name) end);
  elsif v_skip then
    perform public.registration_child_save('public', null, v_id, v_registration, null, null, true);
  else
    perform public.registration_child_save('public', null, v_id, v_registration, null, null);
    select is_pickup_open into v_open from public.site_settings where id;
    v_before := public.registration_pickup_get(v_id);
    v_after := public.registration_pickup_value(p_pickup);
    if not v_open and v_after is not null and v_after is distinct from v_before then
      raise exception using errcode = 'P0001', message = 'PICKUP_CLOSED';
    end if;
    if v_open and coalesce(v_after, v_before) is null then
      raise exception using errcode = 'P0001', message = 'PICKUP_REQUIRED';
    end if;
    if v_open and v_after is not null and v_after is distinct from v_before then
      perform public.registration_pickup_put(v_id, v_after);
      update public.registrations set updated_at = now(),
        import_status = case when import_status = 'imported' then 'reimport_needed' else import_status end
      where id = v_id;
      insert into public.audit_events (actor_type, action, target_type, target_id, before_data, after_data)
      values ('public', 'registration.pickup_updated', 'registration', v_id,
        jsonb_build_object('pickup', v_before), jsonb_build_object('pickup', v_after));
    end if;
  end if;
  if not public.registration_audience_valid(p_choices, public.registration_hosting_get(v_id),
    public.registration_pickup_get(v_id)) then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  perform set_config('registration.saving_child', '', true);
  perform set_config('registration.skip_hosting', '', true);
  return true;
end;
$$;

-- Same as 202611100002, except a non-general identity skips both surveys like a child.
create or replace function public.staff_create_registration_with_pickup(
  p_actor uuid, p_request_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_child_type text default '', p_parent_name text default null
) returns table (registration_id uuid, serial_no bigint)
language plpgsql security invoker set search_path = '' as $$
declare v_pickup jsonb; v_id uuid; v_serial bigint; v_type text; v_child boolean; v_skip boolean;
  v_before public.registrations;
begin
  perform public.staff_assert_actor(p_actor, false);
  -- A new registration must choose an identity; it alone decides the child type.
  if p_meal_identity is null then
    raise exception using errcode = 'P0001', message = 'MEAL_IDENTITY_REQUIRED';
  end if;
  v_type := case p_meal_identity when 'preschool' then 'preschool' when 'child' then 'elementary' end;
  v_child := v_type is not null;
  v_skip := not v_child and p_meal_identity <> 'general';
  perform set_config('registration.staff_identity', 'on', true);
  if v_child then
    perform set_config('registration.saving_child', v_type, true);
  elsif v_skip then
    perform set_config('registration.skip_hosting', 'on', true);
  end if;
  if v_child or v_skip then p_hosting := '{"status": "not_hosting"}'; end if;
  select c.registration_id, c.serial_no into v_id, v_serial
  from public.staff_create_registration(p_actor, p_request_id, p_full_name,
    p_district_id, p_choices, p_hosting, p_meal_identity) c;
  if v_child or v_skip then
    select * into v_before from public.registrations where id = v_id;
    perform public.registration_child_save('staff', p_actor, v_id, v_before, v_type,
      case when v_child then public.registration_parent_name(true, p_parent_name) end, v_skip);
  else
    v_pickup := public.registration_pickup_value(p_pickup);
    if v_pickup is null and coalesce((select is_pickup_open from public.site_settings where id), false) then
      raise exception using errcode = 'P0001', message = 'PICKUP_REQUIRED';
    end if;
    if v_pickup is not null then
      perform public.registration_pickup_put(v_id, v_pickup);
      insert into public.audit_events (actor_type, actor_user_id, action, target_type, target_id, after_data)
      values ('staff', p_actor, 'registration.pickup_updated', 'registration', v_id, jsonb_build_object('pickup', v_pickup));
    end if;
  end if;
  if not public.registration_audience_valid(p_choices, public.registration_hosting_get(v_id),
    public.registration_pickup_get(v_id)) then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  perform set_config('registration.staff_identity', '', true);
  perform set_config('registration.saving_child', '', true);
  perform set_config('registration.skip_hosting', '', true);
  return query select v_id, v_serial;
end;
$$;

-- Same as 202611100002, except a non-general identity skips both surveys like a child. A stored
-- identity counts when the page sends none; a registration without one is left as it is.
create or replace function public.staff_update_registration_with_pickup(
  p_actor uuid, p_registration_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_child_type text default null, p_parent_name text default null
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_before jsonb; v_after jsonb; v_registration public.registrations; v_child boolean; v_type text; v_skip boolean;
begin
  perform public.staff_assert_actor(p_actor, false);
  -- An identity sent decides the child type; an older page sends none and keeps the stored one.
  if p_meal_identity is not null then
    p_child_type := case p_meal_identity when 'preschool' then 'preschool' when 'child' then 'elementary' else '' end;
  end if;
  perform set_config('registration.staff_identity', 'on', true);
  select * into v_registration from public.registrations
  where id = p_registration_id and record_status = 'active' for update;
  v_type := public.registration_child_type(coalesce(p_child_type, v_registration.child_type));
  v_child := v_type is not null;
  v_skip := not v_child and coalesce(p_meal_identity, v_registration.meal_identity, 'general') <> 'general';
  if v_child then
    perform set_config('registration.saving_child', v_type, true);
  elsif v_skip then
    perform set_config('registration.skip_hosting', 'on', true);
  end if;
  if v_child or v_skip then p_hosting := '{"status": "not_hosting"}'; end if;
  if not public.staff_update_registration(p_actor, p_registration_id, p_full_name,
    p_district_id, p_choices, p_hosting, p_meal_identity) then
    perform set_config('registration.staff_identity', '', true);
    perform set_config('registration.saving_child', '', true);
    perform set_config('registration.skip_hosting', '', true);
    return false;
  end if;
  if v_child then
    perform public.registration_child_save('staff', p_actor, p_registration_id, v_registration, v_type,
      case when p_child_type is null then v_registration.parent_name
        else public.registration_parent_name(true, p_parent_name) end);
  elsif v_skip then
    perform public.registration_child_save('staff', p_actor, p_registration_id, v_registration, null, null, true);
  else
    perform public.registration_child_save('staff', p_actor, p_registration_id, v_registration, null, null);
    v_before := public.registration_pickup_get(p_registration_id);
    v_after := public.registration_pickup_value(p_pickup);
    if v_after is not null and v_after is distinct from v_before then
      perform public.registration_pickup_put(p_registration_id, v_after);
      update public.registrations set updated_at = now(),
        import_status = case when import_status = 'imported' then 'reimport_needed' else import_status end
      where id = p_registration_id;
      insert into public.audit_events (actor_type, actor_user_id, action, target_type, target_id, before_data, after_data)
      values ('staff', p_actor, 'registration.pickup_updated', 'registration', p_registration_id,
        jsonb_build_object('pickup', v_before), jsonb_build_object('pickup', v_after));
    end if;
  end if;
  if not public.registration_audience_valid(p_choices, public.registration_hosting_get(p_registration_id),
    public.registration_pickup_get(p_registration_id)) then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  perform set_config('registration.staff_identity', '', true);
  perform set_config('registration.saving_child', '', true);
  perform set_config('registration.skip_hosting', '', true);
  return true;
end;
$$;

revoke all on function public.registration_skipping_hosting(),
  public.registration_child_save(text,uuid,uuid,public.registrations,text,text,boolean)
  from public, anon, authenticated;
grant execute on function public.registration_skipping_hosting(),
  public.registration_child_save(text,uuid,uuid,public.registrations,text,text,boolean)
  to service_role;


-- ===== 202611110001_staff_performance.sql =====


-- Names and family links in one indexed query instead of a lookup followed by a names query.
create or replace function public.staff_registration_children(p_parents jsonb)
returns table (district_id integer, parent_name_key text, serial_no bigint, full_name text)
language sql stable security invoker set search_path = '' as $$
  select child.district_id, child.parent_name_key, child.serial_no, child.full_name
  from jsonb_to_recordset(p_parents) parent(district_id integer, name_key text)
  join public.registrations child on child.district_id = parent.district_id and child.parent_name_key = parent.name_key
  where child.record_status = 'active' and child.is_child
  order by child.serial_no;
$$;
revoke all on function public.staff_registration_children(jsonb) from public, anon, authenticated;
grant execute on function public.staff_registration_children(jsonb) to service_role;

create or replace function public.staff_registration_detail(p_actor uuid, p_registration_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare result jsonb;
begin
  perform public.staff_assert_actor(p_actor, false);
  select to_jsonb(detail) into result from (
    select r.id,r.serial_no,r.full_name,r.district_id,r.record_status,r.import_status,r.created_at,r.updated_at,
      r.meal_identity,r.is_child,r.child_type,r.parent_name,
      coalesce((select jsonb_agg(jsonb_build_object('activity_id',c.activity_id,'attending',c.attending))
        from public.registration_choices c where c.registration_id=r.id),'[]') as registration_choices,
      (select jsonb_build_object('status',h.status,'guest_type',h.guest_type,'guest_count',h.guest_count)
        from public.registration_hosting h where h.registration_id=r.id) as registration_hosting,
      (select jsonb_build_object('status',p.status,'count',p.count)
        from public.registration_pickup p where p.registration_id=r.id) as registration_pickup,
      coalesce((select jsonb_agg(jsonb_build_object('serial_no',c.serial_no,'full_name',c.full_name) order by c.serial_no)
        from public.staff_registration_children(jsonb_build_array(jsonb_build_object('district_id',r.district_id,'name_key',r.name_key))) c
        where r.record_status='active' and not r.is_child),'[]') as children
    from public.registrations r where r.id=p_registration_id
  ) detail;
  return result;
end;
$$;
revoke all on function public.staff_registration_detail(uuid,uuid) from public,anon,authenticated;
grant execute on function public.staff_registration_detail(uuid,uuid) to service_role;

-- Return the canonical saved record in the same RPC/transaction; no extra HTTP read after saving.
create or replace function public.staff_update_registration_result(p_actor uuid,p_registration_id uuid,p_full_name text,
  p_district_id integer,p_choices jsonb,p_hosting jsonb default null,p_meal_identity text default null,
  p_pickup jsonb default null,p_child_type text default null,p_parent_name text default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
begin
  if not public.staff_update_registration_with_pickup(p_actor,p_registration_id,p_full_name,p_district_id,
    p_choices,p_hosting,p_meal_identity,p_pickup,p_child_type,p_parent_name) then return null; end if;
  return public.staff_registration_detail(p_actor,p_registration_id);
end;
$$;
revoke all on function public.staff_update_registration_result(uuid,uuid,text,integer,jsonb,jsonb,text,jsonb,text,text)
  from public,anon,authenticated;
grant execute on function public.staff_update_registration_result(uuid,uuid,text,integer,jsonb,jsonb,text,jsonb,text,text)
  to service_role;

-- Anonymous, bounded aggregates: no names, registration IDs or per-person answers leave the DB.
create or replace function public.staff_registration_statistics(p_actor uuid)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare v_result jsonb;
begin
  perform public.staff_assert_actor(p_actor, false);
  with people as materialized (
    select r.id, r.district_id, r.meal_identity, r.child_type,
      h.status as hosting_status, h.guest_type, h.guest_count,
      p.status as pickup_status, p.count as pickup_count
    from public.registrations r
    left join public.registration_hosting h on h.registration_id = r.id
    left join public.registration_pickup p on p.registration_id = r.id
    where r.record_status = 'active'
  ), responses as materialized (
    select r.id, r.district_id, r.meal_identity, r.child_type, c.activity_id, c.attending,
      case coalesce(a.audience, 'all')
        when 'all' then true
        when 'hosting' then coalesce(r.meal_identity, 'general') <> 'general'
          or coalesce(r.hosting_status in ('hosting','family_registered'), false)
        when 'pickup' then coalesce(r.meal_identity, 'general') <> 'general'
          or coalesce(r.pickup_status = 'yes', false)
        else coalesce(required.attending, false) end as eligible
    from people r
    join public.registration_choices c on c.registration_id = r.id
    join public.activities a on a.id = c.activity_id and a.is_published
    left join public.activities prerequisite on 'activity:' || prerequisite.id::text = a.audience and prerequisite.is_published
    left join public.registration_choices required on required.registration_id = r.id and required.activity_id = prerequisite.id
  ), meal_attendees as (
    select distinct c.id from responses c join public.activities a on a.id = c.activity_id
    where c.attending and a.category = 'meal'
  ), person_counts as (
    select district_id, meal_identity, child_type, count(*) as count,
      count(*) filter (where meal_identity is null and m.id is not null) as no_identity
    from people left join meal_attendees m on m.id = people.id
    group by district_id, meal_identity, child_type
  ), choice_counts as (
    select district_id, meal_identity, child_type, activity_id, attending, eligible, count(*) as count
    from responses group by district_id, meal_identity, child_type, activity_id, attending, eligible
  ), hosting_counts as (
    select hosting_status as status, guest_type, count(*) as registrations,
      coalesce(sum(guest_count),0) as people
    from people group by hosting_status, guest_type
  ), pickup_counts as (
    select pickup_status as status, count(*) as registrations, coalesce(sum(pickup_count),0) as people
    from people group by pickup_status
  )
  select jsonb_build_object(
    'people', coalesce((select jsonb_agg(to_jsonb(x)) from person_counts x),'[]'),
    'choices', coalesce((select jsonb_agg(to_jsonb(x)) from choice_counts x),'[]'),
    'hosting', coalesce((select jsonb_agg(to_jsonb(x)) from hosting_counts x),'[]'),
    'pickup', coalesce((select jsonb_agg(to_jsonb(x)) from pickup_counts x),'[]')
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.staff_registration_statistics(uuid) from public, anon, authenticated;
grant execute on function public.staff_registration_statistics(uuid) to service_role;

-- ===== 202611110002_conference_import_status.sql =====

-- Apply before deploying staff and the site. Initialization leaves import statuses unchanged.
alter table public.activities add column affects_conference_import boolean not null default false;
update public.activities set affects_conference_import = true
where category = 'meeting' and (starts_at at time zone 'Asia/Taipei')::date in ('2027-02-20','2027-02-21');

create function public.conference_choices(p_choices jsonb) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(c order by (c->>'activity_id')::bigint), '[]'::jsonb)
  from jsonb_array_elements(p_choices) c
  join public.activities a on a.id = (c->>'activity_id')::bigint
  where a.affects_conference_import;
$$;
revoke all on function public.conference_choices(jsonb) from public, anon, authenticated;
grant execute on function public.conference_choices(jsonb) to service_role;

-- Same as 202611050006, except only tracked activity answers and any identity change set re-import.
create or replace function public.update_registration(
  p_full_name text,
  p_district_id integer,
  p_choices jsonb,
  p_hosting jsonb default null,
  p_meal_identity text default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_registration public.registrations%rowtype;
  v_before_choices jsonb;
  v_after_choices jsonb;
  v_before_hosting jsonb;
  v_after_hosting jsonb;
  v_identity text;
  v_import_change boolean;
  v_settings public.site_settings%rowtype;
begin
  select * into v_settings from public.site_settings where id;
  if not coalesce(v_settings.is_registration_open
      and (v_settings.registration_deadline_at is null or v_settings.registration_deadline_at > now()), false) then
    raise exception using errcode = 'P0001', message = 'REGISTRATION_CLOSED';
  end if;
  if not coalesce(v_settings.is_lookup_open, false) then
    raise exception using errcode = 'P0001', message = 'LOOKUP_CLOSED';
  end if;

  select * into v_registration from public.registrations
  where district_id = p_district_id and name_key = public.registration_name_key(p_full_name)
    and record_status = 'active'
  for update;
  if not found then return false; end if;
  if public.registration_choices_valid(p_choices) is not true then
    raise exception using errcode = '22023', message = 'INVALID_CHOICES';
  end if;
  v_before_hosting := public.registration_hosting_get(v_registration.id);
  -- An older page sends no pickup_count; keep the stored one instead of resetting it to 0.
  -- ->> is null also covers an explicit JSON null, which registration_hosting_value would turn into 0.
  if jsonb_typeof(p_hosting) = 'object' and p_hosting->>'pickup_count' is null then
    p_hosting := p_hosting || jsonb_build_object('pickup_count', coalesce(v_before_hosting->'pickup_count', '0'));
  end if;
  v_after_hosting := public.registration_hosting_value(p_hosting);
  if not v_settings.is_hosting_open
    and v_after_hosting is not null and v_after_hosting is distinct from v_before_hosting then
    raise exception using errcode = 'P0001', message = 'HOSTING_CLOSED';
  end if;
  -- No answer sent keeps the stored one: a page loaded before the switch opened, or an older page
  -- or Edge Function, sends none. Only a registration that never answered must answer now.
  v_after_hosting := case when v_settings.is_hosting_open then coalesce(v_after_hosting, v_before_hosting)
    else v_before_hosting end;
  if v_after_hosting is null and v_settings.is_hosting_open then
    raise exception using errcode = 'P0001', message = 'HOSTING_REQUIRED';
  end if;
  if public.registration_audience_valid(p_choices, v_after_hosting) is not true then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  v_identity := public.registration_meal_identity(p_choices, p_meal_identity, v_registration.meal_identity);

  select coalesce(jsonb_agg(jsonb_build_object('activity_id', activity_id, 'attending', attending)
    order by activity_id), '[]'::jsonb) into v_before_choices
  from public.registration_choices where registration_id = v_registration.id
    and activity_id in (select id from public.activities where is_published);
  select coalesce(jsonb_agg(jsonb_build_object('activity_id', activity_id, 'attending', attending)
    order by activity_id), '[]'::jsonb) into v_after_choices
  from (
    select (choice->>'activity_id')::bigint as activity_id, (choice->>'attending')::boolean as attending
    from jsonb_array_elements(p_choices) choice
  ) answers;
  -- Hosting answers are imported into the assembly system too, so any change needs a re-import.
  v_import_change := public.conference_choices(v_before_choices) <> public.conference_choices(v_after_choices) or v_before_hosting is distinct from v_after_hosting
    or v_registration.meal_identity is distinct from v_identity;
  if not v_import_change and v_before_choices = v_after_choices then
    return true;
  end if;

  update public.registrations set
    meal_identity = v_identity,
    import_status = case when v_import_change and import_status = 'imported' then 'reimport_needed'
      else import_status end,
    updated_at = now()
  where id = v_registration.id;
  insert into public.registration_choices (registration_id, activity_id, attending)
  select v_registration.id, (choice->>'activity_id')::bigint, (choice->>'attending')::boolean
  from jsonb_array_elements(p_choices) choice
  on conflict (registration_id, activity_id) do update
    set attending = excluded.attending, updated_at = now();
  if v_after_hosting is distinct from v_before_hosting then
    perform public.registration_hosting_put(v_registration.id, v_after_hosting);
  end if;
  insert into public.audit_events (actor_type, action, target_type, target_id, before_data, after_data)
  values ('public', 'registration.updated', 'registration', v_registration.id,
    jsonb_build_object('choices', v_before_choices, 'hosting', v_before_hosting,
      'meal_identity', v_registration.meal_identity, 'import_status', v_registration.import_status),
    jsonb_build_object('choices', v_after_choices, 'hosting', v_after_hosting, 'meal_identity', v_identity,
      'import_status', case when v_import_change and v_registration.import_status = 'imported'
        then 'reimport_needed' else v_registration.import_status end));
  return true;
exception
  when invalid_text_representation then
    raise exception using errcode = '22023', message = 'INVALID_CHOICES';
end;
$$;

-- Same as 202611050006, except only tracked activity answers and any identity change set re-import.
create or replace function public.staff_update_registration(
  p_actor uuid, p_registration_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_registration public.registrations%rowtype;
  v_before_choices jsonb;
  v_after_choices jsonb;
  v_before_hosting jsonb;
  v_after_hosting jsonb;
  v_identity text;
  v_import_change boolean;
begin
  perform public.staff_assert_actor(p_actor);
  select * into v_registration from public.registrations
  where id = p_registration_id and record_status = 'active' for update;
  if not found then return false; end if;

  if coalesce(length(btrim(p_full_name)), 0) not between 1 and 100
    or public.registration_name_key(p_full_name) = ''
    or not exists (select 1 from public.districts where id = p_district_id) then
    raise exception using errcode = '22023', message = 'INVALID_REGISTRATION';
  end if;
  if public.registration_choices_valid(p_choices, p_registration_id) is not true then
    raise exception using errcode = '22023', message = 'INVALID_CHOICES';
  end if;
  v_before_hosting := public.registration_hosting_get(p_registration_id);
  -- An older page sends no pickup_count; keep the stored one instead of resetting it to 0.
  -- ->> is null also covers an explicit JSON null, which registration_hosting_value would turn into 0.
  if jsonb_typeof(p_hosting) = 'object' and p_hosting->>'pickup_count' is null then
    p_hosting := p_hosting || jsonb_build_object('pickup_count', coalesce(v_before_hosting->'pickup_count', '0'));
  end if;
  -- No answer sent keeps the stored one (for example a cached older back-office page).
  v_after_hosting := coalesce(public.registration_hosting_value(p_hosting), v_before_hosting);
  if public.registration_audience_valid(p_choices, v_after_hosting) is not true then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  v_identity := public.registration_meal_identity(p_choices, p_meal_identity, v_registration.meal_identity);

  select coalesce(jsonb_agg(jsonb_build_object('activity_id', activity_id, 'attending', attending)
    order by activity_id), '[]'::jsonb) into v_before_choices
  from public.registration_choices where registration_id = p_registration_id
    and activity_id in (select id from public.activities where is_published);
  select coalesce(jsonb_agg(jsonb_build_object('activity_id', activity_id, 'attending', attending)
    order by activity_id), '[]'::jsonb) into v_after_choices
  from (
    select (choice->>'activity_id')::bigint as activity_id,
      (choice->>'attending')::boolean as attending
    from jsonb_array_elements(p_choices) choice
  ) answers;

  v_import_change := v_registration.full_name <> btrim(p_full_name) or v_registration.district_id <> p_district_id
    or public.conference_choices(v_before_choices) <> public.conference_choices(v_after_choices) or v_before_hosting is distinct from v_after_hosting
    or v_registration.meal_identity is distinct from v_identity;
  if not v_import_change and v_before_choices = v_after_choices then return true; end if;

  update public.registrations set full_name = btrim(p_full_name), district_id = p_district_id,
    meal_identity = v_identity,
    import_status = case when v_import_change and import_status = 'imported' then 'reimport_needed'
      else import_status end,
    updated_at = now()
  where id = p_registration_id;
  insert into public.registration_choices (registration_id, activity_id, attending)
  select p_registration_id, (choice->>'activity_id')::bigint, (choice->>'attending')::boolean
  from jsonb_array_elements(p_choices) choice
  on conflict (registration_id, activity_id) do update
    set attending = excluded.attending, updated_at = now();
  if v_after_hosting is distinct from v_before_hosting then
    perform public.registration_hosting_put(p_registration_id, v_after_hosting);
  end if;
  insert into public.audit_events (actor_type, actor_user_id, action, target_type, target_id, before_data, after_data)
  values ('staff', p_actor, 'registration.staff_updated', 'registration', p_registration_id,
    jsonb_build_object('full_name', v_registration.full_name, 'district_id', v_registration.district_id,
      'choices', v_before_choices, 'hosting', v_before_hosting, 'meal_identity', v_registration.meal_identity,
      'import_status', v_registration.import_status),
    jsonb_build_object('full_name', btrim(p_full_name), 'district_id', p_district_id, 'choices', v_after_choices,
      'hosting', v_after_hosting, 'meal_identity', v_identity,
      'import_status', case when v_import_change and v_registration.import_status = 'imported'
        then 'reimport_needed' else v_registration.import_status end));
  return true;
exception
  when unique_violation then
    if exists (select 1 from public.registrations where district_id = p_district_id
        and record_status = 'active' and id <> p_registration_id
        and name_key = public.registration_name_key(p_full_name)) then
      raise exception using errcode = '23505', message = 'NAME_TAKEN';
    end if;
    raise;
  when invalid_text_representation then
    raise exception using errcode = '22023', message = 'INVALID_CHOICES';
end;
$$;

-- Same as 202611050006, plus affects_conference_import: saving it, and re-import only for tracked activities.
create or replace function public.staff_save_reference_before_identities(p_actor uuid, p_kind text, p_data jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_id bigint;
begin
  perform public.staff_assert_actor(p_actor, true);
  if jsonb_typeof(p_data) <> 'object' then
    raise exception using errcode = '22023', message = 'INVALID_REFERENCE_DATA';
  end if;

  if p_kind = 'settings' then
    select to_jsonb(s) into v_before from public.site_settings s where id for update;
    update public.site_settings set
      event_name = btrim(p_data->>'event_name'),
      venue = nullif(btrim(p_data->>'venue'), ''),
      address = nullif(btrim(p_data->>'address'), ''),
      -- A textarea: also trims line breaks, tabs and full-width spaces (an ASCII escape, since editors
      -- drop invisible characters), so a blank note clears it.
      event_note = case when p_data ? 'event_note'
        then nullif(btrim(p_data->>'event_note', E' \t\r\n\u3000'), '') else event_note end,
      registration_deadline_at = nullif(p_data->>'registration_deadline_at', '')::timestamptz,
      is_registration_open = (p_data->>'is_registration_open')::boolean,
      is_lookup_open = coalesce((p_data->>'is_lookup_open')::boolean, is_lookup_open),
      updated_at = now()
    where id returning to_jsonb(site_settings.*) into v_after;
  elsif p_kind = 'hosting' then
    select to_jsonb(s) into v_before from public.site_settings s where id for update;
    update public.site_settings set
      is_hosting_open = (p_data->>'is_hosting_open')::boolean,
      hosting_description = nullif(btrim(p_data->>'hosting_description'), ''),
      updated_at = now()
    where id returning to_jsonb(site_settings.*) into v_after;
  elsif p_kind = 'district' then
    v_id := nullif(p_data->>'id', '')::bigint;
    if v_id is null then
      insert into public.districts (name, sort_order)
      values (btrim(p_data->>'name'), (p_data->>'sort_order')::integer)
      returning to_jsonb(districts.*) into v_after;
    else
      select to_jsonb(d) into v_before from public.districts d where id = v_id for update;
      update public.districts set name = btrim(p_data->>'name'),
        sort_order = (p_data->>'sort_order')::integer
      where id = v_id returning to_jsonb(districts.*) into v_after;
    end if;
  elsif p_kind = 'activity' then
    v_id := nullif(p_data->>'id', '')::bigint;
    if v_id is null then
      insert into public.activities
        (category, title, starts_at, starts_at_has_time, ends_at, ends_at_has_time,
         venue, address, map_url, description, fee_amount, student_fee_amount, cost_amount,
         audience, audience_note, is_published, sort_order, affects_conference_import)
      values (
        p_data->>'category', btrim(p_data->>'title'),
        nullif(p_data->>'starts_at', '')::timestamptz,
        coalesce((p_data->>'starts_at_has_time')::boolean, nullif(p_data->>'starts_at', '') is not null),
        nullif(p_data->>'ends_at', '')::timestamptz,
        coalesce((p_data->>'ends_at_has_time')::boolean, nullif(p_data->>'ends_at', '') is not null),
        nullif(btrim(p_data->>'venue'), ''), nullif(btrim(p_data->>'address'), ''),
        nullif(btrim(p_data->>'map_url'), ''), nullif(btrim(p_data->>'description'), ''),
        nullif(p_data->>'fee_amount', '')::integer,
        nullif(p_data->>'student_fee_amount', '')::integer,
        nullif(p_data->>'cost_amount', '')::integer,
        coalesce(nullif(p_data->>'audience', ''), 'all'),
        nullif(btrim(p_data->>'audience_note'), ''),
        (p_data->>'is_published')::boolean, (p_data->>'sort_order')::integer,
        coalesce((p_data->>'affects_conference_import')::boolean, false)
      ) returning to_jsonb(activities.*) into v_after;
    else
      select to_jsonb(a) into v_before from public.activities a where id = v_id for update;
      update public.activities set
        category = p_data->>'category', title = btrim(p_data->>'title'),
        starts_at = nullif(p_data->>'starts_at', '')::timestamptz,
        starts_at_has_time = coalesce((p_data->>'starts_at_has_time')::boolean, nullif(p_data->>'starts_at', '') is not null),
        ends_at = nullif(p_data->>'ends_at', '')::timestamptz,
        ends_at_has_time = coalesce((p_data->>'ends_at_has_time')::boolean, nullif(p_data->>'ends_at', '') is not null),
        venue = nullif(btrim(p_data->>'venue'), ''),
        address = nullif(btrim(p_data->>'address'), ''),
        map_url = nullif(btrim(p_data->>'map_url'), ''),
        description = nullif(btrim(p_data->>'description'), ''),
        fee_amount = nullif(p_data->>'fee_amount', '')::integer,
        student_fee_amount = case when p_data ? 'student_fee_amount'
          then nullif(p_data->>'student_fee_amount', '')::integer else student_fee_amount end,
        cost_amount = case when p_data ? 'cost_amount'
          then nullif(p_data->>'cost_amount', '')::integer else cost_amount end,
        audience = case when p_data ? 'audience'
          then coalesce(nullif(p_data->>'audience', ''), 'all') else audience end,
        audience_note = case when p_data ? 'audience_note'
          then nullif(btrim(p_data->>'audience_note'), '') else audience_note end,
        is_published = (p_data->>'is_published')::boolean,
        -- An older page sends no setting; keep the stored one.
        affects_conference_import = case when p_data ? 'affects_conference_import'
          then (p_data->>'affects_conference_import')::boolean else affects_conference_import end,
        sort_order = (p_data->>'sort_order')::integer,
        updated_at = now()
      where id = v_id returning to_jsonb(activities.*) into v_after;
    end if;
  elsif p_kind = 'program' then
    v_id := nullif(p_data->>'id', '')::bigint;
    if v_id is null then
      insert into public.program_items
        (event_date, start_time, end_time, title, note, sort_order, is_visible)
      values (
        (p_data->>'event_date')::date, nullif(p_data->>'start_time', '')::time,
        nullif(p_data->>'end_time', '')::time, btrim(p_data->>'title'),
        nullif(btrim(p_data->>'note'), ''), (p_data->>'sort_order')::integer,
        (p_data->>'is_visible')::boolean
      ) returning to_jsonb(program_items.*) into v_after;
    else
      select to_jsonb(p) into v_before from public.program_items p where id = v_id for update;
      update public.program_items set
        event_date = (p_data->>'event_date')::date,
        start_time = nullif(p_data->>'start_time', '')::time,
        end_time = nullif(p_data->>'end_time', '')::time,
        title = btrim(p_data->>'title'), note = nullif(btrim(p_data->>'note'), ''),
        sort_order = (p_data->>'sort_order')::integer,
        is_visible = (p_data->>'is_visible')::boolean
      where id = v_id returning to_jsonb(program_items.*) into v_after;
    end if;
  else
    raise exception using errcode = '22023', message = 'INVALID_REFERENCE_KIND';
  end if;

  if v_after is null then
    raise exception using errcode = '22023', message = 'REFERENCE_NOT_FOUND';
  end if;
  if p_kind = 'activity' and v_before is not null
    and ((v_before->'affects_conference_import') is distinct from (v_after->'affects_conference_import')
      or ((v_after->>'affects_conference_import')::boolean and (v_before->'title', v_before->'starts_at', v_before->'starts_at_has_time',
         v_before->'ends_at', v_before->'ends_at_has_time', v_before->'is_published')
      is distinct from
        (v_after->'title', v_after->'starts_at', v_after->'starts_at_has_time',
         v_after->'ends_at', v_after->'ends_at_has_time', v_after->'is_published'))) then
    with affected as (
      update public.registrations r
      set import_status = 'reimport_needed', updated_at = now()
      where r.import_status = 'imported' and r.record_status = 'active'
        and exists (
          select 1 from public.registration_choices c
          where c.registration_id = r.id and c.activity_id = (v_after->>'id')::bigint
            and c.attending
        )
      returning r.id
    )
    insert into public.audit_events
      (actor_type, actor_user_id, action, target_type, target_id, before_data, after_data)
    select 'admin', p_actor, 'registration.reimport_needed', 'registration', id,
      '{"import_status":"imported"}'::jsonb,
      '{"import_status":"reimport_needed"}'::jsonb
    from affected;
  end if;
  if (v_before - 'updated_at') is distinct from (v_after - 'updated_at') then
    insert into public.audit_events
      (actor_type, actor_user_id, action, target_type, before_data, after_data)
    values ('admin', p_actor, 'reference.saved', p_kind, v_before, v_after);
  end if;
  return v_after;
end;
$$;


-- ===== 202611110003_survey_identities.sql =====

-- Close registration while applying; then deploy both Edge Functions and the site.
-- Existing answers remain stored. Only validity changes; import statuses are untouched.
alter table public.site_settings
  add column hosting_identity_codes text[] not null default array['general'],
  add column pickup_identity_codes text[] not null default array['general'],
  add constraint hosting_identities_not_empty check (not is_hosting_open or cardinality(hosting_identity_codes)>0),
  add constraint pickup_identities_not_empty check (not is_pickup_open or cardinality(pickup_identity_codes)>0);
alter table public.registration_hosting add column answer_valid boolean not null default true;
alter table public.registration_pickup add column answer_valid boolean not null default true;

-- A 否 is invalid only when the latest audit row that set it is a system action (child_updated,
-- hosting_general_only). Identity never decides it: older saves audit meal_identity too, so a
-- student's own 否 looks the same. shortcut: a 否 that 202611100004 forced inside registration.updated
-- or staff_updated stays valid; only a non-general save made between 202611100004 and this one leaves it.
update public.registration_hosting h set answer_valid=false
from public.registrations r where r.id=h.registration_id and (
  h.status='not_hosting' and coalesce((
    select e.action in ('registration.child_updated','registration.hosting_general_only')
    from public.audit_events e where e.target_id=r.id and (
      e.action in ('registration.created','registration.staff_created') and e.after_data->'hosting' is not null
      or e.action='registration.child_updated' and e.after_data->'hosting' is not null
      or e.action in ('registration.updated','registration.staff_updated','registration.hosting_general_only')
        and e.before_data->'hosting' is distinct from e.after_data->'hosting')
    order by e.created_at desc,e.id desc limit 1),false));
update public.registration_pickup p set answer_valid=false
from public.registrations r where r.id=p.registration_id and (
  p.status='no' and coalesce((
    select e.action in ('registration.child_updated','registration.hosting_general_only')
    from public.audit_events e where e.target_id=r.id and (
      e.action='registration.pickup_updated'
      or e.action='registration.child_updated' and e.after_data->'pickup' is not null
      or e.action='registration.hosting_general_only'
        and e.before_data->'pickup' is distinct from e.after_data->'pickup')
    order by e.created_at desc,e.id desc limit 1),false));

create function public.survey_identity_allowed(p_kind text,p_identity text) returns boolean
language sql stable security invoker set search_path='' as $$
  select coalesce(coalesce(p_identity,'general')=any(case p_kind when 'hosting' then hosting_identity_codes
    when 'pickup' then pickup_identity_codes end),false) from public.site_settings where id;
$$;
revoke all on function public.survey_identity_allowed(text,text) from public,anon,authenticated;
grant execute on function public.survey_identity_allowed(text,text) to service_role;

create or replace function public.registration_hosting_get(p_registration_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('status',status,'guest_type',guest_type,'guest_count',guest_count,'pickup_count',pickup_count)
    || case when answer_valid then '{}'::jsonb else '{"answer_valid":false}'::jsonb end
  from public.registration_hosting where registration_id=p_registration_id;
$$;
create or replace function public.registration_pickup_get(p_registration_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('status',status,'count',count)
    || case when answer_valid then '{}'::jsonb else '{"answer_valid":false}'::jsonb end
  from public.registration_pickup where registration_id=p_registration_id;
$$;

create function public.survey_audience_valid(p_identity text,p_choices jsonb,p_hosting jsonb,p_pickup jsonb)
returns boolean language sql stable security invoker set search_path='' as $$
  select not exists (
    select 1 from jsonb_array_elements(p_choices) c join public.activities a on a.id=(c->>'activity_id')::bigint
    where (c->>'attending')::boolean and (
      a.audience='hosting' and public.survey_identity_allowed('hosting',p_identity)
        and not coalesce(p_hosting->>'status' in ('hosting','family_registered') and coalesce((p_hosting->>'answer_valid')::boolean,true),false)
      or a.audience='pickup' and public.survey_identity_allowed('pickup',p_identity)
        and not coalesce(p_pickup->>'status'='yes' and coalesce((p_pickup->>'answer_valid')::boolean,true),false)
      or a.audience like 'activity:%' and not exists (
        select 1 from public.activities required join jsonb_array_elements(p_choices) rc on required.id=(rc->>'activity_id')::bigint
        where required.id=substring(a.audience from 10)::bigint and required.is_published and (rc->>'attending')::boolean)));
$$;
revoke all on function public.survey_audience_valid(text,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.survey_audience_valid(text,jsonb,jsonb,jsonb) to service_role;


create or replace function public.create_registration(
  p_request_id uuid,
  p_full_name text,
  p_district_id integer,
  p_choices jsonb,
  p_hosting jsonb default null,
  p_meal_identity text default null
)
returns table (registration_id uuid, serial_no bigint)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_registration_id uuid;
  v_serial_no bigint;
  v_hosting jsonb;
  v_identity text;
  v_settings public.site_settings%rowtype;
begin
  select * into v_settings from public.site_settings where id;
  if not coalesce(v_settings.is_registration_open
      and (v_settings.registration_deadline_at is null or v_settings.registration_deadline_at > now()), false) then
    raise exception using errcode = 'P0001', message = 'REGISTRATION_CLOSED';
  end if;
  if coalesce(length(btrim(p_full_name)), 0) not between 1 and 100
    or public.registration_name_key(p_full_name) = '' then
    raise exception using errcode = '22023', message = 'INVALID_NAME';
  end if;
  if not exists (select 1 from public.districts where id = p_district_id) then
    raise exception using errcode = '22023', message = 'INVALID_DISTRICT';
  end if;
  if public.registration_choices_valid(p_choices) is not true then
    raise exception using errcode = '22023', message = 'INVALID_CHOICES';
  end if;
  if coalesce(current_setting('registration.surveys_managed',true),'') <> 'on' then
  v_hosting := public.registration_hosting_value(p_hosting);
  if not v_settings.is_hosting_open and v_hosting is not null then
    raise exception using errcode = 'P0001', message = 'HOSTING_CLOSED';
  end if;
  if v_settings.is_hosting_open and v_hosting is null then
    raise exception using errcode = 'P0001', message = 'HOSTING_REQUIRED';
  end if;
  if public.registration_audience_valid(p_choices, v_hosting) is not true then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  else v_hosting := null; end if;
  v_identity := public.registration_meal_identity(p_choices, p_meal_identity);

  update public.registration_create_limits
  set window_started_at = case when window_started_at <= now() - interval '10 minutes' then now() else window_started_at end,
      created_count = case when window_started_at <= now() - interval '10 minutes' then 1 else created_count + 1 end
  where id = true
    and (window_started_at <= now() - interval '10 minutes' or created_count < 150);
  if not found then
    raise exception using errcode = 'P0001', message = 'CREATE_RATE_LIMITED';
  end if;

  insert into public.registrations (create_request_id, full_name, district_id, meal_identity)
  values (p_request_id, btrim(p_full_name), p_district_id, v_identity)
  returning id, registrations.serial_no into v_registration_id, v_serial_no;
  insert into public.registration_choices (registration_id, activity_id, attending)
  select v_registration_id, (choice->>'activity_id')::bigint, (choice->>'attending')::boolean
  from jsonb_array_elements(p_choices) choice;
  if v_hosting is not null then perform public.registration_hosting_put(v_registration_id, v_hosting); end if;
  insert into public.audit_events (actor_type, action, target_type, target_id, after_data)
  values ('public', 'registration.created', 'registration', v_registration_id,
    jsonb_build_object('full_name', btrim(p_full_name), 'district_id', p_district_id, 'hosting', v_hosting,
      'meal_identity', v_identity));

  return query select v_registration_id, v_serial_no;
exception
  when unique_violation then
    if exists (select 1 from public.registrations where create_request_id = p_request_id) then
      raise exception using errcode = '23505', message = 'DUPLICATE_REQUEST';
    end if;
    if exists (select 1 from public.registrations where district_id = p_district_id
        and record_status = 'active' and name_key = public.registration_name_key(p_full_name)) then
      raise exception using errcode = '23505', message = 'NAME_TAKEN';
    end if;
    raise;
  when invalid_text_representation then
    raise exception using errcode = '22023', message = 'INVALID_CHOICES';
end;
$$;

create or replace function public.staff_create_registration(
  p_actor uuid, p_request_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null
)
returns table (registration_id uuid, serial_no bigint)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
  v_serial bigint;
  v_hosting jsonb;
  v_identity text;
begin
  perform public.staff_assert_actor(p_actor);
  if coalesce(length(btrim(p_full_name)), 0) not between 1 and 100
    or public.registration_name_key(p_full_name) = ''
    or not exists (select 1 from public.districts where id = p_district_id) then
    raise exception using errcode = '22023', message = 'INVALID_REGISTRATION';
  end if;
  if public.registration_choices_valid(p_choices) is not true then
    raise exception using errcode = '22023', message = 'INVALID_CHOICES';
  end if;
  if coalesce(current_setting('registration.surveys_managed',true),'') <> 'on' then
  v_hosting := public.registration_hosting_value(p_hosting);
  if v_hosting is null and coalesce((select is_hosting_open from public.site_settings where id), false) then
    raise exception using errcode = 'P0001', message = 'HOSTING_REQUIRED';
  end if;
  if public.registration_audience_valid(p_choices, v_hosting) is not true then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  else v_hosting := null; end if;
  v_identity := public.registration_meal_identity(p_choices, p_meal_identity);

  insert into public.registrations
    (create_request_id, full_name, district_id, meal_identity)
  values (p_request_id, btrim(p_full_name), p_district_id, v_identity)
  returning id, registrations.serial_no into v_id, v_serial;
  insert into public.registration_choices (registration_id, activity_id, attending)
  select v_id, (choice->>'activity_id')::bigint, (choice->>'attending')::boolean
  from jsonb_array_elements(p_choices) choice;
  if v_hosting is not null then perform public.registration_hosting_put(v_id, v_hosting); end if;
  insert into public.audit_events (actor_type, actor_user_id, action, target_type, target_id, after_data)
  values ('staff', p_actor, 'registration.staff_created', 'registration', v_id,
    jsonb_build_object('full_name', btrim(p_full_name), 'district_id', p_district_id, 'hosting', v_hosting,
      'meal_identity', v_identity));
  return query select v_id, v_serial;
exception
  when unique_violation then
    if exists (select 1 from public.registrations where create_request_id = p_request_id) then
      raise exception using errcode = '23505', message = 'DUPLICATE_REQUEST';
    end if;
    if exists (select 1 from public.registrations where district_id = p_district_id
        and record_status = 'active' and name_key = public.registration_name_key(p_full_name)) then
      raise exception using errcode = '23505', message = 'NAME_TAKEN';
    end if;
    raise;
  when invalid_text_representation then
    raise exception using errcode = '22023', message = 'INVALID_CHOICES';
end;
$$;

create or replace function public.update_registration(
  p_full_name text,
  p_district_id integer,
  p_choices jsonb,
  p_hosting jsonb default null,
  p_meal_identity text default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_registration public.registrations%rowtype;
  v_before_choices jsonb;
  v_after_choices jsonb;
  v_before_hosting jsonb;
  v_after_hosting jsonb;
  v_identity text;
  v_import_change boolean;
  v_settings public.site_settings%rowtype;
begin
  select * into v_settings from public.site_settings where id;
  if not coalesce(v_settings.is_registration_open
      and (v_settings.registration_deadline_at is null or v_settings.registration_deadline_at > now()), false) then
    raise exception using errcode = 'P0001', message = 'REGISTRATION_CLOSED';
  end if;
  if not coalesce(v_settings.is_lookup_open, false) then
    raise exception using errcode = 'P0001', message = 'LOOKUP_CLOSED';
  end if;

  select * into v_registration from public.registrations
  where district_id = p_district_id and name_key = public.registration_name_key(p_full_name)
    and record_status = 'active'
  for update;
  if not found then return false; end if;
  if public.registration_choices_valid(p_choices) is not true then
    raise exception using errcode = '22023', message = 'INVALID_CHOICES';
  end if;
  if coalesce(current_setting('registration.surveys_managed',true),'') <> 'on' then
  v_before_hosting := public.registration_hosting_get(v_registration.id);
  -- An older page sends no pickup_count; keep the stored one instead of resetting it to 0.
  -- ->> is null also covers an explicit JSON null, which registration_hosting_value would turn into 0.
  if jsonb_typeof(p_hosting) = 'object' and p_hosting->>'pickup_count' is null then
    p_hosting := p_hosting || jsonb_build_object('pickup_count', coalesce(v_before_hosting->'pickup_count', '0'));
  end if;
  v_after_hosting := public.registration_hosting_value(p_hosting);
  if not v_settings.is_hosting_open
    and v_after_hosting is not null and v_after_hosting is distinct from v_before_hosting then
    raise exception using errcode = 'P0001', message = 'HOSTING_CLOSED';
  end if;
  -- No answer sent keeps the stored one: a page loaded before the switch opened, or an older page
  -- or Edge Function, sends none. Only a registration that never answered must answer now.
  v_after_hosting := case when v_settings.is_hosting_open then coalesce(v_after_hosting, v_before_hosting)
    else v_before_hosting end;
  if v_after_hosting is null and v_settings.is_hosting_open then
    raise exception using errcode = 'P0001', message = 'HOSTING_REQUIRED';
  end if;
  if public.registration_audience_valid(p_choices, v_after_hosting) is not true then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  else v_before_hosting := null; v_after_hosting := null; end if;
  v_identity := public.registration_meal_identity(p_choices, p_meal_identity, v_registration.meal_identity);

  select coalesce(jsonb_agg(jsonb_build_object('activity_id', activity_id, 'attending', attending)
    order by activity_id), '[]'::jsonb) into v_before_choices
  from public.registration_choices where registration_id = v_registration.id
    and activity_id in (select id from public.activities where is_published);
  select coalesce(jsonb_agg(jsonb_build_object('activity_id', activity_id, 'attending', attending)
    order by activity_id), '[]'::jsonb) into v_after_choices
  from (
    select (choice->>'activity_id')::bigint as activity_id, (choice->>'attending')::boolean as attending
    from jsonb_array_elements(p_choices) choice
  ) answers;
  -- Hosting answers are imported into the assembly system too, so any change needs a re-import.
  v_import_change := public.conference_choices(v_before_choices) <> public.conference_choices(v_after_choices) or v_before_hosting is distinct from v_after_hosting
    or v_registration.meal_identity is distinct from v_identity;
  if not v_import_change and v_before_choices = v_after_choices then
    return true;
  end if;

  update public.registrations set
    meal_identity = v_identity,
    import_status = case when v_import_change and import_status = 'imported' then 'reimport_needed'
      else import_status end,
    updated_at = now()
  where id = v_registration.id;
  insert into public.registration_choices (registration_id, activity_id, attending)
  select v_registration.id, (choice->>'activity_id')::bigint, (choice->>'attending')::boolean
  from jsonb_array_elements(p_choices) choice
  on conflict (registration_id, activity_id) do update
    set attending = excluded.attending, updated_at = now();
  if v_after_hosting is distinct from v_before_hosting then
    perform public.registration_hosting_put(v_registration.id, v_after_hosting);
  end if;
  insert into public.audit_events (actor_type, action, target_type, target_id, before_data, after_data)
  values ('public', 'registration.updated', 'registration', v_registration.id,
    jsonb_build_object('choices', v_before_choices, 'hosting', v_before_hosting,
      'meal_identity', v_registration.meal_identity, 'import_status', v_registration.import_status),
    jsonb_build_object('choices', v_after_choices, 'hosting', v_after_hosting, 'meal_identity', v_identity,
      'import_status', case when v_import_change and v_registration.import_status = 'imported'
        then 'reimport_needed' else v_registration.import_status end));
  return true;
exception
  when invalid_text_representation then
    raise exception using errcode = '22023', message = 'INVALID_CHOICES';
end;
$$;

create or replace function public.staff_update_registration(
  p_actor uuid, p_registration_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_registration public.registrations%rowtype;
  v_before_choices jsonb;
  v_after_choices jsonb;
  v_before_hosting jsonb;
  v_after_hosting jsonb;
  v_identity text;
  v_import_change boolean;
begin
  perform public.staff_assert_actor(p_actor);
  select * into v_registration from public.registrations
  where id = p_registration_id and record_status = 'active' for update;
  if not found then return false; end if;

  if coalesce(length(btrim(p_full_name)), 0) not between 1 and 100
    or public.registration_name_key(p_full_name) = ''
    or not exists (select 1 from public.districts where id = p_district_id) then
    raise exception using errcode = '22023', message = 'INVALID_REGISTRATION';
  end if;
  if public.registration_choices_valid(p_choices, p_registration_id) is not true then
    raise exception using errcode = '22023', message = 'INVALID_CHOICES';
  end if;
  if coalesce(current_setting('registration.surveys_managed',true),'') <> 'on' then
  v_before_hosting := public.registration_hosting_get(p_registration_id);
  -- An older page sends no pickup_count; keep the stored one instead of resetting it to 0.
  -- ->> is null also covers an explicit JSON null, which registration_hosting_value would turn into 0.
  if jsonb_typeof(p_hosting) = 'object' and p_hosting->>'pickup_count' is null then
    p_hosting := p_hosting || jsonb_build_object('pickup_count', coalesce(v_before_hosting->'pickup_count', '0'));
  end if;
  -- No answer sent keeps the stored one (for example a cached older back-office page).
  v_after_hosting := coalesce(public.registration_hosting_value(p_hosting), v_before_hosting);
  if public.registration_audience_valid(p_choices, v_after_hosting) is not true then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  else v_before_hosting := null; v_after_hosting := null; end if;
  v_identity := public.registration_meal_identity(p_choices, p_meal_identity, v_registration.meal_identity);

  select coalesce(jsonb_agg(jsonb_build_object('activity_id', activity_id, 'attending', attending)
    order by activity_id), '[]'::jsonb) into v_before_choices
  from public.registration_choices where registration_id = p_registration_id
    and activity_id in (select id from public.activities where is_published);
  select coalesce(jsonb_agg(jsonb_build_object('activity_id', activity_id, 'attending', attending)
    order by activity_id), '[]'::jsonb) into v_after_choices
  from (
    select (choice->>'activity_id')::bigint as activity_id,
      (choice->>'attending')::boolean as attending
    from jsonb_array_elements(p_choices) choice
  ) answers;

  v_import_change := v_registration.full_name <> btrim(p_full_name) or v_registration.district_id <> p_district_id
    or public.conference_choices(v_before_choices) <> public.conference_choices(v_after_choices) or v_before_hosting is distinct from v_after_hosting
    or v_registration.meal_identity is distinct from v_identity;
  if not v_import_change and v_before_choices = v_after_choices then return true; end if;

  update public.registrations set full_name = btrim(p_full_name), district_id = p_district_id,
    meal_identity = v_identity,
    import_status = case when v_import_change and import_status = 'imported' then 'reimport_needed'
      else import_status end,
    updated_at = now()
  where id = p_registration_id;
  insert into public.registration_choices (registration_id, activity_id, attending)
  select p_registration_id, (choice->>'activity_id')::bigint, (choice->>'attending')::boolean
  from jsonb_array_elements(p_choices) choice
  on conflict (registration_id, activity_id) do update
    set attending = excluded.attending, updated_at = now();
  if v_after_hosting is distinct from v_before_hosting then
    perform public.registration_hosting_put(p_registration_id, v_after_hosting);
  end if;
  insert into public.audit_events (actor_type, actor_user_id, action, target_type, target_id, before_data, after_data)
  values ('staff', p_actor, 'registration.staff_updated', 'registration', p_registration_id,
    jsonb_build_object('full_name', v_registration.full_name, 'district_id', v_registration.district_id,
      'choices', v_before_choices, 'hosting', v_before_hosting, 'meal_identity', v_registration.meal_identity,
      'import_status', v_registration.import_status),
    jsonb_build_object('full_name', btrim(p_full_name), 'district_id', p_district_id, 'choices', v_after_choices,
      'hosting', v_after_hosting, 'meal_identity', v_identity,
      'import_status', case when v_import_change and v_registration.import_status = 'imported'
        then 'reimport_needed' else v_registration.import_status end));
  return true;
exception
  when unique_violation then
    if exists (select 1 from public.registrations where district_id = p_district_id
        and record_status = 'active' and id <> p_registration_id
        and name_key = public.registration_name_key(p_full_name)) then
      raise exception using errcode = '23505', message = 'NAME_TAKEN';
    end if;
    raise;
  when invalid_text_representation then
    raise exception using errcode = '22023', message = 'INVALID_CHOICES';
end;
$$;

-- Central lifecycle for both surveys; the existing base RPCs retain name/choice/rate-limit rules.
create or replace function public.save_registration_surveys(p_actor uuid,p_id uuid,p_request uuid,p_full_name text,
  p_district integer,p_choices jsonb,p_hosting jsonb,p_identity text,p_pickup jsonb,p_child_type text,p_parent text)
returns uuid language plpgsql security invoker set search_path='' as $$
declare r public.registrations; s public.site_settings; new_id uuid; new_serial bigint;
  identity_code text; v_child_type text; v_parent_name text; kind text; before_answer jsonb; after_answer jsonb;
  payload jsonb; allowed boolean; opened boolean; leaving boolean; changed boolean; was_valid boolean; valid boolean;
  actor_type text := case when p_actor is null then 'public' else 'staff' end;
begin
  select * into strict s from public.site_settings where id for share;
  if p_actor is not null then perform public.staff_assert_actor(p_actor,false); end if;
  -- Closed public operations must fail alike before looking up a name.
  if p_actor is null and p_request is null then
    if not s.is_registration_open or (s.registration_deadline_at is not null and s.registration_deadline_at<=now()) then
      raise exception using errcode='P0001',message='REGISTRATION_CLOSED';
    end if;
    if not s.is_lookup_open then raise exception using errcode='P0001',message='LOOKUP_CLOSED'; end if;
  end if;
  if p_request is null then
    if p_actor is null then
      select * into r from public.registrations where full_name is not null and district_id=p_district
        and name_key=public.registration_name_key(p_full_name) and record_status='active' for update;
    else
      select * into r from public.registrations where id=p_id and record_status='active' for update;
    end if;
    if r.id is null then return null; end if;
  elsif p_identity is null then
    raise exception using errcode='P0001',message='MEAL_IDENTITY_REQUIRED';
  end if;
  identity_code := coalesce(p_identity,r.meal_identity,'general');
  v_child_type := case identity_code when 'child' then 'elementary' when 'preschool' then 'preschool' end;
  if v_child_type is not null then
    v_parent_name := public.registration_parent_name(true,case when p_parent is null and r.child_type is not null then r.parent_name else p_parent end);
  end if;
  perform set_config('registration.saving_child',coalesce(v_child_type,''),true);
  perform set_config('registration.staff_identity',case when p_actor is null then '' else 'on' end,true);
  perform set_config('registration.surveys_managed','on',true);
  if p_request is not null then
    if p_actor is null then
      select registration_id,serial_no into new_id,new_serial from public.create_registration(p_request,p_full_name,p_district,p_choices,null,identity_code);
    else
      select registration_id,serial_no into new_id,new_serial from public.staff_create_registration(p_actor,p_request,p_full_name,p_district,p_choices,null,identity_code);
    end if;
  else
    new_id:=r.id;
    if not (case when p_actor is null then public.update_registration(p_full_name,p_district,p_choices,null,identity_code)
      else public.staff_update_registration(p_actor,new_id,p_full_name,p_district,p_choices,null,identity_code) end) then
      -- The flags must not leak into a later save in the same transaction.
      perform set_config('registration.surveys_managed','',true);
      perform set_config('registration.saving_child','',true);
      perform set_config('registration.staff_identity','',true);
      return null;
    end if;
  end if;
  if (r.child_type,r.parent_name) is distinct from (v_child_type,v_parent_name) then
    update public.registrations set is_child=v_child_type is not null,child_type=v_child_type,
      parent_name=v_parent_name,updated_at=now() where id=new_id;
    insert into public.audit_events(actor_type,actor_user_id,action,target_type,target_id,before_data,after_data)
      values(actor_type,p_actor,'registration.child_updated','registration',new_id,
        jsonb_build_object('is_child',coalesce(r.is_child,false),'child_type',r.child_type,'parent_name',r.parent_name),
        jsonb_build_object('is_child',v_child_type is not null,'child_type',v_child_type,'parent_name',v_parent_name));
  end if;
  foreach kind in array array['hosting','pickup'] loop
    before_answer:=case kind when 'hosting' then public.registration_hosting_get(new_id) else public.registration_pickup_get(new_id) end;
    was_valid:=before_answer is not null and coalesce((before_answer->>'answer_valid')::boolean,true);
    valid:=was_valid;
    payload:=case kind when 'hosting' then p_hosting else p_pickup end;
    allowed:=public.survey_identity_allowed(kind,identity_code);
    opened:=case kind when 'hosting' then s.is_hosting_open else s.is_pickup_open end;
    -- Saving a move out of this survey's identities stores 否 (decided 2026-11-11); staff saving a
    -- survey closed or not open to the identity also stores 否 (decided 2026-11-12). Whatever the
    -- page sent for this survey is then ignored.
    leaving:=p_request is null and r.meal_identity is distinct from identity_code
      and public.survey_identity_allowed(kind,r.meal_identity) and not allowed;
    if leaving or (p_actor is not null and (not allowed or not opened)) then
      payload:=case kind when 'hosting' then '{"status":"not_hosting"}'::jsonb else '{"status":"no","count":0}'::jsonb end;
    end if;
    if payload='{"reset":true}'::jsonb and p_request is null then
      -- A public page may only reset a survey its identity can answer.
      if p_actor is not null or allowed then valid:=false; end if;
      after_answer:=null;
      if p_actor is null and allowed and opened then
        raise exception using errcode='P0001',message=upper(kind)||'_REQUIRED';
      end if;
    else
      if kind='hosting' and jsonb_typeof(payload)='object' and payload->>'pickup_count' is null then
        payload:=payload||jsonb_build_object('pickup_count',coalesce(before_answer->'pickup_count','0'::jsonb));
      end if;
      after_answer:=case when kind='hosting' then public.registration_hosting_value(payload) else public.registration_pickup_value(payload) end;
    end if;
    if p_actor is null and (not allowed or not opened) and not leaving then
      if after_answer is not null and after_answer is distinct from
        (case kind when 'hosting' then public.registration_hosting_value(before_answer) else public.registration_pickup_value(before_answer) end) then
        raise exception using errcode='P0001',message=upper(kind)||case when not allowed then '_NOT_ALLOWED' else '_CLOSED' end;
      end if;
      -- Changing configuration alone neither changes nor invalidates answers.
      after_answer:=before_answer;
    else
      if p_actor is null and allowed and opened and not was_valid and after_answer is null then
        raise exception using errcode='P0001',message=upper(kind)||'_REQUIRED';
      end if;
      if p_request is not null and allowed and opened and after_answer is null then
        raise exception using errcode='P0001',message=upper(kind)||'_REQUIRED';
      end if;
      if after_answer is not null then
        valid:=true;
        if kind='hosting' then perform public.registration_hosting_put(new_id,after_answer);
        else perform public.registration_pickup_put(new_id,after_answer); end if;
      else
        after_answer:=before_answer;
      end if;
    end if;
    if kind='hosting' then update public.registration_hosting set answer_valid=valid where registration_id=new_id;
    else update public.registration_pickup set answer_valid=valid where registration_id=new_id; end if;
    changed := (before_answer-'answer_valid') is distinct from (after_answer-'answer_valid') or was_valid is distinct from valid;
    if changed then
      update public.registrations set updated_at=now(),import_status=case when import_status='imported' then 'reimport_needed' else import_status end where id=new_id;
      insert into public.audit_events(actor_type,actor_user_id,action,target_type,target_id,before_data,after_data)
        values(actor_type,p_actor,'registration.'||kind||'_updated','registration',new_id,
          jsonb_build_object(kind,before_answer,'answer_valid',was_valid),jsonb_build_object(kind,after_answer,'answer_valid',valid));
    end if;
  end loop;
  if not public.survey_audience_valid(identity_code,p_choices,public.registration_hosting_get(new_id),public.registration_pickup_get(new_id)) then
    raise exception using errcode='P0001',message='AUDIENCE_RESTRICTED';
  end if;
  perform set_config('registration.surveys_managed','',true);
  perform set_config('registration.saving_child','',true);
  perform set_config('registration.staff_identity','',true);
  return new_id;
end;
$$;
revoke all on function public.save_registration_surveys(uuid,uuid,uuid,text,integer,jsonb,jsonb,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.save_registration_surveys(uuid,uuid,uuid,text,integer,jsonb,jsonb,text,jsonb,text,text) to service_role;

create or replace function public.create_registration_with_pickup(p_request_id uuid,p_full_name text,p_district_id integer,p_choices jsonb,
  p_hosting jsonb default null,p_meal_identity text default null,p_pickup jsonb default null,p_child_type text default '',p_parent_name text default null)
returns table(registration_id uuid,serial_no bigint) language plpgsql security invoker set search_path='' as $$
declare saved uuid;
begin
  saved:=public.save_registration_surveys(null,null,p_request_id,p_full_name,p_district_id,p_choices,p_hosting,p_meal_identity,p_pickup,p_child_type,p_parent_name);
  return query select r.id,r.serial_no from public.registrations r where r.id=saved;
end;
$$;
create or replace function public.staff_create_registration_with_pickup(p_actor uuid,p_request_id uuid,p_full_name text,p_district_id integer,p_choices jsonb,
  p_hosting jsonb default null,p_meal_identity text default null,p_pickup jsonb default null,p_child_type text default '',p_parent_name text default null)
returns table(registration_id uuid,serial_no bigint) language plpgsql security invoker set search_path='' as $$
declare saved uuid;
begin
  perform public.staff_assert_actor(p_actor,false);
  saved:=public.save_registration_surveys(p_actor,null,p_request_id,p_full_name,p_district_id,p_choices,p_hosting,p_meal_identity,p_pickup,p_child_type,p_parent_name);
  return query select r.id,r.serial_no from public.registrations r where r.id=saved;
end;
$$;
create or replace function public.update_registration_with_pickup(p_full_name text,p_district_id integer,p_choices jsonb,
  p_hosting jsonb default null,p_meal_identity text default null,p_pickup jsonb default null,p_child_type text default null,p_parent_name text default null)
returns boolean language sql security invoker set search_path='' as $$
  select public.save_registration_surveys(null,null,null,p_full_name,p_district_id,p_choices,p_hosting,p_meal_identity,p_pickup,p_child_type,p_parent_name) is not null;
$$;
create or replace function public.staff_update_registration_with_pickup(p_actor uuid,p_registration_id uuid,p_full_name text,p_district_id integer,p_choices jsonb,
  p_hosting jsonb default null,p_meal_identity text default null,p_pickup jsonb default null,p_child_type text default null,p_parent_name text default null)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
  perform public.staff_assert_actor(p_actor,false);
  return public.save_registration_surveys(p_actor,p_registration_id,null,p_full_name,p_district_id,p_choices,p_hosting,p_meal_identity,p_pickup,p_child_type,p_parent_name) is not null;
end;
$$;

-- The public page receives authoritative validity in the same save transaction, even if an
-- administrator changed targets while it was editing. Older clients may ignore the extra data.
create function public.update_registration_survey_result(p_full_name text,p_district_id integer,p_choices jsonb,
  p_hosting jsonb default null,p_meal_identity text default null,p_pickup jsonb default null,p_child_type text default null,p_parent_name text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
  if not public.update_registration_with_pickup(p_full_name,p_district_id,p_choices,p_hosting,p_meal_identity,p_pickup,p_child_type,p_parent_name) then return null; end if;
  select jsonb_build_object('success',true,'surveys',jsonb_build_object('hosting',public.registration_hosting_get(r.id),'pickup',public.registration_pickup_get(r.id)))
    into result from public.registrations r where r.district_id=p_district_id and r.name_key=public.registration_name_key(p_full_name) and r.record_status='active';
  return result;
end;
$$;
revoke all on function public.update_registration_survey_result(text,integer,jsonb,jsonb,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.update_registration_survey_result(text,integer,jsonb,jsonb,text,jsonb,text,text) to service_role;


create or replace function public.staff_registration_detail(p_actor uuid, p_registration_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare result jsonb;
begin
  perform public.staff_assert_actor(p_actor, false);
  select to_jsonb(detail) into result from (
    select r.id,r.serial_no,r.full_name,r.district_id,r.record_status,r.import_status,r.created_at,r.updated_at,
      r.meal_identity,r.is_child,r.child_type,r.parent_name,
      coalesce((select jsonb_agg(jsonb_build_object('activity_id',c.activity_id,'attending',c.attending))
        from public.registration_choices c where c.registration_id=r.id),'[]') as registration_choices,
      public.registration_hosting_get(r.id) as registration_hosting,
      public.registration_pickup_get(r.id) as registration_pickup,
      coalesce((select jsonb_agg(jsonb_build_object('serial_no',c.serial_no,'full_name',c.full_name) order by c.serial_no)
        from public.staff_registration_children(jsonb_build_array(jsonb_build_object('district_id',r.district_id,'name_key',r.name_key))) c
        where r.record_status='active' and not r.is_child),'[]') as children
    from public.registrations r where r.id=p_registration_id
  ) detail;
  return result;
end;
$$;

create or replace function public.staff_registration_statistics(p_actor uuid)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare v_result jsonb; v_hosting_codes text[]; v_pickup_codes text[];
begin
  perform public.staff_assert_actor(p_actor, false);
  select hosting_identity_codes,pickup_identity_codes into v_hosting_codes,v_pickup_codes from public.site_settings where id;
  with people as materialized (
    select r.id, r.district_id, r.meal_identity, r.child_type,
      case when h.registration_id is null and not (coalesce(r.meal_identity,'general')=any(v_hosting_codes)) then 'not_applicable' else h.status end as hosting_status, h.guest_type, h.guest_count,
      case when p.registration_id is null and not (coalesce(r.meal_identity,'general')=any(v_pickup_codes)) then 'not_applicable' else p.status end as pickup_status, p.count as pickup_count
    from public.registrations r
    left join public.registration_hosting h on h.registration_id = r.id and h.answer_valid
    left join public.registration_pickup p on p.registration_id = r.id and p.answer_valid
    where r.record_status = 'active'
  ), responses as materialized (
    select r.id, r.district_id, r.meal_identity, r.child_type, c.activity_id, c.attending,
      case coalesce(a.audience, 'all')
        when 'all' then true
        when 'hosting' then not (coalesce(r.meal_identity,'general')=any(v_hosting_codes))
          or coalesce(r.hosting_status in ('hosting','family_registered'), false)
        when 'pickup' then not (coalesce(r.meal_identity,'general')=any(v_pickup_codes))
          or coalesce(r.pickup_status = 'yes', false)
        else coalesce(required.attending, false) end as eligible
    from people r
    join public.registration_choices c on c.registration_id = r.id
    join public.activities a on a.id = c.activity_id and a.is_published
    left join public.activities prerequisite on 'activity:' || prerequisite.id::text = a.audience and prerequisite.is_published
    left join public.registration_choices required on required.registration_id = r.id and required.activity_id = prerequisite.id
  ), meal_attendees as (
    select distinct c.id from responses c join public.activities a on a.id = c.activity_id
    where c.attending and a.category = 'meal'
  ), person_counts as (
    select district_id, meal_identity, child_type, count(*) as count,
      count(*) filter (where meal_identity is null and m.id is not null) as no_identity
    from people left join meal_attendees m on m.id = people.id
    group by district_id, meal_identity, child_type
  ), choice_counts as (
    select district_id, meal_identity, child_type, activity_id, attending, eligible, count(*) as count
    from responses group by district_id, meal_identity, child_type, activity_id, attending, eligible
  ), hosting_counts as (
    select hosting_status as status, guest_type, count(*) as registrations,
      coalesce(sum(guest_count),0) as people
    from people group by hosting_status, guest_type
  ), pickup_counts as (
    select pickup_status as status, count(*) as registrations, coalesce(sum(pickup_count),0) as people
    from people group by pickup_status
  )
  select jsonb_build_object(
    'people', coalesce((select jsonb_agg(to_jsonb(x)) from person_counts x),'[]'),
    'choices', coalesce((select jsonb_agg(to_jsonb(x)) from choice_counts x),'[]'),
    'hosting', coalesce((select jsonb_agg(to_jsonb(x)) from hosting_counts x),'[]'),
    'pickup', coalesce((select jsonb_agg(to_jsonb(x)) from pickup_counts x),'[]')
  ) into v_result;
  return v_result;
end;
$$;

alter function public.staff_save_reference(uuid,text,jsonb) rename to staff_save_reference_before_surveys;
create function public.staff_save_reference(p_actor uuid,p_kind text,p_data jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare before_settings jsonb; result jsonb; h text[]; p text[];
begin
  perform public.staff_assert_actor(p_actor,true);
  if p_kind='delete_identity' then perform 1 from public.site_settings where id for update; end if;
  if p_kind='delete_identity' and exists(select 1 from public.site_settings where id and
    (p_data->>'code'=any(hosting_identity_codes) or p_data->>'code'=any(pickup_identity_codes))) then
    raise exception using errcode='22023',message='IDENTITY_IN_SURVEY_TARGETS';
  end if;
  if p_kind<>'hosting' then return public.staff_save_reference_before_surveys(p_actor,p_kind,p_data); end if;
  if jsonb_typeof(p_data->'is_hosting_open') is distinct from 'boolean' or jsonb_typeof(p_data->'is_pickup_open') is distinct from 'boolean' then
    raise exception using errcode='22023',message='INVALID_REFERENCE_DATA';
  end if;
  select to_jsonb(s),s.hosting_identity_codes,s.pickup_identity_codes into before_settings,h,p from public.site_settings s where id for update;
  if p_data ? 'hosting_identity_codes' then
    if jsonb_typeof(p_data->'hosting_identity_codes')<>'array' then raise exception using errcode='22023',message='INVALID_SURVEY_IDENTITIES'; end if;
    select coalesce(array_agg(value),'{}') into h from jsonb_array_elements_text(p_data->'hosting_identity_codes');
  end if;
  if p_data ? 'pickup_identity_codes' then
    if jsonb_typeof(p_data->'pickup_identity_codes')<>'array' then raise exception using errcode='22023',message='INVALID_SURVEY_IDENTITIES'; end if;
    select coalesce(array_agg(value),'{}') into p from jsonb_array_elements_text(p_data->'pickup_identity_codes');
  end if;
  if exists(select 1 from unnest(h||p) selected(code) where selected.code is null or not exists(select 1 from public.registration_identities i where i.code=selected.code))
    or coalesce((p_data->>'is_hosting_open')::boolean,false) and cardinality(h)=0
    or coalesce((p_data->>'is_pickup_open')::boolean,false) and cardinality(p)=0 then
    raise exception using errcode='22023',message='INVALID_SURVEY_IDENTITIES';
  end if;
  update public.site_settings set is_hosting_open=(p_data->>'is_hosting_open')::boolean,
    is_pickup_open=(p_data->>'is_pickup_open')::boolean,
    hosting_description=nullif(btrim(p_data->>'hosting_description'),''),pickup_description=nullif(btrim(p_data->>'pickup_description'),''),
    hosting_identity_codes=h,pickup_identity_codes=p,updated_at=now() where id returning to_jsonb(site_settings.*) into result;
  if (before_settings-'updated_at') is distinct from (result-'updated_at') then
    insert into public.audit_events(actor_type,actor_user_id,action,target_type,before_data,after_data)
      values('admin',p_actor,'reference.saved','hosting',before_settings,result);
  end if;
  return result;
end;
$$;
revoke all on function public.staff_save_reference(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.staff_save_reference(uuid,text,jsonb) to service_role;

create or replace function public.staff_save_reception_settings(p_actor uuid,p_kind text,p_data jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
begin
  if p_kind<>'hosting' then raise exception using errcode='22023',message='INVALID_REFERENCE_KIND'; end if;
  return public.staff_save_reference(p_actor,p_kind,p_data);
end;
$$;



-- ===== 202611110004_identity_reorder.sql =====


-- Saves a drag-and-drop order for identities in one call. The list must name every identity
-- exactly once, so a stale page (an identity added or removed elsewhere) is refused instead of
-- leaving gaps. Sort order alone never marks registrations for re-import.
create function public.staff_reorder_identities(p_actor uuid, p_identity_codes text[])
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_before jsonb;
  v_after jsonb;
begin
  perform public.staff_assert_actor(p_actor, true);
  -- Row locks would not stop an identity inserted after the count check; this table lock does.
  lock table public.registration_identities in share row exclusive mode;
  if p_identity_codes is null
    or cardinality(p_identity_codes) <> (select count(*) from public.registration_identities)
    or cardinality(p_identity_codes) <> (select count(distinct given.identity_code) from unnest(p_identity_codes) as given(identity_code))
    or exists (
      select 1 from unnest(p_identity_codes) as given(identity_code)
      where not exists (select 1 from public.registration_identities identity where identity.code = given.identity_code)
    ) then
    raise exception using errcode = '22023', message = 'INVALID_IDENTITY_ORDER';
  end if;

  select jsonb_agg(code order by sort_order, code) into v_before from public.registration_identities;
  update public.registration_identities identity
  set sort_order = ordered.position::integer
  from unnest(p_identity_codes) with ordinality as ordered(identity_code, position)
  where identity.code = ordered.identity_code and identity.sort_order is distinct from ordered.position::integer;
  select jsonb_agg(code order by sort_order, code) into v_after from public.registration_identities;

  if v_before is distinct from v_after then
    insert into public.audit_events (actor_type, actor_user_id, action, target_type, before_data, after_data)
    values ('admin', p_actor, 'reference.reordered', 'identity',
      jsonb_build_object('order', v_before), jsonb_build_object('order', v_after));
  end if;
end;
$$;

revoke execute on function public.staff_reorder_identities(uuid, text[]) from public, anon, authenticated;
grant execute on function public.staff_reorder_identities(uuid, text[]) to service_role;


-- ===== 202611130001_student_statistics_identity.sql =====

-- A separate, optional statistics source per environment. No old identity is selected automatically.

alter table public.site_settings add column student_statistics_identity_code text
  references public.registration_identities(code);

alter function public.staff_save_reference(uuid,text,jsonb) rename to staff_save_reference_before_student_statistics;
create function public.staff_save_reference(p_actor uuid,p_kind text,p_data jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_before text; v_code text; v_after jsonb;
begin
  perform public.staff_assert_actor(p_actor,true);
  if p_kind='delete_identity' then
    perform 1 from public.site_settings where id for update;
    if exists(select 1 from public.site_settings where id and student_statistics_identity_code=p_data->>'code') then
      raise exception using errcode='22023',message='IDENTITY_IN_STUDENT_STATISTICS';
    end if;
  end if;
  if p_kind<>'student_statistics_identity' then
    return public.staff_save_reference_before_student_statistics(p_actor,p_kind,p_data);
  end if;
  if not (p_data ? 'code') or jsonb_typeof(p_data->'code') not in ('string','null') then
    raise exception using errcode='22023',message='INVALID_STUDENT_STATISTICS_IDENTITY';
  end if;
  v_code := p_data->>'code';
  select student_statistics_identity_code into v_before from public.site_settings where id for update;
  if v_code is not null and not exists (
    select 1 from public.registration_identities
    where code=v_code and (is_active or code=v_before)
      and code not in ('general','child','preschool') for share
  ) then
    raise exception using errcode='22023',message='INVALID_STUDENT_STATISTICS_IDENTITY';
  end if;
  update public.site_settings set student_statistics_identity_code=v_code,
    updated_at=case when student_statistics_identity_code is distinct from v_code then now() else updated_at end
  where id returning to_jsonb(site_settings.*) into v_after;
  if v_before is distinct from v_code then
    insert into public.audit_events(actor_type,actor_user_id,action,target_type,before_data,after_data)
    values('admin',p_actor,'reference.saved','student_statistics_identity',
      jsonb_build_object('code',v_before),jsonb_build_object('code',v_code));
  end if;
  return v_after;
end;
$$;
revoke all on function public.staff_save_reference(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.staff_save_reference(uuid,text,jsonb) to service_role;


-- ===== 202611140001_student_identity_reserved.sql =====

-- 2026-11-14: 學生 (code student) becomes reserved like 一般 and both 兒童 identities: it cannot be
-- deleted, deactivated or made staff-only; only its name and badge change. It stays selectable as the
-- 學生統計身分 (202611130001 already excludes only general/child/preschool). Decisions are in
-- docs/需求討論與決策紀錄.md, section "正式站發布時保留既有登記資料" Q11, Q12.
-- Adding the constraint fails, and nothing is applied, if 學生 is inactive or staff-only. Check first;
-- the row must show is_active and public_selectable both true (no row: 學生 was deleted, nothing to check):
--   select code, name, is_active, public_selectable from public.registration_identities where code = 'student';
alter table public.registration_identities drop constraint registration_identities_reserved;
alter table public.registration_identities add constraint registration_identities_reserved check
  (code not in ('general','student','child','preschool') or (is_active and public_selectable));
create or replace function public.registration_identity_delete_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.code in ('general','student','child','preschool') then
    raise exception using errcode = '22023', message = 'IDENTITY_IN_USE';
  end if;
  return old;
end;
$$;

-- ===== 202611150001_identity_change_survey_no.sql =====

-- 2026-11-15: changing a registration to an identity a survey is not open to stores 否 for a valid
-- answer of that survey, even when the old identity could not answer it either. Before, a 學生 changed
-- to 兒童（國小） kept its pickup answer, since 學生 could not answer pickup either; staff saving the
-- same change stored 否. A survey with no valid answer, from an identity never asked, stays unanswered.
-- Decisions are in docs/需求討論與決策紀錄.md, section
-- "換成不能填的身分時接待答案一律存「否」" Q22. Only later saves change; stored answers are untouched.
-- Deploy the site with it: the public page shows the 否 before saving.
create or replace function public.save_registration_surveys(p_actor uuid,p_id uuid,p_request uuid,p_full_name text,
  p_district integer,p_choices jsonb,p_hosting jsonb,p_identity text,p_pickup jsonb,p_child_type text,p_parent text)
returns uuid language plpgsql security invoker set search_path='' as $$
declare r public.registrations; s public.site_settings; new_id uuid; new_serial bigint;
  identity_code text; v_child_type text; v_parent_name text; kind text; before_answer jsonb; after_answer jsonb;
  payload jsonb; allowed boolean; opened boolean; leaving boolean; changed boolean; was_valid boolean; valid boolean;
  actor_type text := case when p_actor is null then 'public' else 'staff' end;
begin
  select * into strict s from public.site_settings where id for share;
  if p_actor is not null then perform public.staff_assert_actor(p_actor,false); end if;
  -- Closed public operations must fail alike before looking up a name.
  if p_actor is null and p_request is null then
    if not s.is_registration_open or (s.registration_deadline_at is not null and s.registration_deadline_at<=now()) then
      raise exception using errcode='P0001',message='REGISTRATION_CLOSED';
    end if;
    if not s.is_lookup_open then raise exception using errcode='P0001',message='LOOKUP_CLOSED'; end if;
  end if;
  if p_request is null then
    if p_actor is null then
      select * into r from public.registrations where full_name is not null and district_id=p_district
        and name_key=public.registration_name_key(p_full_name) and record_status='active' for update;
    else
      select * into r from public.registrations where id=p_id and record_status='active' for update;
    end if;
    if r.id is null then return null; end if;
  elsif p_identity is null then
    raise exception using errcode='P0001',message='MEAL_IDENTITY_REQUIRED';
  end if;
  identity_code := coalesce(p_identity,r.meal_identity,'general');
  v_child_type := case identity_code when 'child' then 'elementary' when 'preschool' then 'preschool' end;
  if v_child_type is not null then
    v_parent_name := public.registration_parent_name(true,case when p_parent is null and r.child_type is not null then r.parent_name else p_parent end);
  end if;
  perform set_config('registration.saving_child',coalesce(v_child_type,''),true);
  perform set_config('registration.staff_identity',case when p_actor is null then '' else 'on' end,true);
  perform set_config('registration.surveys_managed','on',true);
  if p_request is not null then
    if p_actor is null then
      select registration_id,serial_no into new_id,new_serial from public.create_registration(p_request,p_full_name,p_district,p_choices,null,identity_code);
    else
      select registration_id,serial_no into new_id,new_serial from public.staff_create_registration(p_actor,p_request,p_full_name,p_district,p_choices,null,identity_code);
    end if;
  else
    new_id:=r.id;
    if not (case when p_actor is null then public.update_registration(p_full_name,p_district,p_choices,null,identity_code)
      else public.staff_update_registration(p_actor,new_id,p_full_name,p_district,p_choices,null,identity_code) end) then
      -- The flags must not leak into a later save in the same transaction.
      perform set_config('registration.surveys_managed','',true);
      perform set_config('registration.saving_child','',true);
      perform set_config('registration.staff_identity','',true);
      return null;
    end if;
  end if;
  if (r.child_type,r.parent_name) is distinct from (v_child_type,v_parent_name) then
    update public.registrations set is_child=v_child_type is not null,child_type=v_child_type,
      parent_name=v_parent_name,updated_at=now() where id=new_id;
    insert into public.audit_events(actor_type,actor_user_id,action,target_type,target_id,before_data,after_data)
      values(actor_type,p_actor,'registration.child_updated','registration',new_id,
        jsonb_build_object('is_child',coalesce(r.is_child,false),'child_type',r.child_type,'parent_name',r.parent_name),
        jsonb_build_object('is_child',v_child_type is not null,'child_type',v_child_type,'parent_name',v_parent_name));
  end if;
  foreach kind in array array['hosting','pickup'] loop
    before_answer:=case kind when 'hosting' then public.registration_hosting_get(new_id) else public.registration_pickup_get(new_id) end;
    was_valid:=before_answer is not null and coalesce((before_answer->>'answer_valid')::boolean,true);
    valid:=was_valid;
    payload:=case kind when 'hosting' then p_hosting else p_pickup end;
    allowed:=public.survey_identity_allowed(kind,identity_code);
    opened:=case kind when 'hosting' then s.is_hosting_open else s.is_pickup_open end;
    -- Saving a change to an identity this survey is not open to stores 否 (decided 2026-11-11). When
    -- the old identity could not answer it either, only a valid answer becomes 否: an invalidated one
    -- counts as unanswered, so no 否 appears for someone never asked (2026-11-15). Staff saving a
    -- survey closed or not open to the identity also stores 否 (decided 2026-11-12). Whatever the page
    -- sent for this survey is then ignored. A missing identity counts as general, so choosing general
    -- is no change.
    leaving:=p_request is null and coalesce(r.meal_identity,'general') is distinct from identity_code and not allowed
      and (public.survey_identity_allowed(kind,r.meal_identity) or was_valid);
    if leaving or (p_actor is not null and (not allowed or not opened)) then
      payload:=case kind when 'hosting' then '{"status":"not_hosting"}'::jsonb else '{"status":"no","count":0}'::jsonb end;
    end if;
    if payload='{"reset":true}'::jsonb and p_request is null then
      -- A public page may only reset a survey its identity can answer.
      if p_actor is not null or allowed then valid:=false; end if;
      after_answer:=null;
      if p_actor is null and allowed and opened then
        raise exception using errcode='P0001',message=upper(kind)||'_REQUIRED';
      end if;
    else
      if kind='hosting' and jsonb_typeof(payload)='object' and payload->>'pickup_count' is null then
        payload:=payload||jsonb_build_object('pickup_count',coalesce(before_answer->'pickup_count','0'::jsonb));
      end if;
      after_answer:=case when kind='hosting' then public.registration_hosting_value(payload) else public.registration_pickup_value(payload) end;
    end if;
    if p_actor is null and (not allowed or not opened) and not leaving then
      if after_answer is not null and after_answer is distinct from
        (case kind when 'hosting' then public.registration_hosting_value(before_answer) else public.registration_pickup_value(before_answer) end) then
        raise exception using errcode='P0001',message=upper(kind)||case when not allowed then '_NOT_ALLOWED' else '_CLOSED' end;
      end if;
      -- Changing configuration alone neither changes nor invalidates answers.
      after_answer:=before_answer;
    else
      if p_actor is null and allowed and opened and not was_valid and after_answer is null then
        raise exception using errcode='P0001',message=upper(kind)||'_REQUIRED';
      end if;
      if p_request is not null and allowed and opened and after_answer is null then
        raise exception using errcode='P0001',message=upper(kind)||'_REQUIRED';
      end if;
      if after_answer is not null then
        valid:=true;
        if kind='hosting' then perform public.registration_hosting_put(new_id,after_answer);
        else perform public.registration_pickup_put(new_id,after_answer); end if;
      else
        after_answer:=before_answer;
      end if;
    end if;
    if kind='hosting' then update public.registration_hosting set answer_valid=valid where registration_id=new_id;
    else update public.registration_pickup set answer_valid=valid where registration_id=new_id; end if;
    changed := (before_answer-'answer_valid') is distinct from (after_answer-'answer_valid') or was_valid is distinct from valid;
    if changed then
      update public.registrations set updated_at=now(),import_status=case when import_status='imported' then 'reimport_needed' else import_status end where id=new_id;
      insert into public.audit_events(actor_type,actor_user_id,action,target_type,target_id,before_data,after_data)
        values(actor_type,p_actor,'registration.'||kind||'_updated','registration',new_id,
          jsonb_build_object(kind,before_answer,'answer_valid',was_valid),jsonb_build_object(kind,after_answer,'answer_valid',valid));
    end if;
  end loop;
  if not public.survey_audience_valid(identity_code,p_choices,public.registration_hosting_get(new_id),public.registration_pickup_get(new_id)) then
    raise exception using errcode='P0001',message='AUDIENCE_RESTRICTED';
  end if;
  perform set_config('registration.surveys_managed','',true);
  perform set_config('registration.saving_child','',true);
  perform set_config('registration.staff_identity','',true);
  return new_id;
end;
$$;
revoke all on function public.save_registration_surveys(uuid,uuid,uuid,text,integer,jsonb,jsonb,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.save_registration_surveys(uuid,uuid,uuid,text,integer,jsonb,jsonb,text,jsonb,text,text) to service_role;

commit;
