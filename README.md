# site-dist 部署镜像

> 本目录是 GitHub Pages 的发布镜像，不是主要源码目录。

## 路径说明

| 路径 | 内容 | 来源 |
| --- | --- | --- |
| `index.html` | 有声书馆着陆页 | `nanagao-redesign/pages/index.html` |
| `sw.js` | 着陆页根级 Service Worker（外壳离线 + 安装为应用；不介入三书） | `nanagao-redesign/pages/sw.js` |
| `manifest.json` / `icon-*.png` | 站点级 PWA 清单与图标 | 本目录直接维护（图标可由 `scripts/gen_pwa_icons.py` 重生成） |
| `404.html` | 404 页（三书快捷入口的章数/时长由 `scripts/gen_landing_stats.py` 写入） | 本目录即事实源（无源码副本） |
| `sitemap.xml` / `robots.txt` / `og-cover.png` | SEO/爬虫/分享卡片 | 顶层站点配置，本目录直接维护 |
| `zhixiao/` | 《知晓》播放器与章节 | `novel1/audiobook/` |
| `dianjing/` | 《电竞群像》播放器与章节 | 书皮由 `scripts/gen_dianjing_site.py` 生成（模板 `novel1/audiobook/`）；`data.json` 由 `scripts/sync_site.py` 从 `novel3/audio/output/` 同步（压缩为 compact 写出） |
| `nanian/` | 《那年高中》播放器与章节 | 书皮由 `scripts/gen_nanian_site.py` 生成（模板 `novel1/audiobook/`）；`data.json`/音频以本目录为事实源 |
| `CNAME` | 生产自定义域名 | 固定为 `audiobook-hub.site` |
| `.nojekyll` | 禁用 Jekyll 处理 | 必须保留 |

## 同步方法

先在源码目录完成修改与本地验证，再同步到本镜像。**不要用整目录覆盖复制**——《知晓》播放器
源码区（`novel1/audiobook/`）与镜像（`zhixiao/`）对 `_shared/` 的引用写法不同（前者 `_shared/`，
后者 `../_shared/`），请使用仓库根的同步脚本：

```bash
python scripts/gen_landing_stats.py      # 着陆页统计数字 ← 三份 data.json（sync 前先跑）
python scripts/gen_dianjing_site.py      # 生成 dianjing 书皮（模板或 novel3 data.json 变更后）
python scripts/gen_nanian_site.py        # 生成 nanian 书皮（模板变更后；data.json 不动）
python scripts/sync_site.py              # 同步全部（zhixiao + dianjing + landing + shared）+ 校验
python scripts/sync_site.py --check      # 只检查漂移（有差异退出码 1，QA/CI 用）
```

着陆页应从生产源码（`nanagao-redesign/pages/index.html`）同步，不从草稿或 UI 探索目录发布。

## 发布到生产

本目录内容即公开部署仓库 `XDWDSQ/audiobook-public` 的**根目录**。发布为手工通道：
先在源码目录跑生成链（`gen_landing_stats.py` / `gen_dianjing_site.py` / `gen_nanian_site.py` / `sync_site.py`），
再把本地 `site-dist/` 的变更（**含章节音频**）同步到该仓库工作副本并提交推送（保留 `CNAME` 与
`.nojekyll`），GitHub Pages 会自动构建。

## 禁止事项

- 不直接把 `site-dist/` 当作长期编辑源。
- 不删除或改写 `CNAME`。
- 不删除 `.nojekyll`。
- 不提交真实 API 密钥或令牌。
- 不从实验稿目录整包覆盖生产镜像。
- 不在未完成本地验证时推送。

## 发布前检查

- [ ] 首页与三个播放器（zhixiao / dianjing / nanian）可打开
- [ ] 章节数据和音频路径正确
- [ ] Service Worker 缓存版本一致
- [ ] CNAME 与 `.nojekyll` 存在
- [ ] Console 无错误
- [ ] Git diff 只包含预期产物

部署与发布流程见源码仓库 [ARCHITECTURE.md](../ARCHITECTURE.md) 第 3 节，排障见 [CLAUDE.md](../CLAUDE.md) 排障速查。
