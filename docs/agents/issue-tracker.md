# Issue tracker: Local Markdown

本專案保留本機 Markdown tracker：`.scratch/` 用於 research、temporary planning、historical design material 與 migration source。

`.scratch` 不是 implementation lifecycle authority。正式 implementation 工作需提升為
PraxisBound Story（`specs/stories/<ID>-<slug>/`），其執行狀態由 ForgePilot Work Item 管理。
舊票據的 `Status` 僅保留歷史／triage 意義，不與 ForgePilot 雙向同步，也不據此領取正式實作。
提升與執行流程見 [development workflow](../development-workflow.md)。

## 檔案慣例

- 每個功能一個目錄：`.scratch/<feature-slug>/`。
- 規格：`.scratch/<feature-slug>/spec.md`。
- 研究／規劃票據（含歷史實作票據）：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`。
- 票據由 `01` 開始編號，每張票獨立一個檔案。
- 在檔案頂部附近以 `Status:` 記錄 triage 狀態，標籤依 `triage-labels.md`。
- 留言與討論追加於檔案底部的 `## Comments`。

## 發布與讀取

技能要求「發布至 issue tracker」時，建立對應 Markdown 檔案；
目錄不存在時才建立。更新既有票據時保留原有討論。
若內容已是正式 implementation requirement，建立或更新 PraxisBound Story，並以 ForgePilot Work Item 管理執行；不要另建 `.scratch` implementation 狀態。

技能要求「取得票據」時，讀取使用者指定的路徑或功能目錄內的票號。
票號不唯一時，先辨識所屬功能。

## Wayfinder 慣例

以下 claimed／resolved 與依賴選票規則只適用 research／temporary planning，不適用正式 implementation。

- Map：`.scratch/<effort>/map.md`。
- 子票：`.scratch/<effort>/issues/NN-<slug>.md`。
- `Type:` 使用 research／prototype／grilling／task。
- 工作領取與解答以 `Status: claimed`／`Status: resolved` 記錄。
- `Blocked by: NN, NN` 記錄依賴；依賴皆 resolved 才可處理。
- 選取未完成、未領取且無阻擋的最小票號，先保存 claimed 再工作。
- 解答追加於 `## Answer`，標記 resolved，再將摘要與連結加入 map。
