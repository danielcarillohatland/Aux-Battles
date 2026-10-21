import { createSignal, For, onMount, Show } from 'solid-js';
import { apiUrl } from '../config/endpoints.js';
import { requestWithDeadline } from '../config/request.js';
import './app-info.css';

export interface AppInfoReportContext {
  roomCode: string;
  sessionToken: string;
  /** Only players visible to this viewer; omit the viewer's own nickname. */
  players: readonly string[];
  roundIdx?: number;
  /** Owners whose defenses have been revealed, never anonymous pre-reveal owners. */
  defenseOwners?: readonly string[];
}
interface AppConfig {
  publisherName: string | null;
  privacyUrl: string | null;
  termsUrl: string | null;
  supportUrl: string | null;
  reportsAvailable: boolean;
}
let configRequest: Promise<AppConfig> | undefined;
function link(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
async function loadConfig(): Promise<AppConfig> {
  configRequest ??= (async () => {
    const response = await requestWithDeadline(
      apiUrl('/api/v1/app-config'),
      { headers: { accept: 'application/json' } },
      8_000,
    );
    const body = (await response.json()) as { ok?: boolean; data?: Record<string, unknown> };
    if (!response.ok || body.ok !== true || !body.data) throw new Error('unavailable');
    return {
      publisherName:
        typeof body.data['publisherName'] === 'string'
          ? body.data['publisherName'].slice(0, 120)
          : null,
      privacyUrl: link(body.data['privacyUrl']),
      termsUrl: link(body.data['termsUrl']),
      supportUrl: link(body.data['supportUrl']),
      reportsAvailable: body.data['reportsAvailable'] === true,
    };
  })().catch((error: unknown) => {
    configRequest = undefined;
    throw error;
  });
  return configRequest;
}

/** Configured publisher links, factual product help and a private room report. */
export function AppInfo(props: { reportContext?: AppInfoReportContext; label?: string }) {
  const [config, setConfig] = createSignal<AppConfig | null>(null);
  const [failed, setFailed] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const refresh = async () => {
    if (loading()) return;
    setLoading(true);
    setFailed(false);
    try {
      setConfig(await loadConfig());
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };
  onMount(() => void refresh());
  return (
    <details
      class="app-info"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <summary>{props.label ?? 'Help & privacy'}</summary>
      <div class="app-info-body">
        <h2>AUX BATTLES</h2>
        <Show when={config()?.publisherName}>
          {(publisher) => <p>Published by {publisher()}</p>}
        </Show>
        <p>
          Play privately with friends. Pick songs for a scenario, then let the AI judge or the room
          decide.
        </p>
        <p>
          AI judging uses song information and your written defense. It does not hear the audio.
          Shared music still plays on the host screen.
        </p>
        <Show
          when={!failed()}
          fallback={
            <div class="app-info-status" role="status">
              <p>Help links could not be loaded.</p>
              <button
                type="button"
                class="btn btn--small btn--ghost"
                disabled={loading()}
                onClick={() => void refresh()}
              >
                Try again
              </button>
            </div>
          }
        >
          <Show when={config()} fallback={<p role="status">Loading help links…</p>}>
            {(settings) => (
              <nav class="app-info-links" aria-label="Publisher information">
                <For
                  each={[
                    { label: 'Privacy policy', url: settings().privacyUrl },
                    { label: 'Terms of use', url: settings().termsUrl },
                    { label: 'Contact support', url: settings().supportUrl },
                  ]}
                >
                  {(item) => (
                    <Show when={item.url} fallback={<span>{item.label} unavailable</span>}>
                      {(url) => (
                        <a href={url()} target="_blank" rel="noopener noreferrer">
                          {item.label} <span aria-hidden="true">↗</span>
                        </a>
                      )}
                    </Show>
                  )}
                </For>
              </nav>
            )}
          </Show>
        </Show>
        <Show when={props.reportContext && config()?.reportsAvailable}>
          <ReportForm context={props.reportContext!} />
        </Show>
        <Show when={props.reportContext && config() && !config()?.reportsAvailable}>
          <p>In-app reports are unavailable. Use the support link above.</p>
        </Show>
      </div>
    </details>
  );
}

function ReportForm(props: { context: AppInfoReportContext }) {
  const [target, setTarget] = createSignal('');
  const [kind, setKind] = createSignal<'nickname' | 'defense'>('nickname');
  const [details, setDetails] = createSignal('');
  const [hide, setHide] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [reference, setReference] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const players = () =>
    [...new Set(props.context.players)].filter((name) => name !== 'Hidden player');
  const canReportDefense = () =>
    props.context.roundIdx !== undefined && props.context.defenseOwners?.includes(target());
  let attempt: { fingerprint: string; id: string } | undefined;
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy() || !players().includes(target())) return;
    const request = {
      kind: kind() === 'defense' && canReportDefense() ? 'defense' : 'nickname',
      targetNickname: target(),
      ...(kind() === 'defense' && canReportDefense() ? { roundIdx: props.context.roundIdx } : {}),
      details: details().trim(),
      alsoBlock: hide(),
    };
    const fingerprint = JSON.stringify(request);
    if (attempt?.fingerprint !== fingerprint) attempt = { fingerprint, id: crypto.randomUUID() };
    setBusy(true);
    setError(null);
    try {
      const response = await requestWithDeadline(
        apiUrl(`/api/v1/rooms/${encodeURIComponent(props.context.roomCode)}/reports`),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${props.context.sessionToken}`,
          },
          body: JSON.stringify({ clientReportId: attempt.id, ...request }),
        },
        10_000,
      );
      const body = (await response.json()) as {
        ok?: boolean;
        data?: { reportId?: string };
        error?: { message?: string };
      };
      if (!response.ok || body.ok !== true || !body.data?.reportId)
        throw new Error(
          body.error?.message || 'Your report could not be saved. Try again or contact support.',
        );
      setReference(body.data.reportId);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.name !== 'AbortError' && cause.name !== 'TypeError'
          ? cause.message
          : 'Your report was not confirmed. Try again or contact support.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="app-report" aria-label="Report content">
      <h3>Report or hide content</h3>
      <p>
        Reports are saved privately for the publisher. For immediate help during a game, ask the
        host to remove the player.
      </p>
      <Show
        when={!reference()}
        fallback={
          <p class="app-report-success" role="status">
            Report saved. Reference: <span>{reference()}</span>
            {hide() ? ' Their name and song details are hidden on your screen in this room.' : ''}
          </p>
        }
      >
        <Show
          when={players().length > 0}
          fallback={<p>No other visible players are available to report.</p>}
        >
          <form onSubmit={(event) => void submit(event)}>
            <label>
              Player
              <select
                class="field"
                value={target()}
                disabled={busy()}
                onChange={(event) => {
                  setTarget(event.currentTarget.value);
                  setKind('nickname');
                }}
                required
              >
                <option value="">Choose a player</option>
                <For each={players()}>{(name) => <option value={name}>{name}</option>}</For>
              </select>
            </label>
            <label>
              Content
              <select
                class="field"
                value={kind()}
                disabled={busy()}
                onChange={(event) =>
                  setKind(event.currentTarget.value === 'defense' ? 'defense' : 'nickname')
                }
              >
                <option value="nickname">Player name</option>
                <Show when={canReportDefense()}>
                  <option value="defense">Revealed song defense</option>
                </Show>
              </select>
            </label>
            <label>
              What happened? <span>(optional)</span>
              <textarea
                class="field"
                value={details()}
                maxLength={1000}
                rows={3}
                disabled={busy()}
                onInput={(event) => setDetails(event.currentTarget.value)}
                placeholder="Describe the problem. Do not include passwords or payment details."
              />
            </label>
            <label class="app-report-hide">
              <input
                type="checkbox"
                checked={hide()}
                disabled={busy()}
                onChange={(event) => setHide(event.currentTarget.checked)}
              />
              <span>Hide this player’s name and song details on my screen for this room.</span>
            </label>
            <p class="app-report-note">
              Hiding does not remove the player or mute shared audio. It ends with this room.
            </p>
            <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
            <button type="submit" class="btn btn--primary" disabled={busy() || !target()}>
              {busy() ? 'Saving…' : 'Send report'}
            </button>
          </form>
        </Show>
      </Show>
    </section>
  );
}
