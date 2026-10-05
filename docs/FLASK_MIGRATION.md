# Flask 后台迁移与验收

2026-10-05。提交要求指定 Python Flask，当前正式后台改为 app.py + wsgi.py。HTML/CSS/JS 和四个已部署 Sepolia 合约沿用。Node.js 仅用于 Solidity 编译、测试链及合约测试；server/ 的旧实现与 tests/api.test.mjs 留作历史参考，不是当前部署入口。

## 本地运行

1. Python 3.12：创建虚拟环境，执行 `pip install -r requirements.txt`。
2. 安装 Node 工具依赖：`corepack enable`、`pnpm install --frozen-lockfile`、`pnpm run build`。构建生成 artifacts、abi 与本地 ethers 浏览器库。
3. 设置 `RPC_URL=https://ethereum-sepolia-rpc.publicnode.com`、`APP_ORIGIN=http://localhost:3000`。根目录部署配置已包含公共信息，不含私钥。
4. `python app.py`，浏览器打开 http://localhost:3000。生产使用 Gunicorn，不用 Flask 开发服务器。

生产要求 DATABASE_URL 指向持久化 PostgreSQL；沿用原 challenges、sessions、invoices、receipts 表。Python 每次事务创建连接并关闭，SQL 参数绑定，nonce 使用带条件 DELETE RETURNING 原子消费。Cookie 使用 HttpOnly / SameSite Strict / Secure，限定 Origin 和请求体大小；单 worker 下的限流为进程内实现。

## 测试

终端一运行 `node tests/flask-fixture.mjs`（自动生成的随机测试私钥仅写入被忽略的 data/，不提交）。终端二执行 `python -m unittest discover -s tests -p test_flask.py -v`。每次完整重跑应重启 fixture，生成干净链。

9 项集成测试通过：本地链实际创建/领取/审计、静态页面与编译产物、Origin/匿名/输入限制、签名伪造与重放、角色和快照、钱包数据隔离与数据库重开持久性、凭证发送者核验/幂等/钱包转发合约兼容、退出会话、生产数据库必需。

转发交易仍要求外层发送者为当前登录钱包，且必须有本部署合约发出的已知事件。不支持外层发送者不同的通用账户抽象代付。

这些是实际 Ganache + SQLite 集成测试，不等同 Sepolia 实际客户交易或云端数据库重启验收。16 项 Solidity 合约测试保留；迁移后正式 API 测试是上述 9 项。

## 提交文件

- contracts/BridgeRemit.sol：四个 Solidity 合约。
- abi/*.json：四份独立 ABI。
- app.py、wsgi.py、requirements.txt：Python Flask 后台与依赖。
- public/index.html、deploy.html、style.css、app.js、deploy-browser.js：英文网页。
- render.yaml、deployment.sepolia.json：云端部署与公开链配置。
- docs/、tests/：报告、说明与测试；视频链接和成员贡献由小组实际完成。

## Render

将 Blueprint 同步为 runtime: python，使用 render.yaml 的构建和 Gunicorn 启动命令。保留原服务、公开网址及数据库。健康接口额外返回 backend: flask，用于区分迁移前后的实际在线实现。

当前公开网站已核验 `/health` 返回 backend=flask、database=postgres、chainConfigured=true。使用只在内存中生成的临时测试账户，线上完成签名登录、Secure Cookie、nonce 重放拒绝、链上快照读取、未授权审计与草稿写入拒绝、退出后会话失效检查。未发送公网链上交易，也未使用用户私钥；结果见 FLASK_PUBLIC_CHECK.json。
