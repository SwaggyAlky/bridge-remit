# 公开部署记录

核验日期：2026-10-05，Asia/Shanghai。

- 公开网页：https://bridge-remit.onrender.com
- 钱包部署助手：https://bridge-remit.onrender.com/deploy.html
- GitHub 源码：https://github.com/SwaggyAlky/bridge-remit
- Render Service ID：srv-db1kcu7avr4c73cbttq0，Node，Free，Oregon。
- Blueprint ID：exs-db1kc7qd0e5s7385pq30。
- 数据库：bridge-remit-db，Postgres 18，Render 显示 Available。
- 第一轮公开部署使用提交 8a02c9a6e6e988db869934e2dbb8186e2e130e4e，Render 显示 Live。

公开 HTTP 检查：/、/health、/api/config、/api/deploy-artifacts、/deploy.html、/vendor/ethers.js 全部返回 200。

`/health` 返回：
```json
{"status":"ok","database":"postgres","chainConfigured":false}
```

这证明网页/API 已公开部署，并已连接云端 Postgres。**Sepolia 合约尚未部署和接入，因此当前公开网页用于示例查看和部署助手，不能进行真实链上汇款。** 后端数据库的客户数据写入、重启持久性及实际 MetaMask 汇款仍待验收。

下一步：在安装 MetaMask 的浏览器中打开钱包部署助手，切换 Sepolia，用有测试 ETH 的专用钱包逐次签署四个合约部署与三个通道设置。下载完整 deployment.sepolia.json（只有公共配置，无私钥）并提交仓库根目录。随后 Render 重建，/health 应变为 chainConfigured=true，完成多角色端到端验收并追加真实交易 hash。

本地与 GitHub 下载版本均通过 24 项合约/API 测试；这不是公网钱包操作证据。免费计划可能休眠，数据库存在有效期限制，正式演示前查看 Render 当前规则与服务状态。


## Sepolia 合约接入更新（2026-10-05）

已收到用户钱包部署的完整 deployment.sepolia.json，并通过公共 RPC 实际核验：四笔部署回执成功、发送者与管理员一致、地址一致、创建字节码与本项目编译产物一致、ABI 一致、运行时代码长度一致，以及各合约依赖地址正确。三笔通道配置交易成功，CorridorBook 发出的事件及当前链上参数均正确。部分钱包交易通过转发合约提交，因此核验目标合约事件，不只检查外层交易接收地址。

公共地址与七笔交易证据见 SEPOLIA_VERIFICATION.json。SG-PH / SG-IN / SG-BD 参考汇率分别为 56.5 / 83.5 / 120，平台费均为 50 基点，通道启用。用户部署钱包为唯一管理员。

此更新取代上文“合约尚未部署”的历史状态。核验时链上汇款数量为 0，实际客户汇款、多钱包端到端流程及云端业务数据重启持久性仍待验证。测试 ETH 和 dUSD 均不代表真实跨境付款。
