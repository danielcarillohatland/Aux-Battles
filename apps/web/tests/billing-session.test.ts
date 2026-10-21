import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getPlatform: vi.fn(),
  apiRequest: vi.fn(),
  commerce: {
    signIn: vi.fn(),
    products: vi.fn(),
    purchase: vi.fn(),
    pendingTransactions: vi.fn(),
    finishTransaction: vi.fn(),
    loadSession: vi.fn(),
    saveSession: vi.fn(),
    addListener: vi.fn(),
  },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: mocks.getPlatform },
  registerPlugin: () => mocks.commerce,
}));
vi.mock('../src/host/api.js', () => ({ apiRequest: mocks.apiRequest }));

const host = {
  id: 'host-1',
  appAccountToken: 'account-1',
  credits: 1,
  createdAt: 1000,
};
const signedInHeaders = { authorization: 'Bearer saved-host-session' };

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.getPlatform.mockReturnValue('ios');
  mocks.commerce.loadSession.mockResolvedValue({ token: 'saved-host-session' });
  mocks.commerce.pendingTransactions.mockResolvedValue({ transactions: [] });
  mocks.commerce.addListener.mockResolvedValue({ remove: vi.fn().mockResolvedValue(undefined) });
  mocks.commerce.finishTransaction.mockResolvedValue(undefined);
  mocks.commerce.saveSession.mockResolvedValue(undefined);
  mocks.apiRequest.mockImplementation(async (path: string) => {
    if (path === '/api/v1/billing/account') return { account: host };
    throw new Error(`Unexpected request: ${path}`);
  });
});

describe('native host billing session', () => {
  it('delivers later valid purchases even when an earlier transaction is rejected', async () => {
    const session = await import('../src/billing/session.js');
    await session.initializeAccount();
    const creditedHost = { ...host, credits: 6 };
    mocks.commerce.pendingTransactions.mockResolvedValue({
      transactions: [
        { transactionId: 'rejected', signedTransaction: 'invalid-receipt' },
        { transactionId: 'valid', signedTransaction: 'valid-receipt' },
      ],
    });
    mocks.apiRequest.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/v1/billing/account') return { account: creditedHost };
      if (path === '/api/v1/billing/purchases') {
        const body = JSON.parse(String(options?.body)) as { signedTransaction: string };
        if (body.signedTransaction === 'invalid-receipt') throw new Error('Wrong host account');
        return { account: creditedHost };
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await expect(session.recoverPurchases()).rejects.toThrow('Some earlier purchases');

    expect(session.account()).toEqual(creditedHost);
    expect(mocks.commerce.finishTransaction).toHaveBeenCalledExactlyOnceWith({
      transactionId: 'valid',
    });
    expect(mocks.apiRequest).toHaveBeenCalledWith('/api/v1/billing/purchases', {
      method: 'POST',
      headers: signedInHeaders,
      body: JSON.stringify({ signedTransaction: 'valid-receipt' }),
    });
  });

  it('keeps a transaction unfinished until the server confirms its credits', async () => {
    const session = await import('../src/billing/session.js');
    await session.initializeAccount();
    mocks.commerce.purchase.mockResolvedValue({
      status: 'purchased',
      transactionId: 'purchase-1',
      signedTransaction: 'signed-receipt',
    });
    const creditedHost = { ...host, credits: 6 };
    let confirmGrant!: (result: { account: typeof host }) => void;
    const grant = new Promise<{ account: typeof host }>((resolve) => {
      confirmGrant = resolve;
    });
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    mocks.apiRequest.mockImplementation((path: string) => {
      if (path !== '/api/v1/billing/purchases') throw new Error(`Unexpected request: ${path}`);
      requestStarted();
      return grant;
    });

    const purchase = session.buyPack('five-games');
    await started;
    expect(mocks.commerce.finishTransaction).not.toHaveBeenCalled();
    expect(session.account()?.credits).toBe(1);

    confirmGrant({ account: creditedHost });
    await expect(purchase).resolves.toBe('Game credits added.');
    expect(session.account()?.credits).toBe(6);
    expect(mocks.commerce.finishTransaction).toHaveBeenCalledExactlyOnceWith({
      transactionId: 'purchase-1',
    });
  });

  it('does not finish an Apple transaction when the credit grant fails', async () => {
    const session = await import('../src/billing/session.js');
    await session.initializeAccount();
    mocks.commerce.purchase.mockResolvedValue({
      status: 'purchased',
      transactionId: 'retry-later',
      signedTransaction: 'signed-receipt',
    });
    mocks.apiRequest.mockRejectedValue(new Error('Server temporarily unavailable'));

    await expect(session.buyPack('five-games')).rejects.toThrow('Server temporarily unavailable');
    expect(mocks.commerce.finishTransaction).not.toHaveBeenCalled();
    expect(session.account()).toEqual(host);
  });

  it('retries initialization after an outage without registering duplicate listeners', async () => {
    const session = await import('../src/billing/session.js');
    mocks.apiRequest
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValueOnce({ account: host });

    await expect(session.initializeAccount()).rejects.toThrow('Offline');
    await expect(session.initializeAccount()).resolves.toBeUndefined();

    expect(session.account()).toEqual(host);
    expect(mocks.commerce.loadSession).toHaveBeenCalledTimes(2);
    expect(mocks.commerce.addListener).toHaveBeenCalledTimes(1);
    expect(mocks.commerce.pendingTransactions).toHaveBeenCalledTimes(2);
  });

  it('omits the paid host header in practice mode while retaining the signed-in session', async () => {
    const session = await import('../src/billing/session.js');
    await session.initializeAccount();
    expect(session.accountHeaders()).toEqual(signedInHeaders);

    session.setUseAi(false);
    expect(session.accountHeaders()).toEqual({});
    expect(session.account()).toEqual(host);

    session.setUseAi(true);
    expect(session.accountHeaders()).toEqual(signedInHeaders);
    expect(mocks.commerce.saveSession).not.toHaveBeenCalled();
  });
});
