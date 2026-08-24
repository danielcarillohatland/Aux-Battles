/**
 * Analytics event bus (D-010): typed, in-process, fire-and-forget, NDJSON sink.
 * Emitting NEVER blocks or throws into the game loop — sink failures are logged, swallowed.
 */
import { createWriteStream, type WriteStream } from 'node:fs';
import type { AnalyticsEvent } from '@aux/shared';

export interface AnalyticsSink {
  write(record: AnalyticsEvent & { ts: number }): void;
  flush?(): void;
}

export class NdjsonAnalyticsSink implements AnalyticsSink {
  private stream: WriteStream | null = null;

  constructor(private readonly filePath: string | null) {}

  start(): void {
    if (!this.filePath) return;
    this.stream = createWriteStream(this.filePath, { flags: 'a' });
    // Without a listener, an async write failure (ENOSPC, EACCES, file rotated
    // away) surfaces as an uncaught exception and kills the process — D-010
    // forbids analytics from ever taking down the party. Swallow; drop records.
    this.stream.on('error', () => {});
  }

  write(record: AnalyticsEvent & { ts: number }): void {
    if (!this.stream) return;
    try {
      this.stream.write(`${JSON.stringify(record)}\n`);
    } catch {
      // Analytics must never break the party (D-010). Drop on error.
    }
  }

  flush(): void {
    this.stream?.end();
    this.stream = null;
  }
}

export class Analytics {
  constructor(private readonly sink: AnalyticsSink) {}

  emit(event: AnalyticsEvent): void {
    this.sink.write({ ...event, ts: Date.now() });
  }

  flush(): void {
    this.sink.flush?.();
  }
}

/** No-op sink for tests. */
export class NullAnalyticsSink implements AnalyticsSink {
  events: Array<AnalyticsEvent & { ts: number }> = [];
  write(record: AnalyticsEvent & { ts: number }): void {
    this.events.push(record);
  }
}
