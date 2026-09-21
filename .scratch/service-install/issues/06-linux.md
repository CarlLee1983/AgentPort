# 06: Linux 平台（systemd --user）

**What to build:** 在 Linux 上 `install` / `status` / `restart` / `uninstall` 與 macOS 行為對等，以 systemd user unit 常駐；linger 只提示不代跑。Linux 無實機，本票以主 seam 的假執行器驗證。

**Blocked by:** 03, 05

**Status:** done

- [x] 平台 linux：`install --dry-run` 印出的 unit 含 `ExecStart="<node>" "<安裝目錄 CLI>" serve --config "<設定檔>"`（路徑含空白時正確）、`EnvironmentFile=<設定檔目錄>/agentport.env`、`Environment=PATH=...`、`Restart=always`、`WantedBy=default.target`
- [x] `install`：unit 寫入 `<XDG_CONFIG_HOME 或 ~/.config>/systemd/user/agentport.service`，指令序列為 `systemctl --user daemon-reload` → `systemctl --user enable --now agentport`；已啟用時重跑改為 daemon-reload → restart
- [x] 埠逾時：輸出含 `journalctl --user -u agentport -n <N> --no-pager` 的結果，結束碼非零
- [x] `loginctl show-user` 回報 `Linger=no`：install 與 status 都印出 `loginctl enable-linger <user>` 提示，且從未送出 `enable-linger`
- [x] `restart` 送 `systemctl --user restart agentport`；`uninstall` 送 `disable --now`、刪 unit、`daemon-reload`，保留資料
- [x] 03、04 的 token / 骨架 / 包裝指令行為在 linux 平台下同樣成立（至少各一個案例）
