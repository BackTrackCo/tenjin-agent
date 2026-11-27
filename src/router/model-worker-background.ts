/**
 * WHAT THE WORKER'S CLAUDE CODE STILL HAS RUNNING IN THE BACKGROUND, read from its own messages.
 * A worker whose shell command ran in the background (a foreground `sleep` is not permitted
 * there) reports a result and goes on: the command's end starts another turn, which reports
 * again. The result of a run is the last of those reports, so the run stays open until the child
 * has no background work, as a native subagent's does.
 *
 * `background_tasks_changed` carries the whole live set and replaces what was known. A child that
 * predates it is followed by the start and end notices of each task instead.
 */
export class BackgroundWork {
  private live = new Set<string>();
  private levels = false;

  /** Reads one message; true when it changed what is running. */
  observe(message: { type?: string; subtype?: string; [key: string]: unknown }): boolean {
    if (message.type !== 'system') return false;
    const before = this.live.size;
    if (message.subtype === 'background_tasks_changed' && Array.isArray(message.tasks)) {
      this.levels = true;
      this.live = new Set(
        (message.tasks as Array<{ task_id?: unknown; ambient?: unknown }>).flatMap((task) =>
          typeof task?.task_id === 'string' && task.ambient !== true ? [task.task_id] : [],
        ),
      );
    } else if (!this.levels && typeof message.task_id === 'string') {
      if (message.subtype === 'task_started' && message.is_backgrounded !== false)
        this.live.add(message.task_id);
      else if (message.subtype === 'task_notification') this.live.delete(message.task_id);
    }
    return this.live.size !== before;
  }

  /** Whether any background task is still running. */
  get busy(): boolean {
    return this.live.size > 0;
  }
}
