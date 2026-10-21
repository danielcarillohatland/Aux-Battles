/** iOS 15-compatible deadlines; AbortSignal.timeout is unavailable on early iOS. */
export async function requestWithDeadline(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 20_000,
): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (init.signal?.aborted) controller.abort();
  else init.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', abort);
  }
}
