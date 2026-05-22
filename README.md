# Falari Desktop Client

Falari Desktop 是面向 macOS 优先、Windows 兼容的跨平台客户端。当前使用 React + Vite 构建渲染层，Electron 作为桌面壳，业务 SDK 复用扩展端已有的链 API、上传、下载、私有加密和访问码分享逻辑。

## 功能范围

- 钱包管理：创建钱包、导入私钥、选择当前地址、领取本地测试币。
- 数据管理：本地资产库、状态查看、下载、续费、提前删除。
- 上传：公开 Shared CID 模式、私有 Unique CID 模式、期限和永久保存选项。
- 分享：访问码分享已经接入；地址分享界面已预留，后续接收方 Vault Public Key 可用后自动生成 Key Envelope。
- 永久基金：永久数据可向 `PermanentStorageFund` 充值。
- 设置：链节点地址配置。

## 运行

```bash
cd desktop
npm install
npm run dev -- --port 5174
```

浏览器预览：

```text
http://127.0.0.1:5174/
```

Electron 预览：

```bash
npm run dev
npm run electron
```

## 构建

```bash
npm run build
```

构建成功后，渲染层输出到 `desktop/dist`。后续可以接入 `electron-builder` 或 `electron-forge` 生成 `.dmg`、`.exe`、`.msi` 安装包。

## 安全存储说明

当前 MVP 使用浏览器本地存储保存桌面客户端状态，适合开发网验证完整流程。生产版需要替换为：

- macOS：Keychain + 加密文件库。
- Windows：Credential Manager 或 DPAPI + 加密文件库。
- Linux：Secret Service 或 libsecret。

业务层已经把钱包、数据资产、分享和节点配置集中在桌面端状态模型里，后续替换存储层不需要重写界面。
