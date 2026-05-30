import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  AlertTriangle,
  ArrowDownToLine,
  ArrowRight,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  Clock,
  Cloud,
  Copy,
  Database,
  Download,
  Eye,
  EyeOff,
  FileKey2,
  FileLock2,
  FileUp,
  Gauge,
  HardDriveDownload,
  Key,
  KeyRound,
  Link2,
  Loader2,
  Lock,
  Plus,
  Play,
  RefreshCw,
  Search,
  Server,
  Settings,
  Share2,
  Shield,
  ShieldCheck,
  Square,
  Trash2,
  UploadCloud,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { ethers } from 'ethers';
import { ChainApi } from '@falari-extension/lib/api';
import {
  computeMultisigAddress,
  validateMultisigSigners,
  buildMultisigTransferRequest,
  signMultisigCreate,
  signMultisigExec,
  encodeMultisigProposal,
  decodeMultisigProposal,
  sortSignatures,
} from '@falari-extension/lib/multisig';
import type { MultisigWallet, MultisigWalletInfo, MultisigProposal, MultisigExecRequest, BridgeConfig, BridgeOutbound } from '@falari-extension/lib/types';
import { TOKEN_UNIT } from '@falari-extension/lib/types';
import { downloadFile, uploadFile } from '@falari-extension/lib/storage';
import {
  createPasscodeShare,
  deriveStorageVaultKeyBase64,
  downloadPrivateFile,
  openAddressShare,
  openPasscodeShare,
  parseShareLink,
  recoverOwnerDataKeyBase64,
  sharePrivateFileWithAddress,
  uploadPrivateFile,
} from '@falari-extension/lib/private-storage';

type Section = 'dashboard' | 'wallets' | 'multisig' | 'bridge' | 'data' | 'upload' | 'shares' | 'mining' | 'settings';
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
  mining: MiningConfig;
}

interface MiningConfig {
  addr: string;
  endpoint: string;
  dataDir: string;
  capacity: number;
  stake: number;
  p2pListen: string;
  p2pPeers: string;
}

interface MiningRuntime {
  running: boolean;
  pid?: number | null;
  logs: string[];
}

interface MinerStats {
  miner_address?: string;
  miner_id?: number;
  status?: string;
  proof_success?: number;
  proof_failure?: number;
  rewards?: number;
  storage_rewards?: number;
  unsettled_storage_rewards?: number;
  estimated_storage_rewards?: number;
  storage_reward_accrued?: number;
  retrieval_rewards?: number;
  repair_rewards?: number;
  pending_mining_rewards?: number;
  vesting_mining_rewards?: number;
  claimable_mining_rewards?: number;
  effective_weight?: number;
  capacity_bytes?: number;
  used_bytes?: number;
  slashed?: number;
  locked_bonus?: number;
  bonus_released?: boolean;
  bonus_expired?: boolean;
  last_capacity_adjust_unix?: number;
}

interface ClaimMiningRewardsResponse {
  miner_address: string;
  claimed: number;
  balance: number;
  pending_mining_rewards?: number;
  vesting_mining_rewards?: number;
  claimable_mining_rewards?: number;
}

const STORAGE_KEY = 'falari_desktop_state_v1';
const defaultState: DesktopState = {
  wallets: [],
  assets: [],
  chainUrl: 'http://localhost:8080',
  mining: {
    addr: ':9090',
    endpoint: 'http://localhost:9090',
    dataDir: './data/desktop-miner',
    capacity: 1024 ** 4,
    stake: 1000,
    p2pListen: '',
    p2pPeers: '',
  },
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
  { id: 'multisig', label: '多签', icon: Users },
  { id: 'bridge', label: '跨链桥', icon: Link2 },
  { id: 'data', label: '数据', icon: Database },
  { id: 'upload', label: '上传', icon: UploadCloud },
  { id: 'shares', label: '分享', icon: Share2 },
  { id: 'mining', label: '挖矿', icon: Server },
  { id: 'settings', label: '设置', icon: Settings },
] satisfies { id: Section; label: string; icon: typeof Gauge }[];

declare global {
  interface Window {
    falariDesktop?: {
      platform: string;
      version: string;
      miningStatus: () => Promise<MiningRuntime>;
      startMining: (config: MiningConfig & { chainUrl: string; minerAddress?: string; minerPrivateKey?: string }) => Promise<MiningRuntime>;
      stopMining: () => Promise<MiningRuntime>;
      getDiskFreeSpace: (dirPath?: string) => Promise<{ freeBytes: number; totalBytes: number }>;
      safeStorageAvailable: () => Promise<boolean>;
      encryptSecret: (plaintext: string) => Promise<string | null>;
      decryptSecret: (base64: string) => Promise<string | null>;
      onMiningLog: (callback: (line: string) => void) => () => void;
      onMiningStatus: (callback: (status: MiningRuntime) => void) => () => void;
    };
  }
}

const SAFE_PREFIX = 'safe:';

async function encryptWalletKeys(wallets: WalletRecord[]): Promise<WalletRecord[]> {
  if (!window.falariDesktop) return wallets;
  const available = await window.falariDesktop.safeStorageAvailable();
  if (!available) return wallets;
  return Promise.all(wallets.map(async (w) => {
    if (!w.privateKey || w.privateKey.startsWith(SAFE_PREFIX)) return w;
    const encrypted = await window.falariDesktop!.encryptSecret(w.privateKey);
    return encrypted ? { ...w, privateKey: SAFE_PREFIX + encrypted } : w;
  }));
}

async function decryptWalletKeys(wallets: WalletRecord[]): Promise<WalletRecord[]> {
  if (!window.falariDesktop) return wallets;
  const available = await window.falariDesktop.safeStorageAvailable();
  if (!available) return wallets;
  return Promise.all(wallets.map(async (w) => {
    if (!w.privateKey.startsWith(SAFE_PREFIX)) return w;
    const decrypted = await window.falariDesktop!.decryptSecret(w.privateKey.slice(SAFE_PREFIX.length));
    return decrypted ? { ...w, privateKey: decrypted } : w;
  }));
}

function loadState(): DesktopState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...defaultState, ...JSON.parse(raw) } : defaultState;
  } catch {
    return defaultState;
  }
}

async function saveState(state: DesktopState) {
  const encryptedWallets = await encryptWalletKeys(state.wallets);
  const toStore = { ...state, wallets: encryptedWallets };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
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

function formatTokenAmount(amount?: number) {
  const units = Number(amount || 0) / TOKEN_UNIT;
  if (units >= 1_000_000) return `${(units / 1_000_000).toFixed(2)}M GF`;
  if (units >= 1_000) return `${(units / 1_000).toFixed(2)}K GF`;
  return `${parseFloat(units.toFixed(8)).toString()} GF`;
}

function shortAddress(address?: string) {
  if (!address) return '未选择';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

async function getWire<T>(chainUrl: string, path: string): Promise<T> {
  const resp = await fetch(`${chainUrl.replace(/\/$/, '')}${path}`);
  const text = await resp.text();
  if (!resp.ok) throw new Error(text || `HTTP ${resp.status}`);
  return text ? JSON.parse(text) as T : undefined as T;
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

function signClaimMiningRewards(privateKey: string, params: {
  chainId: string;
  minerAddress: string;
  nonce: number;
}) {
  const payload = {
    action: 'claim_mining_rewards',
    chain_id: params.chainId,
    miner_address: params.minerAddress,
    nonce: params.nonce,
  };
  const digest = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(payload)));
  const signingKey = new ethers.SigningKey(privateKey);
  return signingKey.sign(digest).serialized;
}

function signAdjustCapacity(privateKey: string, params: {
  chainId: string;
  minerAddress: string;
  newCapacityBytes: number;
  nonce: number;
}) {
  const payload = {
    action: 'adjust_capacity',
    chain_id: params.chainId,
    miner_address: params.minerAddress,
    new_capacity_bytes: params.newCapacityBytes,
    nonce: params.nonce,
  };
  const digest = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(payload)));
  const signingKey = new ethers.SigningKey(privateKey);
  return signingKey.sign(digest).serialized;
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
  const [minerStats, setMinerStats] = useState<MinerStats | null>(null);
  const [minerStatsError, setMinerStatsError] = useState('');
  const [miningRuntime, setMiningRuntime] = useState<MiningRuntime>({ running: false, logs: [] });
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [walletName, setWalletName] = useState('Main Wallet');
  const [importKey, setImportKey] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadAccess, setUploadAccess] = useState<AssetAccess>('private');
  const [duration, setDuration] = useState(durationOptions[1].value);
  const [autoRenew, setAutoRenew] = useState(false);
  const [shareRecipient, setShareRecipient] = useState('');
  const [shareFullLink, setShareFullLink] = useState(false);
  const [openShareId, setOpenShareId] = useState('');
  const [openAccessCode, setOpenAccessCode] = useState('');
  const [renewDuration, setRenewDuration] = useState(durationOptions[1].value);
  const [topUpAmount, setTopUpAmount] = useState(1000000);
  const [diskInfo, setDiskInfo] = useState<{ freeBytes: number; totalBytes: number } | null>(null);
  const [capacityUnit, setCapacityUnit] = useState<'TB' | 'GB'>('TB');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const api = useMemo(() => new ChainApi(state.chainUrl), [state.chainUrl]);
  const selectedWallet = state.wallets.find((wallet) => wallet.id === state.selectedWalletId) ?? state.wallets[0];
  const selectedAsset = state.assets.find((asset) => asset.id === selectedAssetId) ?? state.assets[0];
  const filteredAssets = state.assets.filter((asset) => {
    const haystack = `${asset.fileName} ${asset.intentId} ${asset.status}`.toLowerCase();
    return haystack.includes(query.toLowerCase());
  });

  const refreshMinerStats = useCallback(async () => {
    if (!selectedWallet) {
      setMinerStats(null);
      setMinerStatsError('');
      return;
    }
    try {
      const stats = await getWire<MinerStats>(state.chainUrl, `/miners/${encodeURIComponent(selectedWallet.address)}`);
      setMinerStats(stats?.miner_address ? stats : null);
      setMinerStatsError('');
    } catch (err) {
      setMinerStats(null);
      setMinerStatsError(err instanceof Error ? err.message : '读取矿工收益失败');
    }
  }, [selectedWallet, state.chainUrl]);

  useEffect(() => {
    saveState(state);
  }, [state]);

  useEffect(() => {
    let cancelled = false;
    decryptWalletKeys(state.wallets).then((decrypted) => {
      if (!cancelled && decrypted.some((w, i) => w.privateKey !== state.wallets[i]?.privateKey)) {
        setState((s) => ({ ...s, wallets: decrypted }));
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!window.falariDesktop) return;
    let cancelled = false;
    window.falariDesktop.miningStatus().then((status) => {
      if (!cancelled) setMiningRuntime(status);
    }).catch(() => {});
    const offLog = window.falariDesktop.onMiningLog((line) => {
      setMiningRuntime((current) => ({ ...current, logs: [...current.logs.slice(-79), line] }));
    });
    const offStatus = window.falariDesktop.onMiningStatus((status) => setMiningRuntime(status));
    return () => {
      cancelled = true;
      offLog();
      offStatus();
    };
  }, []);

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

  useEffect(() => {
    refreshMinerStats();
    const timer = window.setInterval(refreshMinerStats, 15000);
    return () => window.clearInterval(timer);
  }, [refreshMinerStats]);

  const refreshDiskInfo = useCallback(async () => {
    if (!window.falariDesktop) return;
    try {
      const info = await window.falariDesktop.getDiskFreeSpace(state.mining.dataDir);
      setDiskInfo(info);
    } catch {
      setDiskInfo(null);
    }
  }, [state.mining.dataDir]);

  useEffect(() => {
    refreshDiskInfo();
  }, [refreshDiskInfo]);

  function patchState(update: Partial<DesktopState>) {
    setState((current) => ({ ...current, ...update }));
  }

  function updateAsset(assetId: string, patch: Partial<DataAsset>) {
    setState((current) => ({
      ...current,
      assets: current.assets.map((asset) => asset.id === assetId ? { ...asset, ...patch, updatedAt: Date.now() } : asset),
    }));
  }

  function updateMiningConfig(patch: Partial<MiningConfig>) {
    setState((current) => ({
      ...current,
      mining: { ...current.mining, ...patch },
    }));
  }

  async function startMining() {
    if (!window.falariDesktop) {
      setNotice('当前运行环境不支持启动本地挖矿节点。');
      return;
    }
    if (!selectedWallet?.privateKey) {
      setNotice('请先创建或选择一个钱包，用这个钱包作为矿工地址启动挖矿。');
      return;
    }

    // Pre-flight: check disk free space.
    const MIN_CAP = chainStatus?.minCapacityBytes ?? 200 * 1024 ** 3;
    try {
      const disk = await window.falariDesktop.getDiskFreeSpace(state.mining.dataDir);
      setDiskInfo(disk);
      if (disk.freeBytes < MIN_CAP) {
        setNotice(`磁盘剩余空间不足（${formatSize(disk.freeBytes)}），最低要求 ${formatSize(MIN_CAP)}，无法启动挖矿。`);
        return;
      }
      if (disk.freeBytes < state.mining.capacity) {
        setNotice(`磁盘剩余空间（${formatSize(disk.freeBytes)}）小于设定的挖矿容量（${formatSize(state.mining.capacity)}），请先清理磁盘或减少挖矿容量。`);
        return;
      }
    } catch {
      setNotice('无法读取磁盘空间信息，请确认数据目录路径正确。');
      return;
    }

    // Pre-flight: check bonus quota & stake requirement.
    const stakePerTiB = chainStatus?.stakePerTiB ?? 1000 * TOKEN_UNIT;
    const bonusAmount = chainStatus?.registrationBonusAmount ?? 5000 * TOKEN_UNIT;
    const bonusGranted = chainStatus?.bonusGrantedCount ?? 0;
    const bonusMax = chainStatus?.maxBonusAddresses ?? 200_000;
    const bonusAvailable = bonusGranted < bonusMax;
    const TiB = 1024 ** 4;
    const tibCount = Math.ceil(state.mining.capacity / TiB);
    const requiredStake = tibCount * stakePerTiB;
    if (!bonusAvailable && requiredStake > 0) {
      // Bonus slots exhausted — user must self-fund the full stake.
      // The mining node will enforce this; we just warn the user here.
      const userStake = state.mining.stake * TOKEN_UNIT;
      if (userStake < requiredStake) {
        setNotice(`奖励名额已满（${bonusGranted.toLocaleString()}/${bonusMax.toLocaleString()}），您需要自行质押 ${formatTokenAmount(requiredStake)} Token，当前设置仅 ${formatTokenAmount(userStake)}。`);
        return;
      }
    }

    setBusy('mining');
    try {
      const status = await window.falariDesktop.startMining({
        ...state.mining,
        chainUrl: state.chainUrl,
        minerAddress: selectedWallet.address,
        minerPrivateKey: selectedWallet.privateKey,
      });
      setMiningRuntime(status);
      await refreshMinerStats();
      setNotice('挖矿已开启，本地节点会同时提供上传和下载访问服务。');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '启动挖矿失败');
    } finally {
      setBusy('');
    }
  }

  async function stopMining() {
    if (!window.falariDesktop) return;
    setBusy('mining-stop');
    try {
      const status = await window.falariDesktop.stopMining();
      setMiningRuntime(status);
      setNotice('挖矿停止中，节点会停止提供访问服务。');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '停止挖矿失败');
    } finally {
      setBusy('');
    }
  }

  async function claimMiningRewards() {
    if (!selectedWallet?.privateKey) {
      setNotice('请先选择矿工钱包。');
      return;
    }
    setBusy('claim-mining-rewards');
    try {
      const [account, status] = await Promise.all([api.getAccount(selectedWallet.address), api.getStatus()]);
      const chainId = status.chainId || status.chain_id || 'falari-dev';
      const nonce = account.nonce;
      const signature = signClaimMiningRewards(selectedWallet.privateKey, {
        chainId,
        minerAddress: selectedWallet.address,
        nonce,
      });
      const resp = await postWire<ClaimMiningRewardsResponse>(state.chainUrl, '/miners/claim-rewards', {
        minerAddress: selectedWallet.address,
        chainId,
        nonce,
        signature,
      });
      await refreshMinerStats();
      setNotice(`已领取 ${formatTokenAmount(resp.claimed)}，新的可用余额 ${formatTokenAmount(resp.balance)}。`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '领取挖矿奖励失败');
    } finally {
      setBusy('');
    }
  }

  async function adjustCapacity(newCapacityBytes: number) {
    if (!selectedWallet?.privateKey) {
      setNotice('请先选择矿工钱包。');
      return;
    }
    setBusy('adjust-capacity');
    try {
      const [account, status] = await Promise.all([api.getAccount(selectedWallet.address), api.getStatus()]);
      const chainId = status.chainId || status.chain_id || 'falari-dev';
      const nonce = account.nonce;
      const signature = signAdjustCapacity(selectedWallet.privateKey, {
        chainId,
        minerAddress: selectedWallet.address,
        newCapacityBytes,
        nonce,
      });
      const resp = await postWire<{ miner: MinerStats; refund_unbonding?: number }>(
        state.chainUrl, '/miners/adjust-capacity',
        { minerAddress: selectedWallet.address, newCapacityBytes, chainId, nonce, signature },
      );
      await refreshMinerStats();
      const refund = resp.refund_unbonding ?? 0;
      if (refund > 0) {
        setNotice(`容量已调整为 ${formatSize(newCapacityBytes)}，退还 ${formatTokenAmount(refund)} 将在 7 天后到账。`);
      } else {
        setNotice(`容量已调整为 ${formatSize(newCapacityBytes)}。`);
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '调整容量失败');
    } finally {
      setBusy('');
    }
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
          ownerPrivateKey: selectedWallet.privateKey,
          ownerAddress: selectedWallet.address,
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
        : asset.access === 'private' && selectedWallet
          ? await downloadPrivateFile(api, normalizeIntentId(asset), {
            owner: selectedWallet.address,
            ownerPrivateKey: selectedWallet.privateKey,
          })
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
      const dataKeyBase64 = selectedAsset.dataKeyBase64 || await recoverOwnerDataKeyBase64(
        api,
        selectedAsset.intentId,
        selectedWallet.address,
        selectedWallet.privateKey,
      );
      const result = await createPasscodeShare(api, {
        intentId: selectedAsset.intentId,
        owner: selectedWallet.address,
        dataKeyBase64,
        appBaseUrl: 'falari://open',
        includeKeyInUrl: shareFullLink,
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

  async function handleAddressShare() {
    if (!selectedAsset || !selectedWallet || !shareRecipient.trim()) {
      setNotice('请选择文件并填写接收方地址。');
      return;
    }
    setBusy('address-share');
    try {
      const result = await sharePrivateFileWithAddress(api, {
        intentId: selectedAsset.intentId,
        owner: selectedWallet.address,
        ownerPrivateKey: selectedWallet.privateKey,
        recipient: shareRecipient.trim(),
        dataKeyBase64: selectedAsset.dataKeyBase64,
        appBaseUrl: 'falari://open',
        includeKeyInUrl: true,
      });
      updateAsset(selectedAsset.id, {
        status: 'shared',
        shareUrl: result.url,
        accessCode: result.accessCode,
      });
      setNotice('地址分享链接已生成。');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '地址分享失败');
    } finally {
      setBusy('');
    }
  }

  async function handleOpenShare() {
    if (!selectedWallet || !openShareId.trim()) return;
    setBusy('open-share');
    try {
      const parsed = parseShareLink(openShareId);
      const code = openAccessCode.trim() || parsed.accessCode || '';
      if (!parsed.shareId) {
        throw new Error('请输入分享 ID 或分享链接。');
      }
      if (!code) {
        throw new Error('请输入访问码或分享链接里的密钥片段。');
      }
      const opened = await openShareWithCode(api, parsed.shareId, code, selectedWallet.address);
      const result = await downloadPrivateFile(api, opened.intentId, { dataKeyBase64: opened.dataKeyBase64 });
      downloadBlob(result.fileName, result.data);
      setNotice('分享文件已解密下载。');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '打开分享失败');
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

        {section === 'multisig' && (
          <MultisigView api={api} wallets={state.wallets} />
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
            shareFullLink={shareFullLink}
            openShareId={openShareId}
            openAccessCode={openAccessCode}
            busy={busy}
            onSelect={(asset) => setSelectedAssetId(asset.id)}
            onShareRecipient={setShareRecipient}
            onShareFullLink={setShareFullLink}
            onPasscodeShare={handlePasscodeShare}
            onAddressShare={handleAddressShare}
            onOpenShareId={setOpenShareId}
            onOpenAccessCode={setOpenAccessCode}
            onOpenShare={handleOpenShare}
          />
        )}

        {section === 'mining' && (
          <MiningView
            config={state.mining}
            chainUrl={state.chainUrl}
            chainStatus={chainStatus}
            selectedWallet={selectedWallet}
            minerStats={minerStats}
            minerStatsError={minerStatsError}
            runtime={miningRuntime}
            busy={busy}
            diskInfo={diskInfo}
            capacityUnit={capacityUnit}
            onCapacityUnit={setCapacityUnit}
            onConfig={updateMiningConfig}
            onStart={startMining}
            onStop={stopMining}
            onRefreshRewards={refreshMinerStats}
            onRefreshDisk={refreshDiskInfo}
            onClaimRewards={claimMiningRewards}
            onAdjustCapacity={adjustCapacity}
          />
        )}

        {section === 'bridge' && (
          <BridgeView
            api={api}
            wallets={state.wallets}
            selectedWallet={state.wallets.find((w) => w.id === state.selectedWalletId)}
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

async function openShareWithCode(
  api: ChainApi,
  shareId: string,
  code: string,
  recipient: string,
): Promise<{ intentId: string; dataKeyBase64: string }> {
  try {
    return await openPasscodeShare(api, shareId, code);
  } catch {
    return openAddressShare(api, {
      shareId,
      recipient,
      shareSecret: code,
    });
  }
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
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [vaultKeys, setVaultKeys] = useState<Record<string, string>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copyText = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const toggleKeys = async (wallet: WalletRecord) => {
    const isVisible = showKeys[wallet.id];
    setShowKeys((prev) => ({ ...prev, [wallet.id]: !isVisible }));
    if (!isVisible && !vaultKeys[wallet.id]) {
      try {
        const vk = await deriveStorageVaultKeyBase64(wallet.privateKey, wallet.address);
        setVaultKeys((prev) => ({ ...prev, [wallet.id]: vk }));
      } catch {
        // ignore
      }
    }
  };

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
            <div key={wallet.id}>
              <div className={`wallet-row ${props.selectedWalletId === wallet.id ? 'active' : ''}`} style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }} onClick={() => props.onSelect(wallet.id)}>
                <div className="wallet-avatar"><Wallet size={18} /></div>
                <div style={{ flex: 1 }}>
                  <div>{wallet.name}</div>
                  <div className="mono muted">{wallet.address}</div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); toggleKeys(wallet); }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px', color: 'var(--text-dim, #888)' }}
                  title="导出密钥"
                >
                  {showKeys[wallet.id] ? <EyeOff size={16} /> : <Key size={16} />}
                </button>
                <ChevronRight size={16} />
              </div>
              {showKeys[wallet.id] && (
                <div style={{ padding: '8px 12px 12px 48px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ borderRadius: '8px', border: '1px solid rgba(239,68,68,0.2)', background: 'rgba(239,68,68,0.08)', padding: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                      <span style={{ fontSize: '11px', fontWeight: 600, color: '#f87171' }}>私钥</span>
                      <button
                        onClick={() => copyText(wallet.privateKey, `pk-${wallet.id}`)}
                        style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'none', border: 'none', cursor: 'pointer', fontSize: '10px', color: '#fca5a5', padding: '2px 6px', borderRadius: '4px' }}
                      >
                        {copiedKey === `pk-${wallet.id}` ? <Check size={12} style={{ color: '#4ade80' }} /> : <Copy size={12} />}
                        {copiedKey === `pk-${wallet.id}` ? '已复制' : '复制'}
                      </button>
                    </div>
                    <code style={{ fontSize: '10px', wordBreak: 'break-all', color: '#fca5a5', lineHeight: 1.5 }}>{wallet.privateKey}</code>
                    <p style={{ fontSize: '10px', color: 'rgba(252,165,165,0.7)', marginTop: '4px' }}>请离线保存。任何获得它的人都可以控制这个钱包。</p>
                  </div>
                  {vaultKeys[wallet.id] && (
                    <div style={{ borderRadius: '8px', border: '1px solid rgba(245,158,11,0.2)', background: 'rgba(245,158,11,0.08)', padding: '8px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                        <span style={{ fontSize: '11px', fontWeight: 600, color: '#fbbf24' }}>Vault Key</span>
                        <button
                          onClick={() => copyText(vaultKeys[wallet.id], `vk-${wallet.id}`)}
                          style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'none', border: 'none', cursor: 'pointer', fontSize: '10px', color: '#fcd34d', padding: '2px 6px', borderRadius: '4px' }}
                        >
                          {copiedKey === `vk-${wallet.id}` ? <Check size={12} style={{ color: '#4ade80' }} /> : <Copy size={12} />}
                          {copiedKey === `vk-${wallet.id}` ? '已复制' : '复制'}
                        </button>
                      </div>
                      <code style={{ fontSize: '10px', wordBreak: 'break-all', color: '#fcd34d', lineHeight: 1.5 }}>{vaultKeys[wallet.id]}</code>
                      <p style={{ fontSize: '10px', color: 'rgba(252,211,77,0.7)', marginTop: '4px' }}>可解密此地址所有私有数据，但无转账权限。可安全提供给 Agent 使用。</p>
                    </div>
                  )}
                </div>
              )}
            </div>
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

function MultisigView({ api, wallets }: { api: ChainApi; wallets: WalletRecord[] }) {
  const [msWallets, setMsWallets] = useState<MultisigWalletInfo[]>([]);
  const [proposals, setProposals] = useState<MultisigProposal[]>([]);
  const [signerInputs, setSignerInputs] = useState<string[]>(['', '']);
  const [threshold, setThreshold] = useState(2);
  const [createError, setCreateError] = useState('');
  const [previewAddr, setPreviewAddr] = useState<string | null>(null);
  const [selWallet, setSelWallet] = useState('');
  const [transferTo, setTransferTo] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferFee, setTransferFee] = useState('1');
  const [transferErr, setTransferErr] = useState('');
  const [shareStr, setShareStr] = useState('');
  const [importStr, setImportStr] = useState('');
  const [importErr, setImportErr] = useState('');
  const [signPropId, setSignPropId] = useState<string | null>(null);
  const [signAddr, setSignAddr] = useState('');
  const [signErr, setSignErr] = useState('');
  const [copied, setCopied] = useState('');
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const salt = useMemo(() => Math.floor(Math.random() * 1_000_000), []);

  // Local address set for quick lookups
  const localAddrs = useMemo(() => new Set(wallets.map((w) => w.address.toLowerCase())), [wallets]);
  const addrLabel = (addr: string) => wallets.find((w) => w.address.toLowerCase() === addr.toLowerCase())?.name;
  const validSignerCount = signerInputs.filter((s) => s.trim().length > 0).length;

  useEffect(() => {
    api.listMultisigWallets().then((r) => setMsWallets(r.wallets || [])).catch(() => {});
  }, [api]);

  useEffect(() => {
    const validAddrs = signerInputs.filter((s) => s.trim().length > 0);
    if (validAddrs.length >= 2 && !validateMultisigSigners(validAddrs)) {
      try { setPreviewAddr(computeMultisigAddress(validAddrs, threshold, salt)); } catch { setPreviewAddr(null); }
    } else { setPreviewAddr(null); }
  }, [signerInputs, threshold, salt]);

  const handleCopy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = document.createElement('textarea'); ta.value = text;
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    }
    setCopied(text); setTimeout(() => setCopied(''), 2000);
  };

  const handleCreate = async () => {
    setCreateError('');
    const signers = signerInputs.map((s) => s.trim()).filter(Boolean);
    const err = validateMultisigSigners(signers);
    if (err) { setCreateError(err); return; }
    if (threshold > signers.length) { setCreateError('阈值不能超过签名者总数'); return; }
    if (threshold < 1) { setCreateError('阈值至少为 1'); return; }
    try {
      let creatorPk = '';
      for (const s of signers) {
        const w = wallets.find((wr) => wr.address.toLowerCase() === s.toLowerCase());
        if (w?.privateKey) { creatorPk = w.privateKey; break; }
      }
      if (!creatorPk) { setCreateError('至少需要一个本地签名者来签署创建请求'); return; }
      const signature = await signMultisigCreate(signers, threshold, salt, creatorPk);
      const result = await api.createMultisigWallet({ signers, threshold, salt, signature });
      setMsWallets((prev) => [...prev, { wallet: result, balance: 0 }]);
      setSignerInputs(['', '']); setThreshold(2); setPreviewAddr(null);
    } catch (err: any) { setCreateError(err.message || '创建失败'); }
  };

  const handleRemoveWallet = (address: string) => {
    setMsWallets((prev) => prev.filter((w) => w.wallet.address !== address));
    setProposals((prev) => prev.filter((p) => p.wallet !== address));
    setConfirmRemove(null);
  };

  const handleCreateProposal = async () => {
    setTransferErr('');
    if (!selWallet) { setTransferErr('请先选择多签钱包'); return; }
    const wInfo = msWallets.find((w) => w.wallet.address === selWallet);
    if (!wInfo) { setTransferErr('找不到该钱包'); return; }
    const amount = parseFloat(transferAmount);
    if (isNaN(amount) || amount <= 0) { setTransferErr('请输入有效金额'); return; }
    if (!transferTo.trim()) { setTransferErr('请输入收款地址'); return; }
    const fee = parseFloat(transferFee) || 1;

    let signerAddr = '', signerPk = '';
    for (const s of wInfo.wallet.signers) {
      const w = wallets.find((wr) => wr.address.toLowerCase() === s.toLowerCase());
      if (w?.privateKey) { signerAddr = w.address; signerPk = w.privateKey; break; }
    }
    if (!signerPk) { setTransferErr('该钱包没有可用的本地签名者'); return; }

    try {
      const req = buildMultisigTransferRequest(selWallet, transferTo.trim(), amount, wInfo.wallet.nonce, fee);
      const sig = await signMultisigExec(req, signerAddr, signerPk);
      req.signatures = [sig];
      const prop: MultisigProposal = {
        id: `msig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        wallet: req.wallet, operation: req.operation, payload: req.payload,
        nonce: req.nonce, fee: req.fee, signatures: req.signatures,
        status: 'pending', createdAt: Date.now(),
      };
      setProposals((p) => [...p, prop]);
      setShareStr(encodeMultisigProposal(req));
      setTransferTo(''); setTransferAmount('');
    } catch (err: any) { setTransferErr(err.message || '创建提案失败'); }
  };

  const handleImportProposal = () => {
    setImportErr('');
    const req = decodeMultisigProposal(importStr.trim());
    if (!req) { setImportErr('无效的提案字符串'); return; }
    if (!msWallets.find((w) => w.wallet.address === req.wallet)) { setImportErr('对应的多签钱包不存在，请先创建或导入'); return; }
    const prop: MultisigProposal = {
      id: `msig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      wallet: req.wallet, operation: req.operation, payload: req.payload,
      nonce: req.nonce, fee: req.fee, signatures: req.signatures || [],
      status: 'pending', createdAt: Date.now(),
    };
    setProposals((p) => [...p, prop]);
    setImportStr('');
  };

  const handleSignProposal = async (propId: string) => {
    setSignErr('');
    const prop = proposals.find((p) => p.id === propId);
    if (!prop || !signAddr) { setSignErr('请选择签名者'); return; }
    const w = wallets.find((wr) => wr.address.toLowerCase() === signAddr.toLowerCase());
    if (!w?.privateKey) { setSignErr('该地址的私钥不可用'); return; }
    const wInfo = msWallets.find((mw) => mw.wallet.address === prop.wallet);
    if (!wInfo?.wallet.signers.some((s) => s.toLowerCase() === signAddr.toLowerCase())) { setSignErr('该地址不是此钱包的签名者'); return; }
    if (prop.signatures.some((s) => s.signer.toLowerCase() === signAddr.toLowerCase())) { setSignErr('该签名者已签署'); return; }
    try {
      const execReq: MultisigExecRequest = { wallet: prop.wallet, operation: prop.operation, payload: prop.payload, nonce: prop.nonce, fee: prop.fee, signatures: [] };
      const sig = await signMultisigExec(execReq, signAddr, w.privateKey);
      setProposals((prev) => prev.map((p) => p.id === propId ? { ...p, signatures: [...p.signatures.filter((s) => s.signer !== sig.signer), sig] } : p));
      setSignPropId(null); setSignAddr('');
    } catch (err: any) { setSignErr(err.message || '签名失败'); }
  };

  const handleSubmitProposal = async (propId: string) => {
    const prop = proposals.find((p) => p.id === propId);
    if (!prop) return;
    const wInfo = msWallets.find((w) => w.wallet.address === prop.wallet);
    if (!wInfo || prop.signatures.length < wInfo.wallet.threshold) return;
    try {
      await api.multisigExec({ wallet: prop.wallet, operation: prop.operation, payload: prop.payload, nonce: prop.nonce, fee: prop.fee, signatures: sortSignatures(prop.signatures) });
      setProposals((prev) => prev.map((p) => p.id === propId ? { ...p, status: 'executed' } : p));
      api.listMultisigWallets().then((r) => setMsWallets(r.wallets || [])).catch(() => {});
    } catch (err: any) { console.error('Exec failed:', err); }
  };

  const pendingProps = proposals.filter((p) => p.status === 'pending');

  return (
    <div className="two-column">
      <section className="surface">
        <div className="section-title">创建多签钱包</div>
        <p className="muted" style={{ fontSize: 12, margin: '-4px 0 12px', lineHeight: 1.5 }}>
          添加 2~16 个签名者地址。转账需要至少 M 个签名者共同授权。默认要求全部签名者同意（M=N），你可以手动调低阈值。
        </p>
        <div className="form-grid">
          {signerInputs.map((val, i) => {
            const isLocal = val.trim() ? localAddrs.has(val.trim().toLowerCase()) : false;
            const label = val.trim() ? addrLabel(val.trim()) : null;
            return (
              <label key={i}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  签名者 #{i + 1}
                  {isLocal && <span style={{ fontSize: 9, color: 'var(--accent)', fontWeight: 600 }}>本地 · {label || '账户'}</span>}
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    value={val}
                    onChange={(e) => { const n = [...signerInputs]; n[i] = e.target.value; setSignerInputs(n); setCreateError(''); }}
                    placeholder="0x...  或从下方选择"
                    style={isLocal ? { borderColor: 'var(--accent)', borderWidth: 1 } : {}}
                  />
                  {signerInputs.length > 2 && <button className="secondary-button" onClick={() => { const next = signerInputs.filter((_, j) => j !== i); setSignerInputs(next); if (threshold > next.filter(Boolean).length) setThreshold(next.filter(Boolean).length || 1); }}><Trash2 size={14} /></button>}
                </div>
                {wallets.length > 0 && (
                  <select
                    style={{ marginTop: 4, fontSize: 11, opacity: 0.7 }}
                    value=""
                    onChange={(e) => { if (e.target.value) { const n = [...signerInputs]; n[i] = e.target.value; setSignerInputs(n); setCreateError(''); } }}
                  >
                    <option value="">从本地钱包选择...</option>
                    {wallets.map((w) => <option key={w.address} value={w.address}>{w.name} ({w.address.slice(0, 8)}...{w.address.slice(-4)})</option>)}
                  </select>
                )}
              </label>
            );
          })}
          <button className="secondary-button" onClick={() => { const next = [...signerInputs, '']; setSignerInputs(next); setThreshold(next.filter(Boolean).length || threshold); }}><Plus size={14} /> 添加签名者</button>
          <label>
            签名阈值：{validSignerCount > 0 ? `${threshold} / ${validSignerCount} 签名者需同意` : '—'}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="number" min={1} max={validSignerCount || 16} value={threshold} onChange={(e) => setThreshold(Math.max(1, Math.min(parseInt(e.target.value) || 1, validSignerCount || 16)))} style={{ width: 70 }} />
              <button
                className="secondary-button"
                style={{ fontSize: 11, padding: '4px 10px', ...(threshold === validSignerCount ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}) }}
                onClick={() => setThreshold(validSignerCount || 1)}
              >全部 (N={validSignerCount})</button>
              <button
                className="secondary-button"
                style={{ fontSize: 11, padding: '4px 10px', ...(threshold === Math.ceil(validSignerCount / 2) ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}) }}
                onClick={() => setThreshold(Math.ceil(validSignerCount / 2) || 1)}
              >多数 ({Math.ceil(validSignerCount / 2)}/{validSignerCount})</button>
            </div>
          </label>
          {previewAddr && <div className="wide muted mono" style={{ fontSize: 12 }}>预览地址: {previewAddr}</div>}
          {createError && <div className="wide" style={{ color: 'var(--danger)' }}>{createError}</div>}
          <button className="primary-button" onClick={handleCreate}><Plus size={17} /> 创建多签钱包</button>
        </div>
      </section>

      <section className="surface">
        <div className="section-title">多签钱包列表</div>
        <div className="wallet-list">
          {msWallets.map((w) => {
            const localCount = w.wallet.signers.filter((s) => localAddrs.has(s.toLowerCase())).length;
            const allLocal = localCount === w.wallet.signers.length;
            return (
              <div key={w.wallet.address} className="wallet-row" style={{ cursor: 'default', flexDirection: 'column', alignItems: 'stretch' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div className="wallet-avatar"><Users size={18} /></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>{w.wallet.threshold}/{w.wallet.signers.length} 多签</span>
                      {allLocal && <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 4, background: 'color-mix(in srgb, var(--accent) 15%, transparent)', color: 'var(--accent)', fontWeight: 600 }}>全部本地</span>}
                      {!allLocal && localCount > 0 && <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 4, background: 'color-mix(in srgb, var(--accent) 10%, transparent)', color: 'var(--accent)', fontWeight: 600 }}>{localCount} 本地</span>}
                    </div>
                    <div className="mono muted" style={{ fontSize: 11 }}>{w.wallet.address}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="secondary-button" onClick={() => handleCopy(w.wallet.address)} style={{ padding: 4 }}>
                      {copied === w.wallet.address ? '✓' : '复制'}
                    </button>
                    {confirmRemove === w.wallet.address ? (
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button className="primary-button" onClick={() => handleRemoveWallet(w.wallet.address)} style={{ padding: '4px 8px', fontSize: 11 }}>确认</button>
                        <button className="secondary-button" onClick={() => setConfirmRemove(null)} style={{ padding: '4px 8px', fontSize: 11 }}>取消</button>
                      </div>
                    ) : (
                      <button className="secondary-button" onClick={() => setConfirmRemove(w.wallet.address)} style={{ padding: 4, color: 'var(--danger)' }}><Trash2 size={14} /></button>
                    )}
                  </div>
                </div>
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
                  <div className="muted" style={{ fontSize: 10, marginBottom: 4 }}>签名者（需 {w.wallet.threshold} 人同意）</div>
                  {w.wallet.signers.map((s) => {
                    const local = localAddrs.has(s.toLowerCase());
                    const lbl = addrLabel(s);
                    return (
                      <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: local ? 'var(--accent)' : 'var(--border)', flexShrink: 0 }} />
                        <code className="mono muted" style={{ fontSize: 10, flex: 1 }}>{s.slice(0, 10)}...{s.slice(-6)}</code>
                        {local && <span style={{ fontSize: 9, color: 'var(--accent)', fontWeight: 500 }}>{lbl || '本地'}</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {msWallets.length === 0 && <EmptyState title="还没有多签钱包" body="多签钱包需要多个签名者共同授权才能转账，适合团队共管资金。在上方创建一个多签钱包来开始。" />}
        </div>
      </section>

      <section className="surface">
        <div className="section-title">创建转账提案</div>
        <p className="muted" style={{ fontSize: 12, margin: '-4px 0 12px', lineHeight: 1.5 }}>
          创建一笔多签转账提案，自动用本地签名者签名后生成分享字符串。
        </p>
        <div className="form-grid">
          <label>
            多签钱包
            <select value={selWallet} onChange={(e) => setSelWallet(e.target.value)}>
              <option value="">选择钱包...</option>
              {msWallets.map((w) => <option key={w.wallet.address} value={w.wallet.address}>{w.wallet.threshold}/{w.wallet.signers.length} ({w.wallet.address.slice(0, 10)}...)</option>)}
            </select>
          </label>
          <label>
            收款地址
            <input value={transferTo} onChange={(e) => { setTransferTo(e.target.value); setTransferErr(''); }} placeholder="0x..." />
          </label>
          <label>
            金额 (FAI)
            <input type="number" step="any" min="0" value={transferAmount} onChange={(e) => { setTransferAmount(e.target.value); setTransferErr(''); }} placeholder="0.00" />
          </label>
          <label>
            手续费
            <input type="number" step="any" min="0" value={transferFee} onChange={(e) => setTransferFee(e.target.value)} />
          </label>
          {transferErr && <div className="wide" style={{ color: 'var(--danger)' }}>{transferErr}</div>}
          <button className="primary-button" onClick={handleCreateProposal}><Plus size={17} /> 创建并签名</button>
          {shareStr && (
            <div className="wide">
              <div style={{ color: 'var(--success)', marginBottom: 4, fontSize: 12 }}>提案已创建！分享以下字符串给其他签名者：</div>
              <div className="mono" style={{ fontSize: 10, wordBreak: 'break-all', background: 'var(--surface-2)', padding: 8, borderRadius: 6 }}>{shareStr}</div>
              <button className="secondary-button" style={{ marginTop: 6 }} onClick={() => handleCopy(shareStr)}>{copied === shareStr ? '已复制!' : '复制'}</button>
            </div>
          )}
        </div>
      </section>

      <section className="surface">
        <div className="section-title">导入提案</div>
        <p className="muted" style={{ fontSize: 12, margin: '-4px 0 12px', lineHeight: 1.5 }}>
          粘贴其他签名者分享的 fms_ 开头的提案字符串。
        </p>
        <div className="form-grid">
          <label className="wide">
            提案字符串
            <textarea value={importStr} onChange={(e) => { setImportStr(e.target.value); setImportErr(''); }} placeholder="fms_..." rows={3} />
          </label>
          {importErr && <div className="wide" style={{ color: 'var(--danger)' }}>{importErr}</div>}
          <button className="secondary-button" onClick={handleImportProposal}>导入</button>
        </div>
      </section>

      {pendingProps.length > 0 && (
        <section className="surface">
          <div className="section-title">待处理提案 ({pendingProps.length})</div>
          {pendingProps.map((p) => {
            const wInfo = msWallets.find((w) => w.wallet.address === p.wallet);
            const needed = wInfo ? wInfo.wallet.threshold : 0;
            const got = p.signatures.length;
            const thresholdMet = got >= needed;
            const payload = p.payload as { to?: string; amount?: number };
            return (
              <div key={p.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <div>
                    <strong>{p.operation === 'transfer' ? '转账' : p.operation}</strong> — {wInfo ? `${wInfo.wallet.threshold}/${wInfo.wallet.signers.length}` : '...'}
                    <div className="mono muted" style={{ fontSize: 11 }}>
                      {payload.to && `至: ${payload.to.slice(0, 10)}...`} {payload.amount !== undefined && `| ${payload.amount} FAI`}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ color: thresholdMet ? 'var(--success)' : 'var(--warning)', fontWeight: 600, fontSize: 12 }}>
                      {got}/{needed}
                    </span>
                    <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{thresholdMet ? '可执行' : `还需 ${needed - got} 个签名`}</div>
                  </div>
                </div>
                {got > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                    {p.signatures.map((sig) => {
                      const local = localAddrs.has(sig.signer.toLowerCase());
                      return (
                        <span key={sig.signer} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 6px', borderRadius: 4, background: 'var(--surface-2)', fontSize: 10 }}>
                          <span style={{ color: 'var(--success)' }}>✓</span>
                          <code className="mono muted" style={{ fontSize: 9 }}>{sig.signer.slice(0, 8)}...{sig.signer.slice(-4)}</code>
                          {local && <span style={{ color: 'var(--accent)', fontSize: 8 }}>本地</span>}
                        </span>
                      );
                    })}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {signPropId === p.id ? (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', width: '100%' }}>
                      <select value={signAddr} onChange={(e) => { setSignAddr(e.target.value); setSignErr(''); }} style={{ flex: 1 }}>
                        <option value="">选择签名者...</option>
                        {wallets.map((w) => <option key={w.address} value={w.address}>{w.name} ({w.address.slice(0, 8)}...)</option>)}
                      </select>
                      <button className="primary-button" onClick={() => handleSignProposal(p.id)}>签名</button>
                      <button className="secondary-button" onClick={() => { setSignPropId(null); setSignAddr(''); setSignErr(''); }}>取消</button>
                    </div>
                  ) : (
                    <>
                      <button className="secondary-button" onClick={() => { setSignPropId(p.id); setSignErr(''); setSignAddr(''); }}>签名</button>
                      <button className="secondary-button" onClick={() => handleCopy(encodeMultisigProposal({ wallet: p.wallet, operation: p.operation, payload: p.payload, nonce: p.nonce, fee: p.fee, signatures: p.signatures }))}>{copied === encodeMultisigProposal({ wallet: p.wallet, operation: p.operation, payload: p.payload, nonce: p.nonce, fee: p.fee, signatures: p.signatures }) ? '已复制' : '复制分享'}</button>
                      {thresholdMet && <button className="primary-button" onClick={() => handleSubmitProposal(p.id)}>提交执行</button>}
                    </>
                  )}
                </div>
                {signPropId === p.id && signErr && <div style={{ color: 'var(--danger)', fontSize: 11, marginTop: 4 }}>{signErr}</div>}
              </div>
            );
          })}
        </section>
      )}
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
            {props.selectedAsset.access === 'private' && props.selectedAsset.dataKeyBase64 && (
              <DataKeyBox dataKey={props.selectedAsset.dataKeyBase64} />
            )}
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
  shareFullLink: boolean;
  openShareId: string;
  openAccessCode: string;
  busy: string;
  onSelect: (asset: DataAsset) => void;
  onShareRecipient: (recipient: string) => void;
  onShareFullLink: (value: boolean) => void;
  onPasscodeShare: () => void;
  onAddressShare: () => void;
  onOpenShareId: (value: string) => void;
  onOpenAccessCode: (value: string) => void;
  onOpenShare: () => void;
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
          <label className="check-row">
            <input type="checkbox" checked={props.shareFullLink} onChange={(event) => props.onShareFullLink(event.target.checked)} />
            生成一个完整链接
          </label>
        </div>
        <div className="share-card muted-card">
          <KeyRound size={22} />
          <div>
            <h3>地址分享</h3>
            <p>输入合法 0x 地址即可，不查询地址是否存在。密钥片段只放在分享链接里，不写入链上。</p>
          </div>
          <input value={props.shareRecipient} onChange={(event) => props.onShareRecipient(event.target.value)} placeholder="0x recipient" />
          <button className="secondary-button" onClick={props.onAddressShare} disabled={!props.selectedAsset || !props.shareRecipient.trim() || props.busy === 'address-share'}>
            {props.busy === 'address-share' ? <Loader2 className="spin" size={17} /> : <KeyRound size={17} />}
            分享给地址
          </button>
        </div>
        {props.selectedAsset?.shareUrl && (
          <div className="share-result">
            <div className="muted">分享链接</div>
            <div className="mono break">{props.selectedAsset.shareUrl}</div>
            <div className="muted">访问码</div>
            <div className="mono">{props.selectedAsset.accessCode}</div>
          </div>
        )}
        <div className="share-card muted-card">
          <Download size={22} />
          <div>
            <h3>打开分享</h3>
            <p>输入分享 ID 和访问码；地址分享使用链接里的密钥片段。</p>
          </div>
          <input value={props.openShareId} onChange={(event) => props.onOpenShareId(event.target.value)} placeholder="share_xxx 或完整分享链接" />
          <input value={props.openAccessCode} onChange={(event) => props.onOpenAccessCode(event.target.value)} placeholder="访问码或链接密钥" />
          <button className="primary-button" onClick={props.onOpenShare} disabled={!props.openShareId.trim() || props.busy === 'open-share'}>
            {props.busy === 'open-share' ? <Loader2 className="spin" size={17} /> : <Download size={17} />}
            打开并下载
          </button>
        </div>
      </aside>
    </div>
  );
}

function MiningView(props: {
  config: MiningConfig;
  chainUrl: string;
  chainStatus: any;
  selectedWallet?: WalletRecord;
  minerStats: MinerStats | null;
  minerStatsError: string;
  runtime: MiningRuntime;
  busy: string;
  diskInfo: { freeBytes: number; totalBytes: number } | null;
  capacityUnit: 'TB' | 'GB';
  onCapacityUnit: (unit: 'TB' | 'GB') => void;
  onConfig: (patch: Partial<MiningConfig>) => void;
  onStart: () => void;
  onStop: () => void;
  onRefreshRewards: () => void;
  onRefreshDisk: () => void;
  onClaimRewards: () => void;
  onAdjustCapacity: (newCapacityBytes: number) => void;
}) {
  const canControl = Boolean(window.falariDesktop);
  const estimatedStorage = props.minerStats?.estimated_storage_rewards ?? 0;
  const unsettledStorage = props.minerStats?.unsettled_storage_rewards ?? 0;
  const pendingMining = props.minerStats?.pending_mining_rewards ?? 0;
  const vestingMining = props.minerStats?.vesting_mining_rewards ?? 0;
  const claimableMining = props.minerStats?.claimable_mining_rewards ?? 0;
  const totalRewards = props.minerStats?.rewards ?? 0;

  // Capacity unit conversion.
  const TiB = 1024 ** 4;
  const GiB = 1024 ** 3;
  const divisor = props.capacityUnit === 'TB' ? TiB : GiB;
  const capacityDisplay = +(props.config.capacity / divisor).toFixed(4);
  const minCapBytes = props.chainStatus?.minCapacityBytes ?? 200 * GiB;
  const minCapDisplay = +(minCapBytes / divisor).toFixed(2);

  function onCapacityChange(raw: string) {
    const val = parseFloat(raw);
    if (isNaN(val) || val < 0) return;
    props.onConfig({ capacity: Math.round(val * divisor) });
  }

  // Stake calculation.
  const stakePerTiB = props.chainStatus?.stakePerTiB ?? 1000 * TOKEN_UNIT;
  const bonusAmount = props.chainStatus?.registrationBonusAmount ?? 5000 * TOKEN_UNIT;
  const tibCount = Math.ceil(props.config.capacity / TiB);
  const requiredStake = tibCount * stakePerTiB;
  const bonusGranted = props.chainStatus?.bonusGrantedCount ?? 0;
  const bonusMax = props.chainStatus?.maxBonusAddresses ?? 200_000;
  const bonusAvailable = bonusGranted < bonusMax;
  const bonusCoversAll = bonusAvailable && bonusAmount >= requiredStake;
  const additionalStakeNeeded = bonusAvailable
    ? Math.max(0, requiredStake - bonusAmount)
    : requiredStake;

  // Disk space validation hints.
  const diskFree = props.diskInfo?.freeBytes ?? 0;
  const diskTotal = props.diskInfo?.totalBytes ?? 0;
  const capacityExceedsDisk = props.config.capacity > diskFree;
  const belowMinimum = props.config.capacity < minCapBytes;

  // Capacity adjustment cooldown.
  const cooldownSeconds = 7 * 24 * 60 * 60; // 7 days
  const lastAdjust = props.minerStats?.last_capacity_adjust_unix ?? 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const cooldownRemaining = lastAdjust > 0 ? Math.max(0, cooldownSeconds - (nowSec - lastAdjust)) : 0;
  const cooldownDays = Math.floor(cooldownRemaining / 86400);
  const cooldownHours = Math.floor((cooldownRemaining % 86400) / 3600);
  const onCooldown = cooldownRemaining > 0;
  const isRegistered = Boolean(props.minerStats?.miner_address);
  const capacityChanged = isRegistered && props.config.capacity !== (props.minerStats?.capacity_bytes ?? 0);

  return (
    <div className="two-column">
      <section className="surface">
        <div className="section-title">本机挖矿节点</div>
        <div className="mining-status">
          <div className={`node-dot ${props.runtime.running ? 'online' : ''}`} />
          <div>
            <h2>{props.runtime.running ? '挖矿运行中' : '挖矿未开启'}</h2>
            <p>开启后，本机客户端会注册为存储矿工，并强制提供 shard 上传和下载访问服务。</p>
          </div>
        </div>
        <div className="detail-grid">
          <Detail label="矿工地址" value={props.selectedWallet ? shortAddress(props.selectedWallet.address) : '未选择钱包'} />
          <Detail label="挖矿编号" value={props.minerStats?.miner_id ? `#${String(props.minerStats.miner_id).padStart(4, '0')}` : '-'} />
          <Detail label="链上状态" value={props.minerStats?.status || '未注册'} />
          <Detail label="链节点" value={props.chainUrl} />
          <Detail label="访问入口" value={props.config.endpoint} />
          <Detail label="监听端口" value={props.config.addr} />
          <Detail label="进程" value={props.runtime.pid ? String(props.runtime.pid) : '-'} />
        </div>
        <div className="action-stack">
          <button className="primary-button" onClick={props.onStart} disabled={!canControl || props.runtime.running || props.busy === 'mining'}>
            {props.busy === 'mining' ? <Loader2 className="spin" size={17} /> : <Play size={17} />}
            开启挖矿
          </button>
          <button className="secondary-button" onClick={props.onStop} disabled={!canControl || !props.runtime.running || props.busy === 'mining-stop'}>
            {props.busy === 'mining-stop' ? <Loader2 className="spin" size={17} /> : <Square size={17} />}
            停止
          </button>
        </div>
      </section>

      <section className="surface">
        <div className="section-title">挖矿奖励</div>
        <div className="detail-grid">
          <Detail label="总挖矿收益" value={formatTokenAmount(totalRewards)} />
          <Detail label="存储收益累计" value={formatTokenAmount(props.minerStats?.storage_rewards)} />
          <Detail label="预估未结算" value={formatTokenAmount(unsettledStorage || estimatedStorage)} />
          <Detail label="已结算总额" value={formatTokenAmount(pendingMining)} />
          <Detail label="30 天释放中" value={formatTokenAmount(vestingMining)} />
          <Detail label="当前可领取" value={formatTokenAmount(claimableMining)} />
          <Detail label="证明成功次数" value={String(props.minerStats?.proof_success ?? 0)} />
          <Detail label="成功率" value={(() => {
            const ok = props.minerStats?.proof_success ?? 0;
            const fail = props.minerStats?.proof_failure ?? 0;
            const total = ok + fail;
            return total > 0 ? `${(ok / total * 100).toFixed(1)}%` : 'N/A';
          })()} />
          <Detail label="锁定注册奖金" value={formatTokenAmount(props.minerStats?.locked_bonus)} />
          <Detail label="奖金状态" value={
            props.minerStats?.bonus_released ? '已释放' :
            props.minerStats?.bonus_expired ? '已过期' : '活跃'
          } />
          <Detail label="有效权重" value={(props.minerStats?.effective_weight ?? 0).toLocaleString()} />
          <Detail label="容量" value={formatSize(props.minerStats?.capacity_bytes ?? props.config.capacity)} />
          <Detail label="已存储" value={formatSize(props.minerStats?.used_bytes ?? 0)} />
        </div>
        <div className="action-stack">
          <button className="primary-button" onClick={props.onClaimRewards} disabled={!props.selectedWallet || claimableMining <= 0 || props.busy === 'claim-mining-rewards'}>
            {props.busy === 'claim-mining-rewards' ? <Loader2 className="spin" size={17} /> : <CircleDollarSign size={17} />}
            领取已成熟奖励
          </button>
          <button className="secondary-button" onClick={props.onRefreshRewards}>
            <RefreshCw size={17} />
            刷新奖励
          </button>
        </div>
        {props.minerStatsError && <p className="muted small">{props.minerStatsError}</p>}
      </section>

      <section className="surface">
        <div className="section-title">奖励名额</div>
        <div className="bonus-quota">
          <div className="bonus-progress">
            <span className="muted">已使用</span>
            <strong>{bonusGranted.toLocaleString()} / {bonusMax.toLocaleString()}</strong>
            <span className="muted">（剩余 {(bonusMax - bonusGranted).toLocaleString()} 个）</span>
          </div>
          <div className="bonus-bar-track">
            <div className="bonus-bar-fill" style={{ width: `${Math.min(100, bonusMax > 0 ? (bonusGranted / bonusMax) * 100 : 0)}%` }} />
          </div>
          {bonusAvailable ? (
            <div className="bonus-hint ok">
              当前仍有名额，注册可获得 {formatTokenAmount(bonusAmount)} 奖励。
              {bonusCoversAll
                ? ' 此奖励可完全覆盖质押需求，无需额外质押。'
                : ` 奖励可覆盖 ${formatTokenAmount(bonusAmount)} 质押，超出部分需自行质押 ${formatTokenAmount(additionalStakeNeeded)}。`}
            </div>
          ) : (
            <div className="bonus-hint warn">
              20 万个奖励名额已全部用完，您需要根据挖矿容量自行质押 Token。
            </div>
          )}
        </div>
      </section>

      <section className="surface">
        <div className="section-title">节点配置</div>
        <div className="form-grid">
          <label>
            监听地址
            <input value={props.config.addr} onChange={(event) => props.onConfig({ addr: event.target.value })} />
          </label>
          <label>
            公开访问地址
            <input value={props.config.endpoint} onChange={(event) => props.onConfig({ endpoint: event.target.value })} />
          </label>
          <label>
            数据目录
            <div className="input-with-action">
              <input value={props.config.dataDir} onChange={(event) => props.onConfig({ dataDir: event.target.value })} />
              <button className="icon-button" title="刷新磁盘空间" onClick={props.onRefreshDisk}><RefreshCw size={14} /></button>
            </div>
          </label>
          <label>
            质押数量 (Token)
            <input type="number" min={0} value={props.config.stake} onChange={(event) => props.onConfig({ stake: Number(event.target.value) })} />
            {!bonusCoversAll && (
              <span className="field-hint">
                最低需质押 {formatTokenAmount(requiredStake)}（每 TiB {formatTokenAmount(stakePerTiB)}）
                {additionalStakeNeeded > 0 && bonusAvailable
                  ? `，扣除奖励后还需 ${formatTokenAmount(additionalStakeNeeded)}`
                  : ''}
              </span>
            )}
          </label>
          <label>
            挖矿容量
            <div className="capacity-input-group">
              <input
                type="number"
                min={0}
                step={props.capacityUnit === 'TB' ? 0.1 : 1}
                value={capacityDisplay}
                onChange={(event) => onCapacityChange(event.target.value)}
                className={belowMinimum || capacityExceedsDisk ? 'input-error' : ''}
              />
              <div className="unit-toggle">
                <button
                  className={`unit-btn ${props.capacityUnit === 'TB' ? 'active' : ''}`}
                  onClick={() => {
                    props.onCapacityUnit('TB');
                    props.onConfig({ capacity: props.config.capacity }); // keep internal bytes
                  }}
                >TB</button>
                <button
                  className={`unit-btn ${props.capacityUnit === 'GB' ? 'active' : ''}`}
                  onClick={() => {
                    props.onCapacityUnit('GB');
                    props.onConfig({ capacity: props.config.capacity });
                  }}
                >GB</button>
              </div>
            </div>
            {belowMinimum && (
              <span className="field-hint error">最低要求 {minCapDisplay} {props.capacityUnit}</span>
            )}
            {capacityExceedsDisk && diskFree > 0 && (
              <span className="field-hint error">超出磁盘剩余空间（{formatSize(diskFree)}）</span>
            )}
            <span className="field-hint">
              需质押 {formatTokenAmount(requiredStake)}（{tibCount} TiB x {formatTokenAmount(stakePerTiB)}）
            </span>
            {isRegistered && capacityChanged && (
              <div className="capacity-adjust-row">
                <button
                  className="secondary-button"
                  disabled={onCooldown || belowMinimum || capacityExceedsDisk || props.busy === 'adjust-capacity'}
                  onClick={() => props.onAdjustCapacity(props.config.capacity)}
                >
                  {props.busy === 'adjust-capacity' ? <Loader2 className="spin" size={15} /> : null}
                  应用容量变更
                </button>
                {onCooldown && (
                  <span className="field-hint">冷却中：{cooldownDays} 天 {cooldownHours} 小时后可再次调整</span>
                )}
              </div>
            )}
            {isRegistered && !capacityChanged && onCooldown && (
              <span className="field-hint">上次调整冷却中：{cooldownDays} 天 {cooldownHours} 小时后可再次调整</span>
            )}
          </label>
          <label>
            P2P 监听
            <input value={props.config.p2pListen} onChange={(event) => props.onConfig({ p2pListen: event.target.value })} placeholder="/ip4/0.0.0.0/tcp/0" />
          </label>
          <label className="wide">
            P2P peers
            <input value={props.config.p2pPeers} onChange={(event) => props.onConfig({ p2pPeers: event.target.value })} placeholder="多个地址用英文逗号分隔" />
          </label>
        </div>
        {props.diskInfo && (
          <div className="disk-info-bar">
            <span>磁盘空间：总计 {formatSize(diskTotal)}</span>
            <span>剩余 {formatSize(diskFree)}</span>
            <span className={capacityExceedsDisk ? 'error' : ''}>
              挖矿占用 {formatSize(props.config.capacity)}
            </span>
          </div>
        )}
      </section>

      <section className="surface wide-panel">
        <div className="section-title">运行日志</div>
        <div className="log-panel">
          {props.runtime.logs.length > 0
            ? props.runtime.logs.map((line, index) => <div key={`${index}-${line}`} className="mono">{line}</div>)
            : <EmptyState title="暂无日志" body="启动本地挖矿后会显示注册、证明、上传和下载服务日志。" />}
        </div>
      </section>
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

function DataKeyBox({ dataKey }: { dataKey: string }) {
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(dataKey);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = dataKey;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={{ borderRadius: '8px', border: '1px solid rgba(59,130,246,0.2)', background: 'rgba(59,130,246,0.08)', padding: '10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
        <span style={{ fontSize: '12px', fontWeight: 600, color: '#60a5fa' }}>Data Key</span>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button
            onClick={() => setShow(!show)}
            style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'none', border: 'none', cursor: 'pointer', fontSize: '10px', color: '#93c5fd', padding: '2px 6px', borderRadius: '4px' }}
          >
            {show ? <EyeOff size={12} /> : <Eye size={12} />}
            {show ? '隐藏' : '显示'}
          </button>
          <button
            onClick={copyKey}
            style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'none', border: 'none', cursor: 'pointer', fontSize: '10px', color: '#93c5fd', padding: '2px 6px', borderRadius: '4px' }}
          >
            {copied ? <Check size={12} style={{ color: '#4ade80' }} /> : <Copy size={12} />}
            {copied ? '已复制' : '复制'}
          </button>
        </div>
      </div>
      <code style={{ fontSize: '10px', wordBreak: 'break-all', color: '#93c5fd', lineHeight: 1.5 }}>
        {show ? dataKey : dataKey.slice(0, 16) + '••••••••'}
      </code>
      <p style={{ fontSize: '10px', color: 'rgba(147,197,253,0.7)', marginTop: '6px' }}>
        可解密此条数据。分享给他人即可让其解密该文件。
      </p>
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

/* ── Bridge ── */

function bridgeFormatBalance(amount: number): string {
  const v = amount / TOKEN_UNIT;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(2)}K`;
  return parseFloat(v.toFixed(8)).toString();
}

function bridgeTruncAddr(addr: string): string {
  if (!addr) return '';
  return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
}

function bridgeCountdown(targetUnix: number): string {
  const now = Math.floor(Date.now() / 1000);
  const remaining = targetUnix - now;
  if (remaining <= 0) return '可领取';
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

async function bridgeSignOut(
  privateKey: string,
  params: {
    chainId: string;
    sender: string;
    recipient: string;
    targetChainId: string;
    amount: number;
    fee: number;
    nonce: number;
  },
): Promise<{ signature: string; publicKey: string }> {
  const payload = {
    chain_id: params.chainId,
    sender: params.sender,
    recipient: params.recipient,
    target_chain_id: params.targetChainId,
    amount: params.amount,
    fee: params.fee,
    nonce: params.nonce,
  };
  const jsonStr = JSON.stringify(payload);
  const hashBytes = new Uint8Array(ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(jsonStr))));
  const signingKey = new ethers.SigningKey(privateKey);
  const signature = signingKey.sign(ethers.hexlify(hashBytes)).serialized;
  const wallet = new ethers.Wallet(privateKey);
  const publicKey = wallet.signingKey.publicKey;
  return { signature, publicKey };
}

function BridgeView({ api, wallets, selectedWallet }: {
  api: ChainApi;
  wallets: WalletRecord[];
  selectedWallet: WalletRecord | undefined;
}) {
  const [amount, setAmount] = useState('');
  const [ethRecipient, setEthRecipient] = useState('');
  const [config, setConfig] = useState<BridgeConfig | null>(null);
  const [outbounds, setOutbounds] = useState<BridgeOutbound[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const wallet = selectedWallet ?? wallets[0];

  const fetchData = useCallback(async () => {
    try {
      const [cfg, pending] = await Promise.all([api.getBridgeConfig(), api.getBridgePending()]);
      setConfig(cfg);
      if (wallet) {
        setOutbounds(pending.outbounds.filter((o) => o.sender.toLowerCase() === wallet.address.toLowerCase()));
        try {
          const acc = await api.getAccount(wallet.address);
          setBalance(acc.balance);
        } catch { setBalance(null); }
      }
    } catch { /* silent */ }
  }, [api, wallet]);

  useEffect(() => { fetchData(); const id = setInterval(fetchData, 20000); return () => clearInterval(id); }, [fetchData]);
  useEffect(() => { const id = setInterval(() => setTick((t) => t + 1), 60000); return () => clearInterval(id); }, []);
  void tick;

  const handleSubmit = async () => {
    setError(null);
    setSuccess(null);
    if (!wallet) { setError('请先创建或选择一个钱包'); return; }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) { setError('请输入有效金额'); return; }
    if (!ethRecipient || !ethers.isAddress(ethRecipient)) { setError('请输入有效的 ETH 接收地址'); return; }

    const amountUnits = Math.round(amountNum * TOKEN_UNIT);
    if (config && amountUnits < config.minBridgeAmount) {
      setError(`低于最小跨链数量 (${bridgeFormatBalance(config.minBridgeAmount)} FAL)`);
      return;
    }
    if (balance !== null && amountUnits > balance) { setError('余额不足'); return; }

    setLoading(true);
    try {
      const [account, status] = await Promise.all([api.getAccount(wallet.address), api.getStatus()]);
      const chainId = status.chainId || status.chain_id || 'falari';
      const targetChainId = config?.targetChainId || 'ethereum';

      const { signature, publicKey } = await bridgeSignOut(wallet.privateKey, {
        chainId,
        sender: wallet.address,
        recipient: ethRecipient,
        targetChainId,
        amount: amountUnits,
        fee: 1,
        nonce: account.nonce + 1,
      });

      const result = await api.bridgeOut({
        sender: wallet.address,
        recipient: ethRecipient,
        targetChainId,
        amount: amountUnits,
        fee: 1,
        nonce: account.nonce + 1,
        signature,
        publicKey,
      });

      setSuccess(`跨链请求已提交 #${result.nonce}`);
      setAmount('');
      setEthRecipient('');
      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : '跨链失败');
    } finally {
      setLoading(false);
    }
  };

  const isPaused = config?.paused ?? false;

  return (
    <div className="two-column">
      <section className="surface">
        <div className="section-title">
          <Link2 size={18} />
          跨链桥 — FAL → ETH
        </div>

        {isPaused && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#f87171', fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
            <AlertTriangle size={14} />
            跨链桥已暂停
          </div>
        )}

        {config && (
          <div className="detail-grid">
            <Detail label="最小跨链" value={`${bridgeFormatBalance(config.minBridgeAmount)} FAL`} />
            <Detail label="延迟时间" value={`${Math.floor(config.delaySeconds / 3600)} 小时`} />
            <Detail label="池地址" value={bridgeTruncAddr(config.bridgePoolAddress)} />
            <Detail label="日限额" value={bridgeFormatBalance(config.maxAmountPerDay)} />
          </div>
        )}

        {wallet && balance !== null && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '12px 0' }}>
            <span className="mono" style={{ fontSize: 12, opacity: 0.6 }}>{wallet.name} · {bridgeTruncAddr(wallet.address)}</span>
            <span className="mono" style={{ fontSize: 13, fontWeight: 700, color: 'var(--accent, #00ff66)' }}>{bridgeFormatBalance(balance)} FAL</span>
          </div>
        )}

        <div className="form-grid">
          <label>
            跨链数量 (FAL)
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              min="0"
              step="0.01"
            />
          </label>
          <label>
            ETH 接收地址
            <input
              type="text"
              value={ethRecipient}
              onChange={(e) => setEthRecipient(e.target.value)}
              placeholder="0x..."
            />
          </label>
        </div>

        <div className="action-stack">
          <button className="primary-button" onClick={handleSubmit} disabled={loading || isPaused || !wallet}>
            {loading ? <><Loader2 size={17} className="spin" /> 跨链中...</> : <><ArrowRight size={17} /> 发起跨链</>}
          </button>
          <button className="secondary-button" onClick={fetchData}>
            <RefreshCw size={17} /> 刷新
          </button>
        </div>

        {error && !loading && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: 10, borderRadius: 8, background: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.3)', color: '#f87171', fontSize: 12, marginTop: 12 }}>
            <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
            {error}
          </div>
        )}
        {success && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: 10, borderRadius: 8, background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)', color: '#4ade80', fontSize: 12, marginTop: 12 }}>
            <CheckCircle2 size={14} style={{ flexShrink: 0, marginTop: 2 }} />
            {success}
          </div>
        )}
      </section>

      <section className="surface">
        <div className="section-title">
          <Clock size={18} />
          待处理跨链
        </div>
        {outbounds.length === 0 ? (
          <EmptyState title="暂无待处理" body="发起跨链后会在这里看到进度。" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {outbounds.map((op) => (
              <div key={op.nonce} className="detail-grid" style={{ padding: '10px 0', borderBottom: '1px solid var(--border, #222)' }}>
                <Detail label="#" value={String(op.nonce)} />
                <Detail label="数量" value={`${bridgeFormatBalance(op.amount)} FAL`} />
                <Detail label="接收" value={bridgeTruncAddr(op.recipient)} />
                <Detail label="状态" value={op.status} />
                {op.claimableAfter > 0 && (
                  <Detail label="倒计时" value={bridgeCountdown(op.claimableAfter)} />
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
