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

先在源码目录完成修改与本地验证，再同步到本镜像。

```powershell
Copy-Item novel1\audiobook\* site-dist\zhixiao\ -Recurse -Force
```

着陆页应从生产源码复制，不从草稿或 UI 探索目录发布。

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

完整流程见[顶层部署指南](../docs/DEPLOYMENT.md)，故障处理见[排错指南](../docs/TROUBLESHOOTING.md)。
