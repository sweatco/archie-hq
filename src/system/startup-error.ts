/**
 * A configuration/environment problem detected during startup that the operator
 * can fix — as opposed to an unexpected crash. The entrypoint renders these as a
 * clean, actionable message (no JS stack trace), since the stack is noise for a
 * "you forgot to set X" error.
 *
 * `message` is the one-line headline. `details` are indented guidance lines shown
 * beneath it (e.g. the options to choose from).
 */
export class StartupError extends Error {
  readonly details: string[];

  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = 'StartupError';
    this.details = details;
  }
}
