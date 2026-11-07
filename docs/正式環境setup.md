# 正式環境 Supabase 設定流程

> 適用範圍：建立正式環境的 Supabase、GitHub Variables，並把 GitHub Pages 切換到正式環境。完成後登記仍維持關閉。
> 驗收、備份還原與開放登記不在本文件範圍，請見 [TODO](TODO.md) 第 4、5 節與 [驗收紀錄](驗收紀錄.md)。
> 部署方式：一律使用 Supabase Dashboard，不使用 CLI。
> 上線後的分支、測試與正式站更新規則見第 9 節。**正式網址只能由 `main` 部署**，任何其他分支部署上去，正式站就會變成連測試 Supabase 的測試站。

## 0. 事前準備

### 機敏資料規則

本文件放在 GitHub 上，依 [機敏資料審查準則](GitHub公開內容機敏資料審查準則.md) 處理：

- 下列值只能貼在 Supabase Dashboard 或 GitHub Settings 中。不要寫進本文件，不要 commit，也不要貼到對話、截圖或 issue。
  - 正式專案的 Project Reference、Project URL
  - Publishable key、Secret key
  - `RATE_LIMIT_KEY`
  - 管理員帳號名稱與密碼
- 本文件中的角括號是 placeholder，操作時換成實際值即可，不要把實際值回填到文件中。

| Placeholder | 意思 | 從哪裡取得 |
| --- | --- | --- |
| `<正式專案>` | 正式 Supabase 專案的名稱 | Dashboard 左上角的專案切換選單 |
| `<帳號名稱>` | 首位管理員的帳號名稱 | 自己決定，規則見 2-2 |
| `<顯示名稱>` | 後台顯示的管理員名稱 | 自己決定，1 到 100 字 |

### 每次操作前先核對專案

開發／測試與正式環境是兩個獨立的 Supabase 專案。每次開啟 SQL Editor、Edge Functions 或 Authentication 頁面前，先確認 Dashboard 左上角顯示的是 `<正式專案>`。

### 建立正式專案

2026-11-06 已建立。日後重建時沿用以下設定：

- **方案**：Free（2026-11-06 決定全程使用）。Free 方案的專案連續 7 天沒有請求會被自動暫停，暫停期間網站讀不到資料，要登入 Dashboard 手動恢復；也沒有自動備份，備份改用手動匯出（見 [TODO](TODO.md) 第 5 節）。每個組織最多 2 個啟用中的專案，測試與正式剛好各一個。
- **Organization**：與測試專案相同。**Region**：與測試專案相同（測試專案的 **Project Settings** → **General** → **Region**）。
- **Database Password**：按 **Generate a password** 產生，存進密碼管理工具，不要貼到對話或文件。
- **Security options**：保留 **Data API + Connection String** 與 **Use public schema for Data API**。Edge Function 透過 Data API 存取 `public` schema。
- 若勾選自動開啟 RLS，專案會自帶 event trigger 函式 `public.rls_auto_enable`，可以保留。它只在新建資料表時開啟 RLS，與 baseline 不衝突。

建立後先確認是空的，再執行第 3 節：

```sql
-- 確認正式專案是空的（唯讀）。public_functions 若為 1，是上述 rls_auto_enable。
select
  (select count(*) from information_schema.tables where table_schema = 'public') as public_tables,
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace) as public_functions,
  (select count(*) from auth.users) as auth_users;
```

### 只能在特定專案執行的 SQL

- `supabase/testing/` 底下的所有檔案只能在測試專案使用，不要在正式環境執行。它們會檢查 `is_test_environment`，但不要依賴這道檢查。
- `supabase/production/baseline_*.sql` 只能在**全新的正式專案**執行一次（第 3 節）。不要在測試專案或已套用過 migration 的資料庫執行。

## 1. Auth 設定

步驟：

- 關閉公開註冊。
- 把最低密碼長度設為 12，與後台規則一致。

※ 1-1

1. 左側選單點 **Authentication**。
2. 在 CONFIGURATION 區塊點 **Sign In / Providers**，位置在 Policies 下面第二個。
3. 頁面上方的 **User Signups** 區塊，把 **Allow new users to sign up** 的開關關閉。
4. 按頁面上的 **Save changes**。如果開關切換後就自動儲存，畫面上沒有出現儲存按鈕也沒關係。

※ 1-2

1. 同一頁往下找到 **Email** provider，點開設定。
2. 找到 **Minimum password length**，填 `12`。
3. 按 **Save**。

## 2. 建立首位管理員的 Auth 使用者

步驟：

- 新增一個使用者，email 填 `<帳號名稱>@accounts.invalid`。
- `staff_profiles` 要等第 3 節 migration 完成後，才在第 4 節建立。

※ 2-1

1. 左側選單點 **Authentication** → **Users**。
2. 點右上角綠色的 **Add user** → **Create new user**。

※ 2-2

1. 填寫：
   - Email：`<帳號名稱>@accounts.invalid`。帳號名稱必須以小寫英文字母開頭，只能包含小寫英文字母、數字、`_`、`-`，長度 3 到 31 字元。
   - Password：自己設一組至少 12 字元、不超過 72 bytes 的臨時密碼。一個中文字約佔 3 bytes。不要求英文、數字、符號的組合，建議用密碼管理工具產生 16～20 字元的隨機英數字。密碼不要貼到任何對話或文件。
   - 勾選 **Auto Confirm User**。
2. 按 **Create user**。
3. 首次登入後台時，系統會要求改密碼，屆時再換成正式密碼。

## 3. 資料庫：執行正式環境 baseline

正式專案不逐支執行 `supabase/migrations/`，改執行一支合併腳本 `supabase/production/baseline_<最後一支 migration 編號>.sql`。

- 內容是依檔名順序串接全部 migration，只移除各檔自己的 `begin;`、`commit;`，整份包成一個交易。任何一段失敗，整份回滾，不會留下半套結構。
- 檔頭列出每支來源檔與 SHA-256。產生後已在本機依序執行全部 migration 比對，結構、權限與初始資料完全一致，並在模擬 Supabase 預設權限的資料庫確認匿名角色讀不到私有資料表。
- 只執行已合併進 `develop` 的版本。如果 `develop` 之後新增了 migration，先重新產生 baseline 再執行，檔名中的編號要等於最後一支 migration。
- **只在第一次建置執行一次。** 上線後新增的 migration 照常放 `supabase/migrations/`，依第 9 節的維護流程，在正式與測試專案逐支套用。

※ 3-1

1. 確認左上角是 `<正式專案>`。
2. 左側選單點 **SQL Editor** → **New query**。
3. 在 GitHub 打開 `develop` 分支上的 `supabase/production/baseline_<編號>.sql`，按 **Copy raw file** 複製全部內容。不要用滑鼠拖曳選取，可能漏行。檔案約 4,700 行，貼上後等編輯器載入完成，確認最後一行是 `commit;`，再按 **Run**。
4. 成功時，SQL Editor 只顯示腳本中最後一個有回傳資料的查詢，也就是一列 `setval`（數字為 3），這是正常的。出現紅色 `ERROR` 時，整份已自動回滾，先停下來確認錯誤原因，不要修改內容後重跑。
5. 執行下面的查詢確認結果，並在下表記錄一列。

```sql
-- baseline 執行後檢查（唯讀）
select
  (select count(*) from information_schema.tables where table_schema = 'public') as public_tables,
  (select count(*) from public.activities) as activities,
  (select count(*) from public.districts) as districts,
  (select is_test_environment from public.site_settings) as is_test_environment,
  (select is_registration_open from public.site_settings) as is_registration_open,
  (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity) as tables_without_rls;
```

`baseline_202611060003.sql` 的預期結果是 12、7、4、`false`、`false`、0。

| 腳本檔名 | 執行日期 | 執行人 | 結果 |
| --- | --- | --- | --- |
| `baseline_202611060003.sql` | 2026-11-06 | 專案負責人 | 成功。12 張資料表、7 個活動、4 個區，測試旗標與登記皆為 `false`，所有資料表已開 RLS，與本機驗證結果一致。 |

## 4. 建立首位管理員的 `staff_profiles`

步驟：

- 在 SQL Editor 為第 2 節建立的使用者新增 `staff_profiles`，`role` 設為 `admin`。
- `must_change_password` 使用預設值 `true`，不另外指定。

※ 4-1

1. 確認左上角是 `<正式專案>`。
2. 左側選單點 **SQL Editor** → **New query**。
3. 貼上下面的 SQL，把兩個 placeholder 換成實際值。`<帳號名稱>` 只出現一次，全部小寫，必須和第 2 節的 Email 相同；`username` 直接取 Email 的 `@` 前半段，避免兩處拼字不一致。

```sql
insert into public.staff_profiles (auth_user_id, username, display_name, role)
select id, split_part(email, '@', 1), '<顯示名稱>', 'admin'
from auth.users
where email = '<帳號名稱>@accounts.invalid';
```

4. 按 **Run**。SQL Editor 對 `insert` 一律顯示 `Success. No rows returned`，看不出是否真的新增，要用下面的查詢確認。結果不含帳號名稱：

```sql
-- 確認管理員 profile 已建立（唯讀）
select
  count(*) as admin_profiles,
  bool_and(p.must_change_password) as must_change_password,
  bool_and(p.is_active) as is_active,
  bool_and(u.email = p.username || '@accounts.invalid') as email_matches
from public.staff_profiles p
join auth.users u on u.id = p.auth_user_id
where p.role = 'admin';
```

   預期是 `1`、`true`、`true`、`true`。`admin_profiles` 為 `0` 代表 Email 對不上，回第 2 節的使用者清單複製 Email 再執行一次。

5. SQL Editor 可能自動保存 query。執行完後到左側清單找這個 query，刪除它，避免帳號名稱留在 Dashboard。
6. 後台登入時，「帳號」只輸入 `@` 前面的帳號名稱，系統會自動補上 `@accounts.invalid`。首次登入會要求把臨時密碼改成正式密碼。

## 5. Edge Functions

步驟：

- 設定 secret `RATE_LIMIT_KEY`。
- 部署 `registration`，關閉 JWT 驗證。
- 部署 `staff`，開啟 JWT 驗證。

`SUPABASE_URL` 和 Secret key 由 Supabase 自動提供給 Edge Function，不用手動設定。

※ 5-1 產生並設定 `RATE_LIMIT_KEY`

1. 在本機 PowerShell 7 執行下面這行。它會產生 64 字元的隨機值，直接複製到剪貼簿，不會顯示在畫面上：

   ```powershell
   [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)) | Set-Clipboard
   ```

2. Dashboard 左側選單點 **Edge Functions** → **Secrets**。
3. 新增一筆：Name 填 `RATE_LIMIT_KEY`，Value 貼上剪貼簿內容。
4. 按 **Save**。
5. 隨便複製一段其他文字，把剪貼簿蓋掉。

正式與測試專案的 `RATE_LIMIT_KEY` 必須不同，不要沿用測試專案的值。

※ 5-2 部署 `registration`

1. **Edge Functions** → **Functions**，點 **Deploy a new function** → **Via Editor**。
2. Function 名稱填 `registration`。名稱必須完全相同，前端靠這個名稱呼叫。
3. 刪除編輯器裡的範例程式碼，貼上 `develop` 上 `supabase/functions/registration/index.ts` 的完整內容。`helpers.test.mjs` 是測試檔，不用部署。
4. 按 **Deploy function**。
5. 部署完成後進入這個 function 的設定頁，把 JWT 驗證關閉。畫面上可能顯示為 **Verify JWT** 或 **Enforce JWT Verification**。這個 function 給公開訪客使用，必須關閉。

※ 5-3 部署 `staff`

1. 同 5-2，Function 名稱改填 `staff`，貼上 `supabase/functions/staff/index.ts` 的完整內容。
2. 部署完成後，到設定頁確認 JWT 驗證是**開啟**狀態。
3. 兩個 function 的 JWT 設定要和測試專案一致。測試專案的設定以 `supabase/config.toml` 為準：`registration` 為 `false`，`staff` 為 `true`。

## 6. GitHub Variables

步驟：

- 在 GitHub repo 設定 `PROD_SUPABASE_URL` 與 `PROD_SUPABASE_PUBLISHABLE_KEY`。
- 這兩個值會寫進公開網站的 `config.js`，本來就是可公開的值。但依審查準則，仍然不寫進 repo 或文件。

※ 6-1 從 Supabase 取得兩個值

1. 確認左上角是 `<正式專案>`。
2. 左側選單點 **Project Settings** → **Data API**，複製 **Project URL**。格式必須是 `https://<一串英數字>.supabase.co`，結尾不能有 `/`。
3. **Project Settings** → **API Keys**，複製 **Publishable key**，開頭必須是 `sb_publishable_`。
4. 不要複製 Secret key 或 `service_role` key。這兩把只能留在 Supabase 內部。

※ 6-2 寫入 GitHub

1. GitHub repo 頁面點 **Settings** → **Secrets and variables** → **Actions**。
2. 切到 **Variables** 分頁，點 **New repository variable**。
3. 新增兩筆：
   - Name：`PROD_SUPABASE_URL`，Value：6-1 第 2 步複製的 URL。
   - Name：`PROD_SUPABASE_PUBLISHABLE_KEY`，Value：6-1 第 3 步複製的 key。
4. 確認名稱沒有拼錯。`DEV_` 開頭的兩筆是測試環境用的，不要改動。

格式不符時，部署 workflow 會在 `Create public site configuration` 這一步失敗，訊息為「缺少有效的 GitHub Pages 公開 Supabase 設定」。

## 7. 上線：GitHub Pages 切換到 `main`

一個 repo 只有一個 GitHub Pages 網址，誰最後部署，網站就是誰的版本。`main` 部署時使用 `PROD_` 設定並產生 `environment: production`，測試站提示不會顯示；其他分支部署時會使用 `DEV_` 設定並顯示測試站提示。因此上線後只能讓 `main` 部署。

步驟：

- 確認 `pages.yml` 只由 `main` 觸發（上線前已合併進 `develop`）。
- 部署環境只允許 `main`，連手動執行也擋下。
- 第一次讓 `main` 接上開發分支的歷史，開上線 PR，由你合併。
- 部署後核對三個頁面都沒有測試站提示。

※ 7-1 確認 workflow 只由 `main` 觸發

`.github/workflows/pages.yml` 必須是：

```yaml
on:
  push:
    branches: [main]
  workflow_dispatch:
```

GitHub 讀取**被 push 的那個分支**上的 `pages.yml` 決定要不要部署，所以這個修改必須在 `develop` 上，不能只改 `main`。這個修改合併進 `develop` 後，測試站停在最後一版，直到 `main` 部署後被正式站取代。

※ 7-2 核對 GitHub 設定

1. **Settings** → **Pages**：**Source** 必須是 **GitHub Actions**。
2. **Settings** → **Environments** → **github-pages** → **Deployment branches and tags**：清單只留 `main`，刪除其他分支。這樣就算有人在 Actions 頁面從其他分支手動執行，GitHub 也會拒絕部署。

※ 7-3 第一次上線：讓 `main` 接上開發分支

`main` 最初只有一個 `Initial commit`，和開發分支沒有共同歷史，GitHub 無法直接開 PR。只有第一次需要接合：

1. 從 `main` 建立暫時分支，用 `git merge --allow-unrelated-histories` 合併 `develop`。`README.md` 衝突時採用開發分支的版本。來源必須是 `develop`，它才有只由 `main` 觸發的 `pages.yml`。
2. 推上暫時分支，開 PR 進 `main`，在 PR 檢視整批上線內容。
3. 第 1～6 節與 7-2 都完成後，才合併這個 PR。合併當下就會部署正式站。
4. 合併方式必須選 **Create a merge commit**。**Squash and merge** 或 **Rebase and merge** 會讓 `main` 再次與 `develop` 沒有共同歷史。

2026-11-06 已完成：PR #26 以 merge commit 合併，`develop` 已是 `main` 的祖先。之後都直接從 `develop` 開 PR 進 `main`，合併方式一樣選 **Create a merge commit**。

※ 7-4 部署後核對

1. **Actions** 分頁確認 `Deploy GitHub Pages` 由 `main` 觸發，且執行成功。
2. 開啟正式站的首頁、登記成功頁與後台登入頁，三個頁面都不應出現「測試站」提示。瀏覽器若顯示舊版，按 `Ctrl` + `F5` 強制重新整理。
3. 瀏覽器開發者工具開啟 `config.js`，確認 `environment` 為 `production`。只用眼睛核對，不要截圖或複製內容。

## 8. 設定核對清單

在 SQL Editor 執行下面兩段查詢，結果都符合預期才算完成。

※ 8-1 站台狀態

```sql
select is_test_environment, is_registration_open
from public.site_settings;
```

預期結果：兩個欄位都是 `false`。

※ 8-2 匿名使用者不能讀取敏感資料

```sql
select t as table_name,
       has_table_privilege('anon', 'public.' || t, 'select') as anon_can_read
from unnest(array[
  'registrations', 'registration_choices', 'registration_hosting', 'registration_pickup', 'staff_profiles',
  'audit_events', 'query_attempts', 'registration_create_limits', 'public_request_limits'
]) as t
where to_regclass('public.' || t) is not null;

select relname as table_name, relrowsecurity as rls_enabled
from pg_class
where relnamespace = 'public'::regnamespace and relkind = 'r'
order by relname;
```

預期結果：第一段每一列的 `anon_can_read` 都是 `false`；第二段每一列的 `rls_enabled` 都是 `true`。

※ 8-3 人工核對

- [ ] 第 1 節：公開註冊已關閉，最低密碼長度為 12。
- [ ] 第 3 節：baseline 執行紀錄已填寫，結果成功。
- [ ] 第 4 節：用首位管理員登入正式站後台，系統要求改密碼；改完後可以進入後台。
- [ ] 第 5 節：兩個 function 都已部署，JWT 設定正確。正式站首頁能載入活動與區別清單。
- [ ] 第 6、7 節：正式站由 `main` 部署，部署環境只允許 `main`，三個頁面沒有測試站提示，`config.js` 的 `environment` 為 `production`。
- [ ] 8-1、8-2 查詢結果符合預期。

全部打勾後，接著進行 [TODO](TODO.md) 第 4 節的 smoke test 與驗收，並把結果記在 [驗收紀錄](驗收紀錄.md)。

2026-11-06 首次建置：第 1～8 節全部通過，結果記在[驗收紀錄](驗收紀錄.md)「2026-11-06 正式環境建置」。

## 9. 上線後的分支、測試與正式站更新

### 9-1 分支角色

```text
feat/*（功能開發） → PR → develop（整合，不部署） → PR → main（正式站）
```

- `feat/*`：每個新功能或修正一個分支，從 `develop` 建立。
- `develop`：整合所有已完成的功能，原名 `feat/ver-001`。上線後不部署到任何網址。
- `main`：正式站。只有它會部署到 GitHub Pages。
- 不再使用 `feat/ver-001-main` 這類中轉分支。正式與測試的差異由部署設定控制，程式只有一份。

### 9-2 上線後如何測試

- 平常在本機用 `npm start` 連測試 Supabase 測試，正式站完全不受影響。
- 需要弟兄們遠端試用時，另開一個獨立測試站，例如另一個 repo 的 GitHub Pages，網址與正式站不同。
- **不要把 `feat/*` 或 `develop` 部署到正式網址**，也不要為了測試修改 `pages.yml` 的觸發條件或部署環境的允許分支。正式網址一旦連到測試 Supabase，登記者送出的資料會進測試資料庫，正式資料庫查不到。

### 9-3 正式站更新的維護流程

更新內容包含 migration 或 Edge Function 時，新舊版本會有一段不一致的空窗，依序執行：

1. 通知服事者「正式站維護中，暫停登記」，在後台網站設定關閉登記（`is_registration_open = false`）。
2. 在正式專案的 SQL Editor 逐支執行新的 migration，每支記錄在第 3 節的表格下方。
3. 重新部署有變更的 Edge Function。
4. 合併 `develop` → `main` 的 PR，等前端部署完成。
5. 依第 7-4、8 節核對，並驗收這次的變更。
6. 重新開放登記，通知服事者維護結束。

只改前端的更新不需要關閉登記，合併進 `main` 後依 7-4 核對即可。

只調整限流數值的 migration 也不需要關閉登記：它只改資料庫，整支在單一交易內完成。流程見[需求討論與決策紀錄](需求討論與決策紀錄.md)「2026-11-07 上線尖峰限流」一節。驗證腳本只能在測試專案執行，正式專案套用後改用下面的唯讀查詢，四欄都應為 `true`。同一來源上限調回平時值時，把 `> 200 then` 改成 `> 60 then`。

```sql
-- 限流數值檢查（唯讀）
select
  pg_get_functiondef('public.create_registration(uuid, text, integer, jsonb, jsonb, text)'::regprocedure)
    like '%created_count < 150);%' as create_limit,
  (select pg_get_constraintdef(oid) from pg_constraint where conname = 'registration_create_limits_created_count_check')
    like '%<= 150)))' as create_check,
  pg_get_functiondef('public.consume_public_request(text)'::regprocedure) like '%v_source > 200 then%' as source_limit,
  pg_get_functiondef('public.consume_public_request(text)'::regprocedure) like '%v_global <= 1000;%' as global_limit;
```
