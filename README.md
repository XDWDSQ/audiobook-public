# site-dist 部署镜像

> 本目录是 GitHub Pages 的发布镜像，不是主要源码目录。

## 路径说明

| 路径 | 内容 | 来源 |
| --- | --- | --- |
| `index.html` | 有声书馆着陆页 | `nanagao-redesign/pages/index.html` |
| `zhixiao/` | 《知晓》播放器与章节 | `novel1/audiobook/` |
| `nanian/` | 《那年高中》播放器与章节 | 对应项目音频产物 |
| `CNAME` | 生产自定义域名 | 固定为 `audiobook-hub.site` |
| `.nojekyll` | 禁用 Jekyll 处理 | 必须保留 |
| `robots.txt` | 爬虫规则 | 顶层站点配置 |

## 同步方法

先在源码目录完成修改与本地验证，再同步到本镜像。**不要用整目录覆盖复制**——《知晓》播放器
源码区（`novel1/audiobook/`）与镜像（`zhixiao/`）对 `_shared/` 的引用写法不同（前者 `_shared/`，
后者 `../_shared/`），请使用仓库根的同步脚本：

```bash
python scripts/sync_zhixiao.py            # 同步 + 校验
python scripts/sync_zhixiao.py --check    # 只检查漂移（有差异退出码 1）
```

着陆页应从生产源码复制，不从草稿或 UI 探索目录发布。

## 发布到生产

本目录内容即公开部署仓库 `XDWDSQ/audiobook-public` 的**根目录**。发布时，把本地 `site-dist/`
的变更同步到该仓库的工作副本并推送，GitHub Pages 会自动构建：

```bash
cd <audiobook-public 工作副本>   # git clone https://github.com/XDWDSQ/audiobook-public.git
# 用本地 site-dist/ 内容覆盖对应文件（保留 CNAME 与 .nojekyll）
git add -A && git commit -m "deploy: 描述" && git push origin main
```

## 禁止事项

- 不直接把 `site-dist/` 当作长期编辑源。
- 不删除或改写 `CNAME`。
- 不删除 `.nojekyll`。
- 不提交真实 API 密钥或令牌。
- 不从实验稿目录整包覆盖生产镜像。
- 不在未完成本地验证时推送。

## 发布前检查

- [ ] 首页与两个播放器可打开
- [ ] 章节数据和音频路径正确
- [ ] Service Worker 缓存版本一致
- [ ] CNAME 与 `.nojekyll` 存在
- [ ] Console 无错误
- [ ] Git diff 只包含预期产物

部署与发布流程见 [ARCHITECTURE.md](../ARCHITECTURE.md) 第 3 节，排障见 [CLAUDE.md](../CLAUDE.md) 排障速查。
