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
  readonly kind: "queue" | "config" = "queue";

  constructor(cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`couldn't queue messages in daemon.db: ${reason}`, { cause });
    this.name = "QueueWriteError";
    this.reason = reason;
  }
}

/**
 * ~/.engram/config.json is there, but which folders it excludes from
 * capture can't be told (engram#673): it can't be read, or isn't settings.
 * Like a failed queue write, this says nothing about the line: the watcher
 * holds the file at it and tries again later. Captured meanwhile, a
 * session in an excluded folder would be queued and sent, and an
 * exclusion can't be taken back once it has.
 *
 * `reason` names the problem and never quotes the file, which holds the
 * API key: it reaches daemon.log, status.json and a notification.
 */
export class ExclusionsUnreadable extends Error {
  /** What is wrong with the file, e.g. "~/.engram/config.json isn't valid JSON". */
  readonly reason: string;
  readonly kind: "queue" | "config" = "config";

  constructor(reason: string) {
    super(`can't tell which folders are excluded from capture: ${reason}`);
    this.name = "ExclusionsUnreadable";
    this.reason = reason;
  }
}

/**
 * Why the watcher holds a transcript at a line rather than read on: the
 * line is fine, but it can't be captured safely yet. Anything else thrown
 * while capturing a line is about the line, and it is skipped.
 */
export type CaptureHold = QueueWriteError | ExclusionsUnreadable;

/** True for an error the watcher holds a transcript for, rather than skip the line. */
export function isCaptureHold(err: unknown): err is CaptureHold {
  return err instanceof QueueWriteError || err instanceof ExclusionsUnreadable;
}

/** Runs one daemon.db step of queuing, turning its failure into a QueueWriteError. */
export function queueing<T>(step: () => T): T {
  try {
    return step();
  } catch (err: unknown) {
    throw isCaptureHold(err) ? err : new QueueWriteError(err);
  }
}
