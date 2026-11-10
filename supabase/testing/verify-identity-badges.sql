-- Test database only; fixtures are rolled back. Run after 202611100003.
begin;
do $$
declare v_actor uuid; v_identity jsonb; v_code text;
begin
  if not coalesce((select is_test_environment from public.site_settings where id), false) then
    raise exception 'TEST_PROJECT_NOT_CONFIRMED';
  end if;
  select auth_user_id into v_actor from public.staff_profiles
    where role = 'admin' and is_active and not must_change_password limit 1;
  if v_actor is null then raise exception 'TEST_ADMIN_REQUIRED'; end if;
  v_identity := public.staff_save_reference(v_actor, 'identity',
    '{"name":"Badge verification","is_active":true,"public_selectable":false}');
  v_code := v_identity->>'code';
  if (v_identity->>'show_badge')::boolean or v_identity->>'badge_color' <> '#e1effe' then
    raise exception 'BADGE_DEFAULTS_INVALID';
  end if;
  v_identity := public.staff_save_reference(v_actor, 'identity',
    v_identity || '{"show_badge":true,"badge_color":"#123ABC"}');
  if not (v_identity->>'show_badge')::boolean or v_identity->>'badge_color' <> '#123ABC' then
    raise exception 'BADGE_NOT_SAVED';
  end if;
  v_identity := public.staff_save_reference(v_actor, 'identity',
    (v_identity - 'show_badge' - 'badge_color') || '{"name":"Badge renamed"}');
  if not (v_identity->>'show_badge')::boolean or v_identity->>'badge_color' <> '#123ABC' then
    raise exception 'OLDER_CLIENT_RESET_BADGE';
  end if;
  begin
    perform public.staff_save_reference(v_actor, 'identity', v_identity || '{"badge_color":"red"}');
    raise exception 'INVALID_BADGE_COLOR_ACCEPTED';
  exception when check_violation then null;
  end;
  perform public.staff_save_reference(v_actor, 'identity', v_identity || '{"show_badge":false}');
  if (select show_badge from public.registration_identities where code = v_code) then
    raise exception 'BADGE_NOT_DISABLED';
  end if;
  if not exists (select 1 from public.audit_events
    where target_type = 'identity' and after_data->>'code' = v_code
      and after_data->>'badge_color' = '#123ABC') then
    raise exception 'BADGE_AUDIT_MISSING';
  end if;
end;
$$;
rollback;
