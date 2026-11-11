# 歷史驗證腳本

此目錄只保存已被後續規格取代的腳本，**不可用於現行 schema 的驗收**。

`verify-meal-pricing-and-audience.sql` 適用於 `202611090002` 之前；現行替代為：

- `../verify-registration-identities.sql`：身分管理與價格。
- `../verify-independent-identity-prices.sql`：各身分價格獨立。
- `../verify-hosting-general-only.sql`：一般與其他身分的接待資格。
- `../verify-activity-fields-and-permissions.sql`：欄位相容性與匿名權限。
- `../verify-activity-audiences.sql`：後台新增／修改的報名對象限制，以及活動改為限定後既有報名的處理。
- `../verify-conference-import-status.sql`：匯入狀態。

保留舊檔供歷史驗收紀錄追溯，不恢復舊規則。
