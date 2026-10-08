# Domain Docs

各 engineering skill 探索程式碼時，如何使用本 repo 的領域文件。本 repo 為 single-context。

## 探索前先讀

- **`CONTEXT.md`**（repo 根目錄）：本 repo 的詞彙表，扮演 skill 預設的 `GLOSSARY.md` 角色。不另建 `GLOSSARY.md`。
- **`docs/adr/`**：讀與你要動的區域相關的 ADR。

## 檔案結構

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-external-observation-and-control.md
│   └── ...
└── src/
```

## 使用詞彙表的用語

輸出中提到領域概念時（票名、重構提案、假設、測試名稱），使用 `CONTEXT.md` 定義的詞，不要換成它標為 _Avoid_ 的同義詞。

需要的概念不在詞彙表裡，代表兩種可能：你在發明專案沒用的語言（重新考慮），或真有缺口（記下來交給 `/domain-modeling`）。

## 標出與 ADR 的衝突

輸出與既有 ADR 矛盾時，明確指出，不要默默覆蓋：

> _與 ADR-0003（local transactional task store）衝突，但值得重開，因為……_
