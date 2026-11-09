-- 各身分價格獨立（202611090003）的資料庫驗證。
-- 在測試專案 SQL Editor 整份執行；整個驗證交易最後回滾。只使用本腳本新增的虛構活動，金額不代表實際價格。
begin;

do $$
declare
  v_admin uuid;
  v_meal bigint;
begin
  if not coalesce((select is_test_environment from public.site_settings where id), false) then
    raise exception 'TEST_PROJECT_NOT_CONFIRMED';
  end if;
  select auth_user_id into v_admin from public.staff_profiles
  where role = 'admin' and is_active and not must_change_password limit 1;
  if v_admin is null then raise exception 'TEST_DATA_NOT_READY'; end if;

  -- Saved the way the staff page sends it: 一般 blank, a student price (mirrored in student_fee_amount)
  -- and a free child price. Before 202611090003 the student price needed a general price.
  v_meal := (public.staff_save_reference(v_admin, 'activity', jsonb_build_object(
    'title', '獨立價格驗證晚餐', 'category', 'meal', 'is_published', false, 'sort_order', 9302,
    'fee_amount', '', 'student_fee_amount', 60,
    'identity_prices', jsonb_build_array(jsonb_build_object('identity_code', 'student', 'fee_amount', 60),
      jsonb_build_object('identity_code', 'child', 'fee_amount', 0))))->>'id')::bigint;
  if (select fee_amount from public.activities where id = v_meal) is not null then raise exception 'GENERAL_NOT_UNSET'; end if;
  if (select fee_amount from public.activity_identity_prices where activity_id = v_meal and identity_code = 'child') is distinct from 0 then
    raise exception 'ZERO_NOT_KEPT';
  end if;
  if (select student_fee_amount from public.activities where id = v_meal) is distinct from 60 then
    raise exception 'STUDENT_PRICE_NOT_SAVED';
  end if;
  raise notice 'INDEPENDENT_IDENTITY_PRICES_OK';
end;
$$;

rollback;
