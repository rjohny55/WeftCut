import { CAPTURE_SUPERSEDED_MESSAGE } from '../../shared/motifs/captureErrors';

export function previewCaptureHostLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : 1;
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 8) : 1;
}

export interface PreviewPageIdentity {
  packageId: string;
  revision: string;
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  texture: boolean;
}
interface Entry<T> { identity: PreviewPageIdentity; key: string; value: T; used: number; retired: boolean }

/** Preview's existing serial queue is still the admission order. This cache
 * retains documents, never frames or simultaneous clocks. Extra pages hold
 * native memory reservations through running cancellation and retirement. */
export class PreviewCaptureResidency<T> {
  private entries: Entry<T>[] = [];
  private running = false;
  private active: Entry<T> | null = null;
  private epoch = 0;
  private sequence = 0;
  private counts = { hits: 0, created: 0, capacityRefusals: 0, fallbacks: 0, retired: 0, peakHosts: 0 };

  constructor(private readonly deps: {
    maxHosts: number;
    create(sizeMiB: number): T;
    close(value: T): void;
    capacity(error: unknown): boolean;
    fallback: T;
    closeFallback(): void;
  }) {}

  get diagnostics() { return { ...this.counts, hosts: this.entries.length + (this.active?.retired ? 1 : 0), running: this.running }; }

  private retire(entry: Entry<T>): void {
    this.entries = this.entries.filter(e => e !== entry);
    entry.retired = true;
    if (this.active !== entry) { this.deps.close(entry.value); this.counts.retired++; }
  }

  clear(): void {
    this.epoch++;
    for (const entry of [...this.entries]) this.retire(entry);
    if (!this.running) this.deps.closeFallback();
  }

  forEachLive(visit: (value: T) => void): void {
    for (const entry of this.entries) visit(entry.value);
    if (this.active?.retired) visit(this.active.value);
  }

  async use<R>(identity: PreviewPageIdentity, sizeMiB: number, current: () => boolean,
    run: (value: T) => Promise<R>, fallback = this.deps.fallback): Promise<R> {
    if (!current()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE);
    if (this.running) throw new Error('Preview capture queue must remain serial');
    const epoch = this.epoch;
    // A package edit cannot resurrect a previous revision's script or assets.
    for (const entry of [...this.entries]) {
      if (entry.identity.packageId === identity.packageId && entry.identity.revision !== identity.revision) this.retire(entry);
    }
    const key = JSON.stringify([identity.packageId, identity.revision, identity.width,
      identity.height, identity.fpsNum, identity.fpsDen, identity.texture]);
    let entry = this.entries.find(e => e.key === key);
    if (entry) this.counts.hits++;
    else {
      if (this.entries.length >= previewCaptureHostLimit(this.deps.maxHosts)) {
        const victim = [...this.entries].sort((a, b) => a.used - b.used)[0];
        if (victim) this.retire(victim);
      }
      try {
        entry = { identity: { ...identity }, key, value: this.deps.create(sizeMiB), used: 0, retired: false };
        this.entries.push(entry); this.counts.created++;
        this.counts.peakHosts = Math.max(this.counts.peakHosts, this.entries.length);
      } catch (error) {
        if (!this.deps.capacity(error)) throw error;
        this.counts.capacityRefusals++;
        // Do not retain extra idle pages while pressure sends work to legacy.
        for (const existing of [...this.entries]) this.retire(existing);
        this.counts.fallbacks++;
      }
    }
    this.running = true;
    this.active = entry ?? null;
    if (entry) entry.used = ++this.sequence;
    try {
      if (!current()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE);
      if (entry) this.deps.closeFallback(); // before doCapture can build a page
      return await run(entry?.value ?? fallback);
    } finally {
      this.running = false;
      this.active = null;
      if (entry?.retired) { this.deps.close(entry.value); this.counts.retired++; }
      if (this.epoch !== epoch) this.deps.closeFallback();
    }
  }
}
