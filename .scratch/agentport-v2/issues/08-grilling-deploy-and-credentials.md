# 部署方式與同使用者憑證模型

Type: grilling
Status: open
Blocked by: 01, 02
Map: ../map.md

## Question

服務在 Mac（launchd）與 Linux（systemd --user？）如何以「已登入 CLI 的那個使用者」身分常駐，Keychain / auth.json 是否可讀，遠端如何連入（直連 HTTP 或 SSH tunnel）。輸出一張 ADR：為何接受同使用者憑證模型並偏離 v1 ADR-0006/0007/0010。
