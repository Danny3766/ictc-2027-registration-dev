-- Apply migration, deploy staff Edge Function, then deploy the site.
begin;
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

commit;
