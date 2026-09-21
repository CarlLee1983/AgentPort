# Issue tracker：local-markdown

本 repo 沒有外部 tracker。地圖、決策票、建置工單都是 `.scratch/` 下的 markdown 檔，git 是唯一的併發控制。

## 目錄

- `.scratch/agentport-v2/`：wayfinder 決策地圖（`map.md`）與決策票（`issues/NN-slug.md`）。
- `.scratch/agentport-v2-build/`：`/to-tickets` 產出的建置工單（`issues/NN-slug.md`）。建置工單與決策票的編號各自獨立；引用時帶目錄名。

## 票的欄位

決策票檔頭：

```
# <票名>

Type: research | prototype | grilling | task
Status: open | claimed | resolved
Assignee: <name> (<date>)        # 只在 claimed 時存在
Blocked by: 01, 02               # 決策票編號；沒有就省略
Map: ../map.md
```

建置工單依 `/to-tickets` 的 local-ticket-template：`**Blocked by:**`、`**Status:** ready-for-agent | done`、驗收 checkbox。

## Wayfinding operations

- **Frontier**：`Status: open` 且 `Blocked by` 列出的票全部 `resolved` 的票，依編號序。查法：`grep -n "^Status:\|^Blocked by:" issues/*.md`。
- **認領**：把 `Status: open` 改成 `Status: claimed` 並加 `Assignee` 行，先改再開工。
- **結案**：在票尾加 `## Answer`，`Status` 改 `resolved`，刪 `Assignee`；地圖 `## Decisions so far` 加一行 `[票名](issues/NN-slug.md) — gist`。
- **新票**：取下一個編號，先建檔再在其他票補 `Blocked by`。
- **出範圍**：`Status: resolved` 加 `Out of scope` 註記，地圖 `## Out of scope` 加一行，不進 Decisions so far。
- **建置工單完成**：勾掉全部 checkbox、`Status` 改 `done`，與程式碼同一個 commit。
