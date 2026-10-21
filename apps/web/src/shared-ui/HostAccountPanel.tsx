import { For, Show, createSignal, onMount } from 'solid-js';
import { apiRequest } from '../host/api.js';
import {
  account,
  useAi,
  setUseAi,
  nativeCommerceAvailable,
  initializeAccount,
  signIn,
  signOut,
  recoverPurchases,
  deleteAccount,
  loadProducts,
  buyPack,
  openAccess,
  setOpenAccess,
  openJudge,
  setOpenJudge,
  type BillingConfig,
  type StoreProduct,
} from '../billing/session.js';

export default function HostAccountPanel() {
  const [config, setConfig] = createSignal<BillingConfig | null>(null);
  const [products, setProducts] = createSignal<StoreProduct[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [deleting, setDeleting] = createSignal(false);
  const run = async (action: () => Promise<unknown>) => {
    if (busy()) return;
    setBusy(true);
    setMessage('');
    try {
      const message = await action();
      if (typeof message === 'string') setMessage(message);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  };
  onMount(() => {
    void run(async () => {
      const result = await apiRequest<BillingConfig>('/api/v1/billing/config');
      setConfig(result);
      setOpenAccess(result.aiAccess === 'open');
      if (result.aiAccess === 'open') return;
      await Promise.all([initializeAccount(), loadProducts(result).then(setProducts)]);
    });
  });
  return (
    <Show when={!openAccess()} fallback={<JudgePicker />}>
      <aside class="host-account-card" aria-label="Game credits">
        <Show
          when={account()}
          fallback={
            <Show
              when={nativeCommerceAvailable() && config()?.signInAvailable}
              fallback={<p>Crowd judging is free. AI game packs are coming to iPhone.</p>}
            >
              <button class="btn btn--ink" disabled={busy()} onClick={() => void run(signIn)}>
                Sign in with Apple
              </button>
              <p>
                {config()?.trialCredits ? `Try ${config()?.trialCredits} AI game free. ` : ''}Guests
                always play free.
              </p>
            </Show>
          }
        >
          {(host) => (
            <>
              <strong>
                {host().credits} AI game{host().credits === 1 ? '' : 's'} available
              </strong>
              <div class="account-actions">
                <label>
                  <input
                    type="checkbox"
                    checked={useAi()}
                    onChange={(e) => setUseAi(e.currentTarget.checked)}
                  />{' '}
                  AI judge · 1 game credit
                </label>
                <button
                  class="btn btn--ghost"
                  disabled={busy()}
                  onClick={() => void run(recoverPurchases)}
                >
                  Refresh credits
                </button>
              </div>
              <p>
                Up to {config()?.maxRoundsPerGame ?? 5} rounds and 8 players. Credit returned if AI
                judging fails.
              </p>
              <div class="account-actions">
                <For each={products()}>
                  {(product) => (
                    <button
                      class="btn btn--primary"
                      disabled={busy()}
                      onClick={() => void run(() => buyPack(product.id))}
                    >
                      {config()?.products.find((p) => p.productId === product.id)?.credits} games ·{' '}
                      {product.price}
                    </button>
                  )}
                </For>
              </div>
              <details>
                <summary>Account</summary>
                <div class="account-actions">
                  <button
                    class="btn btn--ghost"
                    disabled={busy()}
                    onClick={() => void run(signOut)}
                  >
                    Sign out
                  </button>
                  <button
                    class="btn btn--ghost"
                    disabled={busy()}
                    onClick={() => setDeleting(true)}
                  >
                    Delete account
                  </button>
                </div>
                <Show when={deleting()}>
                  <p>Delete your account and unused game credits? This cannot be undone.</p>
                  <div class="account-actions">
                    <button
                      class="btn btn--danger"
                      disabled={busy()}
                      onClick={() => void run(deleteAccount)}
                    >
                      Delete permanently
                    </button>
                    <button class="btn btn--ghost" onClick={() => setDeleting(false)}>
                      Keep account
                    </button>
                  </div>
                </Show>
              </details>
            </>
          )}
        </Show>
        <Show when={message()}>
          <p role="status">{message()}</p>
        </Show>
      </aside>
    </Show>
  );

  function JudgePicker() {
    return (
      <fieldset class="judge-picker">
        <legend>Who judges tonight?</legend>
        <label classList={{ 'judge-picker__option--on': openJudge() === 'ai' }}>
          <input
            type="radio"
            name="judge"
            checked={openJudge() === 'ai'}
            onChange={() => setOpenJudge('ai')}
          />
          <span>
            <strong>DJ AUX</strong>
            <small>The AI judge scores every pick and roasts the bad ones.</small>
          </span>
        </label>
        <label classList={{ 'judge-picker__option--on': openJudge() === 'crowd' }}>
          <input
            type="radio"
            name="judge"
            checked={openJudge() === 'crowd'}
            onChange={() => setOpenJudge('crowd')}
          />
          <span>
            <strong>The room</strong>
            <small>Everyone votes on their phone. No AI involved.</small>
          </span>
        </label>
      </fieldset>
    );
  }
}
