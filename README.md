# 202606AI-

AI 训练营职场人格与 AI 产品方向测评工具。

## 页面

- 测评入口：`https://personality.kiraown.com/`
- 统计后台：`https://personalitystats.kiraown.com/`

`CNAME` 只保留 `personality.kiraown.com`，测评页继续走 GitHub Pages。`personalitystats.kiraown.com` 解析到阿里云服务器公网 IP，并由 Nginx 转发到 Node 统计服务。

## 统计方案

当前采用阿里云服务器部署：

- `index.html`：GitHub Pages 托管测评页。
- `stats.html`：由阿里云服务器上的 Node 服务展示统计后台。
- `server/server.js`：Node 后端，提供统计接口和本地持久化。
- `server/data/submissions.jsonl`：保存每次完成测评的完整答卷。
- `server/data/state.json`：保存完成总数、每题选项计数、结果分布和最近自由输入文本。

测评页只在用户完成全部题目并点击“生成结果”后上报一次，不统计打开页面数，也不统计点击开始数。同一浏览器同一组答案重复点击生成结果不会重复计数；修改答案后重新生成会视为一次新的完成记录。

## 接口

- `POST /api/complete`：保存一次完整测评结果。
- `GET /api/summary`：读取统计后台汇总数据。
- `GET /`：展示统计后台页面。
- `GET /health`：服务健康检查。

默认允许跨域来源：

- `https://personality.kiraown.com`
- `https://personalitystats.kiraown.com`

如需调整，可配置环境变量：

```text
ALLOWED_ORIGINS=https://personality.kiraown.com,https://personalitystats.kiraown.com
```

## 阿里云服务器部署

服务器建议目录：

```bash
/www/personality-stats
```

启动服务：

```bash
cd /www/personality-stats/server
pm2 start server.js --name personality-stats
pm2 save
```

Node 服务默认监听：

```text
127.0.0.1:8788
```

Nginx 反向代理：

```nginx
server {
    listen 80;
    server_name personalitystats.kiraown.com;

    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

上线 HTTPS 后，测评页会向：

```text
https://personalitystats.kiraown.com/api/complete
```

上报数据，统计后台会读取：

```text
https://personalitystats.kiraown.com/api/summary
```

## 测试

1. 打开 `https://personality.kiraown.com/`，完成一次测评并生成结果。
2. 打开 `https://personalitystats.kiraown.com/api/summary`，确认 `completions` 增加。
3. 打开 `https://personalitystats.kiraown.com/`，确认看板显示完成总数、每题选项、主推岗位、职场人格、AI 产品可行性分布。
4. 在同一浏览器不改答案重复点击生成结果，确认完成总数不增加。
5. 修改任意答案后重新生成，确认完成总数增加。
6. 用微信扫码打开测评页，完成测评后确认统计后台更新。
