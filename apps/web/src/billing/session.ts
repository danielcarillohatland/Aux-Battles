import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { createSignal } from 'solid-js';
import { apiRequest } from '../host/api.js';

export interface HostAccount {
  id: string;
  appAccountToken: string;
  credits: number;
  createdAt: number;
}
export interface BillingConfig {
  /** 'open' = free AI judge for every host (portfolio/party deployment). */
  aiAccess?: 'open' | 'account' | 'off';
  signInAvailable: boolean;
  purchasesAvailable: boolean;
  trialCredits: number;
  maxRoundsPerGame: number;
  products: { productId: string; credits: number }[];
}
export interface StoreProduct {
  id: string;
  name: string;
  price: string;
}
interface Transaction {
  transactionId: string;
  signedTransaction: string;
}
interface CommercePlugin {
  signIn(options: {
    nonce: string;
  }): Promise<{ identityToken: string; authorizationCode?: string }>;
  products(options: { ids: string[] }): Promise<{ products: StoreProduct[] }>;
  purchase(options: {
    productId: string;
    appAccountToken: string;
  }): Promise<Partial<Transaction> & { status: 'purchased' | 'pending' | 'cancelled' }>;
  pendingTransactions(): Promise<{ transactions: Transaction[] }>;
  finishTransaction(options: { transactionId: string }): Promise<void>;
  loadSession(): Promise<{ token?: string }>;
  saveSession(options: { token: string }): Promise<void>;
  addListener(
    event: 'transaction',
    callback: (transaction: Transaction) => void,
  ): Promise<PluginListenerHandle>;
}
const commerce = registerPlugin<CommercePlugin>('AuxCommerce');
const [account, setAccount] = createSignal<HostAccount | null>(null);
const [useAi, setUseAi] = createSignal(true);
let token = '';
let initializing: Promise<void> | undefined;
let listening = false;
export { account, useAi, setUseAi };

/** Open-access servers let the host pick the judge per room; no account involved. */
const [openJudge, setOpenJudge] = createSignal<'ai' | 'crowd'>('ai');
const [openAccess, setOpenAccess] = createSignal(false);
export { openJudge, setOpenJudge, openAccess, setOpenAccess };
/** JSON body for POST /rooms, or undefined for the legacy empty request. */
export const createRoomBody = (): string | undefined =>
  openAccess() ? JSON.stringify({ judge: openJudge() }) : undefined;
export const nativeCommerceAvailable = () => Capacitor.getPlatform() === 'ios';
const bearer = () => (token ? { authorization: `Bearer ${token}` } : {});
export const accountHeaders = (): Record<string, string> => (useAi() ? bearer() : {});

async function receiveTransaction(transaction: Transaction) {
  if (!token) return;
  const sessionToken = token;
  const result = await apiRequest<{ account: HostAccount }>('/api/v1/billing/purchases', {
    method: 'POST',
    headers: { authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ signedTransaction: transaction.signedTransaction }),
  });
  if (token === sessionToken) setAccount(result.account);
  await commerce.finishTransaction({ transactionId: transaction.transactionId });
}

export async function recoverPurchases() {
  if (!token || !nativeCommerceAvailable()) return;
  const pending = await commerce.pendingTransactions();
  let deliveryFailed = false;
  for (const transaction of pending.transactions) {
    try {
      await receiveTransaction(transaction);
    } catch {
      deliveryFailed = true;
    }
  }
  await refreshAccount();
  if (deliveryFailed)
    throw new Error(
      'Some earlier purchases could not be added. Your other credits are up to date. Use the original host account or contact support.',
    );
}

export async function refreshAccount() {
  if (!token) return;
  const sessionToken = token;
  const result = await apiRequest<{ account: HostAccount }>('/api/v1/billing/account', {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  if (token === sessionToken) setAccount(result.account);
}

export function initializeAccount(): Promise<void> {
  if (initializing) return initializing;
  initializing = (async () => {
    if (!nativeCommerceAvailable()) return;
    token = (await commerce.loadSession()).token ?? '';
    if (!listening) {
      await commerce.addListener('transaction', (transaction) => {
        // An offline delivery remains unfinished and is retried on next launch/refresh.
        void receiveTransaction(transaction).catch(() => {});
      });
      listening = true;
    }
    if (token) {
      try {
        await recoverPurchases();
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'HOST_SIGN_IN_REQUIRED') {
          token = '';
          setAccount(null);
          await commerce.saveSession({ token: '' });
        } else throw error;
      }
    }
  })().catch((error) => {
    initializing = undefined;
    throw error;
  });
  return initializing;
}

export async function signIn() {
  const challenge = await apiRequest<{ challengeId: string; nonce: string }>(
    '/api/v1/billing/challenge',
    { method: 'POST' },
  );
  const identity = await commerce.signIn({ nonce: challenge.nonce });
  const session = await apiRequest<{ token: string; account: HostAccount }>(
    '/api/v1/billing/apple/session',
    {
      method: 'POST',
      body: JSON.stringify({
        identityToken: identity.identityToken,
        ...(identity.authorizationCode ? { authorizationCode: identity.authorizationCode } : {}),
        challengeId: challenge.challengeId,
      }),
    },
  );
  await commerce.saveSession({ token: session.token });
  token = session.token;
  setAccount(session.account);
  setUseAi(true);
  await recoverPurchases();
}

export async function signOut() {
  if (token) await apiRequest('/api/v1/billing/session', { method: 'DELETE', headers: bearer() });
  await commerce.saveSession({ token: '' });
  token = '';
  setAccount(null);
  setUseAi(false);
}

export async function deleteAccount() {
  await apiRequest('/api/v1/billing/account', { method: 'DELETE', headers: bearer() });
  await commerce.saveSession({ token: '' });
  token = '';
  setAccount(null);
  setUseAi(false);
}

export async function loadProducts(config: BillingConfig) {
  if (!nativeCommerceAvailable() || !config.purchasesAvailable) return [];
  return (await commerce.products({ ids: config.products.map((p) => p.productId) })).products;
}

export async function buyPack(productId: string): Promise<string> {
  const host = account();
  if (!host) throw new Error('Sign in to buy a game pack.');
  const result = await commerce.purchase({ productId, appAccountToken: host.appAccountToken });
  if (result.status === 'purchased' && result.transactionId && result.signedTransaction) {
    await receiveTransaction({
      transactionId: result.transactionId,
      signedTransaction: result.signedTransaction,
    });
    return 'Game credits added.';
  }
  return result.status === 'pending'
    ? 'Waiting for Apple to approve your purchase.'
    : 'Purchase cancelled.';
}
