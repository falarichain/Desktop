import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArrowDownToLine,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  Cloud,
  Database,
  Download,
  FileKey2,
  FileLock2,
  FileUp,
  Gauge,
  HardDriveDownload,
  KeyRound,
  Link2,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  Trash2,
  UploadCloud,
  Wallet,
  X,
} from 'lucide-react';
import { ethers } from 'ethers';
import { ChainApi } from '@falari-extension/lib/api';
import { downloadFile, uploadFile } from '@falari-extension/lib/storage';
import {
  createPasscodeShare,
  downloadPrivateFile,
  uploadPrivateFile,
} from '@falari-extension/lib/private-storage';

type Section = 'dashboard' | 'wallets' | 'data' | 'upload' | 'shares' | 'settings';
type AssetAccess = 'public' | 'private';
type AssetStatus = 'local' | 'uploading' | 'active' | 'shared' | 'deleted' | 'error';

interface WalletRecord {
  id: string;
  name: string;
  address: string;
  privateKey: string;
  createdAt: number;
}

interface DataAsset {
  id: string;
  intentId: string;
  dealId?: string;
  fileName: string;
  fileSize: number;
  access: AssetAccess;
  cidMode: 'shared' | 'unique';
  storageClass: 'standard' | 'permanent';
  duration: number;
  expiresAtUnix?: number;
  status: AssetStatus;
  dataKeyBase64?: string;
  shareUrl?: string;
  accessCode?: string;
  createdAt: number;
  updatedAt: number;
}

interface DesktopState {
  wallets: WalletRecord[];
  selectedWalletId?: string;
  assets: DataAsset[];
  chainUrl: string;
}

const STORAGE_KEY = 'falari_desktop_state_v1';
const defaultState: DesktopState = {
  wallets: [],
  assets: [],
  chainUrl: 'http://localhost:8080',
};

const durationOptions = [
  { label: '90 天', value: 90 * 86400 },
  { label: '1 年', value: 365 * 86400 },
  { label: '5 年', value: 5 * 365 * 86400 },
  { label: '永久', value: 0 },
];

const navigation = [
  { id: 'dashboard', label: '概览', icon: Gauge },
  { id: 'wallets', label: '钱包', icon: Wallet },
  { id: 'data', label: '数据', icon: Database },
  { id: 'upload', label: '上传', icon: UploadCloud },
  { id: 'shares', label: '分享', icon: Share2 },
  { id: 'settings', label: '设置', icon: Settings },
] satisfies { id: Section; label: string; icon: typeof Gauge }[];

function loadState(): DesktopState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...defaultState, ...JSON.parse(raw) } : defaultState;
  } catch {
    return defaultState;
  }
}

function saveState(state: DesktopState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function formatSize(bytes: number) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function shortAddress(address?: string) {
  if (!address) return '未选择';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function normalizeIntentId(asset: DataAsset) {
  return asset.intentId || asset.id;
}

function downloadBlob(fileName: string, data: Uint8Array) {
  const copy = new Uint8Array(data);
  const url = URL.createObjectURL(new Blob([copy.buffer]));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

async function postWire<T>(chainUrl: string, path: string, body: unknown): Promise<T> {
  const resp = await fetch(`${chainUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(toWirePayload(body)),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(text || `HTTP ${resp.status}`);
  return text ? JSON.parse(text) as T : undefined as T;
}

function toWirePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toWirePayload);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
    key.replace(/CIDs/g, 'Cids').replace(/CID/g, 'Cid').replace(/ID/g, 'Id').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase(),
    toWirePayload(entry),
  ]));
}

export default function App() {
  const [section, setSection] = useState<Section>('dashboard');
  const [state, setState] = useState<DesktopState>(() => loadState());
  const [query, setQuery] = useState('');
  const [selectedAssetId, setSelectedAssetId] = useState<string | undefined>();
  const [chainStatus, setChainStatus] = useState<any>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [walletName, setWalletName] = useState('Main Wallet');
  const [importKey, setImportKey] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadAccess, setUploadAccess] = useState<AssetAccess>('private');
  const [duration, setDuration] = useState(durationOptions[1].value);
  const [autoRenew, setAutoRenew] = useState(false);
  const [shareRecipient, setShareRecipient] = useState('');
  const [renewDuration, setRenewDuration] = useState(durationOptions[1].value);
  const [topUpAmount, setTopUpAmount] = useState(1000000);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const api = useMemo(() => new ChainApi(state.chainUrl), [state.chainUrl]);
  const selectedWallet = state.wallets.find((wallet) => wallet.id === state.selectedWalletId) ?? state.wallets[0];
  const selectedAsset = state.assets.find((asset) => asset.id === selectedAssetId) ?? state.assets[0];
  const filteredAssets = state.assets.filter((asset) => {
    const haystack = `${asset.fileName} ${asset.intentId} ${asset.status}`.toLowerCase();
    return haystack.includes(query.toLowerCase());
  });

  useEffect(() => {
    saveState(state);
  }, [state]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const status = await api.getStatus();
        if (!cancelled) setChainStatus(status);
      } catch {
        if (!cancelled) setChainStatus(null);
      }
    };
    tick();
    const timer = window.setInterval(tick, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [api]);

  function patchState(update: Partial<DesktopState>) {
    setState((current) => ({ ...current, ...update }));
  }

  function updateAsset(assetId: string, patch: Partial<DataAsset>) {
    setState((current) => ({
      ...current,
      assets: current.assets.map((asset) => asset.id === assetId ? { ...asset, ...patch, updatedAt: Date.now() } : asset),
    }));
  }

  async function createWallet() {
    const wallet = ethers.Wallet.createRandom();
    const record: WalletRecord = {
      id: `wallet_${Date.now()}`,
      name: walletName.trim() || `Wallet ${state.wallets.length + 1}`,
      address: wallet.address,
      privateKey: wallet.privateKey,
      createdAt: Date.now(),
    };
    patchState({ wallets: [...state.wallets, record], selectedWalletId: record.id });
    setWalletName(`Wallet ${state.wallets.length + 2}`);
    setNotice('钱包已创建，并保存在本机客户端库中。');
  }

  async function importWallet() {
    const wallet = new ethers.Wallet(importKey.trim());
    const record: WalletRecord = {
      id: `wallet_${Date.now()}`,
      name: walletName.trim() || `Imported Wallet ${state.wallets.length + 1}`,
      address: wallet.address,
      privateKey: wallet.privateKey,
      createdAt: Date.now(),
    };
    patchState({ wallets: [...state.wallets, record], selectedWalletId: record.id });
    setImportKey('');
    setNotice('钱包已导入。');
  }

  async function faucet() {
    if (!selectedWallet) return;
    setBusy('faucet');
    try {
      await api.faucet(selectedWallet.address, 100000000);
      setNotice('测试币已领取。');
    } finally {
      setBusy('');
    }
  }

  async function handleUpload() {
    if (!selectedWallet || !selectedFile) return;
    const assetId = `asset_${Date.now()}`;
    const asset: DataAsset = {
      id: assetId,
      intentId: '',
      fileName: selectedFile.name,
      fileSize: selectedFile.size,
      access: uploadAccess,
      cidMode: uploadAccess === 'private' ? 'unique' : 'shared',
      storageClass: duration === 0 ? 'permanent' : 'standard',
      duration,
      status: 'uploading',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    patchState({ assets: [asset, ...state.assets] });
    setSelectedAssetId(assetId);
    setSection('data');
    setBusy('upload');
    try {
      const result: any = uploadAccess === 'private'
        ? await uploadPrivateFile(api, selectedFile, selectedWallet.address, {
          duration,
          onProgress: (stage) => {
            updateAsset(assetId, { status: 'uploading' });
            setNotice(`上传进度：${stage}`);
          },
        })
        : await uploadFile(api, selectedFile, selectedWallet.address, {
          duration,
          onProgress: (progress) => {
            updateAsset(assetId, { status: 'uploading' });
            setNotice(`上传进度：${progress.stage}`);
          },
        });
      updateAsset(assetId, {
        intentId: result.intentId,
        dealId: result.dealId,
        status: 'active',
        dataKeyBase64: 'dataKeyBase64' in result ? result.dataKeyBase64 : undefined,
        expiresAtUnix: duration > 0 ? nowUnix() + duration : undefined,
      });
      if (autoRenew && duration > 0) {
        setNotice('上传完成。自动续费需要链端 intent policy 开启，后续会在上传 SDK 中写入。');
      } else {
        setNotice('上传完成。');
      }
    } catch (err) {
      updateAsset(assetId, { status: 'error' });
      setNotice(err instanceof Error ? err.message : '上传失败');
    } finally {
      setBusy('');
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleDownload(asset = selectedAsset) {
    if (!asset) return;
    setBusy('download');
    try {
      const result = asset.access === 'private' && asset.dataKeyBase64
        ? await downloadPrivateFile(api, normalizeIntentId(asset), { dataKeyBase64: asset.dataKeyBase64 })
        : await downloadFile(api, normalizeIntentId(asset), selectedWallet?.address || '');
      downloadBlob(result.fileName || asset.fileName, result.data);
      setNotice('下载已开始。');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '下载失败');
    } finally {
      setBusy('');
    }
  }

  async function handlePasscodeShare() {
    if (!selectedAsset || !selectedWallet || !selectedAsset.dataKeyBase64) {
      setNotice('只有本机保存了 Data Key 的私有文件才能生成访问码分享。');
      return;
    }
    setBusy('share');
    try {
      const result = await createPasscodeShare(api, {
        intentId: selectedAsset.intentId,
        owner: selectedWallet.address,
        dataKeyBase64: selectedAsset.dataKeyBase64,
        appBaseUrl: 'falari://open',
      });
      updateAsset(selectedAsset.id, {
        status: 'shared',
        shareUrl: result.url,
        accessCode: result.accessCode,
      });
      setNotice('访问码分享已生成。');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '分享失败');
    } finally {
      setBusy('');
    }
  }

  async function handleRenew(asset = selectedAsset) {
    if (!asset || !selectedWallet) return;
    setBusy('renew');
    try {
      const resp: any = await postWire(state.chainUrl, `/intents/${asset.intentId}/renew`, {
        intentId: asset.intentId,
        user: selectedWallet.address,
        duration: renewDuration,
      });
      updateAsset(asset.id, {
        status: 'active',
        expiresAtUnix: resp.expires_at_unix || resp.expiresAtUnix || nowUnix() + renewDuration,
        duration: renewDuration,
      });
      setNotice('续费完成。');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '续费失败');
    } finally {
      setBusy('');
    }
  }

  async function handleTopUpPermanentFund() {
    if (!selectedAsset || !selectedWallet) return;
    setBusy('topup');
    try {
      await api.topUpPermanentFund({
        intentId: selectedAsset.intentId,
        user: selectedWallet.address,
        amount: topUpAmount,
      });
      setNotice('永久基金已充值。');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '充值失败');
    } finally {
      setBusy('');
    }
  }

  async function handleDelete(asset = selectedAsset) {
    if (!asset || !selectedWallet) return;
    setBusy('delete');
    try {
      await postWire(state.chainUrl, '/intents/terminate', {
        intentId: asset.intentId,
        user: selectedWallet.address,
        reason: 'user_delete',
      });
      updateAsset(asset.id, { status: 'deleted' });
      setNotice('删除请求已提交，矿工会按删除任务提交回执。');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="traffic-space" />
        <div className="brand">
          <div className="brand-mark">F</div>
          <div>
            <div className="brand-name">Falari</div>
            <div className="brand-subtitle">Desktop Client</div>
          </div>
        </div>
        <nav className="nav-list">
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={`nav-item ${section === item.id ? 'active' : ''}`} onClick={() => setSection(item.id)}>
                <Icon size={17} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <div className={`node-dot ${chainStatus ? 'online' : ''}`} />
          <div>
            <div className="muted">Chain Node</div>
            <div className="mono small">{state.chainUrl.replace(/^https?:\/\//, '')}</div>
          </div>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div className="search-box">
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件、intent、状态" />
          </div>
          <div className="wallet-pill">
            <Wallet size={16} />
            <span>{selectedWallet ? shortAddress(selectedWallet.address) : '未创建钱包'}</span>
          </div>
          <button className="icon-button" title="刷新链状态" onClick={() => api.getStatus().then(setChainStatus).catch(() => setChainStatus(null))}>
            <RefreshCw size={16} />
          </button>
        </header>

        {notice && (
          <div className="notice">
            <CheckCircle2 size={16} />
            <span>{notice}</span>
            <button onClick={() => setNotice('')}><X size={15} /></button>
          </div>
        )}

        {section === 'dashboard' && (
          <Dashboard
            chainStatus={chainStatus}
            wallets={state.wallets}
            assets={state.assets}
            onOpenUpload={() => setSection('upload')}
          />
        )}

        {section === 'wallets' && (
          <WalletsView
            wallets={state.wallets}
            selectedWalletId={state.selectedWalletId}
            walletName={walletName}
            importKey={importKey}
            busy={busy}
            onSelect={(id) => patchState({ selectedWalletId: id })}
            onWalletName={setWalletName}
            onImportKey={setImportKey}
            onCreate={createWallet}
            onImport={importWallet}
            onFaucet={faucet}
          />
        )}

        {section === 'data' && (
          <DataView
            assets={filteredAssets}
            selectedAsset={selectedAsset}
            busy={busy}
            renewDuration={renewDuration}
            topUpAmount={topUpAmount}
            onSelect={(asset) => setSelectedAssetId(asset.id)}
            onDownload={handleDownload}
            onDelete={handleDelete}
            onRenew={handleRenew}
            onRenewDuration={setRenewDuration}
            onTopUpAmount={setTopUpAmount}
            onTopUp={handleTopUpPermanentFund}
          />
        )}

        {section === 'upload' && (
          <UploadView
            selectedWallet={selectedWallet}
            selectedFile={selectedFile}
            uploadAccess={uploadAccess}
            duration={duration}
            autoRenew={autoRenew}
            busy={busy}
            fileInputRef={fileInputRef}
            onFile={setSelectedFile}
            onUploadAccess={setUploadAccess}
            onDuration={setDuration}
            onAutoRenew={setAutoRenew}
            onUpload={handleUpload}
          />
        )}

        {section === 'shares' && (
          <SharesView
            assets={state.assets}
            selectedAsset={selectedAsset}
            shareRecipient={shareRecipient}
            busy={busy}
            onSelect={(asset) => setSelectedAssetId(asset.id)}
            onShareRecipient={setShareRecipient}
            onPasscodeShare={handlePasscodeShare}
          />
        )}

        {section === 'settings' && (
          <SettingsView
            chainUrl={state.chainUrl}
            onChainUrl={(chainUrl) => patchState({ chainUrl })}
          />
        )}
      </main>
    </div>
  );
}

function Dashboard({ chainStatus, wallets, assets, onOpenUpload }: {
  chainStatus: any;
  wallets: WalletRecord[];
  assets: DataAsset[];
  onOpenUpload: () => void;
}) {
  const activeAssets = assets.filter((asset) => asset.status !== 'deleted');
  return (
    <div className="page-grid">
      <section className="hero-panel">
        <div>
          <div className="eyebrow">Falari private storage</div>
          <h1>钱包、数据和分享在一个工作台里完成。</h1>
          <p>本地客户端负责密钥、加密、上传、下载和访问码分享；链节点负责 intent、续费、删除任务和治理状态。</p>
        </div>
        <button className="primary-button" onClick={onOpenUpload}>
          <FileUp size={17} />
          上传文件
        </button>
      </section>
      <div className="metric-row">
        <Metric icon={Wallet} label="钱包" value={wallets.length.toString()} />
        <Metric icon={Archive} label="本地资产" value={activeAssets.length.toString()} />
        <Metric icon={Cloud} label="链高度" value={chainStatus?.height?.toString() || '离线'} />
        <Metric icon={Database} label="活跃矿工" value={chainStatus?.activeMiners?.toString() || '0'} />
      </div>
      <section className="split">
        <div className="surface">
          <div className="section-title">最近数据</div>
          <AssetList assets={assets.slice(0, 6)} onSelect={() => {}} compact />
        </div>
        <div className="surface">
          <div className="section-title">推荐流程</div>
          <div className="flow-list">
            <FlowItem icon={ShieldCheck} title="私有上传" body="客户端先加密，再分片上传，同一文件不同用户 CID 不同。" />
            <FlowItem icon={Share2} title="访问码分享" body="生成公开分享链接和单独访问码，普通用户不用理解 Data Key。" />
            <FlowItem icon={CalendarClock} title="续费和删除" body="期限数据可续费或提前删除，永久数据可为基金充值。" />
          </div>
        </div>
      </section>
    </div>
  );
}

function WalletsView(props: {
  wallets: WalletRecord[];
  selectedWalletId?: string;
  walletName: string;
  importKey: string;
  busy: string;
  onSelect: (id: string) => void;
  onWalletName: (name: string) => void;
  onImportKey: (key: string) => void;
  onCreate: () => void;
  onImport: () => void;
  onFaucet: () => void;
}) {
  return (
    <div className="two-column">
      <section className="surface">
        <div className="section-title">钱包管理</div>
        <div className="form-grid">
          <label>
            钱包名称
            <input value={props.walletName} onChange={(event) => props.onWalletName(event.target.value)} />
          </label>
          <button className="primary-button" onClick={props.onCreate}>
            <Plus size={17} />
            创建钱包
          </button>
          <label className="wide">
            导入私钥
            <input value={props.importKey} onChange={(event) => props.onImportKey(event.target.value)} placeholder="0x..." />
          </label>
          <button className="secondary-button" onClick={props.onImport} disabled={!props.importKey.trim()}>
            <KeyRound size={17} />
            导入
          </button>
        </div>
      </section>
      <section className="surface">
        <div className="section-title">本机钱包</div>
        <div className="wallet-list">
          {props.wallets.map((wallet) => (
            <button key={wallet.id} className={`wallet-row ${props.selectedWalletId === wallet.id ? 'active' : ''}`} onClick={() => props.onSelect(wallet.id)}>
              <div className="wallet-avatar"><Wallet size={18} /></div>
              <div>
                <div>{wallet.name}</div>
                <div className="mono muted">{wallet.address}</div>
              </div>
              <ChevronRight size={16} />
            </button>
          ))}
          {props.wallets.length === 0 && <EmptyState title="还没有钱包" body="创建或导入一个钱包后，就可以上传和管理数据。" />}
        </div>
        <button className="secondary-button full" onClick={props.onFaucet} disabled={!props.selectedWalletId || props.busy === 'faucet'}>
          {props.busy === 'faucet' ? <Loader2 className="spin" size={17} /> : <CircleDollarSign size={17} />}
          领取本地测试币
        </button>
      </section>
    </div>
  );
}

function DataView(props: {
  assets: DataAsset[];
  selectedAsset?: DataAsset;
  busy: string;
  renewDuration: number;
  topUpAmount: number;
  onSelect: (asset: DataAsset) => void;
  onDownload: (asset?: DataAsset) => void;
  onDelete: (asset?: DataAsset) => void;
  onRenew: (asset?: DataAsset) => void;
  onRenewDuration: (duration: number) => void;
  onTopUpAmount: (amount: number) => void;
  onTopUp: () => void;
}) {
  return (
    <div className="data-layout">
      <section className="surface">
        <div className="section-title">数据资产</div>
        <AssetList assets={props.assets} selectedAsset={props.selectedAsset} onSelect={props.onSelect} />
      </section>
      <aside className="detail-panel">
        {props.selectedAsset ? (
          <>
            <div className="detail-header">
              <FileLock2 size={22} />
              <div>
                <h2>{props.selectedAsset.fileName}</h2>
                <div className="muted mono">{props.selectedAsset.intentId || '等待上传'}</div>
              </div>
            </div>
            <div className="detail-grid">
              <Detail label="大小" value={formatSize(props.selectedAsset.fileSize)} />
              <Detail label="权限" value={props.selectedAsset.access === 'private' ? '私有' : '公开'} />
              <Detail label="CID 模式" value={props.selectedAsset.cidMode === 'unique' ? '每人独立' : '共用'} />
              <Detail label="状态" value={props.selectedAsset.status} />
            </div>
            <div className="action-stack">
              <button className="primary-button" onClick={() => props.onDownload()} disabled={props.busy === 'download' || !props.selectedAsset.intentId}>
                {props.busy === 'download' ? <Loader2 className="spin" size={17} /> : <Download size={17} />}
                下载
              </button>
              {props.selectedAsset.storageClass === 'permanent' ? (
                <div className="inline-form">
                  <input type="number" value={props.topUpAmount} onChange={(event) => props.onTopUpAmount(Number(event.target.value))} />
                  <button className="secondary-button" onClick={props.onTopUp} disabled={props.busy === 'topup'}>
                    <CircleDollarSign size={17} />
                    充值基金
                  </button>
                </div>
              ) : (
                <div className="inline-form">
                  <select value={props.renewDuration} onChange={(event) => props.onRenewDuration(Number(event.target.value))}>
                    {durationOptions.filter((option) => option.value > 0).map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <button className="secondary-button" onClick={() => props.onRenew()} disabled={props.busy === 'renew'}>
                    <CalendarClock size={17} />
                    续费
                  </button>
                </div>
              )}
              <button className="danger-button" onClick={() => props.onDelete()} disabled={props.busy === 'delete' || !props.selectedAsset.intentId}>
                <Trash2 size={17} />
                提前删除
              </button>
            </div>
          </>
        ) : (
          <EmptyState title="选择一个文件" body="文件的下载、分享、续费和删除操作会在这里显示。" />
        )}
      </aside>
    </div>
  );
}

function UploadView(props: {
  selectedWallet?: WalletRecord;
  selectedFile: File | null;
  uploadAccess: AssetAccess;
  duration: number;
  autoRenew: boolean;
  busy: string;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onFile: (file: File | null) => void;
  onUploadAccess: (access: AssetAccess) => void;
  onDuration: (duration: number) => void;
  onAutoRenew: (autoRenew: boolean) => void;
  onUpload: () => void;
}) {
  return (
    <div className="upload-layout">
      <section className="drop-zone" onClick={() => props.fileInputRef.current?.click()}>
        <input ref={props.fileInputRef} type="file" hidden onChange={(event) => props.onFile(event.target.files?.[0] || null)} />
        <HardDriveDownload size={34} />
        <h2>{props.selectedFile ? props.selectedFile.name : '选择一个文件上传'}</h2>
        <p>{props.selectedFile ? formatSize(props.selectedFile.size) : '私有模式会先在客户端加密，再上传到 Falari 网络。'}</p>
      </section>
      <section className="surface upload-options">
        <div className="section-title">上传设置</div>
        <div className="segmented">
          <button className={props.uploadAccess === 'private' ? 'active' : ''} onClick={() => props.onUploadAccess('private')}>
            <Lock size={16} />
            私有
          </button>
          <button className={props.uploadAccess === 'public' ? 'active' : ''} onClick={() => props.onUploadAccess('public')}>
            <Link2 size={16} />
            公开
          </button>
        </div>
        <div className="hint-box">
          {props.uploadAccess === 'private'
            ? 'Private 模式会生成随机 Data Key。同一明文文件，不同用户上传后的 CID 不同。'
            : 'Shared 模式保留内容寻址语义。同一份公开内容可共用 CID，删除时会保护其他有效引用。'}
        </div>
        <label>
          保存期
          <select value={props.duration} onChange={(event) => props.onDuration(Number(event.target.value))}>
            {durationOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={props.autoRenew} onChange={(event) => props.onAutoRenew(event.target.checked)} />
          到期前自动续费
        </label>
        <button className="primary-button full" onClick={props.onUpload} disabled={!props.selectedWallet || !props.selectedFile || props.busy === 'upload'}>
          {props.busy === 'upload' ? <Loader2 className="spin" size={17} /> : <UploadCloud size={17} />}
          开始上传
        </button>
      </section>
    </div>
  );
}

function SharesView(props: {
  assets: DataAsset[];
  selectedAsset?: DataAsset;
  shareRecipient: string;
  busy: string;
  onSelect: (asset: DataAsset) => void;
  onShareRecipient: (recipient: string) => void;
  onPasscodeShare: () => void;
}) {
  const privateAssets = props.assets.filter((asset) => asset.access === 'private');
  return (
    <div className="data-layout">
      <section className="surface">
        <div className="section-title">可分享文件</div>
        <AssetList assets={privateAssets} selectedAsset={props.selectedAsset} onSelect={props.onSelect} compact />
      </section>
      <aside className="detail-panel">
        <div className="section-title">分享方式</div>
        <div className="share-card">
          <FileKey2 size={22} />
          <div>
            <h3>访问码分享</h3>
            <p>生成公开链接和单独访问码，适合普通用户。</p>
          </div>
          <button className="primary-button" onClick={props.onPasscodeShare} disabled={!props.selectedAsset || props.busy === 'share'}>
            {props.busy === 'share' ? <Loader2 className="spin" size={17} /> : <Share2 size={17} />}
            生成
          </button>
        </div>
        <div className="share-card muted-card">
          <KeyRound size={22} />
          <div>
            <h3>地址分享</h3>
            <p>后续接入接收方 Vault Public Key 后，可自动为地址生成 Key Envelope。</p>
          </div>
          <input value={props.shareRecipient} onChange={(event) => props.onShareRecipient(event.target.value)} placeholder="0x recipient" />
        </div>
        {props.selectedAsset?.shareUrl && (
          <div className="share-result">
            <div className="muted">分享链接</div>
            <div className="mono break">{props.selectedAsset.shareUrl}</div>
            <div className="muted">访问码</div>
            <div className="mono">{props.selectedAsset.accessCode}</div>
          </div>
        )}
      </aside>
    </div>
  );
}

function SettingsView({ chainUrl, onChainUrl }: { chainUrl: string; onChainUrl: (url: string) => void }) {
  return (
    <section className="surface settings-panel">
      <div className="section-title">客户端设置</div>
      <label>
        链节点地址
        <input value={chainUrl} onChange={(event) => onChainUrl(event.target.value)} />
      </label>
      <div className="settings-grid">
        <FlowItem icon={Cloud} title="Mac 优先" body="Electron 壳已经预留，当前可在 macOS 作为桌面应用运行。" />
        <FlowItem icon={ShieldCheck} title="PC 兼容" body="渲染层使用 React，Windows 打包时无需重写业务界面。" />
        <FlowItem icon={KeyRound} title="密钥本地化" body="后续可把 localStorage 替换为系统钥匙串和安全文件库。" />
      </div>
    </section>
  );
}

function AssetList({ assets, selectedAsset, onSelect, compact = false }: {
  assets: DataAsset[];
  selectedAsset?: DataAsset;
  onSelect: (asset: DataAsset) => void;
  compact?: boolean;
}) {
  if (assets.length === 0) return <EmptyState title="暂无数据" body="上传后会在这里看到文件状态。" />;
  return (
    <div className={`asset-list ${compact ? 'compact' : ''}`}>
      {assets.map((asset) => (
        <button key={asset.id} className={`asset-row ${selectedAsset?.id === asset.id ? 'active' : ''}`} onClick={() => onSelect(asset)}>
          <div className="file-icon">{asset.access === 'private' ? <FileLock2 size={17} /> : <Archive size={17} />}</div>
          <div className="asset-main">
            <div className="asset-name">{asset.fileName}</div>
            <div className="asset-meta">{formatSize(asset.fileSize)} · {asset.cidMode === 'unique' ? '独立 CID' : '共用 CID'} · {asset.status}</div>
          </div>
          <div className="asset-status">{asset.storageClass === 'permanent' ? '永久' : '期限'}</div>
        </button>
      ))}
    </div>
  );
}

function Metric({ icon: Icon, label, value }: { icon: typeof Gauge; label: string; value: string }) {
  return (
    <div className="metric">
      <Icon size={18} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function FlowItem({ icon: Icon, title, body }: { icon: typeof Gauge; title: string; body: string }) {
  return (
    <div className="flow-item">
      <Icon size={18} />
      <div>
        <h3>{title}</h3>
        <p>{body}</p>
      </div>
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-state">
      <Database size={22} />
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}
