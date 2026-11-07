-- 在測試專案 SQL Editor 執行；整個驗證交易最後回滾，不留下登記資料。
begin;

do $$
declare
  v_choices jsonb;
  -- 開家接待開放時必須回答；關閉時不得送出。
  v_hosting jsonb := case when (select is_hosting_open from public.site_settings where id = true)
    then '{"status":"not_hosting"}'::jsonb end;
  v_district_id integer;
  v_registration_id uuid;
  -- Per-source limit: 200 at a peak, 60 normally. Change only this when the limit is switched.
  v_source_limit constant integer := 200;
  -- A suffix keeps the names from clashing with a registration someone made by hand on the test site.
  v_suffix text := left(gen_random_uuid()::text, 8);
begin
  if not coalesce((select is_test_environment from public.site_settings where id = true), false) then
    raise exception 'TEST_PROJECT_NOT_CONFIRMED';
  end if;

  select id into v_district_id
  from public.districts order by sort_order limit 1;
  select jsonb_agg(jsonb_build_object('activity_id', id, 'attending', false))
  into v_choices from public.activities where is_published;
  if v_district_id is null or v_choices is null then
    raise exception 'TEST_DATA_NOT_READY';
  end if;

  update public.registration_create_limits
  set window_started_at = now(), created_count = 0 where id = true;

  select registration_id into v_registration_id
  from public.create_registration(gen_random_uuid(), '安全驗收測試', v_district_id, v_choices, v_hosting);
  if v_registration_id is null or
    (select count(*) from public.registration_choices where registration_id = v_registration_id) <> jsonb_array_length(v_choices) or
    exists (select 1 from public.registration_choices where registration_id = v_registration_id and attending) then
    raise exception 'ALL_NO_CREATE_FAILED';
  end if;

  -- Lookup ignores case, width and spacing; the public update changes choices only.
  if not public.update_registration(' 安全 驗收 測試 ', v_district_id, v_choices, v_hosting) then
    raise exception 'ALL_NO_UPDATE_FAILED';
  end if;

  begin
    perform public.create_registration(gen_random_uuid(), '安全驗收測試', v_district_id, v_choices, v_hosting);
    raise exception 'SAME_NAME_DID_NOT_BLOCK';
  exception when others then
    if sqlerrm <> 'NAME_TAKEN' then raise; end if;
  end;

  update public.registration_create_limits
  set window_started_at = now(), created_count = 149 where id = true;
  perform public.create_registration(gen_random_uuid(), '限流驗收測試甲' || v_suffix, v_district_id, v_choices, v_hosting);
  begin
    perform public.create_registration(gen_random_uuid(), '限流驗收測試乙' || v_suffix, v_district_id, v_choices, v_hosting);
    raise exception 'RATE_LIMIT_DID_NOT_BLOCK';
  exception when others then
    if sqlerrm <> 'CREATE_RATE_LIMITED' then raise; end if;
  end;

  -- One source gets v_source_limit requests per 10 minutes, the whole site 1000.
  delete from public.public_request_limits;
  for i in 1..v_source_limit loop
    if not public.consume_public_request(repeat('a', 64)) then raise exception 'SOURCE_LIMIT_TOO_LOW'; end if;
  end loop;
  if public.consume_public_request(repeat('a', 64)) then raise exception 'SOURCE_LIMIT_DID_NOT_BLOCK'; end if;
  -- The refused request does not count globally, so one busy source cannot use up everyone's allowance.
  if (select request_count from public.public_request_limits where source_key = 'global') is distinct from v_source_limit then
    raise exception 'REFUSED_REQUEST_COUNTED_GLOBALLY';
  end if;
  update public.public_request_limits set request_count = 999 where source_key = 'global';
  if not public.consume_public_request(repeat('b', 64)) then raise exception 'GLOBAL_LIMIT_TOO_LOW'; end if;
  if public.consume_public_request(repeat('c', 64)) then raise exception 'GLOBAL_LIMIT_DID_NOT_BLOCK'; end if;

  raise notice 'ALL_NO_AND_RATE_LIMIT_OK';
end;
$$;

rollback;
