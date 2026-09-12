# Issue tracker: Local Markdown

本專案的規格與票據存放於 `.scratch/`。

## 檔案慣例

- 每個功能一個目錄：`.scratch/<feature-slug>/`。
- 規格：`.scratch/<feature-slug>/spec.md`。
- 實作票據：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`。
- 票據由 `01` 開始編號，每張票獨立一個檔案。
- 在檔案頂部附近以 `Status:` 記錄 triage 狀態，標籤依 `triage-labels.md`。
- 留言與討論追加於檔案底部的 `## Comments`。

## 發布與讀取

技能要求「發布至 issue tracker」時，建立對應 Markdown 檔案；
目錄不存在時才建立。更新既有票據時保留原有討論。

技能要求「取得票據」時，讀取使用者指定的路徑或功能目錄內的票號。
票號不唯一時，先辨識所屬功能。

## Wayfinder 慣例

- Map：`.scratch/<effort>/map.md`。
- 子票：`.scratch/<effort>/issues/NN-<slug>.md`。
- `Type:` 使用 research／prototype／grilling／task。
- 工作領取與解答以 `Status: claimed`／`Status: resolved` 記錄。
- `Blocked by: NN, NN` 記錄依賴；依賴皆 resolved 才可處理。
- 選取未完成、未領取且無阻擋的最小票號，先保存 claimed 再工作。
- 解答追加於 `## Answer`，標記 resolved，再將摘要與連結加入 map。
