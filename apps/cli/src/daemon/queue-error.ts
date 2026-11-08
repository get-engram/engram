/**
 * Messages read from a transcript could not be queued in daemon.db
 * (engram#584): the disk is full, an I/O error, a locked or damaged
 * database. Unlike a line the parser can't make sense of, this says nothing
 * about the line itself: the same line queues fine once the disk has room.
 * So the watcher stops at the line, keeps its place, and tries again later,
 * where a bad line is skipped.
 *
 * It used to be logged and dropped: the daemon called the syncer as
 * `onMessages(...).catch(log)`, the watcher had already moved on, and it
 * saved the file's resume offset past the line. The message was never
 * queued, and nothing ever read that line again.
 */
export class QueueWriteError extends Error {
  /** What daemon.db said, e.g. "database or disk is full". */
  readonly reason: string;

  constructor(cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`couldn't queue messages in daemon.db: ${reason}`, { cause });
    this.name = "QueueWriteError";
    this.reason = reason;
  }
}

/** Runs one daemon.db step of queuing, turning its failure into a QueueWriteError. */
export function queueing<T>(step: () => T): T {
  try {
    return step();
  } catch (err: unknown) {
    throw err instanceof QueueWriteError ? err : new QueueWriteError(err);
  }
}
