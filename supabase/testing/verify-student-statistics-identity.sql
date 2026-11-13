-- Test database only, after 202611130001. All changes roll back.
begin;
do $$
declare v_actor uuid; v_code text; v_audits bigint;
begin
  if not coalesce((select is_test_environment from public.site_settings where id), false) then
    raise exception 'TEST_PROJECT_NOT_CONFIRMED';
  end if;
  select auth_user_id into v_actor from public.staff_profiles
    where role='admin' and is_active and not must_change_password limit 1;
  if v_actor is null then raise exception 'TEST_ADMIN_REQUIRED'; end if;
  if (select column_default from information_schema.columns
      where table_schema='public' and table_name='site_settings'
        and column_name='student_statistics_identity_code') is not null then
    raise exception 'COLUMN_HAS_NON_NULL_DEFAULT';
  end if;
  if has_function_privilege('anon','public.staff_save_reference(uuid,text,jsonb)','execute')
    or has_function_privilege('authenticated','public.staff_save_reference(uuid,text,jsonb)','execute') then
    raise exception 'RPC_GRANTS_INVALID';
  end if;
  v_code := public.staff_save_reference(v_actor,'identity',
    '{"name":"Student statistics fixture","is_active":true,"public_selectable":false}')->>'code';
  select count(*) into v_audits from public.audit_events
    where target_type='student_statistics_identity' and action='reference.saved';
  perform public.staff_save_reference(v_actor,'student_statistics_identity',jsonb_build_object('code',v_code));
  if (select student_statistics_identity_code from public.site_settings where id) is distinct from v_code then
    raise exception 'SETTING_NOT_SAVED';
  end if;
  perform public.staff_save_reference(v_actor,'student_statistics_identity',jsonb_build_object('code',v_code));
  if (select count(*) from public.audit_events
    where target_type='student_statistics_identity' and action='reference.saved') <> v_audits+1 then
    raise exception 'AUDIT_NOT_ONCE';
  end if;
  begin
    perform public.staff_save_reference(v_actor,'delete_identity',jsonb_build_object('code',v_code));
    raise exception 'DESIGNATED_IDENTITY_DELETED';
  exception when invalid_parameter_value then
    if sqlerrm <> 'IDENTITY_IN_STUDENT_STATISTICS' then raise; end if;
  end;
  begin
    perform public.staff_save_reference(v_actor,'student_statistics_identity','{"code":"general"}');
    raise exception 'RESERVED_IDENTITY_ACCEPTED';
  exception when invalid_parameter_value then
    if sqlerrm <> 'INVALID_STUDENT_STATISTICS_IDENTITY' then raise; end if;
  end;
  perform public.staff_save_reference(v_actor,'identity',jsonb_build_object(
    'code',v_code,'name','Student statistics fixture','is_active',false,'public_selectable',false));
  perform public.staff_save_reference(v_actor,'student_statistics_identity',jsonb_build_object('code',v_code));
  perform public.staff_save_reference(v_actor,'student_statistics_identity','{"code":null}');
  if (select student_statistics_identity_code from public.site_settings where id) is not null then
    raise exception 'SETTING_NOT_CLEARED';
  end if;
  begin
    perform public.staff_save_reference(v_actor,'student_statistics_identity',jsonb_build_object('code',v_code));
    raise exception 'DISABLED_IDENTITY_ACCEPTED';
  exception when invalid_parameter_value then
    if sqlerrm <> 'INVALID_STUDENT_STATISTICS_IDENTITY' then raise; end if;
  end;
  perform public.staff_save_reference(v_actor,'delete_identity',jsonb_build_object('code',v_code));
  update public.staff_profiles set role='staff' where auth_user_id=v_actor;
  begin
    perform public.staff_save_reference(v_actor,'student_statistics_identity','{"code":null}');
    raise exception 'STAFF_SETTING_ACCEPTED';
  exception when insufficient_privilege then null; end;
end;
$$;
rollback;
